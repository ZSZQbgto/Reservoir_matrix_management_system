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
  console.error(
    `[pages] 缺少 ${imageryDir}。请先运行 \`npm run cache:prefetch\` 生成影像缓存。`
  )
  process.exit(1)
}

const terrainUsage = copyDirectory(
  terrainDir,
  path.join(distDir, 'terrain-cache'),
  'terrain-cache'
)
const imageryUsage = copyDirectory(
  imageryDir,
  path.join(distDir, 'imagery-cache'),
  'imagery-cache'
)
// layer.json 之外至少要有一块地形；影像缓存为空同样不能发布。
if (terrainUsage.files < 2 || imageryUsage.files === 0) {
  console.error(
    '[pages] 瓦片缓存不完整（地形或影像为空）。请重新运行 `npm run cache:prefetch` 后重试。'
  )
  process.exit(1)
}

// GitHub Pages 不需要 Jekyll；显式放一个标记也避免旧流程误处理资产目录。
fs.writeFileSync(path.join(distDir, '.nojekyll'), '')

const total = directoryUsage(distDir)
const basePath = process.env.BASE_PATH || '/'
console.log(
  `[pages] 静态站点就绪：dist/ 共 ${total.files} 个文件 / ` +
    `${(total.bytes / 1024 / 1024).toFixed(1)} MB，base=${basePath}`
)
