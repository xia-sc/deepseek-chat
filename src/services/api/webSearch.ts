import { request } from './client.js'

/**
 * 应用侧联网搜索：不少第三方供应商（如 Command Code）提供独立的搜索接口，
 * 与模型内置的 web_search 不同，它在发送聊天请求之前调用，结果再注入上下文，
 * 因此对任何模型都有效，包括不支持内置搜索的 DeepSeek 系列。
 */

export type WebSearchResult = {
  title: string
  url: string
  snippet: string
}

/** 单次检索返回的结果条数，与供应商默认值一致 */
const NUM_RESULTS = 5

/**
 * 调用供应商的搜索接口。请求体用 CLI 同款结构 `{ query, numResults }`，
 * 响应里的 `results` 每项至少要有 url；缺少标题或摘要时保留空串。
 */
export const searchWeb = async (
  endpoint: string,
  apiKey: string,
  query: string,
  signal?: AbortSignal
): Promise<WebSearchResult[]> => {
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, numResults: NUM_RESULTS }),
    signal,
  })
  const payload = (await response.json()) as { results?: unknown }
  const results = Array.isArray(payload.results) ? payload.results : []
  return results.flatMap((item): WebSearchResult[] => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const { title, url, snippet } = item as Record<string, unknown>
    if (typeof url !== 'string' || !url.trim()) {
      return []
    }
    return [
      {
        title: typeof title === 'string' ? title.trim() : '',
        url: url.trim(),
        snippet: typeof snippet === 'string' ? snippet.trim() : '',
      },
    ]
  })
}

/** 把检索结果拼成注入 system 的上下文；没有结果时返回空串 */
export const formatSearchContext = (query: string, results: WebSearchResult[]): string => {
  if (results.length === 0) {
    return ''
  }
  const lines = results
    .map((result, index) => {
      const title = result.title || result.url
      const snippet = result.snippet ? `\n   ${result.snippet}` : ''
      return `${index + 1}. ${title}\n   ${result.url}${snippet}`
    })
    .join('\n\n')
  return `以下是针对「${query}」的联网搜索结果，已作为背景信息提供给你。请直接、自然地回答问题，不要写“搜索结果说”“根据搜索”“有文章说”之类的过程描述；引用具体事实时用自然语言陈述，并附上来源链接。\n\n${lines}`
}

/** 纯寒暄、确认、道谢等不需要外部信息的输入 */
const SMALL_TALK =
  /^(你好|您好|hi|hello|hey|嗨|在吗|在不在|谢谢|谢了|多谢|好的|好|ok|okay|嗯|嗯嗯|收到|明白|知道了|再见|拜拜|晚安|早上好|下午好|晚上好|辛苦了|厉害|牛)[!！。.？?~～\s]*$/i

/**
 * 是否值得为这个提问发起联网搜索。
 * 客户端搜索是「先搜后问」，不像模型内置工具那样能由模型自己判断，
 * 所以先在这里过滤掉明显不需要外部信息、且搜索会显得突兀的输入。
 */
export const shouldSearch = (question: string): boolean => {
  const text = question.trim()
  if (!text) {
    return false
  }
  // 纯符号或表情
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return false
  }
  // 极短且没有实义的输入
  if (text.length < 2) {
    return false
  }
  if (SMALL_TALK.test(text)) {
    return false
  }
  return true
}
