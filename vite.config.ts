import { defineConfig, loadEnv, type Connect, type Plugin, type ProxyOptions } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTileCache } from './scripts/tile-cache.mjs'

const rootDir = dirname(fileURLToPath(import.meta.url))

/**
 * dev / preview 服务器上的地形与影像本地缓存中间件：
 * 优先从 `.cache/tiles` 返回 Cesium 地形 / ArcGIS 影像瓦片，缺块时回源并写盘。
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

function tiandituProxy(referer: string, subdomain: string, token: string): ProxyOptions {
  const origin = (() => {
    try {
      return new URL(referer).origin
    } catch {
      return 'https://tellux.cyanfish.site'
    }
  })()

  return {
    target: `https://t${subdomain}.tianditu.gov.cn`,
    changeOrigin: true,
    rewrite: (path) => path.replace(new RegExp(`^/tianditu/${subdomain}`), ''),
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq) => {
        if (proxyReq.headersSent) return
        proxyReq.setHeader('Referer', referer)
        proxyReq.setHeader('Origin', origin)
        if (token) {
          const rewritten = new URL(proxyReq.path || '/', 'http://localhost')
          const requested = rewritten.searchParams.get('tk')
          if (!requested || requested === 'proxy') {
            rewritten.searchParams.set('tk', token)
            proxyReq.path = `${rewritten.pathname}${rewritten.search}`
          }
        }
      })
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const referer = env.TIANDITU_REFERER || 'https://tellux.cyanfish.site/'
  const tiandituToken = env.TIANDITU_TOKEN || ''
  const mapTilerKey = env.MAPTILER_KEY || ''
  const subdomains = ['0', '1', '2', '3', '4', '5', '6', '7']

  const proxy: Record<string, ProxyOptions> = {}
  for (const subdomain of subdomains) {
    proxy[`/tianditu/${subdomain}`] = tiandituProxy(referer, subdomain, tiandituToken)
  }
  proxy['/maptiler'] = {
    target: 'https://api.maptiler.com',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/maptiler/, ''),
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        if (proxyReq.headersSent) return
        if (!mapTilerKey) return
        const url = new URL(req.url || '/', 'http://localhost')
        if (!url.searchParams.has('key')) {
          const next = new URL(req.url || '/', 'http://localhost')
          next.searchParams.set('key', mapTilerKey)
          proxyReq.path = `${next.pathname}${next.search}`
        }
      })
    }
  }

  return {
    root: rootDir,
    base: '/',
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
      proxy,
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
      port: 4173,
      proxy
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 4096
    },
    define: {
      __TIANDITU_TOKEN_CONFIGURED__: JSON.stringify(Boolean(tiandituToken)),
      __MAPTILER_CONFIGURED__: JSON.stringify(Boolean(mapTilerKey))
    }
  }
})
