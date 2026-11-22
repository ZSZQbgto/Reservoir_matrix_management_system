import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTileCache } from './scripts/tile-cache.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

/**
 * 站点基础路径。
 *
 * 本地 / 自建服务器：`/`；GitHub Pages 项目站点：`/<仓库名>/`。
 * 由 CI 的 `BASE_PATH` 环境变量注入，构建产物里的资源、瓦片端点与运行时
 * `import.meta.env.BASE_URL` 都会使用同一前缀。
 */
function resolveBasePath(): string {
  const raw = process.env.BASE_PATH?.trim()
  if (!raw || raw === '/') return '/'
  return `/${raw.replace(/^\/+|\/+$/g, '')}/`
}

/**
 * dev / preview 服务器上的地形与影像本地缓存中间件。
 *
 * 优先从 `.cache/tiles` 返回 Cesium 地形 / ArcGIS 影像瓦片，缺块时回源并写盘，
 * 与生产服务器（`server.mjs`）共用同一套 `tile-cache` 实现。
 */
function tileCachePlugin(token: string): Plugin {
  const cache = createTileCache({ root: rootDir, token })
  const middleware: Connect.NextHandleFunction = async (req, res, next) => {
    if (!req.url) return next()
    try {
      const handled = await cache.handle(req, res, new URL(req.url, 'http://127.0.0.1'))
      if (!handled) next()
    } catch (error) {
      next(error as Error)
    }
  }
  return {
    name: 'tellux-local-tile-cache',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    root: rootDir,
    base: resolveBasePath(),
    envDir: rootDir,
    plugins: [tileCachePlugin(env.CESIUM_ION_TOKEN || '')],
    resolve: {
      dedupe: ['three']
    },
    optimizeDeps: {
      // Tellux 用 `new URL('./assets/tellux/…', import.meta.url)` 解析内置云/星空
      // 纹理。预打包会把 import.meta.url 指向 .vite/deps，纹理 URL 随之失效
      // （dev 下体积云/星空贴图 404）。排除预打包后资源路径保持真实，dev 才能
      // 正常渲染体积云与夜空。
      exclude: ['tellux', 'three']
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      watch: {
        // 文件写入工具会在源目录旁生成临时目录；Windows 上被 Vite 的文件监听
        // 捕获会抛 EBUSY 并直接退出 dev server，这里忽略这些临时产物。
        ignored: ['**/*.tmpdir/**', '**/.tmp/**', '**/node_modules/**', '**/dist/**']
      },
      fs: {
        allow: [rootDir]
      }
    },
    preview: {
      host: '127.0.0.1',
      port: 4173
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 4096
    }
  }
})
