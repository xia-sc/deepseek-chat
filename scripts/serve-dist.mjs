// 复刻 electron/main.cjs 里的静态服务，用于验证构建产物能被正常托管。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve('dist')
const PORT = 37822
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

createServer(async (request, response) => {
  let pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
  if (pathname === '/' || pathname.endsWith('/')) {
    pathname += 'index.html'
  }
  const file = path.join(ROOT, pathname)
  try {
    const data = await readFile(file)
    response.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    })
    response.end(data)
  } catch {
    response.writeHead(404).end('not found')
  }
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}/`))
