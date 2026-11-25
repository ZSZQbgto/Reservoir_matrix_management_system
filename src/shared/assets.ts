/**
 * 资源基础路径与部署形态。
 *
 * `ASSET_BASE` 来自构建注入的 `import.meta.env.BASE_URL`（本地为 `/`，子路径部署
 * 为 `/<仓库名>/`）；`assetPath` 把相对路径拼到该前缀下，避免根路径写死导致 404。
 */
export const ASSET_BASE = import.meta.env.BASE_URL

/** 把 `terrain-cache/layer.json` 这类相对路径拼到当前基础路径下。 */
export function assetPath(path: string): string {
  return `${ASSET_BASE}${path.replace(/^\/+/, '')}`
}

/**
 * 是否纯静态托管：由构建时注入的 `VITE_STATIC_HOST=1` 判定；为真时不请求
 * `/domain-cache` 等服务端接口。
 */
export const STATIC_HOST = import.meta.env.VITE_STATIC_HOST === '1'
