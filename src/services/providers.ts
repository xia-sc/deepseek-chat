import { create } from 'zustand'
import { useSettings } from './settings.js'

/** 第三方供应商支持的请求协议 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini'

/** 模型目录中的一项；name 仅用于展示，请求只用 id */
export type ProviderModel = { id: string; name?: string }

/** 一个第三方供应商：地址、协议、密钥与模型目录 */
export type Provider = {
  /** 小写字母开头的唯一标识，用于派生存储键与日志 */
  id: string
  /** 显示名称 */
  name: string
  /** API 地址，需包含协议版本前缀（例如 https://gateway.example/v1） */
  baseUrl: string
  protocol: ProviderProtocol
  apiKey: string
  /** 已选模型：进入模型选择器，请求只会用这些模型 */
  models: ProviderModel[]
  /** 从接口获取到的候选模型；仅用于下拉展示，未勾选的不进模型选择器 */
  catalog?: ProviderModel[]
}

/** 官方 DeepSeek 供应商的固定 id：鉴权沿用设置里的 API Key */
export const OFFICIAL_PROVIDER_ID = 'official'

/** 官方供应商固定可用的模型 */
export const OFFICIAL_MODELS: ProviderModel[] = [
  { id: 'deepseek-flash', name: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
]

/** 当前使用的模型：官方或某个第三方供应商的模型 */
export type ActiveModel = { providerId: string; modelId: string }

const PROVIDERS_KEY = 'deepseek-chat:providers'
const ACTIVE_KEY = 'deepseek-chat:active-model'

/** Provider ID 规则：小写字母开头，可含数字、连字符与下划线 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]*$/

const isProtocol = (value: unknown): value is ProviderProtocol =>
  value === 'openai' || value === 'anthropic' || value === 'gemini'

const normalizeModel = (value: unknown): ProviderModel | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, name } = value as Record<string, unknown>
  if (typeof id !== 'string' || !id.trim()) {
    return null
  }
  return typeof name === 'string' && name.trim() ? { id: id.trim(), name: name.trim() } : { id: id.trim() }
}

/** 从存储读入时逐项校验，损坏的条目直接丢弃，不影响其余配置 */
const normalizeProvider = (value: unknown): Provider | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, name, baseUrl, protocol, apiKey, models, catalog } = value as Record<string, unknown>
  if (typeof id !== 'string' || !PROVIDER_ID_PATTERN.test(id) || id === OFFICIAL_PROVIDER_ID) {
    return null
  }
  if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
    return null
  }
  const toModels = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((item) => {
          const model = normalizeModel(item)
          return model ? [model] : []
        })
      : []
  return {
    id,
    name: typeof name === 'string' && name.trim() ? name.trim() : id,
    baseUrl: baseUrl.trim(),
    protocol: isProtocol(protocol) ? protocol : 'openai',
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    models: toModels(models),
    ...(catalog === undefined ? {} : { catalog: toModels(catalog) }),
  }
}

const readProviders = (): Provider[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROVIDERS_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.flatMap((item) => {
      const provider = normalizeProvider(item)
      return provider ? [provider] : []
    }) : []
  } catch {
    return []
  }
}

const readActive = (providers: Provider[]): ActiveModel => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null')
    if (typeof parsed === 'object' && parsed !== null) {
      const { providerId, modelId } = parsed as Record<string, unknown>
      if (typeof providerId === 'string' && typeof modelId === 'string' && modelId.trim()) {
        const known =
          providerId === OFFICIAL_PROVIDER_ID
            ? OFFICIAL_MODELS.some((model) => model.id === modelId)
            : providers.some((provider) => provider.id === providerId)
        if (known) {
          return { providerId, modelId }
        }
      }
    }
  } catch {
    // 损坏的选择回退到官方默认模型
  }
  return { providerId: OFFICIAL_PROVIDER_ID, modelId: OFFICIAL_MODELS[0].id }
}

const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/**
 * 本地存储是否可写：无痕窗口、禁用站点数据或 file:// 下受限时会失败，
 * 此时配置只存在内存里，刷新即丢失，界面需要明确提示。
 */
export const isStorageAvailable = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return false
  }
  const probe = 'deepseek-chat:storage-probe'
  try {
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

type ProvidersState = {
  providers: Provider[]
  active: ActiveModel
}

const initialProviders = readProviders()

export const useProviders = create<ProvidersState>(() => ({
  providers: initialProviders,
  active: readActive(initialProviders),
}))

const commit = (providers: Provider[]) => {
  write(PROVIDERS_KEY, providers)
  useProviders.setState({ providers })
}

export const getProvider = (id: string) =>
  useProviders.getState().providers.find((provider) => provider.id === id)

/** 新增或覆盖同名供应商；被覆盖的供应商已不再承载当前模型时回退到官方默认 */
export const saveProvider = (provider: Provider) => {
  const { providers } = useProviders.getState()
  const exists = providers.some((item) => item.id === provider.id)
  commit(exists ? providers.map((item) => (item.id === provider.id ? provider : item)) : [...providers, provider])
  const { active } = useProviders.getState()
  if (active.providerId === provider.id && !provider.models.some((model) => model.id === active.modelId)) {
    setActiveModel({ providerId: OFFICIAL_PROVIDER_ID, modelId: OFFICIAL_MODELS[0].id })
  }
}

/** 删除供应商；正在使用的模型回退到官方默认 */
export const removeProvider = (id: string) => {
  commit(useProviders.getState().providers.filter((provider) => provider.id !== id))
  if (useProviders.getState().active.providerId === id) {
    setActiveModel({ providerId: OFFICIAL_PROVIDER_ID, modelId: OFFICIAL_MODELS[0].id })
  }
}

export const setActiveModel = (active: ActiveModel) => {
  write(ACTIVE_KEY, active)
  useProviders.setState({ active })
}

/** 当前生效的供应商，官方时返回 null */
export const useActiveProvider = () =>
  useProviders((state) =>
    state.active.providerId === OFFICIAL_PROVIDER_ID
      ? null
      : (state.providers.find((provider) => provider.id === state.active.providerId) ?? null)
  )

/** 请求用：官方返回固定协议，第三方返回自身配置；供应商已被删除时回退官方 */
export const resolveActiveTarget = (): { provider: Provider | null; modelId: string } => {
  const { active, providers } = useProviders.getState()
  if (active.providerId === OFFICIAL_PROVIDER_ID) {
    return { provider: null, modelId: active.modelId }
  }
  const provider = providers.find((item) => item.id === active.providerId)
  return provider
    ? { provider, modelId: active.modelId }
    : { provider: null, modelId: OFFICIAL_MODELS[0].id }
}

/** 官方供应商沿用设置里的 API Key；第三方使用自身密钥 */
export const getActiveApiKey = (provider: Provider | null): string =>
  provider ? provider.apiKey : (useSettings.getState().apiKey ?? '')

/** 当前模型在界面上的展示名 */
export const getActiveModelLabel = ({ provider, modelId }: { provider: Provider | null; modelId: string }) => {
  const models = provider ? provider.models : OFFICIAL_MODELS
  const found = models.find((model) => model.id === modelId)
  return found?.name ?? modelId
}
