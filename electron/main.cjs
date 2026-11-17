const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')

// 启动阶段的异常没有窗口可提示，写到临时目录方便排查
const writeCrashLog = (error) => {
  try {
    const target = path.join(process.env.TEMP ?? '.', 'deepseek-chat-crash.log')
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    fsSync.appendFileSync(target, `[${new Date().toISOString()}] ${detail}\n`)
  } catch {
    // 连日志都写不了时只能放弃
  }
}
process.on('uncaughtException', writeCrashLog)
process.on('unhandledRejection', writeCrashLog)

/**
 * 桌面外壳：用固定端口的本地服务托管构建产物，
 * 页面 origin 始终是 http://127.0.0.1:<port>，IndexedDB 与缓存不会因协议或端口变化而丢失；
 * 模型供应商配置额外写入数据目录下的 config.json，便于备份和手工编辑。
 */

const DEFAULT_PORT = Number(process.env.DEEPSEEK_CHAT_PORT ?? 37821)
const DIST_DIR = path.join(__dirname, '..', 'dist')
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')

// 统一应用名：开发运行与打包后的用户数据目录一致
app.setName('DeepSeek Chat')

/**
 * 便携模式：portable 启动器会把 PORTABLE_EXECUTABLE_DIR 指向用户双击 exe 所在的目录。
 * 配置与会话都放在该目录的 data/ 下，整个文件夹拷走即可迁移；
 * 该位置不可写（只读介质、Program Files 等）时退回系统用户数据目录。
 */
/**
 * 数据根目录：
 * - portable 启动器会设置 PORTABLE_EXECUTABLE_DIR，指向用户双击 exe 的目录；
 * - zip 免安装版没有启动器，直接用 exe 自身所在目录；
 * - 开发运行（未打包）不启用便携目录，沿用系统用户数据目录。
 */
const resolvePortableRoot = () => {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return process.env.PORTABLE_EXECUTABLE_DIR
  }
  return app.isPackaged ? path.dirname(process.execPath) : null
}

const resolvePortableDataDir = () => {
  const root = resolvePortableRoot()
  if (!root) {
    return null
  }
  const dir = path.join(root, 'data')
  try {
    fsSync.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.write-test')
    fsSync.writeFileSync(probe, 'ok')
    fsSync.unlinkSync(probe)
    return dir
  } catch {
    return null
  }
}

const portableDataDir = resolvePortableDataDir()
if (portableDataDir) {
  try {
    // app.setPath 要求目标目录已经存在，否则会抛异常导致主进程启动即退出
    const sessionDir = path.join(portableDataDir, 'session')
    fsSync.mkdirSync(sessionDir, { recursive: true })
    app.setPath('userData', portableDataDir)
    // Chromium 的缓存、IndexedDB、Local Storage 都跟着数据目录走
    app.setPath('sessionData', sessionDir)
  } catch {
    // 切换失败时保持默认用户数据目录，至少能正常启动
  }
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

const configFile = () => path.join(app.getPath('userData'), 'config.json')

/** 旧版本（非便携）把配置放在 %APPDATA%\DeepSeek Chat\config.json */
const legacyConfigFile = () => path.join(app.getPath('appData'), 'DeepSeek Chat', 'config.json')

/** 便携版首次启动：如果本地还没有配置，把旧版本的配置复制过来，避免重新配置 */
const migrateLegacyConfig = async () => {
  if (!portableDataDir) {
    return
  }
  const target = configFile()
  try {
    await fs.access(target)
    return
  } catch {
    // 本地还没有配置文件，继续尝试迁移
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(legacyConfigFile(), target)
  } catch {
    // 没有旧配置或复制失败时保持空白配置
  }
}

const readConfig = async () => {
  try {
    return JSON.parse(await fs.readFile(configFile(), 'utf8'))
  } catch {
    return null
  }
}

/** 先写临时文件再改名，避免写一半崩溃把配置写坏 */
const writeConfig = async (data) => {
  const file = configFile()
  const temp = `${file}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(temp, file)
  return file
}

const serve = (root) =>
  new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      let pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
      if (pathname === '/' || pathname.endsWith('/')) {
        pathname += 'index.html'
      }
      const file = path.join(root, pathname)
      // 只允许读取 dist 内的文件
      if (!file.startsWith(root)) {
        response.writeHead(403).end()
        return
      }
      try {
        const data = await fs.readFile(file)
        response.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        })
        response.end(data)
      } catch {
        response.writeHead(404).end('not found')
      }
    })
    server.once('error', reject)
    server.listen(DEFAULT_PORT, '127.0.0.1', () => resolve(server))
  })

let mainWindow = null

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    title: 'DeepSeek Chat',
    icon: path.join(RESOURCES_DIR, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  mainWindow = win

  // 外部链接交给系统浏览器，不在应用内跳出新窗口
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  win.loadURL(`http://127.0.0.1:${DEFAULT_PORT}/`)
  return win
}

// 单实例：重复启动时聚焦已有窗口，避免第二个进程争用固定端口
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) {
      return
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    }
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    await migrateLegacyConfig()
    ipcMain.handle('config:read', () => readConfig())
    ipcMain.handle('config:write', (_event, data) => writeConfig(data))
    ipcMain.handle('config:path', () => configFile())
    ipcMain.handle('config:reveal', async () => {
      await fs.mkdir(path.dirname(configFile()), { recursive: true })
      shell.showItemInFolder(configFile())
    })

    try {
      await serve(DIST_DIR)
    } catch (error) {
      dialog.showErrorBox(
        '端口被占用',
        `无法在 127.0.0.1:${DEFAULT_PORT} 启动本地服务（${error?.code ?? error}）。\n` +
          '请先关闭占用该端口的程序再重新打开本应用。'
      )
      app.quit()
      return
    }

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
      }
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
