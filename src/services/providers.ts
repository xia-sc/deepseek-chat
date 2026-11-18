import { create } from 'zustand'
import { getDesktopBridge } from './desktop.js'
import { useSettings } from './settings.js'

/** 第三方供应商支持的请求协议 */
export type ProviderProtocol = 'openai' | 'anthropic' | 'gemini' | 'responses'

/** 模型目录中的一项；name 仅用于展示，请求只用 id */
export type ProviderModel = {
  id: string
  name?: string
  /** 是否接受图片输入；未设置表示未知，可用接口返回自动填充或手动配置 */
  vision?: boolean
  /** 是否接受非图片文件（PDF、文档等）输入；未设置表示未知 */
  files?: boolean
  /** 是否支持 Responses 的内置联网搜索（web_search）；未设置表示未知 */
  search?: boolean
  /** 上下文窗口 token 数；未设置表示未知 */
  contextLength?: number
  /** 单次回复最大输出 token 数；未设置表示未知 */
  maxOutput?: number
}

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
  /**
   * 应用侧联网搜索接口（可选）：打开智能搜索时先调用它检索，
   * 再把结果注入请求上下文，因此不依赖模型自身是否支持内置 web_search。
   */
  searchEndpoint?: string
  /**
   * DeepSeek 官方 API Key（可选）：供应商没有自己的搜索接口时，
   * 用这个 Key 调 DeepSeek 的 server tool 做联网搜索；留空则回退到全局 API Key。
   */
  deepseekSearchKey?: string
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
  value === 'openai' || value === 'anthropic' || value === 'gemini' || value === 'responses'

const normalizeModel = (value: unknown): ProviderModel | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, name, vision, files, search, contextLength, maxOutput } = value as Record<
    string,
    unknown
  >
  if (typeof id !== 'string' || !id.trim()) {
    return null
  }
  const asBoolean = (input: unknown) => (typeof input === 'boolean' ? input : undefined)
  const asPositive = (input: unknown) =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? Math.round(input) : undefined
  return {
    id: id.trim(),
    ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}),
    ...(asBoolean(vision) === undefined ? {} : { vision: asBoolean(vision) }),
    ...(asBoolean(files) === undefined ? {} : { files: asBoolean(files) }),
    ...(asBoolean(search) === undefined ? {} : { search: asBoolean(search) }),
    ...(asPositive(contextLength) === undefined ? {} : { contextLength: asPositive(contextLength) }),
    ...(asPositive(maxOutput) === undefined ? {} : { maxOutput: asPositive(maxOutput) }),
  }
}

/** 从存储读入时逐项校验，损坏的条目直接丢弃，不影响其余配置 */
const normalizeProvider = (value: unknown): Provider | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, name, baseUrl, protocol, apiKey, searchEndpoint, deepseekSearchKey, models, catalog } =
    value as Record<string, unknown>
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
  const searchUrl = typeof searchEndpoint === 'string' ? searchEndpoint.trim() : ''
  const deepseekKey = typeof deepseekSearchKey === 'string' ? deepseekSearchKey.trim() : ''
  return {
    id,
    name: typeof name === 'string' && name.trim() ? name.trim() : id,
    baseUrl: baseUrl.trim(),
    protocol: isProtocol(protocol) ? protocol : 'openai',
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    ...(/^https?:\/\//.test(searchUrl) ? { searchEndpoint: searchUrl } : {}),
    ...(deepseekKey ? { deepseekSearchKey: deepseekKey } : {}),
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

const DEFAULT_ACTIVE: ActiveModel = {
  providerId: OFFICIAL_PROVIDER_ID,
  modelId: OFFICIAL_MODELS[0].id,
}

/** 校验一个「当前模型」取值：官方要求模型在固定清单里，第三方只要求供应商存在 */
const normalizeActive = (value: unknown, providers: Provider[]): ActiveModel | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { providerId, modelId } = value as Record<string, unknown>
  if (typeof providerId !== 'string' || typeof modelId !== 'string' || !modelId.trim()) {
    return null
  }
  const known =
    providerId === OFFICIAL_PROVIDER_ID
      ? OFFICIAL_MODELS.some((model) => model.id === modelId)
      : providers.some((provider) => provider.id === providerId)
  return known ? { providerId, modelId } : null
}

const readActive = (providers: Provider[]): ActiveModel => {
  try {
    return (
      normalizeActive(JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null'), providers) ??
      DEFAULT_ACTIVE
    )
  } catch {
    // 损坏的选择回退到官方默认模型
    return DEFAULT_ACTIVE
  }
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

/**
 * 桌面模式下把配置写到用户数据目录的 config.json；
 * 浏览器里没有桥，只使用 localStorage。
 */
const persistToDesktop = () => {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return
  }
  const { providers, active } = useProviders.getState()
  void bridge.writeConfig({ providers, active }).catch(() => {
    // 写文件失败时 localStorage 仍是有效缓存，界面上的提示由存储检测负责
  })
}

const commit = (providers: Provider[]) => {
  write(PROVIDERS_KEY, providers)
  useProviders.setState({ providers })
  persistToDesktop()
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
  persistToDesktop()
}

/**
 * 启动时在桌面外壳里从 config.json 恢复配置，并回填 localStorage 缓存。
 * 文件不存在或已损坏时保留缓存；浏览器里立即返回。
 */
export const hydrateProviders = async (): Promise<void> => {
  const bridge = getDesktopBridge()
  if (!bridge) {
    return
  }
  try {
    const raw = await bridge.readConfig()
    if (!raw || typeof raw !== 'object') {
      return
    }
    const { providers, active } = raw as { providers?: unknown; active?: unknown }
    const list = Array.isArray(providers)
      ? providers.flatMap((item) => {
          const provider = normalizeProvider(item)
          return provider ? [provider] : []
        })
      : []
    if (list.length === 0) {
      return
    }
    const nextActive = normalizeActive(active, list) ?? DEFAULT_ACTIVE
    useProviders.setState({ providers: list, active: nextActive })
    write(PROVIDERS_KEY, list)
    write(ACTIVE_KEY, nextActive)
  } catch {
    // 配置文件损坏时沿用 localStorage 缓存
  }
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
