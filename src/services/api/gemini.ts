import type { Provider } from '../providers.js'
import { ApiError, request } from './client.js'
import { readServerSentEvents } from './sse.js'
import type { MessageParam, MessageStreamEvent, MessageUsage, StopReason } from './types.js'

/**
 * Google Gemini（generateContent）的流式适配：
 * 把内部消息转成 contents + systemInstruction，再把 SSE 里的候选文本还原为内部流式事件。
 */

type GeminiPart = { text: string } | { inline_data: { mime_type: string; data: string } }

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

/** 拆出 data URL 的 MIME 与 base64 体；不是 data URL 时按原始 base64 处理 */
const parseDataUrl = (dataUrl: string) => {
  const match = /^data:([^;,]*)(?:;[^,]*)?,(.*)$/s.exec(dataUrl)
  return match
    ? { mediaType: match[1] || 'application/octet-stream', data: match[2] ?? '' }
    : { mediaType: 'application/octet-stream', data: dataUrl }
}

/** 内部内容块 → Gemini parts：文本转 text，内联附件转 inline_data */
const toGeminiParts = (content: MessageParam['content']): GeminiPart[] => {
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }
  const parts: GeminiPart[] = []
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ text: block.text })
    } else if (block.type === 'inline_file') {
      const { mediaType, data } = parseDataUrl(block.dataUrl)
      parts.push({ inline_data: { mime_type: block.mimeType || mediaType, data } })
    }
  }
  return parts
}

const toGeminiContents = (messages: MessageParam[]): GeminiContent[] =>
  messages.flatMap((message): GeminiContent[] => {
    if (message.role === 'latest_reminder') {
      return []
    }
    if (message.role === 'user') {
      const parts = toGeminiParts(message.content)
      return parts.length > 0 ? [{ role: 'user', parts }] : []
    }
    const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')
    return text.trim() ? [{ role: 'model', parts: [{ text }] }] : []
  })

const STOP_REASONS: Record<string, StopReason> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  RECITATION: 'refusal',
}

type GeminiChunk = {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
  error?: { message?: string }
}

export type GeminiRequest = {
  model: string
  system: string
  messages: MessageParam[]
  /** 模型配置的最大输出 token 数；未配置时不发送 generationConfig */
  maxOutput?: number
}

/** POST {baseUrl}/models/{model}:streamGenerateContent?alt=sse */
export async function* streamGemini(
  provider: Provider,
  body: GeminiRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const base = provider.baseUrl.replace(/\/+$/, '')
  const url = `${base}/models/${encodeURIComponent(body.model)}:streamGenerateContent?alt=sse`
  const response = await request(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': provider.apiKey,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: body.system }] },
      contents: toGeminiContents(body.messages),
      ...(body.maxOutput ? { generationConfig: { maxOutputTokens: body.maxOutput } } : {}),
    }),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw new ApiError('protocol', `接口未返回 SSE 流（Content-Type: ${contentType || '未知'}）`)
  }

  let started = false
  let textOpen = false
  let stopReason: StopReason | undefined
  let usage: MessageUsage | undefined

  const start = (): MessageStreamEvent[] => {
    if (started) {
      return []
    }
    started = true
    return [{ type: 'message_start', message: { id: '', model: body.model } }]
  }

  for await (const { data } of readServerSentEvents(response.body, signal)) {
    const trimmed = data.trim()
    if (!trimmed) {
      continue
    }
    let chunk: GeminiChunk
    try {
      chunk = JSON.parse(trimmed) as GeminiChunk
    } catch {
      continue
    }
    if (chunk.error) {
      throw new ApiError('stream', chunk.error.message ?? trimmed)
    }
    if (chunk.usageMetadata) {
      usage = {
        input_tokens: chunk.usageMetadata.promptTokenCount ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
      }
    }
    for (const candidate of chunk.candidates ?? []) {
      const text = candidate.content?.parts?.flatMap((part) => (part.text ? [part.text] : [])).join('')
      if (text) {
        for (const event of start()) {
          yield event
        }
        if (!textOpen) {
          textOpen = true
          yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }
      }
      if (candidate.finishReason) {
        stopReason = STOP_REASONS[candidate.finishReason] ?? 'end_turn'
      }
    }
    if (stopReason) {
      break
    }
  }

  if (!started) {
    throw new ApiError('protocol', '接口没有返回任何内容')
  }
  if (textOpen) {
    yield { type: 'content_block_stop', index: 0 }
  }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReason ?? 'end_turn', stop_sequence: null },
    ...(usage ? { usage } : {}),
  }
  yield { type: 'message_stop' }
}
