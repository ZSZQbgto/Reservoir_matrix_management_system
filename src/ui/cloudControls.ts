/**
 * 场景控制台：体积云与大气 / 时间控件。
 *
 * 只负责「面板 ↔ viewer.scene.clouds / viewer.clock」的绑定与本地持久化；
 * 体积云的默认值同时供 `main.ts` 创建 Viewer 时使用，避免两处硬编码。
 *
 * 「云体与性能」分组的数值滑杆通过 `cloudTuning` 访问底层 CloudsEffect：
 * Tellux 的云设置每次生效都会重新套用质量预设，因此这里在每次改动后重放
 * 自定义数值，保证滑杆不会被预设悄悄覆盖。
 */
import type { Viewer } from 'tellux'
import { domId } from '../shared/domIds'
import { requireElement, syncRangeFill } from '../shared/dom'
import { DEFAULT_TIME_MINUTES, formatClockTime, minutesToSceneDate } from '../shared/format'
import {
  CLOUD_TUNING_DEFAULTS,
  applyCloudTuning,
  normalizeCloudTuning,
  readCloudTuning,
  resolveCloudsEffect,
  type CloudTuning
} from './cloudTuning'

const QUALITY_PRESETS = ['low', 'medium', 'high', 'ultra'] as const
const QUALITY_LABELS = ['低', '中', '高', '极致']
const SHADOW_PRESETS = ['low', 'medium', 'high'] as const
const SHADOW_LABELS = ['低', '中', '高']
const CLOUD_SPEED_UNIT = 0.001
const CLOUD_PREFS_KEY = 'tellux-cloud-prefs-v1'

type CloudQuality = (typeof QUALITY_PRESETS)[number]
type CloudShadowQuality = (typeof SHADOW_PRESETS)[number]

/** 体积云与大气初始值：面板、Viewer 配置与恢复逻辑共用。 */
export const CLOUD_SCENE_DEFAULTS = {
  show: false,
  quality: 'high' as CloudQuality,
  coverage: 0.3,
  altitude: 9000,
  height: 800,
  speed: 1,
  lightShafts: true,
  detail: true,
  turbulence: true,
  haze: true,
  shadowQuality: 'medium' as CloudShadowQuality
} as const

const DEFAULT_QUALITY_INDEX = Math.max(0, QUALITY_PRESETS.indexOf(CLOUD_SCENE_DEFAULTS.quality))
const DEFAULT_SHADOW_INDEX = Math.max(0, SHADOW_PRESETS.indexOf(CLOUD_SCENE_DEFAULTS.shadowQuality))

/** 持久化到 localStorage 的云层偏好（speed 为 UV/s，面板显示为倍率）。 */
interface CloudPrefs {
  show: boolean
  coverage: number
  altitude: number
  height: number
  speed: number
  quality: CloudQuality
  lightShafts: boolean
  detail: boolean
  turbulence: boolean
  haze: boolean
  shadow: CloudShadowQuality
  /** 云体与性能数值（旧版本没有该字段时按当前预设或新装默认值迁移）。 */
  tuning?: CloudTuning
}

export interface CloudControlsOptions {
  viewer: Viewer
  /** 顶部时间胶囊的文案回调。 */
  onTimeChange(minutes: number): void
  showToast(message: string): void
}

function readCloudPrefs(): Partial<CloudPrefs> {
  try {
    const raw = localStorage.getItem(CLOUD_PREFS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Partial<CloudPrefs>) : {}
  } catch {
    return {}
  }
}

function writeCloudPrefs(prefs: CloudPrefs): void {
  try {
    localStorage.setItem(CLOUD_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // localStorage 不可用时静默降级。
  }
}

/** 把恢复的数值写回滑杆并触发一次 input，复用统一的事件处理。 */
function setStoredRange(input: HTMLInputElement, value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) return
  input.value = String(Math.min(max, Math.max(min, value)))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function setStoredChecked(input: HTMLInputElement, value: unknown): void {
  if (typeof value !== 'boolean' || input.checked === value) return
  input.checked = value
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

export function initCloudControls(options: CloudControlsOptions): void {
  const { viewer, onTimeChange, showToast } = options
  const clouds = viewer.scene.clouds
  const effect = resolveCloudsEffect(viewer)

  const cloudStatus = requireElement(domId('cloud-status'))
  const cloudsToggle = requireElement<HTMLInputElement>(domId('clouds-toggle'))
  const coverage = requireElement<HTMLInputElement>(domId('coverage'))
  const coverageValue = requireElement<HTMLOutputElement>(domId('coverage-value'))
  const cloudAltitude = requireElement<HTMLInputElement>(domId('cloud-altitude'))
  const cloudAltitudeValue = requireElement<HTMLOutputElement>(domId('cloud-altitude-value'))
  const cloudHeight = requireElement<HTMLInputElement>(domId('cloud-height'))
  const cloudHeightValue = requireElement<HTMLOutputElement>(domId('cloud-height-value'))
  const cloudSpeed = requireElement<HTMLInputElement>(domId('cloud-speed'))
  const cloudSpeedValue = requireElement<HTMLOutputElement>(domId('cloud-speed-value'))
  const cloudDetail = requireElement<HTMLInputElement>(domId('cloud-detail'))
  const cloudTurbulence = requireElement<HTMLInputElement>(domId('cloud-turbulence'))
  const cloudHaze = requireElement<HTMLInputElement>(domId('cloud-haze'))
  const cloudLightShafts = requireElement<HTMLInputElement>(domId('cloud-light-shafts'))
  const cloudShadowQuality = requireElement<HTMLInputElement>(domId('cloud-shadow-quality'))
  const cloudShadowQualityValue = requireElement<HTMLOutputElement>(
    domId('cloud-shadow-quality-value')
  )
  const quality = requireElement<HTMLInputElement>(domId('quality'))
  const qualityValue = requireElement<HTMLOutputElement>(domId('quality-value'))
  const atmosphereToggle = requireElement<HTMLInputElement>(domId('atmosphere-toggle'))
  const localHour = requireElement<HTMLInputElement>(domId('local-hour'))
  const localHourValue = requireElement<HTMLOutputElement>(domId('local-hour-value'))

  // 云体与性能滑杆（底层 CloudsEffect 不可用时整组隐藏）。
  const tuningSection = requireElement(domId('cloud-tuning'))
  const cloudMinStep = requireElement<HTMLInputElement>(domId('cloud-min-step'))
  const cloudMinStepValue = requireElement<HTMLOutputElement>(domId('cloud-min-step-value'))
  const cloudIterations = requireElement<HTMLInputElement>(domId('cloud-iterations'))
  const cloudIterationsValue = requireElement<HTMLOutputElement>(domId('cloud-iterations-value'))
  const cloudSunIterations = requireElement<HTMLInputElement>(domId('cloud-sun-iterations'))
  const cloudSunIterationsValue = requireElement<HTMLOutputElement>(
    domId('cloud-sun-iterations-value')
  )
  const cloudScattering = requireElement<HTMLInputElement>(domId('cloud-scattering'))
  const cloudScatteringValue = requireElement<HTMLOutputElement>(domId('cloud-scattering-value'))
  const cloudAbsorption = requireElement<HTMLInputElement>(domId('cloud-absorption'))
  const cloudAbsorptionValue = requireElement<HTMLOutputElement>(domId('cloud-absorption-value'))
  const cloudTurbulenceDisplacement = requireElement<HTMLInputElement>(
    domId('cloud-turbulence-displacement')
  )
  const cloudTurbulenceValue = requireElement<HTMLOutputElement>(domId('cloud-turbulence-value'))

  const readTuningInputs = (): CloudTuning => ({
    minStepSize: Number(cloudMinStep.value),
    maxIterationCount: Number(cloudIterations.value),
    maxIterationCountToSun: Number(cloudSunIterations.value),
    scatteringCoefficient: Number(cloudScattering.value),
    absorptionCoefficient: Number(cloudAbsorption.value),
    turbulenceDisplacement: Number(cloudTurbulenceDisplacement.value)
  })

  const writeTuningOutputs = (tuning: CloudTuning): void => {
    cloudMinStepValue.textContent = String(Math.round(tuning.minStepSize))
    cloudIterationsValue.textContent = String(Math.round(tuning.maxIterationCount))
    cloudSunIterationsValue.textContent = String(Math.round(tuning.maxIterationCountToSun))
    cloudScatteringValue.textContent = tuning.scatteringCoefficient.toFixed(2)
    cloudAbsorptionValue.textContent = tuning.absorptionCoefficient.toFixed(2)
    cloudTurbulenceValue.textContent = `${Math.round(tuning.turbulenceDisplacement)} m`
    for (const input of [
      cloudMinStep,
      cloudIterations,
      cloudSunIterations,
      cloudScattering,
      cloudAbsorption,
      cloudTurbulenceDisplacement
    ]) {
      syncRangeFill(input)
    }
  }

  const writeTuningInputs = (tuning: CloudTuning): void => {
    cloudMinStep.value = String(tuning.minStepSize)
    cloudIterations.value = String(Math.round(tuning.maxIterationCount))
    cloudSunIterations.value = String(Math.round(tuning.maxIterationCountToSun))
    cloudScattering.value = String(tuning.scatteringCoefficient)
    cloudAbsorption.value = String(tuning.absorptionCoefficient)
    cloudTurbulenceDisplacement.value = String(Math.round(tuning.turbulenceDisplacement))
    writeTuningOutputs(tuning)
  }

  /** Tellux 应用云设置时会重套质量预设；这里重放滑杆的自定义数值。 */
  const reapplyTuning = (): void => {
    if (effect) applyCloudTuning(effect, readTuningInputs())
  }

  const persist = (): void => {
    writeCloudPrefs({
      show: cloudsToggle.checked,
      coverage: Number(coverage.value) / 100,
      altitude: Number(cloudAltitude.value),
      height: Number(cloudHeight.value),
      speed: Number(cloudSpeed.value) * CLOUD_SPEED_UNIT,
      quality: QUALITY_PRESETS[Number(quality.value)] ?? CLOUD_SCENE_DEFAULTS.quality,
      lightShafts: cloudLightShafts.checked,
      detail: cloudDetail.checked,
      turbulence: cloudTurbulence.checked,
      haze: cloudHaze.checked,
      shadow:
        SHADOW_PRESETS[Number(cloudShadowQuality.value)] ?? CLOUD_SCENE_DEFAULTS.shadowQuality,
      tuning: effect ? readTuningInputs() : undefined
    })
  }

  const setCloudAltitude = (meters: number): void => {
    clouds.layer.altitude = meters
    cloudAltitude.value = String(Math.round(meters))
    cloudAltitudeValue.textContent = `${Math.round(meters)} m`
  }

  const setCloudHeight = (meters: number): void => {
    clouds.layer.height = meters
    cloudHeight.value = String(Math.round(meters))
    cloudHeightValue.textContent = `${Math.round(meters)} m`
  }

  cloudsToggle.addEventListener('change', () => {
    clouds.show = cloudsToggle.checked
    reapplyTuning()
    const span = cloudStatus.querySelector('span')
    if (span) span.textContent = cloudsToggle.checked ? '已开启' : '已关闭'
    cloudStatus.toggleAttribute('data-muted', !cloudsToggle.checked)
    persist()
  })

  coverage.addEventListener('input', () => {
    const percent = Number(coverage.value)
    clouds.coverage = percent / 100
    reapplyTuning()
    coverageValue.textContent = `${percent}%`
    persist()
  })

  cloudAltitude.addEventListener('input', () => {
    setCloudAltitude(Number(cloudAltitude.value))
    reapplyTuning()
    persist()
  })

  cloudHeight.addEventListener('input', () => {
    setCloudHeight(Number(cloudHeight.value))
    reapplyTuning()
    persist()
  })

  cloudSpeed.addEventListener('input', () => {
    const factor = Number(cloudSpeed.value)
    clouds.speed = factor * CLOUD_SPEED_UNIT
    reapplyTuning()
    cloudSpeedValue.textContent = `${factor.toFixed(1)}×`
    persist()
  })

  cloudDetail.addEventListener('change', () => {
    clouds.look.detail = cloudDetail.checked
    reapplyTuning()
    persist()
  })

  cloudTurbulence.addEventListener('change', () => {
    clouds.look.turbulence = cloudTurbulence.checked
    reapplyTuning()
    persist()
  })

  cloudHaze.addEventListener('change', () => {
    clouds.look.haze = cloudHaze.checked
    reapplyTuning()
    persist()
  })

  cloudLightShafts.addEventListener('change', () => {
    clouds.lightShafts = cloudLightShafts.checked
    reapplyTuning()
    persist()
  })

  cloudShadowQuality.addEventListener('input', () => {
    const index = Math.max(0, Math.min(SHADOW_PRESETS.length - 1, Number(cloudShadowQuality.value)))
    clouds.shadow.quality = SHADOW_PRESETS[index] ?? CLOUD_SCENE_DEFAULTS.shadowQuality
    reapplyTuning()
    cloudShadowQualityValue.textContent = SHADOW_LABELS[index] ?? ''
    persist()
  })

  quality.addEventListener('input', () => {
    const index = Math.max(0, Math.min(QUALITY_PRESETS.length - 1, Number(quality.value)))
    clouds.quality = QUALITY_PRESETS[index] ?? CLOUD_SCENE_DEFAULTS.quality
    qualityValue.textContent = QUALITY_LABELS[index] ?? ''
    // 质量预设有自己的分辨率/步进默认值：滑杆跟随预设，而不是继续覆盖它。
    if (effect) writeTuningInputs(readCloudTuning(effect))
    persist()
  })

  for (const input of [
    cloudMinStep,
    cloudIterations,
    cloudSunIterations,
    cloudScattering,
    cloudAbsorption,
    cloudTurbulenceDisplacement
  ]) {
    input.addEventListener('input', () => {
      if (!effect) return
      const tuning = readTuningInputs()
      applyCloudTuning(effect, tuning)
      writeTuningOutputs(tuning)
      persist()
    })
  }

  atmosphereToggle.addEventListener('change', () => {
    viewer.scene.atmosphere.show = atmosphereToggle.checked
    showToast(atmosphereToggle.checked ? '大气散射已开启' : '大气散射已关闭')
  })

  localHour.addEventListener('input', () => {
    const minutes = Number(localHour.value)
    viewer.clock.currentTime = minutesToSceneDate(minutes)
    localHourValue.textContent = formatClockTime(minutes)
    onTimeChange(minutes)
  })

  // 面板初值：以 HTML 中的默认值为准，Viewer 侧同步到同一状态。
  cloudsToggle.checked = CLOUD_SCENE_DEFAULTS.show
  clouds.show = CLOUD_SCENE_DEFAULTS.show
  cloudStatus.toggleAttribute('data-muted', !CLOUD_SCENE_DEFAULTS.show)
  const statusLabel = cloudStatus.querySelector('span')
  if (statusLabel) statusLabel.textContent = CLOUD_SCENE_DEFAULTS.show ? '已开启' : '已关闭'
  setCloudAltitude(CLOUD_SCENE_DEFAULTS.altitude)
  setCloudHeight(CLOUD_SCENE_DEFAULTS.height)
  clouds.speed = CLOUD_SCENE_DEFAULTS.speed * CLOUD_SPEED_UNIT
  cloudSpeed.value = String(CLOUD_SCENE_DEFAULTS.speed)
  cloudSpeedValue.textContent = `${CLOUD_SCENE_DEFAULTS.speed.toFixed(1)}×`
  quality.value = String(DEFAULT_QUALITY_INDEX)
  qualityValue.textContent = QUALITY_LABELS[DEFAULT_QUALITY_INDEX] ?? ''
  cloudShadowQuality.value = String(DEFAULT_SHADOW_INDEX)
  cloudShadowQualityValue.textContent = SHADOW_LABELS[DEFAULT_SHADOW_INDEX] ?? ''
  localHourValue.textContent = formatClockTime(DEFAULT_TIME_MINUTES)
  onTimeChange(DEFAULT_TIME_MINUTES)

  // 恢复上次的体积云设置；没有记录时保持默认值。
  const stored = readCloudPrefs()
  const hasStoredPrefs = Object.keys(stored).length > 0
  if (typeof stored.quality === 'string') {
    const index = (QUALITY_PRESETS as readonly string[]).indexOf(stored.quality)
    if (index >= 0) setStoredRange(quality, index, 0, QUALITY_PRESETS.length - 1)
  }
  if (typeof stored.shadow === 'string') {
    const index = (SHADOW_PRESETS as readonly string[]).indexOf(stored.shadow)
    if (index >= 0) setStoredRange(cloudShadowQuality, index, 0, SHADOW_PRESETS.length - 1)
  }
  setStoredRange(
    coverage,
    typeof stored.coverage === 'number' ? stored.coverage * 100 : undefined,
    0,
    100
  )
  setStoredRange(cloudAltitude, stored.altitude, 800, 16000)
  setStoredRange(cloudHeight, stored.height, 120, 4000)
  setStoredRange(
    cloudSpeed,
    typeof stored.speed === 'number' ? stored.speed / CLOUD_SPEED_UNIT : undefined,
    0,
    8
  )
  setStoredChecked(cloudDetail, stored.detail)
  setStoredChecked(cloudTurbulence, stored.turbulence)
  setStoredChecked(cloudHaze, stored.haze)
  setStoredChecked(cloudLightShafts, stored.lightShafts)
  setStoredChecked(cloudsToggle, stored.show)

  // 云体与性能：新装用优化默认值；已有偏好但无该字段时沿用它当前的预设值。
  if (effect) {
    tuningSection.hidden = false
    const fallback = hasStoredPrefs ? readCloudTuning(effect) : CLOUD_TUNING_DEFAULTS
    const tuning = stored.tuning ? normalizeCloudTuning(stored.tuning) : fallback
    writeTuningInputs(tuning)
    applyCloudTuning(effect, tuning)
    persist()
  } else {
    tuningSection.hidden = true
  }
}
