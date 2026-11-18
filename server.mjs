#!/usr/bin/env node
/**
 * Tellux Earth production server.
 *
 * Serves the Vite build from `dist/`, proxies Tianditu map/terrain tiles through
 * a same-origin endpoint (injecting the `tk` and the registered Referer), and
 * proxies the MapTiler terrain fallback so its key stays server-side.
 */
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTileCache } from './scripts/tile-cache.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(root, 'dist')

// Node >= 20.12 can load .env without a dependency. Keep this tolerant.
try {
  if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'))
} catch {
  // Older Node: rely on process.env / shell env.
}

const port = Number(process.env.PORT || 8090)
const host = process.env.HOST || '127.0.0.1'

/** 本地地形 / 影像瓦片缓存（.cache/tiles），缺块时回源并写盘。 */
const localTileCache = createTileCache({ root, token: process.env.CESIUM_ION_TOKEN || '' })

// Public demo credentials from the Tellux docs deployment. Replace with keys
// issued to your own domain/service for production use.
const tiandituTokens = (process.env.TIANDITU_TOKEN || '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean)
const tiandituToken = tiandituTokens[0] || ''
const tiandituReferer = (process.env.TIANDITU_REFERER || 'https://tellux.cyanfish.site/').trim()
const mapTilerKey = (process.env.MAPTILER_KEY || '').trim()
const forcedTerrain = (process.env.TERRAIN_MODE || 'auto').trim().toLowerCase()

const tiandituSubdomains = ['0', '1', '2', '3', '4', '5', '6', '7']

const mime = {
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

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  })
  res.end(body)
}

let probePromise = null
function probeSwdx() {
  if (probePromise) return probePromise
  if (!tiandituToken) {
    probePromise = Promise.resolve({ available: false, reason: '未配置 TIANDITU_TOKEN' })
    return probePromise
  }

  const candidates = [
    { x: 101, y: 21, l: 7 }, // 四川 / 云南
    { x: 52, y: 25, l: 6 }, // 华东
    { x: 26, y: 12, l: 6 } // 华北
  ]

  const attempt = ({ x, y, l }) =>
    new Promise((resolve) => {
      const url = new URL(`https://t0.tianditu.gov.cn/mapservice/swdx`)
      url.searchParams.set('T', 'elv_c')
      url.searchParams.set('x', String(x))
      url.searchParams.set('y', String(y))
      url.searchParams.set('l', String(l))
      url.searchParams.set('tk', tiandituToken)

      const req = https.get(
        url,
        {
          headers: {
            Referer: tiandituReferer,
            Origin: new URL(tiandituReferer).origin,
            // Tianditu rejects non-browser user agents for browser-type keys
            // with `Key权限类型为:浏览器端` (code 301012), so the probe and the
            // tile proxy must both present a browser UA.
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Accept: '*/*',
            'Accept-Encoding': 'identity'
          },
          timeout: 5500
        },
        (response) => {
          const chunks = []
          let size = 0
          response.on('data', (chunk) => {
            size += chunk.length
            if (size <= 16384) chunks.push(chunk)
          })
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            const bodyText = size < 512 ? buffer.toString('utf8') : ''
            const status = response.statusCode || 0
            const available =
              status === 200 && size >= 1000 && !bodyText.includes('"resolve"')
            resolve({
              available,
              status,
              bytes: size,
              reason: available
                ? null
                : status === 403
                  ? `领域未授权：${bodyText.slice(0, 160) || '403'}`
                  : size === 0
                    ? 'swdx 返回空包（tk 未开通“三维地形”或域名不在白名单）'
                    : `swdx 返回 ${status} / ${size} bytes`
            })
          })
        }
      )
      req.on('timeout', () => {
        req.destroy(new Error('timeout'))
      })
      req.on('error', (error) => {
        resolve({ available: false, status: 0, bytes: 0, reason: error.message })
      })
    })

  probePromise = (async () => {
    let last = null
    for (const candidate of candidates) {
      last = await attempt(candidate)
      if (last.available) return last
    }
    return last
  })()

  return probePromise
}

function getAppConfig() {
  return Promise.resolve({
    terrainMode: 'local-cache',
    tileCache: localTileCache.stats(),
    swdxAvailable: false,
    swdxReason: null,
    tiandituToken: 'proxy',
    tiandituReferer,
    maptilerAvailable: Boolean(mapTilerKey),
    maptilerUrl: '/maptiler/tiles/terrain-quantized-mesh-v2/',
    serviceOrigin: ''
  })
}

function proxyRequest({ targetBase, pathName, search, req, res, inject, extraHeaders = {} }) {
  const target = new URL(targetBase)
  target.pathname = pathName
  target.search = search

  const headers = {
    ...extraHeaders,
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    Accept: req.headers.accept || '*/*',
    'Accept-Encoding': 'identity',
    ...inject(target)
  }

  const proxy = https.request(
    target,
    {
      method: req.method,
      headers,
      timeout: 15000
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, {
        'content-type': upstream.headers['content-type'] || 'application/octet-stream',
        'cache-control': upstream.headers['cache-control'] || 'public, max-age=300',
        'access-control-allow-origin': '*'
      })
      upstream.pipe(res)
    }
  )

  proxy.on('timeout', () => {
    proxy.destroy(new Error('upstream timeout'))
  })
  proxy.on('error', (error) => {
    if (!res.headersSent) {
      json(res, 502, { error: 'upstream_error', message: error.message })
    } else {
      res.destroy(error)
    }
  })

  req.pipe(proxy)
}

const tileCache = new Map()
const TILE_CACHE_TTL_MS = 10 * 60 * 1000
const TILE_CACHE_MAX_ENTRIES = 3500
const OPAQUE_FALLBACK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQYlWMwsdX+jw8zjAwFALU0ZsGaghq5AAAAAElFTkSuQmCC',
  'base64'
)

/**
 * A 429 from Tianditu is transient and should not surface as a hard console
 * error. Terrain gets an empty body (Tellux uses flat fallback); imagery gets a
 * transparent 1x1 PNG. The tiles render as a small hole instead of breaking the
 * layer, and the browser has no error to report.
 */
function sendFallbackTile(res, upstreamPath) {
  if (upstreamPath.includes('/mapservice/swdx')) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-tellux-fallback': 'opaque-land'
  })
  res.end(OPAQUE_FALLBACK_PNG)
}

function rememberTile(key, entry) {
  if (tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
    const oldest = tileCache.keys().next().value
    if (oldest) tileCache.delete(oldest)
  }
  tileCache.set(key, entry)
}

function readCachedTile(key) {
  const entry = tileCache.get(key)
  if (!entry) return null
  if (Date.now() - entry.createdAt > TILE_CACHE_TTL_MS) {
    tileCache.delete(key)
    return null
  }
  return entry
}

function sendTile(res, entry, cacheState) {
  res.writeHead(200, {
    'content-type': entry.contentType,
    'cache-control': 'public, max-age=600',
    'access-control-allow-origin': '*',
    'x-tellux-cache': cacheState
  })
  res.end(entry.buffer)
}

function handleTianditu(req, res, pathname, searchParams) {
  const match = pathname.match(/^\/tianditu\/(\d)(\/.*)$/)
  if (!match) {
    json(res, 404, { error: 'unknown_tianditu_route' })
    return
  }

  const sub = match[1]
  if (!tiandituSubdomains.includes(sub)) {
    json(res, 404, { error: 'unknown_tianditu_subdomain' })
    return
  }

  const upstreamPath = match[2]
  const params = new URLSearchParams(searchParams)
  // The browser always sends `tk=proxy`; the real key never leaves the server.
  params.delete('tk')

  const cacheKey = `${sub}${upstreamPath}?${params.toString()}`
  const cached = readCachedTile(cacheKey)
  if (cached) {
    sendTile(res, cached, 'hit')
    return
  }

  const x = Number(params.get('x') || 0)
  const y = Number(params.get('y') || 0)
  const l = Number(params.get('l') || 0)
  const startIndex = tiandituTokens.length
    ? Math.abs((x * 31 + y * 257 + l * 6151) % tiandituTokens.length)
    : 0

  const targetUrl = (token) => {
    const url = new URL(`https://t${sub}.tianditu.gov.cn${upstreamPath}`)
    url.search = params.toString()
    if (token) url.searchParams.set('tk', token)
    return url
  }

  const attempt = (offset) => {
    if (!tiandituTokens.length) {
      sendFallbackTile(res, upstreamPath)
      return
    }
    if (offset >= tiandituTokens.length) {
      sendFallbackTile(res, upstreamPath)
      return
    }
    const token = tiandituTokens[(startIndex + offset) % tiandituTokens.length]
    const url = targetUrl(token)
    const upstream = https.get(
      url,
      {
        headers: {
          Referer: tiandituReferer,
          Origin: new URL(tiandituReferer).origin,
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Accept: req.headers.accept || '*/*',
          'Accept-Encoding': 'identity'
        },
        timeout: 15000
      },
      (response) => {
        const status = response.statusCode || 0
        const retryable = status === 403 || status === 418 || status === 429 || status >= 500
        if (retryable && offset + 1 < tiandituTokens.length) {
          response.resume()
          attempt(offset + 1)
          return
        }

        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size <= 2 * 1024 * 1024) chunks.push(chunk)
        })
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          // Tianditu sometimes returns a tiny JSON error or an empty body for a
          // valid tile when a key is being rate-limited. Retry with the next key
          // before surfacing the flat-fallback signal to Tellux.
          if (status === 200 && buffer.length < 1000 && offset + 1 < tiandituTokens.length) {
            attempt(offset + 1)
            return
          }
          if ((status === 403 || status === 429 || status >= 500) && offset + 1 >= tiandituTokens.length) {
            sendFallbackTile(res, upstreamPath)
            return
          }
          if (status === 200 && buffer.length < 1000) {
            // Never cache or forward Tianditu's tiny JSON error bodies as tiles.
            sendFallbackTile(res, upstreamPath)
            return
          }
          if (status === 200 && buffer.length > 0) {
            const entry = {
              buffer,
              contentType: response.headers['content-type'] || 'application/octet-stream',
              createdAt: Date.now()
            }
            rememberTile(cacheKey, entry)
            sendTile(res, entry, 'miss')
            return
          }
          res.writeHead(status || 502, {
            'content-type': response.headers['content-type'] || 'text/plain; charset=utf-8',
            'cache-control': 'no-store',
            'x-tellux-cache': 'miss'
          })
          res.end(buffer)
        })
      }
    )
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')))
    upstream.on('error', (error) => {
      if (!res.headersSent) json(res, 502, { error: 'upstream_error', message: error.message })
      else res.destroy(error)
    })
  }

  attempt(0)
}

function handleMapTiler(req, res, pathname, searchParams) {
  const upstreamPath = pathname.replace(/^\/maptiler/, '')
  const params = new URLSearchParams(searchParams)
  if (!params.get('key') && mapTilerKey) params.set('key', mapTilerKey)

  proxyRequest({
    targetBase: 'https://api.maptiler.com',
    pathName: upstreamPath || '/',
    search: `?${params.toString()}`,
    req,
    res,
    inject: () => ({})
  })
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(distDir)) {
    json(res, 503, {
      error: 'build_missing',
      message: 'dist/ 不存在。请先运行 `npm run build`，再执行 `npm start`。'
    })
    return
  }

  let decoded
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    json(res, 400, { error: 'bad_path' })
    return
  }

  const cleanPath = decoded === '/' ? '/index.html' : decoded
  const filePath = path.resolve(distDir, `.${cleanPath}`)
  if (!filePath.startsWith(`${distDir}${path.sep}`) && filePath !== path.join(distDir, 'index.html')) {
    json(res, 403, { error: 'forbidden' })
    return
  }

  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      // SPA fallback.
      const indexPath = path.join(distDir, 'index.html')
      if (fs.existsSync(indexPath)) {
        res.writeHead(200, { 'content-type': mime['.html'], 'cache-control': 'no-cache' })
        fs.createReadStream(indexPath).pipe(res)
        return
      }
      json(res, 404, { error: 'not_found' })
      return
    }

    const extension = path.extname(filePath).toLowerCase()
    const immutable = /\/assets\//.test(cleanPath)
    res.writeHead(200, {
      'content-type': mime[extension] || 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
    })
    fs.createReadStream(filePath).pipe(res)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname

  if (pathname === '/healthz') {
    json(res, 200, { ok: true, uptime: process.uptime() })
    return
  }

  if (pathname === '/api/config') {
    getAppConfig()
      .then((config) => json(res, 200, config))
      .catch((error) => json(res, 500, { error: 'config_failed', message: error.message }))
    return
  }

  // 本地地形 / 影像缓存优先；未命中时回源并写盘。
  try {
    if (await localTileCache.handle(req, res, url)) return
  } catch (error) {
    console.warn('[tellux-earth] tile cache error:', error.message)
  }

  if (pathname.startsWith('/tianditu/')) {
    handleTianditu(req, res, pathname, url.searchParams)
    return
  }

  if (pathname.startsWith('/maptiler/')) {
    handleMapTiler(req, res, pathname, url.searchParams)
    return
  }

  serveStatic(req, res, pathname)
})

server.listen(port, host, () => {
  const address = `http://${host}:${port}`
  console.log(`[tellux-earth] ${address}`)
  console.log(`[tellux-earth] Tianditu token: ${tiandituToken ? 'configured' : 'missing'}`)
  console.log(`[tellux-earth] MapTiler fallback: ${mapTilerKey ? 'configured' : 'missing'}`)
  const cacheStats = localTileCache.stats()
  const cacheTiles = (cacheStats.terrain?.tiles || 0) + (cacheStats.imagery?.tiles || 0)
  console.log(
    `[tellux-earth] tile cache: ${localTileCache.cacheDir} (${cacheTiles} tiles${
      cacheStats.region
        ? ` · ${cacheStats.region.sizeMeters / 1000} km @ ${cacheStats.region.longitude},${cacheStats.region.latitude}`
        : ''
    })`
  )
  if (cacheTiles === 0) {
    console.log('[tellux-earth] local cache empty: run `npm run cache:prefetch` to warm it')
  }
  probeSwdx().then((probe) => {
    console.log(
      `[tellux-earth] swdx probe: ${probe.available ? 'available' : 'unavailable'}${probe.reason ? ` — ${probe.reason}` : ''}`
    )
  })
})

function shutdown(signal) {
  console.log(`[tellux-earth] ${signal}, shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
