const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const http = require('node:http')
const path = require('node:path')
const fs = require('node:fs/promises')

/**
 * 桌面外壳：用固定端口的本地服务托管构建产物，
 * 页面 origin 始终是 http://127.0.0.1:<port>，IndexedDB 与缓存不会因协议或端口变化而丢失；
 * 模型供应商配置额外写入用户数据目录下的 config.json，便于备份和手工编辑。
 */

const DEFAULT_PORT = Number(process.env.DEEPSEEK_CHAT_PORT ?? 37821)
const DIST_DIR = path.join(__dirname, '..', 'dist')

// 统一应用名：开发运行与打包后的用户数据目录一致（%APPDATA%\DeepSeek Chat）
app.setName('DeepSeek Chat')
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
