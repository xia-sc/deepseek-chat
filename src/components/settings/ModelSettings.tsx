import clsx from 'clsx'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconEditOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { fetchDraftModels } from '../../services/api/providerModels.js'
import {
  isStorageAvailable,
  OFFICIAL_MODELS,
  OFFICIAL_PROVIDER_ID,
  PROVIDER_ID_PATTERN,
  removeProvider,
  saveProvider,
  setActiveModel,
  useProviders,
  type Provider,
  type ProviderModel,
  type ProviderProtocol,
} from '../../services/providers.js'
import styles from './Settings.module.css'

/** 协议在界面上的名称；Gemini 走 generateContent，OpenAI/Anthropic 为各自的 Messages 风格 */
const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: 'OpenAI Chat Completions',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
}

const PROTOCOLS: ProviderProtocol[] = ['openai', 'anthropic', 'gemini']

/**
 * 设置 → 模型：选择当前使用的模型，并管理第三方供应商
 * （地址、协议、密钥与模型目录）。官方 DeepSeek 为内置项，不可删除。
 */
export const ModelSettings = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  // undefined：未打开表单；null：新建；Provider：编辑
  const [editing, setEditing] = useState<Provider | null | undefined>(undefined)
  // 挂载时探测一次本地存储；不可用时明确告知，避免刷新后配置静默丢失
  const [storageAvailable] = useState(isStorageAvailable)

  return (
    <>
      {storageAvailable ? null : (
        <div className={styles.storageWarning} role="alert">
          {t('storageUnavailable')}
        </div>
      )}
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsActiveModel')}</div>
          <div className={styles.description}>{t('settingsActiveModelDescription')}</div>
        </div>
        <ModelPicker />
      </div>

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('providerOfficialName')}</div>
          <div className={styles.description}>{t('providerOfficialDescription')}</div>
        </div>
        <span className={styles.providerTag}>{OFFICIAL_PROVIDER_ID}</span>
      </div>

      {providers.map((provider) => (
        <div key={provider.id} className={clsx(styles.cell, styles.row)}>
          <div className={styles.text}>
            <div className={styles.label}>{provider.name}</div>
            <div className={styles.description}>
              {provider.id} · {PROTOCOL_LABELS[provider.protocol]} · {provider.baseUrl} ·{' '}
              {t('providerModelCount', { count: provider.models.length })}
            </div>
          </div>
          <div className={styles.providerActions}>
            <IconButton
              icon={<IconEditOutline16 />}
              tooltip={t('providerEdit')}
              onClick={() => setEditing(provider)}
            />
            <IconButton
              icon={<IconTrashOutline16 />}
              tooltip={t('providerDelete')}
              onClick={() => {
                removeProvider(provider.id)
                showToast({ key: 'providerDeleted' })
              }}
            />
          </div>
        </div>
      ))}

      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('providerAdd')}</div>
          <div className={styles.description}>{t('providerAddDescription')}</div>
        </div>
        <Button variant="outlined" size="m" className={styles.cellButton} onClick={() => setEditing(null)}>
          {t('providerAdd')}
        </Button>
      </div>

      {editing !== undefined ? (
        <ProviderForm initial={editing} onClose={() => setEditing(undefined)} />
      ) : null}
    </>
  )
}

/** 当前模型：按供应商分组的单选下拉，带搜索，点选即生效 */
const ModelPicker = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const active = useProviders((state) => state.active)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [triggerWidth, setTriggerWidth] = useState<number>()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { maxHeight: 380, minSpace: 300 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  // 官方在前，第三方按配置顺序；没有模型的供应商不出现
  const groups = [
    { id: OFFICIAL_PROVIDER_ID, name: t('providerOfficialName'), models: OFFICIAL_MODELS },
    ...providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: provider.models,
    })),
  ].filter((group) => group.models.length > 0)

  const current = groups
    .flatMap((group) => group.models.map((model) => ({ model, group })))
    .find(({ model, group }) => group.id === active.providerId && model.id === active.modelId)

  const keyword = query.trim().toLowerCase()
  const filtered = groups
    .map((group) => ({
      ...group,
      models: keyword
        ? group.models.filter(
            (model) =>
              model.id.toLowerCase().includes(keyword) ||
              (model.name ?? '').toLowerCase().includes(keyword) ||
              group.name.toLowerCase().includes(keyword)
          )
        : group.models,
    }))
    .filter((group) => group.models.length > 0)

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.catalogTrigger, styles.modelPicker, open && styles.catalogTriggerOpen)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open && anchorRef.current) {
            setTriggerWidth(anchorRef.current.getBoundingClientRect().width)
          }
          setOpen((value) => !value)
        }}
      >
        <span className={clsx(styles.catalogSummary, !current && styles.catalogPlaceholder)}>
          {current ? `${current.group.name} · ${current.model.name ?? current.model.id}` : t('settingsActiveModelEmpty')}
        </span>
        <span className={styles.catalogArrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.catalogMenu}
              style={{ ...position, ...(triggerWidth ? { width: triggerWidth } : {}) }}
            >
              <input
                className={styles.catalogSearch}
                value={query}
                placeholder={t('settingsActiveModelSearch')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div role="listbox" className={styles.catalogList}>
                {filtered.map((group) => (
                  <div key={group.id}>
                    <div className={styles.catalogGroupTitle}>{group.name}</div>
                    {group.models.map((model) => {
                      const isActive = group.id === active.providerId && model.id === active.modelId
                      return (
                        <div
                          key={model.id}
                          role="option"
                          aria-selected={isActive}
                          className={clsx(
                            styles.catalogOption,
                            isActive && styles.catalogOptionSelected
                          )}
                          onClick={() => {
                            setActiveModel({ providerId: group.id, modelId: model.id })
                            setQuery('')
                            setOpen(false)
                          }}
                        >
                          <span className={styles.catalogOptionLabel}>{model.name ?? model.id}</span>
                        </div>
                      )
                    })}
                  </div>
                ))}
                {filtered.length === 0 ? (
                  <div className={styles.catalogEmpty}>{t('providerModelNoMatch')}</div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

const PROTOCOL_OPTIONS = PROTOCOLS.map((protocol) => ({
  value: protocol,
  label: PROTOCOL_LABELS[protocol],
}))

const emptyProvider = (): Provider => ({
  id: '',
  name: '',
  baseUrl: '',
  protocol: 'openai',
  apiKey: '',
  models: [],
})

/** 字段容器：标签在上，提示或错误在下 */
const Field = ({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) => (
  <div className={styles.field}>
    <div className={styles.fieldLabel}>{label}</div>
    {children}
    {error ? (
      <div className={styles.error}>{error}</div>
    ) : hint ? (
      <div className={styles.description}>{hint}</div>
    ) : null}
  </div>
)

/**
 * 模型目录下拉：触发器只显示已选摘要，展开后可在列表里勾选或取消，
 * 也可以在搜索框里直接输入模型 ID 回车加入；模型较多时用搜索过滤。
 */
const ModelCatalog = ({
  models,
  catalog,
  onChange,
}: {
  models: ProviderModel[]
  catalog?: ProviderModel[]
  onChange: (models: ProviderModel[]) => void
}) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 浮层宽度跟随触发器，打开时测量一次；后续尺寸变化由 useAnchoredPosition 处理位置
  const [triggerWidth, setTriggerWidth] = useState<number>()
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { maxHeight: 380, minSpace: 300 })
  // Esc 只收起下拉，不让外层表单一起关闭
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  const selected = new Set(models.map((model) => model.id))
  // 候选 = 接口获取到的 + 手动加入或已选但不在候选里的，避免勾选后从列表消失
  const candidates = [...(catalog ?? [])]
  for (const model of models) {
    if (!candidates.some((item) => item.id === model.id)) {
      candidates.push(model)
    }
  }
  // 已选的置顶，打开列表就能看到当前勾选了哪些
  const ordered = [
    ...candidates.filter((model) => selected.has(model.id)),
    ...candidates.filter((model) => !selected.has(model.id)),
  ]
  const keyword = query.trim().toLowerCase()
  const visible = keyword
    ? ordered.filter((model) => model.id.toLowerCase().includes(keyword))
    : ordered

  const toggle = (id: string) => {
    onChange(
      selected.has(id)
        ? models.filter((model) => model.id !== id)
        : [...models, { id }]
    )
  }

  /** 搜索框回车：已存在则切换，不存在则直接加入目录 */
  const submit = () => {
    const id = query.trim()
    if (!id) {
      return
    }
    if (selected.has(id)) {
      toggle(id)
    } else {
      onChange([...models, { id }])
    }
    setQuery('')
  }

  const summary =
    models.length === 0
      ? t('providerCatalogEmpty')
      : models.length <= 2
        ? models.map((model) => model.id).join('、')
        : `${models
            .slice(0, 2)
            .map((model) => model.id)
            .join('、')} ${t('providerCatalogMore', { count: models.length - 2 })}`

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.catalogTrigger, open && styles.catalogTriggerOpen)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open && anchorRef.current) {
            setTriggerWidth(anchorRef.current.getBoundingClientRect().width)
          }
          setOpen((value) => !value)
        }}
      >
        <span
          className={clsx(styles.catalogSummary, models.length === 0 && styles.catalogPlaceholder)}
        >
          {summary}
        </span>
        <span className={styles.catalogArrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.catalogMenu}
              style={{ ...position, ...(triggerWidth ? { width: triggerWidth } : {}) }}
            >
              <input
                className={styles.catalogSearch}
                value={query}
                placeholder={t('providerModelSearch')}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    submit()
                  }
                }}
              />
              <div role="listbox" aria-multiselectable="true" className={styles.catalogList}>
                {visible.map((model) => {
                  const isSelected = selected.has(model.id)
                  return (
                    <div
                      key={model.id}
                      role="option"
                      aria-selected={isSelected}
                      className={clsx(
                        styles.catalogOption,
                        isSelected && styles.catalogOptionSelected
                      )}
                      onClick={() => toggle(model.id)}
                    >
                      <span
                        className={clsx(
                          styles.catalogCheckbox,
                          isSelected && styles.catalogCheckboxChecked
                        )}
                      >
                        {isSelected ? <IconCheckOutline16 /> : null}
                      </span>
                      <span className={styles.catalogOptionLabel}>{model.id}</span>
                    </div>
                  )
                })}
                {visible.length === 0 ? (
                  <div className={styles.catalogEmpty}>
                    {candidates.length === 0
                      ? t('providerCatalogEmptyHint')
                      : t('providerModelNoMatch')}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * 新增 / 编辑供应商：校验标识与地址，模型目录可手动添加，
 * 也可按当前填写的地址、协议与密钥调用 GET /models 拉取。
 */
const ProviderForm = ({ initial, onClose }: { initial: Provider | null; onClose: () => void }) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const [draft, setDraft] = useState<Provider>(() => initial ?? emptyProvider())
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const isNew = initial === null

  const update = <K extends keyof Provider>(key: K, value: Provider[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))

  const idError = (() => {
    const id = draft.id.trim()
    if (!id) {
      return submitted ? t('providerIdRequired') : undefined
    }
    if (!PROVIDER_ID_PATTERN.test(id)) {
      return t('providerIdInvalid')
    }
    if (id === OFFICIAL_PROVIDER_ID) {
      return t('providerIdReserved')
    }
    if (providers.some((provider) => provider.id === id && provider.id !== initial?.id)) {
      return t('providerIdDuplicated')
    }
    return undefined
  })()

  const baseUrlError =
    submitted && !/^https?:\/\//.test(draft.baseUrl.trim()) ? t('providerBaseUrlInvalid') : undefined

  const fetchModels = async () => {
    if (!draft.baseUrl.trim()) {
      setFetchError(t('providerBaseUrlRequired'))
      return
    }
    setFetching(true)
    setFetchError(null)
    try {
      const ids = await fetchDraftModels({
        baseUrl: draft.baseUrl.trim(),
        protocol: draft.protocol,
        apiKey: draft.apiKey.trim(),
      })
      if (ids.length === 0) {
        setFetchError(t('providerModelsEmpty'))
        return
      }
      // 获取到的只是候选，勾选后才进入模型选择器
      setDraft((current) => {
        const existing = current.catalog ?? []
        return {
          ...current,
          catalog: [
            ...existing,
            ...ids
              .filter((id) => !existing.some((model) => model.id === id))
              .map((id) => ({ id })),
          ],
        }
      })
      showToast({ key: 'providerModelsFetched', params: { count: ids.length } })
    } catch (error) {
      setFetchError(
        t('providerModelsFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setFetching(false)
    }
  }

  const submit = () => {
    setSubmitted(true)
    const id = draft.id.trim()
    if (
      !id ||
      !PROVIDER_ID_PATTERN.test(id) ||
      id === OFFICIAL_PROVIDER_ID ||
      providers.some((provider) => provider.id === id && provider.id !== initial?.id) ||
      !/^https?:\/\//.test(draft.baseUrl.trim())
    ) {
      return
    }
    saveProvider({
      ...draft,
      id,
      name: draft.name.trim() || id,
      baseUrl: draft.baseUrl.trim(),
      apiKey: draft.apiKey.trim(),
      models: draft.models.filter((model) => model.id.trim()),
    })
    showToast({ key: 'providerSaved' })
    onClose()
  }

  return (
    <Modal
      title={isNew ? t('providerAdd') : t('providerEdit')}
      className={styles.providerDialog}
      mainClassName={styles.providerDialogMain}
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" size="m" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button size="m" onClick={submit}>
            {t('confirm')}
          </Button>
        </>
      }
    >
      <p className={styles.description}>{t('providerFormDescription')}</p>

      <Field label={t('providerId')} hint={t('providerIdHint')} error={idError}>
        <input
          className={styles.providerInput}
          value={draft.id}
          placeholder="acme-gateway"
          autoComplete="off"
          spellCheck={false}
          disabled={!isNew}
          onChange={(event) => update('id', event.target.value)}
        />
      </Field>

      <Field label={t('providerName')}>
        <input
          className={styles.providerInput}
          value={draft.name}
          placeholder={t('providerNamePlaceholder')}
          onChange={(event) => update('name', event.target.value)}
        />
      </Field>

      <Field label={t('providerBaseUrl')} error={baseUrlError}>
        <input
          className={styles.providerInput}
          value={draft.baseUrl}
          placeholder="https://gateway.example/v1"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => update('baseUrl', event.target.value)}
        />
      </Field>

      <Field label={t('providerProtocol')}>
        <Select
          ariaLabel={t('providerProtocol')}
          value={draft.protocol}
          options={PROTOCOL_OPTIONS}
          onChange={(value) => update('protocol', value)}
        />
      </Field>

      <Field label={t('providerApiKey')}>
        <input
          className={styles.providerInput}
          type="password"
          value={draft.apiKey}
          placeholder={t('providerApiKeyPlaceholder')}
          autoComplete="off"
          onChange={(event) => update('apiKey', event.target.value)}
        />
      </Field>

      <div className={styles.field}>
        <div className={styles.fieldHeader}>
          <div className={styles.fieldLabel}>{t('providerModels')}</div>
          <button
            type="button"
            className={styles.fetchModels}
            disabled={fetching}
            onClick={() => void fetchModels()}
          >
            <IconRefreshOutline16 />
            {fetching ? t('providerModelsFetching') : t('providerModelsFetch')}
          </button>
        </div>
        <ModelCatalog
          models={draft.models}
          catalog={draft.catalog}
          onChange={(models) => update('models', models)}
        />
        {fetchError ? (
          <div className={styles.error}>{fetchError}</div>
        ) : (
          <div className={styles.description}>{t('providerModelsHint')}</div>
        )}
      </div>
    </Modal>
  )
}
