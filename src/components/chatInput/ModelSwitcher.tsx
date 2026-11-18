import clsx from 'clsx'
import { memo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from '../base/anchored.js'
import { IconCheckOutline16, IconChevronDownOutline14 } from '../base/icons.js'
import {
  OFFICIAL_MODELS,
  OFFICIAL_PROVIDER_ID,
  setActiveModel,
  useProviders,
} from '../../services/providers.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ModelSwitcher.module.css'

/**
 * 输入框底部的模型切换下拉：按供应商分组列出已选模型，点选即生效。
 * 与设置页的模型选择器共用同一份 providers 状态，切换后请求与附件能力立即跟着变。
 */
export const ModelSwitcher = memo(function ModelSwitcher() {
  const t = useTranslate()
  const providers = useProviders((state) => state.providers)
  const active = useProviders((state) => state.active)
  const [open, setOpen] = useState(false)
  const { anchorRef, floatingRef, position } = useAnchoredPosition<
    HTMLButtonElement,
    HTMLDivElement
  >(open, { align: 'end', maxHeight: 340, minSpace: 220, offset: 6 })
  useDismiss(open, [anchorRef, floatingRef], () => setOpen(false), { captureEscape: true })

  // 官方在前，第三方按配置顺序；没有已选模型的供应商不出现在列表里
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

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={clsx(styles.trigger, open && styles.open)}
        aria-label={t('modelSwitcherLabel')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.label}>
          {current ? (current.model.name ?? current.model.id) : t('settingsActiveModelEmpty')}
        </span>
        <span className={styles.arrow}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              style={position ?? undefined}
              role="listbox"
              aria-label={t('modelSwitcherLabel')}
            >
              {groups.map((group) => (
                <div key={group.id}>
                  <div className={styles.groupTitle}>{group.name}</div>
                  {group.models.map((model) => {
                    const isActive = group.id === active.providerId && model.id === active.modelId
                    return (
                      <div
                        key={model.id}
                        role="option"
                        aria-selected={isActive}
                        className={clsx(styles.option, isActive && styles.selected)}
                        onClick={() => {
                          setActiveModel({ providerId: group.id, modelId: model.id })
                          setOpen(false)
                        }}
                      >
                        <span className={styles.optionLabel}>{model.name ?? model.id}</span>
                        {isActive ? <IconCheckOutline16 /> : null}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
})
