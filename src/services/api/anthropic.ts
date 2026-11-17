import type { Provider } from '../providers.js'
import { ApiError, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageParam, MessageStreamEvent } from './types.js'

/**
 * Anthropic Messages 兼容协议的流式请求：第三方服务只接受标准字段，
 * 因此去掉 DeepSeek 的 latest_reminder、文件引用与联网搜索工具，只保留文本对话。
 */

type AnthropicMessage = { role: 'user' | 'assistant'; content: string }

const toText = (content: MessageParam['content']): string =>
  typeof content === 'string'
    ? content
    : content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')

const toAnthropicMessages = (messages: MessageParam[]): AnthropicMessage[] => {
  const converted: AnthropicMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    const text =
      message.role === 'user'
        ? toText(message.content)
        : message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    if (text.trim()) {
      converted.push({ role: message.role, content: text })
    }
  }
  return converted
}

export type AnthropicRequest = {
  model: string
  system: string
  messages: MessageParam[]
  thinking?: boolean
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
      // Anthropic 要求显式给出输出上限
      max_tokens: 8192,
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
