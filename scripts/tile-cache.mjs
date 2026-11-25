/**
 * 地形 / 影像本地缓存。
 *
 * 目标：把 50 km × 50 km（默认中心 116.77, 36.02）的 Cesium World Terrain
 * quantized-mesh 瓦片与 ArcGIS World Imagery 瓦片缓存到 `.cache/tiles`，
 * 之后 dev / 生产服务器优先从磁盘返回，不再每次从网上加载；缺块时按需回源并写盘。
 *
 * 该模块同时被三处复用：
 * - `scripts/cache-region.mjs`：预热指定区域的瓦片；
 * - `vite.config.ts`：dev / preview 服务器中间件；
 * - `server.mjs`：生产服务器中间件。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const DEFAULT_REGION = Object.freeze({
  longitude: 116.77,
  latitude: 36.02,
  sizeMeters: 50_000
})

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const CESIUM_ASSET_ID = 1
const CESIUM_ENDPOINT = `https://api.cesium.com/v1/assets/${CESIUM_ASSET_ID}/endpoint`
const ARCGIS_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
const TERRAIN_CONTENT_TYPE =
  'application/vnd.quantized-mesh;extensions=octvertexnormals-watermask-metadata'
const IMAGERY_CONTENT_TYPE = 'image/jpeg'
/** 水体模拟域固定参数（与 src/water/types.ts 的 WATER_DOMAIN / TERRAIN_GRID_SIZE 保持一致）。 */
const DOMAIN_STORE = Object.freeze({
  center: { longitude: 116.77, latitude: 36.02 },
  sizeMeters: 8000,
  resolution: 97
})
const MAX_DOMAIN_BODY_BYTES = 2 * 1024 * 1024
/** 1×1 透明 PNG：影像回源失败时的兜底，避免整块图层报错。 */
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

export function defaultCacheRoot(root) {
  return process.env.TILE_CACHE_DIR
    ? path.resolve(process.env.TILE_CACHE_DIR)
    : path.join(root, '.cache', 'tiles')
}

/** 区域中心 + 边长（米）→ 经纬度包围盒。 */
export function regionBounds(region = DEFAULT_REGION) {
  const latRad = (region.latitude * Math.PI) / 180
  const mPerDegLat =
    111132.92 -
    559.82 * Math.cos(2 * latRad) +
    1.175 * Math.cos(4 * latRad) -
    0.0023 * Math.cos(6 * latRad)
  const mPerDegLon =
    111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad) + 0.118 * Math.cos(5 * latRad)
  const halfLat = region.sizeMeters / 2 / mPerDegLat
  const halfLon = region.sizeMeters / 2 / Math.max(1, mPerDegLon)
  // WebMercator 的纬度上限约 ±85°；超大区域（全球低层级预热）按世界范围裁剪。
  return {
    minLon: Math.max(-180, region.longitude - halfLon),
    maxLon: Math.min(180, region.longitude + halfLon),
    minLat: Math.max(-85, region.latitude - halfLat),
    maxLat: Math.min(85, region.latitude + halfLat),
    mPerDegLat,
    mPerDegLon
  }
}

/** Cesium quantized-mesh（EPSG:4326 / tms）某层覆盖包围盒的瓦片范围。 */
export function terrainTileRange(bounds, level) {
  const xCount = 2 ** (level + 1)
  const yCount = 2 ** level
  const clampX = (value) => Math.max(0, Math.min(xCount - 1, value))
  const clampY = (value) => Math.max(0, Math.min(yCount - 1, value))
  return {
    level,
    startX: clampX(Math.floor(((bounds.minLon + 180) / 360) * xCount)),
    endX: clampX(Math.floor(((bounds.maxLon + 180) / 360) * xCount)),
    startY: clampY(Math.floor(((bounds.minLat + 90) / 180) * yCount)),
    endY: clampY(Math.floor(((bounds.maxLat + 90) / 180) * yCount))
  }
}

/** WebMercator（EPSG:3857）某层覆盖包围盒的影像瓦片范围。 */
export function imageryTileRange(bounds, level) {
  const count = 2 ** level
  const toY = (lat) => {
    const rad = (lat * Math.PI) / 180
    const value = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * count
    return Math.max(0, Math.min(count - 1, Math.floor(value)))
  }
  return {
    level,
    startX: Math.max(0, Math.min(count - 1, Math.floor(((bounds.minLon + 180) / 360) * count))),
    endX: Math.max(0, Math.min(count - 1, Math.floor(((bounds.maxLon + 180) / 360) * count))),
    startY: toY(bounds.maxLat),
    endY: toY(bounds.minLat)
  }
}

function layerAvailable(layer, level, x, y) {
  const ranges = layer?.available?.[level]
  if (!Array.isArray(ranges) || ranges.length === 0) return true
  return ranges.some(
    (range) => x >= range.startX && x <= range.endX && y >= range.startY && y <= range.endY
  )
}

async function fetchBuffer(url, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      signal: controller.signal
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    return { response, buffer }
  } finally {
    clearTimeout(timer)
  }
}

async function writeFileAtomic(filePath, buffer) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(temporary, buffer)
  await fsp.rename(temporary, filePath)
}

async function readBuffer(filePath) {
  try {
    return await fsp.readFile(filePath)
  } catch {
    return null
  }
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

function readRequestBody(req, limitBytes = MAX_DOMAIN_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 校验模拟域地形缓存 JSON（中心 / 尺寸 / 分辨率固定，高度为 base64 Float32）。 */
function isValidDomainPayload(data) {
  if (!data || typeof data !== 'object') return false
  if (data.version !== 1) return false
  if (
    !data.center ||
    Math.abs(data.center.longitude - DOMAIN_STORE.center.longitude) > 1e-9 ||
    Math.abs(data.center.latitude - DOMAIN_STORE.center.latitude) > 1e-9
  ) {
    return false
  }
  if (data.sizeMeters !== DOMAIN_STORE.sizeMeters) return false
  if (data.resolution !== DOMAIN_STORE.resolution) return false
  if (typeof data.baseElevation !== 'number' || !Number.isFinite(data.baseElevation)) return false
  if (typeof data.heights !== 'string') return false
  const expectedBytes = DOMAIN_STORE.resolution * DOMAIN_STORE.resolution * 4
  const minBase64 = Math.floor((expectedBytes * 4) / 3) - 8
  return data.heights.length >= minBase64 && /^[A-Za-z0-9+/=]+$/.test(data.heights)
}

export function createTileCache(options) {
  const root = options?.root ?? process.cwd()
  const token = (options?.token ?? '').trim()
  const cacheDir = options?.cacheDir ?? defaultCacheRoot(root)
  const terrainDir = path.join(cacheDir, 'terrain')
  const imageryDir = path.join(cacheDir, 'imagery')
  const manifestPath = path.join(cacheDir, 'manifest.json')
  const domainFile = path.join(cacheDir, 'domain', 'domain.json')
  const logger = options?.logger ?? console
  let manifestCache = null
  let terrainSource = null

  const loadManifest = () => {
    if (manifestCache) return manifestCache
    try {
      manifestCache = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      manifestCache = { terrain: { tiles: 0, bytes: 0 }, imagery: { tiles: 0, bytes: 0 } }
    }
    return manifestCache
  }

  const resolveTerrainSource = async (force = false) => {
    if (terrainSource && !force) return terrainSource
    if (!token) throw new Error('缺少 CESIUM_ION_TOKEN，无法回源 Cesium World Terrain')
    const { response, buffer } = await fetchBuffer(
      `${CESIUM_ENDPOINT}?access_token=${encodeURIComponent(token)}`,
      { headers: { Accept: 'application/json' } }
    )
    if (!response.ok) throw new Error(`Cesium Ion endpoint 请求失败：HTTP ${response.status}`)
    const data = JSON.parse(buffer.toString('utf8'))
    terrainSource = {
      baseUrl: String(data.url || '').replace(/\/$/, ''),
      accessToken: data.accessToken || '',
      fetchedAt: Date.now()
    }
    return terrainSource
  }

  const terrainFile = (z, x, y) => path.join(terrainDir, String(z), String(x), `${y}.terrain`)
  const imageryFile = (z, y, x) => path.join(imageryDir, String(z), String(y), `${x}.jpg`)

  const ensureTerrainLayer = async () => {
    const layerPath = path.join(terrainDir, 'layer.json')
    const cached = await readBuffer(layerPath)
    if (cached) return cached
    const source = await resolveTerrainSource()
    const url = `${source.baseUrl}/layer.json?access_token=${encodeURIComponent(source.accessToken)}`
    const { response, buffer } = await fetchBuffer(url)
    if (!response.ok) throw new Error(`地形 layer.json 下载失败：HTTP ${response.status}`)
    await writeFileAtomic(layerPath, buffer)
    return buffer
  }

  const ensureTerrainTile = async (z, x, y) => {
    const pathName = terrainFile(z, x, y)
    const cached = await readBuffer(pathName)
    if (cached) return cached
    let source = await resolveTerrainSource()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const url = `${source.baseUrl}/${z}/${x}/${y}.terrain?v=1&access_token=${encodeURIComponent(source.accessToken)}`
      const { response, buffer } = await fetchBuffer(url, { timeoutMs: 30_000 })
      if (response.ok) {
        await writeFileAtomic(pathName, buffer)
        return buffer
      }
      if (response.status === 401 || response.status === 403) {
        source = await resolveTerrainSource(true)
        continue
      }
      if (response.status === 404) return null
      throw new Error(`地形瓦片下载失败：HTTP ${response.status}`)
    }
    return null
  }

  const ensureImageryTile = async (z, y, x) => {
    const pathName = imageryFile(z, y, x)
    const cached = await readBuffer(pathName)
    if (cached) return cached
    const url = `${ARCGIS_IMAGERY}/${z}/${y}/${x}`
    const { response, buffer } = await fetchBuffer(url)
    if (!response.ok) return null
    await writeFileAtomic(pathName, buffer)
    return buffer
  }

  /**
   * 统计目录内的瓦片数与字节数。
   *
   * `manifest.json` 只有 `cache:prefetch` 会写；按需缓存（浏览时回源写盘）没有清单，
   * 此时直接数文件，避免启动日志 / `/tile-cache/stats` 误报 0 块。
   */
  const directoryUsage = (dir) => {
    let tiles = 0
    let bytes = 0
    const walk = (current) => {
      let entries
      try {
        entries = fs.readdirSync(current, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.isFile()) {
          tiles += 1
          try {
            bytes += fs.statSync(full).size
          } catch {
            // 单个文件读不到时只是少算字节数。
          }
        }
      }
    }
    walk(dir)
    return { tiles, bytes }
  }

  const readStats = () => {
    const manifest = loadManifest()
    const terrain = manifest.terrain?.tiles ? manifest.terrain : directoryUsage(terrainDir)
    const imagery = manifest.imagery?.tiles ? manifest.imagery : directoryUsage(imageryDir)
    return {
      cacheDir,
      region: manifest.region ?? null,
      terrain,
      imagery,
      domain: { exists: fs.existsSync(domainFile), file: domainFile },
      updatedAt: manifest.updatedAt ?? null
    }
  }

  /** JSON 响应：统计接口与模拟域缓存接口共用。 */
  const sendJson = (res, status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  /** 影像缺块兜底：1×1 透明 PNG，避免浏览器报图层错误。 */
  const sendTransparentPng = (res) => {
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(TRANSPARENT_PNG)
  }

  /** 中间件主入口：命中返回 true，否则交给下一个处理者。 */
  const handle = async (req, res, url) => {
    const pathname = decodeURIComponent(url.pathname)
    if (pathname === '/tile-cache/stats') {
      sendJson(res, 200, readStats())
      return true
    }
    // 固定模拟域地形高度场：GET 恢复 / POST 覆盖（与浏览器 localStorage 双向兜底）。
    if (pathname === '/domain-cache/domain.json') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const buffer = await readBuffer(domainFile)
        if (buffer) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store'
          })
          res.end(buffer)
        } else {
          // 用 200 + missing 标记代替 404，避免浏览器控制台出现“资源 404”错误。
          sendJson(res, 200, { missing: true })
        }
        return true
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          const body = await readRequestBody(req)
          const data = JSON.parse(body.toString('utf8'))
          if (!isValidDomainPayload(data)) {
            sendJson(res, 400, { error: 'invalid_domain_payload' })
            return true
          }
          await writeFileAtomic(domainFile, body)
          sendJson(res, 200, { ok: true, savedAt: data.savedAt ?? null })
        } catch (error) {
          sendJson(res, 400, {
            error: 'domain_cache_write_failed',
            message: error.message
          })
        }
        return true
      }
      if (req.method === 'DELETE') {
        await fsp.rm(domainFile, { force: true })
        sendJson(res, 200, { ok: true })
        return true
      }
      res.writeHead(405, { allow: 'GET, HEAD, POST, PUT, DELETE' })
      res.end()
      return true
    }
    if (pathname === '/terrain-cache/layer.json') {
      try {
        const layer = await ensureTerrainLayer()
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'public, max-age=86400'
        })
        res.end(layer)
      } catch (error) {
        logger.warn?.(`[tile-cache] layer.json 不可用：${error.message}`)
        sendJson(res, 503, { error: 'terrain_cache_unavailable', message: error.message })
      }
      return true
    }
    const terrainMatch = pathname.match(/^\/terrain-cache\/(\d+)\/(\d+)\/(\d+)\.terrain$/)
    if (terrainMatch) {
      const z = Number(terrainMatch[1])
      const x = Number(terrainMatch[2])
      const y = Number(terrainMatch[3])
      try {
        const tile = await ensureTerrainTile(z, x, y)
        if (tile) {
          res.writeHead(200, {
            'content-type': TERRAIN_CONTENT_TYPE,
            'cache-control': 'public, max-age=86400'
          })
          res.end(tile)
        } else {
          // 该经纬度没有地形数据（例如可用范围外）：让 Tellux 使用平面兜底。
          res.writeHead(204, { 'cache-control': 'no-store' })
          res.end()
        }
      } catch (error) {
        logger.warn?.(`[tile-cache] 地形瓦片 ${z}/${x}/${y} 回源失败：${error.message}`)
        sendJson(res, 503, { error: 'terrain_tile_unavailable' })
      }
      return true
    }
    const imageryMatch = pathname.match(/^\/imagery-cache\/(\d+)\/(\d+)\/(\d+)(?:\.[a-z]+)?$/)
    if (imageryMatch) {
      const z = Number(imageryMatch[1])
      const y = Number(imageryMatch[2])
      const x = Number(imageryMatch[3])
      try {
        const tile = await ensureImageryTile(z, y, x)
        if (tile) {
          res.writeHead(200, {
            'content-type': IMAGERY_CONTENT_TYPE,
            'cache-control': 'public, max-age=86400'
          })
          res.end(tile)
        } else {
          sendTransparentPng(res)
        }
      } catch (error) {
        logger.warn?.(`[tile-cache] 影像瓦片 ${z}/${y}/${x} 回源失败：${error.message}`)
        sendTransparentPng(res)
      }
      return true
    }
    return false
  }

  return {
    cacheDir,
    terrainDir,
    imageryDir,
    manifestPath,
    handle,
    stats: readStats,
    ensureTerrainLayer,
    resolveTerrainSource,
    isReady: () => fileExists(path.join(terrainDir, 'layer.json'))
  }
}

/**
 * 预热指定区域：下载该范围内地形（默认 0–14 级）与影像（默认 8–15 级）瓦片。
 */
export async function prefetchRegion(options = {}) {
  const region = { ...DEFAULT_REGION, ...(options.region ?? {}) }
  const root = options.root ?? process.cwd()
  const cacheDir = options.cacheDir ?? defaultCacheRoot(root)
  const terrainDir = path.join(cacheDir, 'terrain')
  const imageryDir = path.join(cacheDir, 'imagery')
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8))
  const terrainMinLevel = options.terrainMinLevel ?? 0
  const terrainMaxLevel = options.terrainMaxLevel ?? 14
  const imageryMinLevel = options.imageryMinLevel ?? 8
  const imageryMaxLevel = options.imageryMaxLevel ?? 15
  const logger = options.logger ?? console
  const onProgress = options.onProgress ?? (() => {})
  const bounds = regionBounds(region)

  await fsp.mkdir(terrainDir, { recursive: true })
  await fsp.mkdir(imageryDir, { recursive: true })

  const cache = createTileCache({ root, token: options.token, cacheDir, logger })
  const layerBuffer = await cache.ensureTerrainLayer()
  const layer = JSON.parse(layerBuffer.toString('utf8'))
  const source = await cache.resolveTerrainSource()

  const terrainTasks = []
  for (let level = terrainMinLevel; level <= terrainMaxLevel; level += 1) {
    const range = terrainTileRange(bounds, level)
    for (let x = range.startX; x <= range.endX; x += 1) {
      for (let y = range.startY; y <= range.endY; y += 1) {
        if (!layerAvailable(layer, level, x, y)) continue
        terrainTasks.push({ level, x, y })
      }
    }
  }

  const imageryTasks = []
  for (let level = imageryMinLevel; level <= imageryMaxLevel; level += 1) {
    const range = imageryTileRange(bounds, level)
    for (let x = range.startX; x <= range.endX; x += 1) {
      for (let y = range.startY; y <= range.endY; y += 1) {
        imageryTasks.push({ level, y, x })
      }
    }
  }

  const total = terrainTasks.length + imageryTasks.length
  let completed = 0
  let downloaded = 0
  let skipped = 0
  let failed = 0
  let bytes = 0
  const startedAt = Date.now()
  let lastReport = 0

  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < 1500) return
    lastReport = now
    const elapsed = Math.max(0.001, (now - startedAt) / 1000)
    logger.log(
      `[tile-cache] ${completed}/${total} 瓦片 · 新下载 ${downloaded} · 跳过 ${skipped} · 失败 ${failed} · ` +
        `${(bytes / 1024 / 1024).toFixed(1)} MB · ${(completed / elapsed).toFixed(1)} 块/s`
    )
    onProgress({ completed, total, downloaded, skipped, failed, bytes })
  }

  await runPool(terrainTasks, concurrency, async (task) => {
    const filePath = path.join(terrainDir, String(task.level), String(task.x), `${task.y}.terrain`)
    if (await fileExists(filePath)) {
      skipped += 1
    } else {
      try {
        const url = `${source.baseUrl}/${task.level}/${task.x}/${task.y}.terrain?v=1&access_token=${encodeURIComponent(source.accessToken)}`
        const { response, buffer } = await fetchBuffer(url, { timeoutMs: 30_000 })
        if (response.ok) {
          await writeFileAtomic(filePath, buffer)
          downloaded += 1
          bytes += buffer.length
        } else if (response.status === 404) {
          skipped += 1
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }
    completed += 1
    report()
  })

  await runPool(imageryTasks, concurrency, async (task) => {
    const filePath = path.join(imageryDir, String(task.level), String(task.y), `${task.x}.jpg`)
    if (await fileExists(filePath)) {
      skipped += 1
    } else {
      try {
        const { response, buffer } = await fetchBuffer(
          `${ARCGIS_IMAGERY}/${task.level}/${task.y}/${task.x}`
        )
        if (response.ok) {
          await writeFileAtomic(filePath, buffer)
          downloaded += 1
          bytes += buffer.length
        } else {
          failed += 1
        }
      } catch {
        failed += 1
      }
    }
    completed += 1
    report()
  })

  report(true)
  const manifest = {
    version: 1,
    region,
    bounds,
    levels: {
      terrain: { min: terrainMinLevel, max: terrainMaxLevel },
      imagery: { min: imageryMinLevel, max: imageryMaxLevel }
    },
    terrain: {
      tiles: terrainTasks.length,
      bytes: await directoryStats(path.join(terrainDir))
    },
    imagery: {
      tiles: imageryTasks.length,
      bytes: await directoryStats(path.join(imageryDir))
    },
    sources: { terrain: 'Cesium World Terrain (Cesium Ion)', imagery: 'ArcGIS World Imagery' },
    updatedAt: new Date().toISOString()
  }
  await writeFileAtomic(
    path.join(cacheDir, 'manifest.json'),
    Buffer.from(JSON.stringify(manifest, null, 2))
  )
  return {
    manifest,
    terrainTasks: terrainTasks.length,
    imageryTasks: imageryTasks.length,
    downloaded,
    skipped,
    failed,
    bytes
  }
}

async function directoryStats(dir) {
  let total = 0
  const walk = async (current) => {
    let entries
    try {
      entries = await fsp.readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) {
        try {
          total += (await fsp.stat(full)).size
        } catch {
          // 忽略统计失败的单个文件。
        }
      }
    }
  }
  await walk(dir)
  return total
}

async function runPool(items, concurrency, worker) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      await worker(item)
    }
  })
  await Promise.all(workers)
}
