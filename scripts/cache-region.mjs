#!/usr/bin/env node
/**
 * 预热指定区域的 Cesium 地形与 ArcGIS 影像本地缓存。
 *
 * 默认：中心 116.77, 36.02、范围 50 km × 50 km、地形 0–14 级、影像 8–15 级，
 * 缓存写入 `.cache/tiles`（可用 --cache-dir / TILE_CACHE_DIR 覆盖）。
 *
 * 用法：
 *   npm run cache:prefetch
 *   npm run cache:prefetch -- --size 50000 --imagery-levels 8-16
 *   npm run cache:prefetch -- --center 116.8,36.0 --terrain-levels 5-14
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_REGION, defaultCacheRoot, prefetchRegion } from './tile-cache.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function readEnv(key) {
  if (process.env[key]) return process.env[key]
  const envPath = path.join(root, '.env')
  if (!fs.existsSync(envPath)) return ''
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`))
  return line ? line.slice(line.indexOf('=') + 1).trim() : ''
}

function parseArgs(argv) {
  const options = {
    // 复制成可变对象：DEFAULT_REGION 被 Object.freeze，直接展开会保留只读属性。
    region: {
      longitude: DEFAULT_REGION.longitude,
      latitude: DEFAULT_REGION.latitude,
      sizeMeters: DEFAULT_REGION.sizeMeters
    },
    terrainMinLevel: 0,
    terrainMaxLevel: 14,
    imageryMinLevel: 8,
    imageryMaxLevel: 15,
    concurrency: 8,
    cacheDir: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--center' && next) {
      const [longitude, latitude] = next.split(',').map(Number)
      if (Number.isFinite(longitude) && Number.isFinite(latitude)) {
        options.region.longitude = longitude
        options.region.latitude = latitude
      }
      i += 1
    } else if (arg === '--size' && next) {
      const size = Number(next)
      if (Number.isFinite(size) && size > 0) options.region.sizeMeters = size
      i += 1
    } else if (arg === '--terrain-levels' && next) {
      const [min, max] = next.split('-').map(Number)
      if (Number.isFinite(min)) options.terrainMinLevel = min
      if (Number.isFinite(max)) options.terrainMaxLevel = max
      i += 1
    } else if (arg === '--imagery-levels' && next) {
      const [min, max] = next.split('-').map(Number)
      if (Number.isFinite(min)) options.imageryMinLevel = min
      if (Number.isFinite(max)) options.imageryMaxLevel = max
      i += 1
    } else if (arg === '--concurrency' && next) {
      const concurrency = Number(next)
      if (Number.isFinite(concurrency) && concurrency > 0) options.concurrency = concurrency
      i += 1
    } else if (arg === '--cache-dir' && next) {
      options.cacheDir = path.resolve(next)
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        [
          '用法: npm run cache:prefetch -- [选项]',
          '  --center <lon,lat>       区域中心（默认 116.77,36.02）',
          '  --size <meters>          区域边长（默认 50000）',
          '  --terrain-levels <a-b>   地形层级范围（默认 0-14）',
          '  --imagery-levels <a-b>   影像层级范围（默认 8-15）',
          '  --concurrency <n>        并发下载数（默认 8）',
          '  --cache-dir <path>       缓存目录（默认 .cache/tiles）'
        ].join('\n')
      )
      process.exit(0)
    }
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const token = readEnv('CESIUM_ION_TOKEN')
if (!token) {
  console.error(
    '[cache] 未找到 CESIUM_ION_TOKEN（.env 或环境变量），无法下载 Cesium World Terrain。'
  )
  process.exit(1)
}
const cacheDir = options.cacheDir ?? defaultCacheRoot(root)
console.log('[cache] 区域:', options.region)
console.log('[cache] 缓存目录:', cacheDir)
console.log(
  `[cache] 层级: 地形 ${options.terrainMinLevel}-${options.terrainMaxLevel} / ` +
    `影像 ${options.imageryMinLevel}-${options.imageryMaxLevel} · 并发 ${options.concurrency}`
)

try {
  const result = await prefetchRegion({
    root,
    token,
    region: options.region,
    cacheDir,
    terrainMinLevel: options.terrainMinLevel,
    terrainMaxLevel: options.terrainMaxLevel,
    imageryMinLevel: options.imageryMinLevel,
    imageryMaxLevel: options.imageryMaxLevel,
    concurrency: options.concurrency
  })
  const { manifest } = result
  console.log('')
  console.log('[cache] 完成')
  console.log(
    `  地形: ${result.terrainTasks} 块 / ${(manifest.terrain.bytes / 1024 / 1024).toFixed(1)} MB`
  )
  console.log(
    `  影像: ${result.imageryTasks} 块 / ${(manifest.imagery.bytes / 1024 / 1024).toFixed(1)} MB`
  )
  console.log(
    `  新下载 ${result.downloaded} 块，跳过 ${result.skipped} 块，失败 ${result.failed} 块，` +
      `本次写入 ${(result.bytes / 1024 / 1024).toFixed(1)} MB`
  )
  console.log(`  清单: ${path.join(cacheDir, 'manifest.json')}`)
  if (result.failed > 0) process.exitCode = 1
} catch (error) {
  console.error('[cache] 预热失败:', error)
  process.exit(1)
}
