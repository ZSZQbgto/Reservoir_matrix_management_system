#!/usr/bin/env node
/**
 * 把本地瓦片缓存导出为纯静态站点资源，供 GitHub Pages 等静态托管使用。
 *
 * `vite build` 只会把 `public/` 和源码产物写进 `dist/`；地形 / 影像瓦片在
 * `.cache/tiles` 里，需要单独拷贝成与运行时端点一致的路径：
 *
 *   .cache/tiles/terrain  -> dist/terrain-cache
 *   .cache/tiles/imagery  -> dist/imagery-cache
 *
 * 模拟域地形缓存（domain/domain.json）是服务端接口，纯静态托管下由客户端
 * localStorage + 现场采样替代，因此不导出。
 *
 * 用法：npm run build:pages（内部先 vite build，再执行本脚本）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const distDir = path.join(root, 'dist')
const cacheDir = process.env.TILE_CACHE_DIR
  ? path.resolve(process.env.TILE_CACHE_DIR)
  : path.join(root, '.cache', 'tiles')

function directoryUsage(dir) {
  let files = 0
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
        files += 1
        bytes += fs.statSync(full).size
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

function copyDirectory(source, target, label) {
  fs.rmSync(target, { recursive: true, force: true })
  fs.cpSync(source, target, { recursive: true })
  const usage = directoryUsage(target)
  console.log(
    `[pages] ${label}: ${usage.files} 个文件 / ${(usage.bytes / 1024 / 1024).toFixed(1)} MB`
  )
  return usage
}

/**
 * 按实际导出的瓦片重写 layer.json 的 available / maxzoom。
 *
 * Cesium 原始 layer.json 描述整颗地球（约 900 KB、到 19 级），静态站点只带
 * 50 km 范围内的瓦片；不裁剪的话浏览器会不断请求未缓存的层级和范围，地形
 * 看起来会一直加载。这里扫描真实存在的 .terrain 文件生成精确可用范围。
 */
function rewriteStaticTerrainLayer(terrainDir) {
  const layerPath = path.join(terrainDir, 'layer.json')
  const layer = JSON.parse(fs.readFileSync(layerPath, 'utf8'))
  const levelsByNumber = new Map()

  for (const levelEntry of fs.readdirSync(terrainDir, { withFileTypes: true })) {
    if (!levelEntry.isDirectory() || !/^\d+$/.test(levelEntry.name)) continue
    const level = Number(levelEntry.name)
    const levelDir = path.join(terrainDir, levelEntry.name)
    const rows = []

    for (const xEntry of fs.readdirSync(levelDir, { withFileTypes: true })) {
      if (!xEntry.isDirectory() || !/^\d+$/.test(xEntry.name)) continue
      const x = Number(xEntry.name)
      const ys = fs
        .readdirSync(path.join(levelDir, xEntry.name))
        .filter((name) => /^\d+\.terrain$/.test(name))
        .map((name) => Number(name.slice(0, -'.terrain'.length)))
        .sort((a, b) => a - b)
      if (ys.length === 0) continue

      const runs = []
      let start = ys[0]
      let previous = ys[0]
      for (let i = 1; i < ys.length; i += 1) {
        if (ys[i] === previous + 1) {
          previous = ys[i]
          continue
        }
        runs.push([start, previous])
        start = ys[i]
        previous = ys[i]
      }
      runs.push([start, previous])
      rows.push({ x, runs })
    }

    rows.sort((a, b) => a.x - b.x)
    const sameRuns = (a, b) =>
      a.length === b.length &&
      a.every((run, index) => run[0] === b[index][0] && run[1] === b[index][1])
    const ranges = []
    let block = null
    const flushBlock = () => {
      if (!block) return
      for (const [startY, endY] of block.runs) {
        ranges.push({ startX: block.startX, startY, endX: block.endX, endY })
      }
    }
    for (const row of rows) {
      if (block && row.x === block.endX + 1 && sameRuns(block.runs, row.runs)) {
        block.endX = row.x
        continue
      }
      flushBlock()
      block = { startX: row.x, endX: row.x, runs: row.runs }
    }
    flushBlock()
    levelsByNumber.set(level, ranges)
  }

  const maxLevel = Math.max(...levelsByNumber.keys())
  const available = []
  for (let level = 0; level <= maxLevel; level += 1) {
    available[level] = levelsByNumber.get(level) ?? []
  }
  layer.available = available
  layer.maxzoom = maxLevel
  layer.minzoom = 0
  fs.writeFileSync(layerPath, `${JSON.stringify(layer)}\n`)

  const rangeCount = available.reduce((sum, ranges) => sum + ranges.length, 0)
  console.log(
    `[pages] layer.json: 裁剪到 0-${maxLevel} 级、${rangeCount} 个可用范围 / ` +
      `${(fs.statSync(layerPath).size / 1024).toFixed(1)} KB`
  )
}

if (!fs.existsSync(distDir)) {
  console.error('[pages] dist 不存在，请先运行 vite build。')
  process.exit(1)
}

const terrainDir = path.join(cacheDir, 'terrain')
const imageryDir = path.join(cacheDir, 'imagery')
const layerFile = path.join(terrainDir, 'layer.json')

if (!fs.existsSync(layerFile)) {
  console.error(
    `[pages] 缺少 ${layerFile}。\n` +
      '       静态站点需要预先缓存地形与影像：运行 `npm run cache:prefetch`，' +
      '或在 CI 中配置 CESIUM_ION_TOKEN secret 让工作流自动预热。'
  )
  process.exit(1)
}
if (!fs.existsSync(imageryDir)) {
  console.error(`[pages] 缺少 ${imageryDir}。请先运行 \`npm run cache:prefetch\` 生成影像缓存。`)
  process.exit(1)
}

const staticTerrainDir = path.join(distDir, 'terrain-cache')
const staticImageryDir = path.join(distDir, 'imagery-cache')
const terrainUsage = copyDirectory(terrainDir, staticTerrainDir, 'terrain-cache')
const imageryUsage = copyDirectory(imageryDir, staticImageryDir, 'imagery-cache')
// layer.json 之外至少要有一块地形；影像缓存为空同样不能发布。
if (terrainUsage.files < 2 || imageryUsage.files === 0) {
  console.error(
    '[pages] 瓦片缓存不完整（地形或影像为空）。请重新运行 `npm run cache:prefetch` 后重试。'
  )
  process.exit(1)
}

rewriteStaticTerrainLayer(staticTerrainDir)

// GitHub Pages 不需要 Jekyll；显式放一个标记也避免旧流程误处理资产目录。
fs.writeFileSync(path.join(distDir, '.nojekyll'), '')

const total = directoryUsage(distDir)
const basePath = process.env.BASE_PATH || '/'
console.log(
  `[pages] 静态站点就绪：dist/ 共 ${total.files} 个文件 / ` +
    `${(total.bytes / 1024 / 1024).toFixed(1)} MB，base=${basePath}`
)
