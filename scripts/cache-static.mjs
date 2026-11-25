#!/usr/bin/env node
/**
 * 静态站点（GitHub Pages）的瓦片预热。
 *
 * 只预热区域高层级不够：Cesium 会先请求全球低层级瓦片作为金字塔根节点，
 * 缺失时会出现“只有水库附近有地形、没有卫星底图”。因此分两段预热：
 *
 * 1. 全球低层级：地形 0-4、影像 0-4（数量小，保证地球/远景有底图）；
 * 2. 目标区域高层级：地形 5-14、影像 5-15（覆盖初始视角与模拟域）。
 *
 * 区域中心取 `DEFAULT_REGION`（116.77, 36.02）；区域边长、最大层级与并发可用环境变量
 * PREFETCH_SIZE / PREFETCH_TERRAIN_MAX / PREFETCH_IMAGERY_MAX / PREFETCH_CONCURRENCY 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_REGION, prefetchRegion } from './tile-cache.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const GLOBAL_MIN_LEVEL = 0
const GLOBAL_MAX_LEVEL = 4
const REGION_MIN_LEVEL = 5

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

function readNumber(key, fallback) {
  const raw = readEnv(key)
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

const token = readEnv('CESIUM_ION_TOKEN')
if (!token) {
  console.error(
    '[cache-static] 未找到 CESIUM_ION_TOKEN（.env 或环境变量），无法下载 Cesium World Terrain。'
  )
  process.exit(1)
}

const sizeMeters = Math.max(1000, readNumber('PREFETCH_SIZE', DEFAULT_REGION.sizeMeters))
const terrainMaxLevel = Math.max(
  GLOBAL_MAX_LEVEL,
  Math.round(readNumber('PREFETCH_TERRAIN_MAX', 14))
)
const imageryMaxLevel = Math.max(
  GLOBAL_MAX_LEVEL,
  Math.round(readNumber('PREFETCH_IMAGERY_MAX', 15))
)
const concurrency = Math.max(1, Math.min(16, Math.round(readNumber('PREFETCH_CONCURRENCY', 8))))
const common = { root, token, concurrency }

console.log(
  `[cache-static] 全球低层：地形 ${GLOBAL_MIN_LEVEL}-${GLOBAL_MAX_LEVEL} / ` +
    `影像 ${GLOBAL_MIN_LEVEL}-${GLOBAL_MAX_LEVEL}`
)
console.log(
  `[cache-static] 目标区域：${DEFAULT_REGION.longitude},${DEFAULT_REGION.latitude} ` +
    `${(sizeMeters / 1000).toFixed(0)} km · 地形 ${REGION_MIN_LEVEL}-${terrainMaxLevel} / ` +
    `影像 ${REGION_MIN_LEVEL}-${imageryMaxLevel}`
)

let failed = 0
const globalResult = await prefetchRegion({
  ...common,
  // 40,000 km 的区域会在 regionBounds 里裁剪到整个世界。
  region: { longitude: 0, latitude: 0, sizeMeters: 40_000_000 },
  terrainMinLevel: GLOBAL_MIN_LEVEL,
  terrainMaxLevel: GLOBAL_MAX_LEVEL,
  imageryMinLevel: GLOBAL_MIN_LEVEL,
  imageryMaxLevel: GLOBAL_MAX_LEVEL
})
failed += globalResult.failed

const regionResult = await prefetchRegion({
  ...common,
  region: { ...DEFAULT_REGION, sizeMeters },
  terrainMinLevel: REGION_MIN_LEVEL,
  terrainMaxLevel: terrainMaxLevel,
  imageryMinLevel: REGION_MIN_LEVEL,
  imageryMaxLevel: imageryMaxLevel
})
failed += regionResult.failed

if (failed > 0) {
  console.error(`[cache-static] 有 ${failed} 块瓦片下载失败，请重试。`)
  process.exitCode = 1
} else {
  console.log('[cache-static] 完成')
}
