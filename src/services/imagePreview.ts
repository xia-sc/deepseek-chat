import { create } from 'zustand'

type ImagePreviewState = {
  /**
   * 预览图使用自己的对象 URL：附件视图卸载时会 revoke 它自己的 URL，
   * 打开预览后立刻发送消息、清空草稿也不应该让预览图变成裂图。
   */
  preview: { url: string; name: string; owned: boolean } | null
}

const store = create<ImagePreviewState>(() => ({ preview: null }))

/** 最近一次打开请求的标记：快速连点时只保留最后一次的结果 */
let pending: object | null = null

export const openImagePreview = (url: string, name: string) => {
  closeImagePreview()
  const token = {}
  pending = token
  const show = (previewUrl: string, owned: boolean) => {
    if (pending !== token) {
      if (owned) {
        URL.revokeObjectURL(previewUrl)
      }
      return
    }
    store.setState({ preview: { url: previewUrl, name, owned } })
  }
  // 复制一份独立数据，避免预览依赖附件视图的对象 URL 生命周期
  fetch(url)
    .then((response) => response.blob())
    .then((blob) => show(URL.createObjectURL(blob), true))
    .catch(() => {
      // 复制失败时退回原地址；该地址归附件视图所有，不在这里 revoke
      if (pending === token) {
        show(url, false)
      }
    })
}

export const closeImagePreview = () => {
  pending = null
  const { preview } = store.getState()
  if (!preview) {
    return
  }
  if (preview.owned) {
    URL.revokeObjectURL(preview.url)
  }
  store.setState({ preview: null })
}

export { store as useImagePreview }
