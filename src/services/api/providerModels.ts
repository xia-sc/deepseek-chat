import type { Provider, ProviderModel } from '../providers.js'
import { request } from './client.js'

/**
 * 供应商模型目录探测：各协议都支持 GET /models，
 * 只是鉴权头与响应结构略有差异（OpenAI/Anthropic 用 data，Gemini 用 models）。
 * 同时尽力从响应里读出多模态、上下文与最大输出能力：不同供应商字段名差异很大，
 * 读不到时保持未知，由用户在设置里手动配置。
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

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const firstPositive = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value)
    }
  }
  return undefined
}

type ModelCapabilities = Pick<
  ProviderModel,
  'vision' | 'files' | 'search' | 'contextLength' | 'maxOutput'
>

/**
 * 解析单个模型条目的能力字段，覆盖常见的几种返回结构：
 * - OpenRouter：architecture.input_modalities / top_provider.max_completion_tokens
 * - Gemini：inputTokenLimit / outputTokenLimit
 * - 其他兼容服务：context_length、max_output_tokens、capabilities.vision 等
 */
const readCapabilities = (item: Record<string, unknown>, id: string): ModelCapabilities => {
  const architecture = asRecord(item.architecture)
  const capabilities = asRecord(item.capabilities)
  const topProvider = asRecord(item.top_provider)
  const modalities = asRecord(item.modalities)

  const inputModalities = [
    ...asStrings(architecture?.input_modalities),
    ...asStrings(item.input_modalities),
    ...asStrings(modalities?.input),
  ].map((value) => value.toLowerCase())
  const modalityText = [...asStrings(architecture?.modality), ...asStrings(item.modality)]
    .join(' ')
    .toLowerCase()

  const visionFlag = capabilities?.vision ?? item.supports_vision ?? item.supportsVision ?? item.vision
  const filesFlag = capabilities?.file_input ?? item.supports_files ?? item.supportsFiles

  // 明确给出布尔值优先；否则按声明的输入模态推断；完全没有信息时保持未知
  const vision =
    typeof visionFlag === 'boolean'
      ? visionFlag
      : inputModalities.includes('image') || modalityText.includes('image')
        ? true
        : inputModalities.length > 0
          ? false
          : undefined
  const files =
    typeof filesFlag === 'boolean'
      ? filesFlag
      : inputModalities.length === 0
        ? undefined
        : inputModalities.some((value) => value === 'file' || value === 'pdf' || value === 'document')

  const contextLength = firstPositive(
    item.context_length,
    item.context_window,
    item.contextLength,
    item.max_input_tokens,
    item.maxInputTokens,
    item.inputTokenLimit,
    item.max_context_tokens
  )
  const maxOutput = firstPositive(
    item.max_completion_tokens,
    item.max_output_tokens,
    item.maxOutputTokens,
    item.outputTokenLimit,
    topProvider?.max_completion_tokens,
    topProvider?.max_output_tokens
  )
  // Responses 的内置联网搜索目前只有 OpenAI 模型支持，其他模型会被上游忽略
  const search = /^(gpt-|o[1-9]|chatgpt-)/i.test(id) ? true : undefined
  return { vision, files, search, contextLength, maxOutput }
}

/** 从响应体里取出模型条目：兼容 data[]（OpenAI/Anthropic）与 models[]（Gemini） */
const parseModels = (payload: unknown): ProviderModel[] => {
  const record = asRecord(payload)
  if (!record) {
    return []
  }
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : []
  const models = list.flatMap((entry): ProviderModel[] => {
    const item = asRecord(entry)
    if (!item) {
      return []
    }
    const rawId =
      typeof item.id === 'string' && item.id
        ? item.id
        : typeof item.name === 'string' && item.name
          ? item.name
          : null
    if (!rawId) {
      return []
    }
    const id = rawId.replace(/^models\//, '')
    // Gemini 的 name 是 models/xxx，展示名在 displayName；OpenAI 兼容服务常用 display_name 或 name
    const display =
      typeof item.displayName === 'string' && item.displayName.trim()
        ? item.displayName.trim()
        : typeof item.display_name === 'string' && item.display_name.trim()
          ? item.display_name.trim()
          : typeof item.name === 'string' &&
              item.name.trim() &&
              !item.name.startsWith('models/')
            ? item.name.trim()
            : undefined
    return [{ id, ...(display ? { name: display } : {}), ...readCapabilities(item, id) }]
  })
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false
    }
    seen.add(model.id)
    return true
  })
}

/** 拉取供应商的可用模型与能力；网络或鉴权失败时抛出 ApiError，由调用方翻译展示 */
export const fetchProviderModels = async (
  provider: Provider,
  signal?: AbortSignal
): Promise<ProviderModel[]> => {
  const response = await request(`${baseOf(provider)}/models`, {
    method: 'GET',
    headers: headersOf(provider),
    signal,
  })
  return parseModels(await response.json())
}

/** 编辑表单里以草稿配置探测模型，不必先保存 */
export const fetchDraftModels = async (
  draft: Pick<Provider, 'baseUrl' | 'protocol' | 'apiKey'>,
  signal?: AbortSignal
): Promise<ProviderModel[]> => fetchProviderModels(draft as Provider, signal)
