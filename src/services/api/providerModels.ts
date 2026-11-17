import type { Provider } from '../providers.js'
import { request } from './client.js'

/**
 * 供应商模型目录探测：各协议都支持 GET /models，
 * 只是鉴权头与响应结构略有差异（OpenAI/Anthropic 用 data，Gemini 用 models）。
 */

const baseOf = (provider: Provider) => provider.baseUrl.replace(/\/+$/, '')

const headersOf = (provider: Provider): Record<string, string> => {
  switch (provider.protocol) {
    case 'anthropic':
      return { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' }
    case 'gemini':
      return { 'x-goog-api-key': provider.apiKey }
    default:
      return { Authorization: `Bearer ${provider.apiKey}` }
  }
}

/** 从响应体里取出模型 id：兼容 data[].id（OpenAI/Anthropic）与 models[].name（Gemini） */
const parseModelIds = (payload: unknown): string[] => {
  if (typeof payload !== 'object' || payload === null) {
    return []
  }
  const record = payload as Record<string, unknown>
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const ids = list.flatMap((item) => {
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const { id, name } = item as Record<string, unknown>
    const value = typeof id === 'string' && id ? id : typeof name === 'string' && name ? name : null
    return value ? [value.replace(/^models\//, '')] : []
  })
  return [...new Set(ids)]
}

/** 拉取供应商的可用模型；网络或鉴权失败时抛出 ApiError，由调用方翻译展示 */
export const fetchProviderModels = async (
  provider: Provider,
  signal?: AbortSignal
): Promise<string[]> => {
  const response = await request(`${baseOf(provider)}/models`, {
    method: 'GET',
    headers: headersOf(provider),
    signal,
  })
  return parseModelIds(await response.json())
}

/** 编辑表单里以草稿配置探测模型，不必先保存 */
export const fetchDraftModels = async (
  draft: Pick<Provider, 'baseUrl' | 'protocol' | 'apiKey'>,
  signal?: AbortSignal
): Promise<string[]> => fetchProviderModels(draft as Provider, signal)
