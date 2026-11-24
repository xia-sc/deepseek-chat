import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { closeImagePreview, useImagePreview } from '../../services/imagePreview.js'
import { IconCloseOutline16 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import styles from './ImagePreview.module.css'

/** 图片大图预览：点遮罩、关闭按钮或按 Esc 退出 */
export const ImagePreview = () => {
  const t = useTranslate()
  const preview = useImagePreview((state) => state.preview)

  useEffect(() => {
    if (!preview) {
      return
    }
    // 捕获阶段拦下 Esc，避免下层弹窗跟着一起关闭
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return
      }
      event.stopPropagation()
      closeImagePreview()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [preview])

  if (!preview) {
    return null
  }

  return createPortal(
    <div className={styles.overlay} onMouseDown={closeImagePreview}>
      <img
        className={styles.image}
        src={preview.url}
        alt={preview.name}
        onMouseDown={(event) => event.stopPropagation()}
      />
      <IconButton
        className={styles.close}
        size="xl"
        tooltip={t('close')}
        icon={<IconCloseOutline16 />}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={closeImagePreview}
      />
    </div>,
    document.body
  )
}
