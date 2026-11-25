/**
 * 体积云的高级数值调参。
 *
 * Tellux 公开的 `scene.clouds` 只提供覆盖率、层高、质量档等少量参数；底层的
 * Takram `CloudsEffect` 还有光线步进、散射/吸收、湍流位移等直接决定性能与
 * 云体外观的数值参数。这里通过 Tellux 内部的 `atmosphere.cloudsEffect`
 * 访问它们，并做字段探测：探测失败时返回 null，界面隐藏这组滑杆。
 *
 * 注意：`CloudsEffect.resolutionScale` 在 Tellux 初始化后再改会让整帧变黑
 * （后处理尺寸与合成器不同步），因此这里不暴露它；性能档位统一用步进参数控制。
 */
import type { Viewer } from 'tellux'
import type { CloudsEffect } from '@takram/three-clouds'
import { clamp } from '../shared/math'

export interface CloudTuning {
  /** 主光线最小步长 30–150 m：越大采样越少、越省 GPU，但可能出现步进纹。 */
  minStepSize: number
  /** 主光线步进上限 120–500：直接决定每像素采样成本。 */
  maxIterationCount: number
  /** 太阳方向步进上限 0–4：越大阴影/透光越准，开销越高。 */
  maxIterationCountToSun: number
  /** 散射系数 0.2–2：云体亮度与厚重感。 */
  scatteringCoefficient: number
  /** 吸收系数 0–0.5：云体自遮挡与暗部厚度。 */
  absorptionCoefficient: number
  /** 湍流位移（米）0–1000：湍流开启时的形体扰动幅度。 */
  turbulenceDisplacement: number
}

/** 新装默认值：相对 high 预设放宽步进，约省三成云渲染成本。 */
export const CLOUD_TUNING_DEFAULTS: CloudTuning = {
  minStepSize: 60,
  maxIterationCount: 400,
  maxIterationCountToSun: 2,
  scatteringCoefficient: 1,
  absorptionCoefficient: 0,
  turbulenceDisplacement: 350
}

export const CLOUD_TUNING_RANGES = {
  minStepSize: { min: 30, max: 150 },
  maxIterationCount: { min: 120, max: 500 },
  maxIterationCountToSun: { min: 0, max: 4 },
  scatteringCoefficient: { min: 0.2, max: 2 },
  absorptionCoefficient: { min: 0, max: 0.5 },
  turbulenceDisplacement: { min: 0, max: 1000 }
} as const

type EffectInternals = Pick<
  CloudsEffect,
  'scatteringCoefficient' | 'absorptionCoefficient' | 'turbulenceDisplacement'
> & {
  clouds: Pick<
    CloudsEffect['clouds'],
    'maxIterationCount' | 'maxIterationCountToSun' | 'minStepSize'
  >
}

const CLOUD_KEYS = ['minStepSize', 'maxIterationCount', 'maxIterationCountToSun'] as const
type CloudKey = (typeof CLOUD_KEYS)[number]

const INTEGER_KEYS = new Set<keyof CloudTuning>(['maxIterationCount', 'maxIterationCountToSun'])
const TUNING_KEYS = Object.keys(CLOUD_TUNING_RANGES) as Array<keyof CloudTuning>

const isCloudKey = (key: keyof CloudTuning): key is CloudKey =>
  (CLOUD_KEYS as readonly string[]).includes(key)

function readField(effect: EffectInternals, key: keyof CloudTuning): unknown {
  return isCloudKey(key) ? effect.clouds[key] : effect[key]
}

function writeField(effect: EffectInternals, key: keyof CloudTuning, value: number): void {
  if (isCloudKey(key)) effect.clouds[key] = value
  else effect[key] = value
}

/**
 * 取得 Tellux 内部的 CloudsEffect。
 *
 * `atmosphere` 是 Tellux 的私有字段（编译后仍可访问），字段缺失或版本变化时
 * 返回 null，由调用方隐藏高级滑杆。
 */
export function resolveCloudsEffect(viewer: Viewer): EffectInternals | null {
  const atmosphere = (viewer as unknown as { atmosphere?: { cloudsEffect?: EffectInternals } })
    .atmosphere
  const effect = atmosphere?.cloudsEffect
  if (!effect || !effect.clouds) return null
  // 逐字段校验：Tellux 改版后缺任何一个，number 类型假设都会在运行时失效。
  if (TUNING_KEYS.some((key) => typeof readField(effect, key) !== 'number')) return null
  return effect
}

/** 读取当前云参数（质量档刚生效时用于把滑杆同步到预设值）。 */
export function readCloudTuning(effect: EffectInternals): CloudTuning {
  return {
    minStepSize: effect.clouds.minStepSize,
    maxIterationCount: effect.clouds.maxIterationCount,
    maxIterationCountToSun: effect.clouds.maxIterationCountToSun,
    scatteringCoefficient: effect.scatteringCoefficient,
    absorptionCoefficient: effect.absorptionCoefficient,
    turbulenceDisplacement: effect.turbulenceDisplacement
  }
}

/** 写入并裁剪到安全范围（范围只在 `CLOUD_TUNING_RANGES` 维护一份）。 */
export function applyCloudTuning(effect: EffectInternals, tuning: CloudTuning): void {
  for (const key of TUNING_KEYS) {
    const range = CLOUD_TUNING_RANGES[key]
    const value = clamp(tuning[key], range.min, range.max)
    writeField(effect, key, INTEGER_KEYS.has(key) ? Math.round(value) : value)
  }
}

/** 归一化 localStorage / 旧版本中读取的调参对象。 */
export function normalizeCloudTuning(raw: unknown): CloudTuning {
  const input = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const value = (key: keyof CloudTuning): number => {
    const range = CLOUD_TUNING_RANGES[key]
    const candidate = input[key]
    const fallback = CLOUD_TUNING_DEFAULTS[key]
    const source =
      typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : fallback
    return clamp(source, range.min, range.max)
  }
  return {
    minStepSize: value('minStepSize'),
    maxIterationCount: value('maxIterationCount'),
    maxIterationCountToSun: value('maxIterationCountToSun'),
    scatteringCoefficient: value('scatteringCoefficient'),
    absorptionCoefficient: value('absorptionCoefficient'),
    turbulenceDisplacement: value('turbulenceDisplacement')
  }
}
