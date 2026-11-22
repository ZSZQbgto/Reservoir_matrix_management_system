/**
 * 静态资源路径。
 *
 * 本地 / 自建服务器部署时基础路径是 `/`；GitHub Pages 项目站点是
 * `/<仓库名>/`。所有 public 资源与静态瓦片端点都必须经 `assetPath` 拼接，
 * 不要在代码里写死根路径，否则子路径部署会整站 404。
 */
export const ASSET_BASE = import.meta.env.BASE_URL

/** 把 `terrain-cache/layer.json` 这类相对路径拼到当前基础路径下。 */
export function assetPath(path: string): string {
  return `${ASSET_BASE}${path.replace(/^\/+/, '')}`
}

/**
 * 是否纯静态托管（GitHub Pages）：没有 `/domain-cache` 等服务端接口，
 * 由构建时注入 `VITE_STATIC_HOST=1`。
 */
export const STATIC_HOST = import.meta.env.VITE_STATIC_HOST === '1'
