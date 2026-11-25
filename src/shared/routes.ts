import { ASSET_BASE } from './assets'

function devPort(port: string): boolean {
  return port === '5173' || port === '5174'
}

/**
 * 场景页地址。
 * - dev：业务 5173 → 场景 5174；场景自身保持同一地址。
 * - GitHub Pages / 静态：同源同 base，仅带 `?scene=1`。
 */
export function sceneUrl(): string {
  if (import.meta.env.DEV && devPort(window.location.port)) {
    return `${window.location.protocol}//${window.location.hostname}:5174/?scene=1`
  }
  return `${window.location.origin}${ASSET_BASE}?scene=1`
}

/** 业务页地址：dev 场景 5174 → 业务 5173；静态同源 base。 */
export function businessUrl(): string {
  if (import.meta.env.DEV && window.location.port === '5174') {
    return `${window.location.protocol}//${window.location.hostname}:5173/`
  }
  return `${window.location.origin}${ASSET_BASE}`
}
