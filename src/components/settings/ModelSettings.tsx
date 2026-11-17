import clsx from 'clsx'
import { useState } from 'react'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { IconEditOutline16, IconRefreshOutline16, IconTrashOutline16 } from '../base/icons.js'
import { Modal } from '../base/Modal.js'
import { Select } from '../base/Select.js'
import { showToast } from '../base/toastState.js'
import { useTranslate } from '../../i18n/index.js'
import { fetchDraftModels } from '../../services/api/providerModels.js'
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROVIDER_ID,
  PROVIDER_ID_PATTERN,
  removeProvider,
  saveProvider,
  setActiveModel,
  useProviders,
  type Provider,
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

/** 当前模型用 providerId + modelId 编码成下拉值，避免模型 id 里出现分隔符时冲突 */
const encode = (providerId: string, modelId: string) => JSON.stringify([providerId, modelId])

const decode = (value: string): { providerId: string; modelId: string } | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { providerId: parsed[0], modelId: parsed[1] }
    }
  } catch {
    // 非法值按未选择处理
  }
  return null
}

/**
 * 设置 → 模型：选择当前使用的模型，并管理第三方供应商
 * （地址、协议、密钥与模型目录）。官方 DeepSeek 为内置项，不可删除。
 */
export const ModelSettings = () => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const active = useProviders((state) => state.active)
  // undefined：未打开表单；null：新建；Provider：编辑
  const [editing, setEditing] = useState<Provider | null | undefined>(undefined)

  const modelOptions = [
    ...OFFICIAL_MODELS.map((model) => ({
      value: encode(OFFICIAL_PROVIDER_ID, model.id),
      label: `${t('providerOfficialName')} · ${model.name ?? model.id}`,
    })),
    ...providers.flatMap((provider) =>
      provider.models.map((model) => ({
        value: encode(provider.id, model.id),
        label: `${provider.name} · ${model.name ?? model.id}`,
      }))
    ),
  ]

  return (
    <>
      <div className={clsx(styles.cell, styles.row)}>
        <div className={styles.text}>
          <div className={styles.label}>{t('settingsActiveModel')}</div>
          <div className={styles.description}>{t('settingsActiveModelDescription')}</div>
        </div>
        <Select
          ariaLabel={t('settingsActiveModel')}
          className={styles.modelSelect}
          value={encode(active.providerId, active.modelId)}
          options={modelOptions}
          placeholder={t('settingsActiveModelEmpty')}
          onChange={(value) => {
            const next = decode(value)
            if (next) {
              setActiveModel(next)
            }
          }}
        />
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
 * 新增 / 编辑供应商：校验标识与地址，模型目录可手动添加，
 * 也可按当前填写的地址、协议与密钥调用 GET /models 拉取。
 */
const ProviderForm = ({ initial, onClose }: { initial: Provider | null; onClose: () => void }) => {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const [draft, setDraft] = useState<Provider>(() => initial ?? emptyProvider())
  const [modelInput, setModelInput] = useState('')
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

  const addModel = (id: string) => {
    const value = id.trim()
    if (!value) {
      return
    }
    setDraft((current) =>
      current.models.some((model) => model.id === value)
        ? current
        : { ...current, models: [...current.models, { id: value }] }
    )
    setModelInput('')
  }

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
      setDraft((current) => ({
        ...current,
        models: [
          ...current.models,
          ...ids
            .filter((id) => !current.models.some((model) => model.id === id))
            .map((id) => ({ id })),
        ],
      }))
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
        {draft.models.length > 0 ? (
          <div className={styles.modelList}>
            {draft.models.map((model) => (
              <span key={model.id} className={styles.modelChip}>
                {model.id}
                <button
                  type="button"
                  className={styles.modelRemove}
                  aria-label={t('providerModelRemove')}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      models: current.models.filter((item) => item.id !== model.id),
                    }))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div className={styles.modelAdd}>
          <input
            className={styles.providerInput}
            value={modelInput}
            placeholder={t('providerModelPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setModelInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                addModel(modelInput)
              }
            }}
          />
          <Button variant="outlined" size="m" onClick={() => addModel(modelInput)}>
            {t('providerModelAdd')}
          </Button>
        </div>
        {fetchError ? (
          <div className={styles.error}>{fetchError}</div>
        ) : (
          <div className={styles.description}>{t('providerModelsHint')}</div>
        )}
      </div>
    </Modal>
  )
}
