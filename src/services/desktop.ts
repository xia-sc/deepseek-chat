/** 桌面外壳（Electron）通过 preload 暴露的能力；浏览器里不存在 */
export type DesktopBridge = {
  /** 读取用户数据目录下的 config.json；不存在时返回 null */
  readConfig: () => Promise<unknown>
  /** 覆盖写入 config.json，返回最终文件路径 */
  writeConfig: (data: unknown) => Promise<string>
  /** config.json 的完整路径 */
  configPath: () => Promise<string>
  /** 在资源管理器中定位 config.json */
  revealConfig: () => Promise<void>
}

/** 运行在桌面外壳里时返回桥接对象，浏览器里返回 null */
export const getDesktopBridge = (): DesktopBridge | null => {
  if (typeof window === 'undefined') {
    return null
  }
  const bridge = (window as unknown as { desktop?: DesktopBridge }).desktop
  return bridge && typeof bridge.readConfig === 'function' ? bridge : null
}
