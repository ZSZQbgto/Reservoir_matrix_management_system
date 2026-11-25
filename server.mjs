#!/usr/bin/env node
/**
 * Tellux Earth 生产服务器。
 *
 * - 托管 `dist/` 静态产物（SPA 回退到 `index.html`，`/assets/*` 长缓存）；
 * - 挂载本地地形 / 影像瓦片缓存（`/terrain-cache/*`、`/imagery-cache/*`）：
 *   命中 `.cache/tiles` 直接返回，缺块回源 Cesium Ion / ArcGIS 并写盘；
 * - `/healthz` 供部署探活。
 *
 * Cesium Ion token 只在服务端用于回源与预热，浏览器全程不接触。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTileCache } from './scripts/tile-cache.mjs'
import { createLiveStateStore, readJsonBody, sendLiveJson } from './scripts/live-state.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(root, 'dist')

// Node >= 20.12 可直接读取 .env；旧版本退化为使用 shell 环境变量。
try {
  if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'))
} catch {
  // 读取失败时保持 process.env 现状，不阻塞启动。
}

const port = Number(process.env.PORT || 8090)
const host = process.env.HOST || '127.0.0.1'

const localTileCache = createTileCache({ root, token: process.env.CESIUM_ION_TOKEN || '' })
const liveState = createLiveStateStore(root)

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8'
}

/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(JSON.stringify(payload))
}

/**
 * 托管 `dist/` 下的静态文件。
 *
 * 路径先解析成绝对路径再校验是否仍在 `dist/` 内，避免 `..` 穿越；
 * 未命中的路径回退到 `index.html` 交给前端路由。
 */
function serveStatic(req, res, pathname) {
  if (!fs.existsSync(distDir)) {
    sendJson(res, 503, {
      error: 'build_missing',
      message: 'dist/ 不存在。请先运行 `npm run build`，再执行 `npm start`。'
    })
    return
  }

  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { error: 'bad_path' })
    return
  }

  const cleanPath = decoded === '/' ? '/index.html' : decoded
  const filePath = path.resolve(distDir, `.${cleanPath}`)
  const distPrefix = `${distDir}${path.sep}`
  if (!filePath.startsWith(distPrefix) && filePath !== path.join(distDir, 'index.html')) {
    sendJson(res, 403, { error: 'forbidden' })
    return
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      const indexPath = path.join(distDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'content-type': MIME_TYPES['.html'], 'cache-control': 'no-cache' })
        fs.createReadStream(indexPath).pipe(res)
        return
      }
      sendJson(res, 404, { error: 'not_found' })
      return
    }

    const extension = path.extname(filePath).toLowerCase()
    // Vite 产物带内容哈希，可以放心长缓存；其余（index.html 等）保持协商。
    const immutable = cleanPath.startsWith('/assets/')
    res.writeHead(200, {
      'content-type': MIME_TYPES[extension] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  if (pathname === '/healthz') {
    sendJson(res, 200, { ok: true, uptime: process.uptime() })
    return
  }

  if (pathname === '/api/live-state') {
    if (req.method === 'GET') {
      sendLiveJson(res, 200, liveState.read())
      return
    }
    if (req.method === 'POST') {
      try {
        sendLiveJson(res, 200, liveState.merge(await readJsonBody(req)))
      } catch (error) {
        const status = error instanceof Error && error.message === 'payload_too_large' ? 413 : 400
        sendLiveJson(res, status, { error: 'invalid_live_state' })
      }
      return
    }
    res.writeHead(405, { allow: 'GET, POST' })
    res.end()
    return
  }

  // 本地瓦片缓存优先；未命中时由中间件回源并写盘。
  try {
    if (await localTileCache.handle(req, res, url)) return
  } catch (error) {
    console.warn('[tellux-earth] 瓦片缓存处理失败：', error.message)
  }

  serveStatic(req, res, pathname)
})

server.listen(port, host, () => {
  console.log(`[tellux-earth] http://${host}:${port}`)
  const stats = localTileCache.stats()
  const tileCount = (stats.terrain?.tiles || 0) + (stats.imagery?.tiles || 0)
  const region = stats.region
    ? ` · ${stats.region.sizeMeters / 1000} km @ ${stats.region.longitude},${stats.region.latitude}`
    : ''
  console.log(`[tellux-earth] 本地瓦片缓存：${localTileCache.cacheDir}（${tileCount} 块${region}）`)
  if (tileCount === 0) {
    console.log('[tellux-earth] 缓存为空：可运行 `npm run cache:prefetch` 预热')
  }
  console.log(
    `[tellux-earth] Cesium Ion token：${process.env.CESIUM_ION_TOKEN ? '已配置' : '未配置（仅能使用已有缓存）'}`
  )
})

function shutdown(signal) {
  console.log(`[tellux-earth] 收到 ${signal}，正在关闭`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
