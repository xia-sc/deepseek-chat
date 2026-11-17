import { create } from 'zustand'
import { resolveActiveTarget } from '../../services/providers.js'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用设置 / 模型 / 数据管理 */
export type SettingsSection = 'general' | 'model' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 没有可用密钥时打开设置：官方去「数据管理」，第三方去「模型」，返回是否已具备密钥 */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  const { provider } = resolveActiveTarget()
  if (provider?.apiKey) {
    return true
  }
  openSettings(provider ? 'model' : 'data')
  return false
}
