import type { LonLat, SimTerrain, TerrainField } from './types'
import { TERRAIN_GRID_SIZE } from './types'
import { nextFrame } from './async'

/**
 * 模拟域的切平面近似投影。
 *
 * 所有水源、地形采样网格、模拟网格与水面网格都通过同一组米/度换算，
 * 保证「经纬度 ↔ 域内偏移」在四层之间完全一致。
 */
export interface LocalProjection {
  origin: LonLat
  mPerDegLat: number
  mPerDegLon: number
  /** 经纬度 → 域平面偏移（米，x 东 / z 北）。 */
  toLocal(longitude: number, latitude: number): { x: number; z: number }
  /** 域平面偏移（米）→ 经纬度。 */
  toLonLat(x: number, z: number): LonLat
  /** 偏移是否落在域内（含可选外扩，单位米）。 */
  contains(x: number, z: number, margin?: number): boolean
  sizeMeters: number
}

export function createLocalProjection(origin: LonLat, sizeMeters: number): LocalProjection {
  const latRad = (origin.latitude * Math.PI) / 180
  // WGS84 子午圈 / 卯酉圈在给定纬度的每度弧长（米）。
  const mPerDegLat =
    111132.92 - 559.82 * Math.cos(2 * latRad) + 1.175 * Math.cos(4 * latRad) - 0.0023 * Math.cos(6 * latRad)
  const mPerDegLon =
    111412.84 * Math.cos(latRad) - 93.5 * Math.cos(3 * latRad) + 0.118 * Math.cos(5 * latRad)
  const half = sizeMeters / 2

  return {
    origin,
    sizeMeters,
    mPerDegLat,
    mPerDegLon: Math.max(1, mPerDegLon),
    toLocal(longitude, latitude) {
      return {
        x: (longitude - origin.longitude) * Math.max(1, mPerDegLon),
        z: (latitude - origin.latitude) * mPerDegLat
      }
    },
    toLonLat(x, z) {
      return {
        longitude: origin.longitude + x / Math.max(1, mPerDegLon),
        latitude: origin.latitude + z / mPerDegLat
      }
    },
    contains(x, z, margin = 0) {
      return Math.abs(x) <= half + margin && Math.abs(z) <= half + margin
    }
  }
}

export interface TerrainSampleOptions {
  projection: LocalProjection
  /** 单点高度采样（通常包一层 viewer.sampleHeight）；返回 undefined 表示未命中。 */
  sampleHeight(points: LonLat[]): (number | undefined)[]
  gridSize?: number
  /** 每帧采样行数，控制卡顿；默认 4。 */
  chunkRows?: number
  onProgress?: (completed: number, total: number) => void
  /** 取消令牌：置 true 后尽快返回 null。 */
  cancel?: { cancelled: boolean }
}

/**
 * 沿域平面均匀采样地形高度，返回相对域中心高程的高度场。
 *
 * 采样是同步 GPU/CPU 混合操作（viewer.sampleHeight 约 0.2 ms/点），
 * 因此按行分帧执行，避免长时间冻结页面。
 */
export async function sampleTerrainField(options: TerrainSampleOptions): Promise<TerrainField | null> {
  const { projection, sampleHeight, cancel } = options
  const gridSize = options.gridSize ?? TERRAIN_GRID_SIZE
  const chunkRows = Math.max(1, options.chunkRows ?? 4)
  const total = gridSize * gridSize
  const points: LonLat[] = new Array(total)
  const step = projection.sizeMeters / (gridSize - 1)
  const half = projection.sizeMeters / 2

  for (let j = 0; j < gridSize; j++) {
    const z = -half + j * step
    for (let i = 0; i < gridSize; i++) {
      const x = -half + i * step
      points[j * gridSize + i] = projection.toLonLat(x, z)
    }
  }

  // 域中心点用于确定基准高程，使高度场保持小数值（浮点纹理精度更好）。
  const centerHeight = sampleHeight([projection.origin])[0]
  const heights = new Float32Array(total)
  const found = new Uint8Array(total)
  let completed = 0

  for (let j = 0; j < gridSize; j += chunkRows) {
    if (cancel?.cancelled) return null
    const end = Math.min(gridSize, j + chunkRows)
    const chunk = points.slice(j * gridSize, end * gridSize)
    const samples = sampleHeight(chunk)
    for (let k = 0; k < samples.length; k++) {
      const value = samples[k]
      if (typeof value === 'number' && Number.isFinite(value)) {
        const index = j * gridSize + k
        heights[index] = value
        found[index] = 1
      }
    }
    completed = end * gridSize
    options.onProgress?.(completed, total)
    await nextFrame()
  }

  if (cancel?.cancelled) return null

  let baseElevation = typeof centerHeight === 'number' && Number.isFinite(centerHeight) ? centerHeight : Number.NaN
  if (!Number.isFinite(baseElevation)) {
    let sum = 0
    let count = 0
    for (let i = 0; i < total; i++) {
      if (found[i]) {
        sum += heights[i]
        count += 1
      }
    }
    baseElevation = count > 0 ? sum / count : 0
  }

  fillMissingHeights(heights, found, gridSize)
  for (let i = 0; i < total; i++) heights[i] -= baseElevation

  return {
    origin: projection.origin,
    sizeMeters: projection.sizeMeters,
    resolution: gridSize,
    baseElevation,
    heights
  }
}

/**
 * 用最近的有效邻格补洞（迭代扩散）；整片无数据时全部补 0（平地形兜底）。
 */
function fillMissingHeights(heights: Float32Array, found: Uint8Array, gridSize: number): void {
  const total = gridSize * gridSize
  let missing = 0
  for (let i = 0; i < total; i++) if (!found[i]) missing += 1
  if (missing === 0) return
  if (missing === total) return

  let frontier: number[] = []
  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const index = j * gridSize + i
      if (found[index]) continue
      const neighbors: number[] = []
      if (i > 0 && found[index - 1]) neighbors.push(index - 1)
      if (i < gridSize - 1 && found[index + 1]) neighbors.push(index + 1)
      if (j > 0 && found[index - gridSize]) neighbors.push(index - gridSize)
      if (j < gridSize - 1 && found[index + gridSize]) neighbors.push(index + gridSize)
      if (neighbors.length === 0) continue
      let sum = 0
      for (const n of neighbors) sum += heights[n]
      heights[index] = sum / neighbors.length
      found[index] = 2
      missing -= 1
      frontier.push(index)
    }
  }
  while (missing > 0 && frontier.length > 0) {
    const next: number[] = []
    for (const index of frontier) {
      const j = Math.floor(index / gridSize)
      const i = index % gridSize
      const candidates: Array<[number, number]> = [
        [i - 1, j],
        [i + 1, j],
        [i, j - 1],
        [i, j + 1]
      ]
      for (const [ni, nj] of candidates) {
        if (ni < 0 || nj < 0 || ni >= gridSize || nj >= gridSize) continue
        const nIndex = nj * gridSize + ni
        if (found[nIndex]) continue
        heights[nIndex] = heights[index]
        found[nIndex] = 2
        missing -= 1
        next.push(nIndex)
      }
    }
    frontier = next
  }
}

/**
 * 把地形高度场双线性重采样到模拟分辨率；模拟层不直接持有 97² 原场。
 */
export function resampleTerrain(field: TerrainField, resolution: number): SimTerrain {
  const src = field.resolution
  const dst = resolution
  const heights = new Float32Array(dst * dst)
  if (src === dst) {
    heights.set(field.heights)
  } else {
    const scale = (src - 1) / (dst - 1)
    for (let j = 0; j < dst; j++) {
      const sy = j * scale
      const y0 = Math.min(src - 1, Math.floor(sy))
      const y1 = Math.min(src - 1, y0 + 1)
      const fy = sy - y0
      for (let i = 0; i < dst; i++) {
        const sx = i * scale
        const x0 = Math.min(src - 1, Math.floor(sx))
        const x1 = Math.min(src - 1, x0 + 1)
        const fx = sx - x0
        const h00 = field.heights[y0 * src + x0]
        const h10 = field.heights[y0 * src + x1]
        const h01 = field.heights[y1 * src + x0]
        const h11 = field.heights[y1 * src + x1]
        heights[j * dst + i] = (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy
      }
    }
  }
  return {
    origin: field.origin,
    sizeMeters: field.sizeMeters,
    resolution,
    baseElevation: field.baseElevation,
    heights
  }
}

/** 双线性读取域内任意位置的地形相对高度（米）；域外按边缘钳制。 */
export function sampleFieldHeight(field: TerrainField | SimTerrain, x: number, z: number): number {
  const n = field.resolution
  const half = field.sizeMeters / 2
  const gx = ((x + half) / field.sizeMeters) * (n - 1)
  const gz = ((z + half) / field.sizeMeters) * (n - 1)
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(gx)))
  const z0 = Math.max(0, Math.min(n - 1, Math.floor(gz)))
  const x1 = Math.min(n - 1, x0 + 1)
  const z1 = Math.min(n - 1, z0 + 1)
  const fx = Math.max(0, Math.min(1, gx - x0))
  const fz = Math.max(0, Math.min(1, gz - z0))
  const h00 = field.heights[z0 * n + x0]
  const h10 = field.heights[z0 * n + x1]
  const h01 = field.heights[z1 * n + x0]
  const h11 = field.heights[z1 * n + x1]
  return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
}
