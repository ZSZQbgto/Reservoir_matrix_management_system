import { defineConfig, loadEnv, type ProxyOptions } from 'vite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))

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
    resolve: {
      dedupe: ['three']
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy,
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
