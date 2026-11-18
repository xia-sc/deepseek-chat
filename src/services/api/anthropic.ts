import type { Provider } from '../providers.js'
import { ApiError, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageParam, MessageStreamEvent } from './types.js'

/**
 * Anthropic Messages 兼容协议的流式请求：第三方服务只接受标准字段，
 * 因此去掉 DeepSeek 的 latest_reminder、文件引用与联网搜索工具，只保留文本对话。
 */

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }

/** 拆出 data URL 的 MIME 与 base64 体；不是 data URL 时按原始 base64 处理 */
const parseDataUrl = (dataUrl: string) => {
  const match = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(dataUrl)
  return match
    ? { mediaType: match[1] || 'application/octet-stream', data: match[2] ?? '' }
    : { mediaType: 'application/octet-stream', data: dataUrl }
}

/**
 * 内部内容块 → Anthropic content：文本拼字符串，内联图片用 base64 image，
 * 其余文件用 base64 document；DeepSeek 的 file_id 引用在第三方协议里没有对应物，丢弃。
 */
const toAnthropicContent = (
  content: MessageParam['content']
): string | AnthropicContentBlock[] => {
  if (typeof content === 'string') {
    return content
  }
  const blocks: AnthropicContentBlock[] = []
  for (const block of content) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'inline_file') {
      const { mediaType, data } = parseDataUrl(block.dataUrl)
      blocks.push({
        type: block.isImage ? 'image' : 'document',
        source: { type: 'base64', media_type: block.mimeType || mediaType, data },
      })
    }
  }
  return blocks.length === 1 && blocks[0]?.type === 'text' ? blocks[0].text : blocks
}

const hasContent = (content: string | AnthropicContentBlock[]) =>
  typeof content === 'string'
    ? content.trim() !== ''
    : content.some((block) => block.type !== 'text' || block.text.trim() !== '')

const toAnthropicMessages = (messages: MessageParam[]): AnthropicMessage[] => {
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user') {
      const content = toAnthropicContent(message.content)
      if (hasContent(content)) {
        converted.push({ role: 'user', content })
      }
      continue
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    if (text.trim()) {
      converted.push({ role: 'assistant', content: text })
    }
  }
  return converted
}

export type AnthropicRequest = {
  model: string
  system: string
  messages: MessageParam[]
  thinking?: boolean
  /** 模型配置的最大输出 token 数；未配置时用协议默认值 */
  maxOutput?: number
}

/**
 * POST {baseUrl}/messages（stream: true）：上游事件本身已是 Messages 格式，
 * 校验错误帧后原样透传给上层。
 */
export async function* streamAnthropic(
  provider: Provider,
  body: AnthropicRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/messages`
  const response = await request(url, {
    method: 'POST',
    headers: {
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model: body.model,
      // Anthropic 要求显式给出输出上限；优先用模型配置的值
      max_tokens: body.maxOutput ?? 8192,
      system: body.system,
      messages: toAnthropicMessages(body.messages),
      stream: true,
      ...(body.thinking
        ? { thinking: { type: 'enabled', budget_tokens: 4096 } }
        : { thinking: { type: 'disabled' } }),
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('protocol', `接口未返回 SSE 流（Content-Type: ${contentType || '未知'}）`)
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed) {
      continue
    }
    let payload: { type?: string; error?: { message?: string } }
    try {
      payload = JSON.parse(trimmed) as { type?: string; error?: { message?: string } }
    } catch {
      continue
    }
    if (payload.type === 'error') {
      throw new ApiError('stream', payload.error?.message ?? trimmed)
    }
    if (payload.type === 'ping' || !payload.type) {
      continue
    }
    yield payload as MessageStreamEvent
    if (payload.type === 'message_stop') {
      return
    }
  }
  // 没有 message_stop 就结束：由上层按已收到的结束原因决定是否算完成
  throw new ApiError('interrupted', '')
}
