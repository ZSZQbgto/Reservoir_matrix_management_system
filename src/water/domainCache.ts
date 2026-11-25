import { TERRAIN_GRID_SIZE, WATER_DOMAIN, type TerrainField } from './types'
import { STATIC_HOST, assetPath } from '../shared/assets'

/**
 * 固定模拟域地形高度场的本地存储。
 *
 * 模拟域地形高度场（97 × 97，相对域中心椭球高的 Float32 米数）一经采样就同时写入：
 * - 浏览器 localStorage（键 `tellux-water-domain-v1`，约 50 KB）；
 * - 服务器本地缓存 `.cache/tiles/domain/domain.json`（跨浏览器/清空浏览器缓存后仍可恢复）。
 *
 * 再次进入或刷新时直接恢复，跳过相机飞行与地形采样。
 */
export const WATER_DOMAIN_CACHE_KEY = 'tellux-water-domain-v1'
export const WATER_DOMAIN_SERVER_URL = assetPath('domain-cache/domain.json')
const CACHE_VERSION = 1
const HEIGHTS_BASE64_CHUNK = 0x8000

interface CachedDomainPayload {
  version: number
  center: { longitude: number; latitude: number }
  sizeMeters: number
  resolution: number
  baseElevation: number
  savedAt: string
  heights: string
}

export interface CachedDomainInfo {
  resolution: number
  sizeMeters: number
  center: { longitude: number; latitude: number }
  baseElevation: number
  savedAt: string
  bytes: number
}

function encodeHeights(heights: Float32Array): string {
  const bytes = new Uint8Array(heights.length * 4)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < heights.length; i += 1) view.setFloat32(i * 4, heights[i]!, true)
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += HEIGHTS_BASE64_CHUNK) {
    const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + HEIGHTS_BASE64_CHUNK))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function decodeHeights(base64: string, resolution: number): Float32Array | null {
  let binary = ''
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const expectedBytes = resolution * resolution * 4
  if (binary.length !== expectedBytes) return null
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const view = new DataView(bytes.buffer)
  const heights = new Float32Array(resolution * resolution)
  for (let i = 0; i < heights.length; i += 1) {
    const value = view.getFloat32(i * 4, true)
    if (!Number.isFinite(value)) return null
    heights[i] = value
  }
  return heights
}

function createPayload(field: TerrainField): CachedDomainPayload | null {
  if (!field || field.resolution !== TERRAIN_GRID_SIZE) return null
  if (field.heights.length !== field.resolution * field.resolution) return null
  if (!Number.isFinite(field.baseElevation)) return null
  return {
    version: CACHE_VERSION,
    center: { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
    sizeMeters: WATER_DOMAIN.sizeMeters,
    resolution: field.resolution,
    baseElevation: field.baseElevation,
    savedAt: new Date().toISOString(),
    heights: encodeHeights(field.heights)
  }
}

function fieldFromPayload(payload: unknown): TerrainField | null {
  const data = payload as CachedDomainPayload
  if (!data || data.version !== CACHE_VERSION) return null
  if (
    !data.center ||
    typeof data.center.longitude !== 'number' ||
    typeof data.center.latitude !== 'number' ||
    Math.abs(data.center.longitude - WATER_DOMAIN.longitude) > 1e-9 ||
    Math.abs(data.center.latitude - WATER_DOMAIN.latitude) > 1e-9
  ) {
    return null
  }
  if (data.sizeMeters !== WATER_DOMAIN.sizeMeters) return null
  if (data.resolution !== TERRAIN_GRID_SIZE) return null
  if (typeof data.baseElevation !== 'number' || !Number.isFinite(data.baseElevation)) return null
  if (typeof data.heights !== 'string' || data.heights.length === 0) return null
  const heights = decodeHeights(data.heights, data.resolution)
  if (!heights) return null
  return {
    origin: { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
    sizeMeters: WATER_DOMAIN.sizeMeters,
    resolution: data.resolution,
    baseElevation: data.baseElevation,
    heights
  }
}

/** 读取浏览器 localStorage 中的地形高度场；版本/中心/尺寸/分辨率不匹配或损坏时返回 null。 */
export function loadCachedDomainField(): TerrainField | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(WATER_DOMAIN_CACHE_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    return fieldFromPayload(JSON.parse(raw))
  } catch {
    return null
  }
}

/** 把地形高度场写入浏览器 localStorage；配额不足或不可用时返回 false。 */
export function saveCachedDomainField(field: TerrainField): boolean {
  const payload = createPayload(field)
  if (!payload) return false
  try {
    localStorage.setItem(WATER_DOMAIN_CACHE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

export function clearCachedDomainField(): void {
  try {
    localStorage.removeItem(WATER_DOMAIN_CACHE_KEY)
  } catch {
    // localStorage 不可用时无需处理。
  }
}

/** 读取本地缓存元信息（不解析高度场），用于面板/调试展示。 */
export function getCachedDomainInfo(): CachedDomainInfo | null {
  try {
    const raw = localStorage.getItem(WATER_DOMAIN_CACHE_KEY)
    if (!raw) return null
    const payload = JSON.parse(raw) as CachedDomainPayload
    if (!payload || payload.version !== CACHE_VERSION) return null
    if (payload.resolution !== TERRAIN_GRID_SIZE) return null
    if (payload.sizeMeters !== WATER_DOMAIN.sizeMeters) return null
    return {
      resolution: payload.resolution,
      sizeMeters: payload.sizeMeters,
      center: { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
      baseElevation: payload.baseElevation,
      savedAt: payload.savedAt,
      bytes: raw.length
    }
  } catch {
    return null
  }
}

/** 服务器缓存请求超时（ms）：本地中间件假死时不能让建域流程永久停在进度条上。 */
const SERVER_FETCH_TIMEOUT_MS = 4000

/**
 * 带超时的 fetch。
 *
 * `AbortSignal.timeout` 在旧 Safari 上不存在，此时退回无信号请求，
 * 保持原来的「失败即降级」行为而不是抛错。
 */
function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const signal =
    typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS)
      : undefined
  return fetch(input, { ...init, signal })
}

/** 从服务器本地缓存（.cache/tiles/domain）读取模拟域地形；不可用时返回 null。 */
export async function fetchServerDomainField(): Promise<TerrainField | null> {
  // 纯静态托管（GitHub Pages）没有该接口，直接用浏览器缓存 / 现场采样。
  if (STATIC_HOST) return null
  try {
    const response = await fetchWithTimeout(WATER_DOMAIN_SERVER_URL, { cache: 'no-store' })
    if (!response.ok) return null
    return fieldFromPayload(await response.json())
  } catch (error) {
    console.warn('[domainCache] 服务器缓存不可用，改用浏览器缓存或现场采样', error)
    return null
  }
}

/** 把模拟域地形写入服务器本地缓存（跨浏览器共享）；失败时静默返回 false。 */
export async function saveDomainFieldToServer(field: TerrainField): Promise<boolean> {
  if (STATIC_HOST) return false
  const payload = createPayload(field)
  if (!payload) return false
  try {
    const response = await fetchWithTimeout(WATER_DOMAIN_SERVER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    })
    return response.ok
  } catch (error) {
    console.warn('[domainCache] 写入服务器缓存失败', error)
    return false
  }
}

/** 清除服务器本地缓存中的模拟域地形（下次进入会重新采样）。 */
export async function clearServerDomainField(): Promise<boolean> {
  if (STATIC_HOST) return false
  try {
    const response = await fetchWithTimeout(WATER_DOMAIN_SERVER_URL, { method: 'DELETE' })
    return response.ok
  } catch (error) {
    console.warn('[domainCache] 清除服务器缓存失败', error)
    return false
  }
}
