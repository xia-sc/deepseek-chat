/**
 * 主进程启动自检：用 mock 的 electron 模块加载 electron/main.cjs，
 * 验证便携数据目录、IPC 注册、静态服务与窗口创建都不会在启动阶段抛错。
 * 用法：node tmp/check-main.cjs
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const Module = require('node:module')

const probeRoot = path.join(os.tmpdir(), `ds-chat-probe-${Date.now()}`)
fs.mkdirSync(probeRoot, { recursive: true })
process.env.PORTABLE_EXECUTABLE_DIR = probeRoot

const state = {
  paths: { appData: path.join(probeRoot, 'appdata'), temp: os.tmpdir() },
  setPathCalls: [],
  windowOptions: null,
  loadedUrl: null,
  quit: false,
  handlers: [],
}

const fakeApp = {
  isPackaged: true,
  setName: (name) => {
    state.appName = name
  },
  getPath: (key) => state.paths[key] ?? path.join(probeRoot, key),
  // 真实的 Electron 在目录不存在时会抛错，这里刻意复现该行为
  setPath: (key, value) => {
    if (key === 'sessionData' && !fs.existsSync(value)) {
      throw new Error(`ENOENT: sessionData directory missing: ${value}`)
    }
    state.setPathCalls.push([key, value])
    state.paths[key] = value
  },
  requestSingleInstanceLock: () => true,
  on: () => {},
  quit: () => {
    state.quit = true
  },
  whenReady: () => Promise.resolve(),
}

class FakeBrowserWindow {
  constructor(options) {
    state.windowOptions = options
    this.webContents = {
      setWindowOpenHandler: () => {},
      on: () => {},
      toggleDevTools: () => {},
    }
  }
  loadURL(url) {
    state.loadedUrl = url
  }
  on() {}
  isMinimized() {
    return false
  }
  restore() {}
  focus() {}
  static getAllWindows() {
    return []
  }
}

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  Menu: { setApplicationMenu: () => {} },
  dialog: { showErrorBox: (title, message) => console.log('DIALOG', title, message) },
  ipcMain: { handle: (channel) => state.handlers.push(channel) },
  shell: { openExternal: () => {}, showItemInFolder: () => {} },
}

const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return fakeElectron
  }
  return originalLoad.call(this, request, ...rest)
}

process.on('uncaughtException', (error) => {
  console.log('UNCAUGHT:', error.message)
  process.exit(1)
})

require(path.resolve(__dirname, '..', 'electron', 'main.cjs'))

setTimeout(() => {
  const dataDir = path.join(probeRoot, 'data')
  const sessionDir = path.join(dataDir, 'session')
  console.log('app name          :', state.appName)
  console.log('data dir exists   :', fs.existsSync(dataDir))
  console.log('session dir exists:', fs.existsSync(sessionDir))
  console.log('setPath calls     :', JSON.stringify(state.setPathCalls))
  console.log('ipc handlers      :', state.handlers.join(', '))
  console.log('window icon       :', state.windowOptions?.icon)
  console.log('loaded url        :', state.loadedUrl)
  console.log('quit early        :', state.quit)

  fetch(state.loadedUrl)
    .then(async (response) => {
      const html = await response.text()
      console.log('http status       :', response.status)
      console.log('html has root     :', html.includes('id="root"'))
      process.exit(0)
    })
    .catch((error) => {
      console.log('HTTP FAILED:', error.message)
      process.exit(1)
    })
}, 800)
