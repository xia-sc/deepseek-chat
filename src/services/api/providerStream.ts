import type { Provider } from '../providers.js'
import { streamAnthropic } from './anthropic.js'
import { streamGemini } from './gemini.js'
import { streamOpenAi } from './openai.js'
import { streamResponses } from './responses.js'
import type { MessageParam, MessageStreamEvent } from './types.js'

export type ProviderStreamRequest = {
  model: string
  system: string
  messages: MessageParam[]
  thinking?: boolean
  /** 第三方协议里只有 Responses 支持内置联网搜索，其余协议忽略 */
  search?: boolean
  /** 模型配置的最大输出 token 数；未配置时由各协议使用默认值 */
  maxOutput?: number
}

/** 按供应商设置的协议选择流式实现；未知协议按 OpenAI 兼容处理 */
export function streamProvider(
  provider: Provider,
  body: ProviderStreamRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  switch (provider.protocol) {
    case 'anthropic':
      return streamAnthropic(provider, body, signal)
    case 'gemini':
      return streamGemini(provider, body, signal)
    case 'responses':
      return streamResponses(provider, body, signal)
    default:
      return streamOpenAi(provider, body, signal)
  }
}
