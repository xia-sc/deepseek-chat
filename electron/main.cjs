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
// 开发模式：设置该环境变量后直接加载 rspack dev server，改前端代码即时刷新，无需打包。
// 生产运行不设置它，仍然由内置静态服务托管 dist。
const DEV_URL = process.env.DEEPSEEK_CHAT_DEV_URL
const DIST_DIR = path.join(__dirname, '..', 'dist')
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')

// 统一应用名：开发运行与打包后的用户数据目录一致
app.setName('DeepSeek Chat')

/**
 * 数据根目录固定为系统用户数据目录（Windows 上是 %APPDATA%\DeepSeek Chat），
 * 这样升级版本或移动 exe 位置都不会丢配置；
 * 需要便携数据时用环境变量 DEEPSEEK_CHAT_DATA_DIR 指定（例如 U 盘场景）。
 */
const resolveDataRoot = () => {
  const explicit = process.env.DEEPSEEK_CHAT_DATA_DIR
  if (explicit) {
    return explicit
  }
  try {
    return path.join(app.getPath('appData'), 'DeepSeek Chat')
  } catch {
    // 极端情况下取不到系统目录，退回当前工作目录下的数据文件夹
    return path.join(process.cwd(), 'DeepSeek Chat')
  }
}

const dataRoot = resolveDataRoot()
try {
  // app.setPath 要求目标目录已经存在，否则会抛异常导致主进程启动即退出
  const sessionDir = path.join(dataRoot, 'session')
  fsSync.mkdirSync(sessionDir, { recursive: true })
  app.setPath('userData', dataRoot)
  // Chromium 的缓存、IndexedDB、Local Storage 都跟着会话目录走
  app.setPath('sessionData', sessionDir)
} catch {
  // 切换失败时保持默认用户数据目录，至少能正常启动
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

const configFile = () => path.join(dataRoot, 'config.json')

/**
 * 旧版便携模式把配置和会话放在 exe 同目录的 data/ 下；
 * 升级后首次启动时把它们迁移到系统数据目录，避免用户重新配置。
 */
const migratePortableData = async () => {
  const portableRoots = [
    process.env.PORTABLE_EXECUTABLE_DIR,
    app.isPackaged ? path.dirname(process.execPath) : null,
  ].filter(Boolean)
  const legacyRoot = portableRoots
    .map((root) => path.join(root, 'data'))
    .find((dir) => dir !== dataRoot && fsSync.existsSync(path.join(dir, 'config.json')))
  if (!legacyRoot) {
    return
  }
  try {
    if (!fsSync.existsSync(configFile())) {
      await fs.mkdir(path.dirname(configFile()), { recursive: true })
      await fs.copyFile(path.join(legacyRoot, 'config.json'), configFile())
    }
    const legacySession = path.join(legacyRoot, 'session')
    const targetSession = path.join(dataRoot, 'session')
    if (fsSync.existsSync(legacySession) && !fsSync.existsSync(path.join(targetSession, 'Local Storage'))) {
      await fs.cp(legacySession, targetSession, { recursive: true })
    }
  } catch {
    // 迁移失败时保持空白配置，用户可手工把旧 data/ 目录复制过来
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

  win.loadURL(DEV_URL ?? `http://127.0.0.1:${DEFAULT_PORT}/`)
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
    await migratePortableData()
    ipcMain.handle('config:read', () => readConfig())
    ipcMain.handle('config:write', (_event, data) => writeConfig(data))
    ipcMain.handle('config:path', () => configFile())
    ipcMain.handle('config:reveal', async () => {
      await fs.mkdir(path.dirname(configFile()), { recursive: true })
      shell.showItemInFolder(configFile())
    })

    // 开发模式直接连 dev server，不再启动内置静态服务
    if (!DEV_URL) {
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
