import { API_ORIGIN, request } from './client.js'
import type { WebSearchResult } from './webSearch.js'

/**
 * 用 DeepSeek 官方 API Key 做联网搜索：调用 `POST /v1/tools/search`。
 * 供应商自己没有搜索接口时，用户可以在供应商配置里填 DeepSeek API Key，
 * 由应用用这个 Key 检索，再把结果注入第三方模型的上下文。
 */

const SEARCH_URL = `${API_ORIGIN}/v1/tools/search`
/** 返回条数；与上下文注入的篇幅折中 */
const SEARCH_COUNT = 5
/** DeepSeek 限制 query 为 1–128 字符 */
const MAX_QUERY_LENGTH = 128

export const searchWithDeepseek = async (
  apiKey: string,
  query: string,
  signal?: AbortSignal
): Promise<WebSearchResult[]> => {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH)
  if (!trimmed) {
    return []
  }
  const response = await request(SEARCH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: trimmed,
      count: SEARCH_COUNT,
      // 长摘要（summary）比 snippet 更适合直接给模型阅读
      need_content: false,
    }),
    signal,
  })
  const payload = (await response.json()) as { results?: unknown }
  const results = Array.isArray(payload.results) ? payload.results : []
  return results.flatMap((item): WebSearchResult[] => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const { title, url, snippet, summary } = item as Record<string, unknown>
    if (typeof url !== 'string' || !url.trim()) {
      return []
    }
    const detail =
      typeof summary === 'string' && summary.trim()
        ? summary.trim()
        : typeof snippet === 'string'
          ? snippet.trim()
          : ''
    return [
      {
        title: typeof title === 'string' ? title.trim() : '',
        url: url.trim(),
        snippet: detail,
      },
    ]
  })
}
