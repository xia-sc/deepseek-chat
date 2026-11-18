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
 * OpenAI Chat Completions 兼容协议的请求与流式响应转换：
 * 把应用内部的 Messages 风格请求体转成 OpenAI messages，再把 SSE 增量还原成内部的流式事件。
 * 第三方服务不提供 DeepSeek 的联网搜索、文件接口与标题生成，这里只映射文本与思考内容。
 */

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /** 非图片文件按 OpenAI 的 file 部分发送，要求 file_data 为 data URL */
  | { type: 'file'; file: { filename: string; file_data: string } }

type OpenAiMessage = { role: 'system' | 'user' | 'assistant'; content: string | OpenAiContentPart[] }

/**
 * 内部内容块 → OpenAI content：文本拼成字符串，内联图片转 image_url，
 * 内联文件转 file 部分；DeepSeek 的 file_id 引用在第三方协议里没有对应物，丢弃。
 */
const toOpenAiContent = (content: MessageParam['content']): string | OpenAiContentPart[] => {
  if (typeof content === 'string') {
    return content
  }
  const parts: OpenAiContentPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'inline_file') {
      parts.push(
        block.isImage
          ? { type: 'image_url', image_url: { url: block.dataUrl } }
          : { type: 'file', file: { filename: block.name, file_data: block.dataUrl } }
      )
    }
  }
  return parts.length === 1 && parts[0]?.type === 'text' ? parts[0].text : parts
}

/** 有文本或附件才保留该条消息 */
const hasContent = (content: string | OpenAiContentPart[]) =>
  typeof content === 'string'
    ? content.trim() !== ''
    : content.some((part) => part.type !== 'text' || part.text.trim() !== '')

/** 历史助手内容只回传正文，思考与工具块不进入第三方上下文 */
const assistantToText = (content: Extract<MessageParam, { role: 'assistant' }>['content']): string =>
  content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')

/**
 * latest_reminder 是 DeepSeek 扩展角色，第三方没有对应语义：
 * 把它拼进 system 末尾，保留其中的时间与位置提示。
 */
export const toOpenAiMessages = (system: string, messages: MessageParam[]): OpenAiMessage[] => {
  const reminders: string[] = []
  const converted: OpenAiMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      if (message.content.trim() && reminders.at(-1) !== message.content) {
        reminders.push(message.content)
      }
      continue
    }
    if (message.role === 'user') {
      const content = toOpenAiContent(message.content)
      if (hasContent(content)) {
        converted.push({ role: 'user', content })
      }
      continue
    }
    const text = assistantToText(message.content)
    if (text.trim()) {
      converted.push({ role: 'assistant', content: text })
    }
  }
  const systemText = [system, ...reminders].filter((part) => part.trim()).join('\n\n')
  return systemText ? [{ role: 'system', content: systemText }, ...converted] : converted
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

type OpenAiUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
}

const toUsage = (usage: OpenAiUsage): MessageUsage => ({
  input_tokens: usage.prompt_tokens ?? 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  output_tokens: usage.completion_tokens ?? 0,
})

type OpenAiChunk = {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: OpenAiUsage
  error?: { message?: string }
}

/** 流式索引：思考块固定在文本块之前，用互不冲突的序号交给上层做增量映射 */
const THINKING_INDEX = 1000
const TEXT_INDEX = 0

export type OpenAiRequest = {
  model: string
  system: string
  messages: MessageParam[]
  /** 部分兼容服务支持 reasoning_effort；未知字段通常被忽略 */
  thinking?: boolean
  /** 模型配置的最大输出 token 数；未配置时不发送该字段 */
  maxOutput?: number
}

/**
 * POST {baseUrl}/chat/completions（stream: true），逐个产出内部流式事件。
 * 首次收到内容时补发 message_start；思考内容映射为 thinking 块，正文映射为 text 块；
 * finish_reason 或 [DONE] 之后收尾，缺少结束标记时按断流抛错。
 */
export async function* streamOpenAi(
  provider: Provider,
  body: OpenAiRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const response = await request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: body.model,
      messages: toOpenAiMessages(body.system, body.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(body.maxOutput ? { max_completion_tokens: body.maxOutput } : {}),
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

  const start = (): MessageStreamEvent[] => {
    if (started) {
      return []
    }
    started = true
    return [{ type: 'message_start', message: { id: '', model: body.model } }]
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed || trimmed === '[DONE]') {
      if (trimmed === '[DONE]') {
        break
      }
      continue
    }
    let chunk: OpenAiChunk
    try {
      chunk = JSON.parse(trimmed) as OpenAiChunk
    } catch {
      continue
    }
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message ?? trimmed)
    }
    if (chunk.usage) {
      usage = toUsage(chunk.usage)
    }
    for (const choice of chunk.choices ?? []) {
      const reasoning = choice.delta?.reasoning_content
      if (reasoning) {
        for (const event of start()) {
          yield event
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
          delta: { type: 'thinking_delta', thinking: reasoning },
        }
      }
      const text = choice.delta?.content
      if (text) {
        for (const event of start()) {
          yield event
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
          delta: { type: 'text_delta', text },
        }
      }
      if (choice.finish_reason) {
        stopReason = STOP_REASONS[choice.finish_reason] ?? 'end_turn'
      }
    }
    if (stopReason) {
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
  // 部分兼容服务只发 [DONE] 不带 finish_reason，按正常结束处理
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}
