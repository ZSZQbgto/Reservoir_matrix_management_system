/**
 * 水体编辑器共享类型与常量：状态模型、模拟常量与网格坐标。
 *
 * 本文件是 UI / 模拟 / 渲染三层之间唯一的类型来源：
 * - `src/water/waterEditor.ts` 只读写 `WaterState`；
 * - `src/water/shallowWater.ts` 只消费 `SimTerrain` / `SimSource`；
 * - `src/water/waterSurface.ts` 只消费模拟纹理与 `SurfaceDomain`。
 *
 * 坐标定义（三层共用）：
 * - 模拟域是以 `origin` 为原点、边长 `sizeMeters` 的切平面正方形；
 * - 网格索引 `i` 沿东（+x）从 0 到 N-1，`j` 沿北（+z）从 0 到 N-1；
 * - 纹理 `uv = ((i + 0.5) / N, (j + 0.5) / N)`，即 v=0 是南边、v=1 是北边；
 * - 网格高度为相对域中心椭球高 `baseElevation` 的米数。
 */

export const WATER_STATE_VERSION = 1
export const WATER_STORAGE_KEY = 'tellux-water-editor-v1'
export const WATER_MODE_STORAGE_KEY = 'tellux-water-editor-mode-v1'
export const MAX_WATER_SOURCES = 8

/** 水源半径（米）：数据层允许 20–3000。 */
export const SOURCE_RADIUS_RANGE = { min: 20, max: 3000 } as const

/** 面板滑杆范围 20–2000（窄于数据层上限）。 */
export const SOURCE_RADIUS_PANEL_RANGE = { min: 20, max: 2000 } as const

/** 单个水源每次注水深度（米）：数据层与模拟层共用同一范围。 */
export const SOURCE_AMOUNT_RANGE = { min: 0.5, max: 300 } as const

/** 模拟域固定中心与边长（米）：116.77, 36.02 附近的 8 km × 8 km 区域。 */
export const WATER_DOMAIN = Object.freeze({
  longitude: 116.77,
  latitude: 36.02,
  sizeMeters: 8000
})

/** 模拟网格边长档位。 */
export const SIM_RESOLUTION_OPTIONS = [192, 256, 384] as const

/** 地形高度场采样网格边长（固定 97×97，约 0.2 ms/点）。 */
export const TERRAIN_GRID_SIZE = 97

export const SIM_DEFAULTS = {
  speed: 1,
  waterAmount: 15,
  resolution: 256,
  maxFlowSpeed: 30,
  damping: 0.995,
  injectInterval: 2
} as const

export const VISUAL_DEFAULTS = {
  shimmer: 1,
  glint: 1,
  reflection: 1,
  ripple: 1,
  rippleScale: 1,
  flowSpeed: 1,
  foam: 1,
  clarity: 0.62,
  opacity: 0
} as const

export interface LonLat {
  longitude: number
  latitude: number
}

export interface WaterDomainState extends LonLat {
  /** 模拟域边长（米）。 */
  sizeMeters: number
}

export interface WaterSource {
  id: string
  name: string
  longitude: number
  latitude: number
  /** 注水半径（米）。数据层 20–3000，面板滑块 20–2000。 */
  radius: number
  /** 目标水面绝对椭球高程（米）；null = 不限制。 */
  targetLevel: number | null
  /** 该水源每次注水的水深（米）；null = 跟随 sim.waterAmount。 */
  amount: number | null
  enabled: boolean
  /** 最近一次采样得到的地面绝对高程（米）；用于面板显示与默认目标水位。 */
  groundLevel: number | null
}

export interface WaterSimSettings {
  /** 模拟速度倍率 0.1–64：1× = 实时，每个子步 1/30 s。 */
  speed: number
  /** 每次注水量（米）1–300。 */
  waterAmount: number
  /** 模拟网格边长。 */
  resolution: number
  paused: boolean
  /** 单格允许的最大流速（m/s）5–60：越高水扩散越快，过高会放大数值振荡。 */
  maxFlowSpeed: number
  /** 通量阻尼 0.90–1：按 1/60 s 参考步长做幂补偿，保持每秒衰减不变。 */
  damping: number
  /** 注水间隔 1–8，以 1/60 s 为单位：越小注水越频繁。 */
  injectInterval: number
}

export interface WaterVisualSettings {
  /** 太阳高光强度 0–3。 */
  shimmer: number
  /** 太阳高光锐度 0.3–2.5（越大高光越集中、越锐利）。 */
  glint: number
  /** 天空反射强度 0–1.5（菲涅尔反射混合比例）。 */
  reflection: number
  /** 波纹强度 0–2。 */
  ripple: number
  /** 波纹尺度 0.4–2.5（越大纹理越细）。 */
  rippleScale: number
  /** 波纹平流速度 0–2。 */
  flowSpeed: number
  /** 泡沫强度 0–2。 */
  foam: number
  /** 水体清澈度 0–1。 */
  clarity: number
  /** 水面不透明度 0–1：0 完全沿用清澈度/水深的透明混合，1 深水完全不透明。 */
  opacity: number
}

export interface WaterState {
  version: number
  /** 水体总开关：关闭后不渲染水面、也不推进模拟。 */
  enabled: boolean
  /** 模拟域；null = 尚未建立。 */
  domain: WaterDomainState | null
  sim: WaterSimSettings
  visual: WaterVisualSettings
  sources: WaterSource[]
}

/** 地形高度场：相对 baseElevation 的米数，行主序 `j * N + i`。 */
export interface TerrainField {
  origin: LonLat
  sizeMeters: number
  /** 网格边长（TERRAIN_GRID_SIZE）。 */
  resolution: number
  baseElevation: number
  heights: Float32Array
}

/** 模拟层消费的地形：重采样到模拟分辨率。 */
export interface SimTerrain {
  origin: LonLat
  sizeMeters: number
  /** 模拟网格边长。 */
  resolution: number
  baseElevation: number
  /** length = resolution²，相对 baseElevation 的米数，行主序 `j * N + i`。 */
  heights: Float32Array
}

export interface SimSource {
  /** 相对域中心的东向偏移（米）。 */
  x: number
  /** 相对域中心的北向偏移（米）。 */
  z: number
  radius: number
  /** 目标水面绝对高程（米）；null = 不限制。 */
  targetLevel: number | null
  /** 每次注水水深（米）。 */
  amount: number
  enabled: boolean
}

export interface SimSettings {
  speed: number
  paused: boolean
  waterAmount: number
  maxFlowSpeed: number
  damping: number
  injectInterval: number
}

export interface SimStats {
  steps: number
  wetCells: number
  maxDepth: number
  /** 最近一帧模拟 GPU 耗时（毫秒，估算值）。 */
  simMs: number
}

/** 水面渲染层消费的域信息。 */
export interface SurfaceDomain {
  origin: LonLat
  sizeMeters: number
  resolution: number
  baseElevation: number
}

/**
 * 显式 `.ts` 后缀：`tests/` 用 Node 原生类型剥离直接运行本文件，
 * Node ESM 不做无后缀解析（应用侧其余模块仍按 Vite 约定省略后缀）。
 */
import { clamp } from '../shared/math.ts'

export { clamp }

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 有限数则原样返回，否则返回 null（用于校验外部数据）。 */
export function toFiniteNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null
}

export function nearestOption<T extends number>(
  options: readonly T[],
  value: unknown,
  fallback: T
): T {
  if (!isFiniteNumber(value)) return fallback
  const first = options[0]
  if (first === undefined) return fallback
  let best = first
  let bestDistance = Number.POSITIVE_INFINITY
  for (const option of options) {
    const distance = Math.abs(option - value)
    if (distance < bestDistance) {
      best = option
      bestDistance = distance
    }
  }
  return best
}

let sourceCounter = 0

/** 水源 id 会写进 DOM 属性与调试 API，只接受字母 / 数字 / 下划线 / 连字符。 */
const SOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function createSourceId(): string {
  sourceCounter += 1
  return `wsrc_${Date.now().toString(36)}_${sourceCounter.toString(36)}`
}

/** 深拷贝，避免 UI 与运行时共享可变对象。 */
export function cloneState(state: WaterState): WaterState {
  return {
    version: state.version,
    enabled: state.enabled,
    domain: state.domain ? { ...state.domain } : null,
    sim: { ...state.sim },
    visual: { ...state.visual },
    sources: state.sources.map((source) => ({ ...source }))
  }
}

export function createDefaultState(): WaterState {
  return {
    version: WATER_STATE_VERSION,
    enabled: true,
    domain: null,
    sim: { ...SIM_DEFAULTS, paused: false },
    visual: { ...VISUAL_DEFAULTS },
    sources: []
  }
}

/** 校验并归一化来自 localStorage / 导入文件的任意 JSON。 */
export function normalizeWaterState(raw: unknown): WaterState {
  const defaults = createDefaultState()
  if (!raw || typeof raw !== 'object') return defaults
  const input = raw as Record<string, unknown>

  const enabled = typeof input.enabled === 'boolean' ? input.enabled : defaults.enabled

  let domain: WaterDomainState | null = null
  const rawDomain = input.domain
  if (rawDomain && typeof rawDomain === 'object') {
    // 域中心与尺寸取当前常量；旧工程/旧尺寸统一迁移到该区域。
    domain = { ...WATER_DOMAIN }
  }

  const rawSim =
    input.sim && typeof input.sim === 'object' ? (input.sim as Record<string, unknown>) : {}
  const sim: WaterSimSettings = {
    speed: isFiniteNumber(rawSim.speed) ? clamp(rawSim.speed, 0.1, 64) : defaults.sim.speed,
    waterAmount: isFiniteNumber(rawSim.waterAmount)
      ? clamp(rawSim.waterAmount, 1, 300)
      : defaults.sim.waterAmount,
    resolution: nearestOption(SIM_RESOLUTION_OPTIONS, rawSim.resolution, 256),
    paused: rawSim.paused === true,
    maxFlowSpeed: isFiniteNumber(rawSim.maxFlowSpeed)
      ? clamp(rawSim.maxFlowSpeed, 5, 60)
      : defaults.sim.maxFlowSpeed,
    damping: isFiniteNumber(rawSim.damping) ? clamp(rawSim.damping, 0.9, 1) : defaults.sim.damping,
    injectInterval: isFiniteNumber(rawSim.injectInterval)
      ? Math.round(clamp(rawSim.injectInterval, 1, 8))
      : defaults.sim.injectInterval
  }

  const rawVisual =
    input.visual && typeof input.visual === 'object'
      ? (input.visual as Record<string, unknown>)
      : {}
  // 兼容短暂的布尔版本工程（opaque: true/false）。
  const opacity = isFiniteNumber(rawVisual.opacity)
    ? clamp(rawVisual.opacity, 0, 1)
    : rawVisual.opaque === true
      ? 1
      : defaults.visual.opacity
  const visual: WaterVisualSettings = {
    shimmer: isFiniteNumber(rawVisual.shimmer)
      ? clamp(rawVisual.shimmer, 0, 3)
      : defaults.visual.shimmer,
    glint: isFiniteNumber(rawVisual.glint)
      ? clamp(rawVisual.glint, 0.3, 2.5)
      : defaults.visual.glint,
    reflection: isFiniteNumber(rawVisual.reflection)
      ? clamp(rawVisual.reflection, 0, 1.5)
      : defaults.visual.reflection,
    ripple: isFiniteNumber(rawVisual.ripple)
      ? clamp(rawVisual.ripple, 0, 2)
      : defaults.visual.ripple,
    rippleScale: isFiniteNumber(rawVisual.rippleScale)
      ? clamp(rawVisual.rippleScale, 0.4, 2.5)
      : defaults.visual.rippleScale,
    flowSpeed: isFiniteNumber(rawVisual.flowSpeed)
      ? clamp(rawVisual.flowSpeed, 0, 2)
      : defaults.visual.flowSpeed,
    foam: isFiniteNumber(rawVisual.foam) ? clamp(rawVisual.foam, 0, 2) : defaults.visual.foam,
    clarity: isFiniteNumber(rawVisual.clarity)
      ? clamp(rawVisual.clarity, 0, 1)
      : defaults.visual.clarity,
    opacity
  }

  const sources: WaterSource[] = []
  if (Array.isArray(input.sources)) {
    for (const item of input.sources) {
      if (sources.length >= MAX_WATER_SOURCES) break
      if (!item || typeof item !== 'object') continue
      const s = item as Record<string, unknown>
      if (!isFiniteNumber(s.longitude) || !isFiniteNumber(s.latitude)) continue
      if (Math.abs(s.longitude) > 180 || Math.abs(s.latitude) > 85) continue
      const targetLevel =
        isFiniteNumber(s.targetLevel) && s.targetLevel > -1000 && s.targetLevel < 20000
          ? s.targetLevel
          : null
      const amount =
        isFiniteNumber(s.amount) &&
        s.amount >= SOURCE_AMOUNT_RANGE.min &&
        s.amount <= SOURCE_AMOUNT_RANGE.max
          ? s.amount
          : null
      const groundLevel = isFiniteNumber(s.groundLevel) ? s.groundLevel : null
      sources.push({
        id: typeof s.id === 'string' && SOURCE_ID_PATTERN.test(s.id) ? s.id : createSourceId(),
        name:
          typeof s.name === 'string' && s.name.trim()
            ? s.name.trim().slice(0, 40)
            : `水源 ${sources.length + 1}`,
        longitude: clamp(s.longitude, -180, 180),
        latitude: clamp(s.latitude, -85, 85),
        radius: isFiniteNumber(s.radius)
          ? clamp(s.radius, SOURCE_RADIUS_RANGE.min, SOURCE_RADIUS_RANGE.max)
          : 150,
        targetLevel,
        amount,
        enabled: s.enabled !== false,
        groundLevel
      })
    }
  }

  return {
    version: WATER_STATE_VERSION,
    enabled,
    domain,
    sim,
    visual,
    sources
  }
}
