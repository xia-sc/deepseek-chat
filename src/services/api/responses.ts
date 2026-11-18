import type { Provider } from '../providers.js'
import { ApiError, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type {
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/**
 * OpenAI Responses API 的流式适配：
 * 请求走 {baseUrl}/responses，工具数组原样透传（例如 {"type":"web_search"}），
 * 把 response.* 事件还原成内部的流式事件。Responses 支持内置联网搜索，
 * 搜索结果的 URL 引用会转成文本块的 citations。
 */

type ResponsesInputPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  | { type: 'input_file'; filename: string; file_data: string }

/** assistant 的历史输出在 Responses 的 input 里用 output_text 表示 */
type ResponsesOutputPart = { type: 'output_text'; text: string }

type ResponsesInputMessage =
  | { role: 'user'; content: string | ResponsesInputPart[] }
  | { role: 'assistant'; content: ResponsesOutputPart[] }

/**
 * 内部消息 → Responses 的 input：user 用 input_text / input_image / input_file，
 * assistant 的历史输出用 output_text；latest_reminder 是 DeepSeek 扩展，跳过。
 */
const toResponsesInput = (messages: MessageParam[]): ResponsesInputMessage[] => {
  const input: ResponsesInputMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content.trim()) {
          input.push({ role: 'user', content: message.content })
        }
        continue
      }
      const parts: ResponsesInputPart[] = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push({ type: 'input_text', text: block.text })
        } else if (block.type === 'inline_file') {
          parts.push(
            block.isImage
              ? { type: 'input_image', image_url: block.dataUrl }
              : { type: 'input_file', filename: block.name, file_data: block.dataUrl }
          )
        }
      }
      if (parts.length > 0) {
        input.push({ role: 'user', content: parts })
      }
      continue
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    if (text.trim()) {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text }] })
    }
  }
  return input
}

type ResponsesUsage = {
  input_tokens?: number
  output_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

const toUsage = (usage: ResponsesUsage): MessageUsage => ({
  input_tokens: usage.input_tokens ?? 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: usage.input_tokens_details?.cached_tokens ?? 0,
  output_tokens: usage.output_tokens ?? 0,
})

type ResponsesAnnotation = {
  type?: string
  url?: string
  title?: string
}

type ResponsesEvent = {
  type?: string
  delta?: string
  message?: string
  response?: {
    id?: string
    model?: string
    usage?: ResponsesUsage
    error?: { message?: string }
    incomplete_details?: { reason?: string }
  }
  annotations?: ResponsesAnnotation[]
}

/** 思考块固定在文本块之前，用互不冲突的序号交给上层做增量映射 */
const THINKING_INDEX = 1000
const TEXT_INDEX = 0

export type ResponsesRequest = {
  model: string
  system: string
  messages: MessageParam[]
  thinking?: boolean
  /** 声明内置 web_search 工具；上游模型不支持时会拒绝该请求 */
  search?: boolean
  /** 模型配置的最大输出 token 数；未配置时不发送该字段 */
  maxOutput?: number
}

/**
 * POST {baseUrl}/responses（stream: true），逐个产出内部流式事件。
 * 正文映射为 text 块，推理摘要映射为 thinking 块，URL 引用映射为 citations。
 */
export async function* streamResponses(
  provider: Provider,
  body: ResponsesRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/responses`
  const response = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: body.model,
      instructions: body.system,
      input: toResponsesInput(body.messages),
      stream: true,
      ...(body.search ? { tools: [{ type: 'web_search' }] } : {}),
      ...(body.maxOutput ? { max_output_tokens: body.maxOutput } : {}),
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('protocol', `接口未返回 SSE 流（Content-Type: ${contentType || '未知'}）`)
  }

  let started = false
  let thinkingOpen = false
  let textOpen = false
  let usage: MessageUsage | undefined
  let stopReason: StopReason | undefined

  const start = (id = '', model = body.model): MessageStreamEvent[] => {
    if (started) {
      return []
    }
    started = true
    return [{ type: 'message_start', message: { id, model } }]
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed || trimmed === '[DONE]') {
      if (trimmed === '[DONE]') {
        break
      }
      continue
    }
    let event: ResponsesEvent
    try {
      event = JSON.parse(trimmed) as ResponsesEvent
    } catch {
      continue
    }
    const type = event.type ?? ''

    if (type === 'error' || type === 'response.failed') {
      throw new ApiError('stream', event.response?.error?.message ?? event.message ?? trimmed)
    }
    if (type === 'response.created') {
      for (const yielded of start(event.response?.id ?? '', event.response?.model ?? body.model)) {
        yield yielded
      }
      continue
    }
    if (type === 'response.reasoning_summary_text.delta' && event.delta) {
      for (const yielded of start()) {
        yield yielded
      }
      if (!thinkingOpen) {
        thinkingOpen = true
        yield {
          type: 'content_block_start',
          index: THINKING_INDEX,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: THINKING_INDEX,
        delta: { type: 'thinking_delta', thinking: event.delta },
      }
      continue
    }
    if (type === 'response.output_text.delta' && event.delta) {
      for (const yielded of start()) {
        yield yielded
      }
      if (thinkingOpen) {
        thinkingOpen = false
        yield { type: 'content_block_stop', index: THINKING_INDEX }
      }
      if (!textOpen) {
        textOpen = true
        yield { type: 'content_block_start', index: TEXT_INDEX, content_block: { type: 'text', text: '' } }
      }
      yield {
        type: 'content_block_delta',
        index: TEXT_INDEX,
        delta: { type: 'text_delta', text: event.delta },
      }
      continue
    }
    if (type === 'response.output_text.done' && Array.isArray(event.annotations)) {
      for (const annotation of event.annotations) {
        if (annotation.type !== 'url_citation' || !annotation.url) {
          continue
        }
        yield {
          type: 'content_block_delta',
          index: TEXT_INDEX,
          delta: {
            type: 'citations_delta',
            citation: {
              type: 'web_search_result_location',
              url: annotation.url,
              title: annotation.title ?? null,
              cited_text: '',
              encrypted_index: '',
            },
          },
        }
      }
      continue
    }
    if (type === 'response.completed' || type === 'response.incomplete') {
      if (event.response?.usage) {
        usage = toUsage(event.response.usage)
      }
      stopReason = type === 'response.incomplete' ? 'max_tokens' : 'end_turn'
      break
    }
  }

  if (!started) {
    throw new ApiError('protocol', '接口没有返回任何内容')
  }
  if (thinkingOpen) {
    yield { type: 'content_block_stop', index: THINKING_INDEX }
  }
  if (textOpen) {
    yield { type: 'content_block_stop', index: TEXT_INDEX }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}
