import tellux, { type ImageryLayerOptions, type TerrainOptions } from 'tellux'
import { WaterEditor } from './water/waterEditor'
import './style.css'

interface TileCacheStats {
  cacheDir?: string
  region?: { longitude: number; latitude: number; sizeMeters: number } | null
  terrain?: { tiles: number; bytes: number }
  imagery?: { tiles: number; bytes: number }
  updatedAt?: string | null
}

const INITIAL_VIEW = {
  longitude: 116.77,
  latitude: 36.015,
  height: 7600,
  heading: 0,
  pitch: -75,
  cloudAltitude: 9000,
  cloudThickness: 800
}

const QUALITY_PRESETS = ['low', 'medium', 'high', 'ultra'] as const
const QUALITY_LABELS = ['低', '中', '高', '极致']
const DEFAULT_QUALITY_INDEX = 2
const SHADOW_PRESETS = ['low', 'medium', 'high'] as const
const SHADOW_LABELS = ['低', '中', '高']
const CLOUD_PREFS_KEY = 'tellux-cloud-prefs-v1'

interface CloudPrefs {
  show: boolean
  coverage: number
  altitude: number
  height: number
  speed: number
  quality: (typeof QUALITY_PRESETS)[number]
  lightShafts: boolean
  detail: boolean
  turbulence: boolean
  haze: boolean
  shadow: (typeof SHADOW_PRESETS)[number]
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

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`UI element not found: ${selector}`)
  return element
}

const container = $('#viewer')
const loader = $('#loader')
const loaderDetail = $('#loader-detail')
const loaderBar = $('#loader-bar')
const toast = $('#toast')
const terrainStatus = $('#terrain-status')
const cloudStatus = $('#cloud-status')
const consoleElement = $('#console')
const consoleToggle = $('#console-toggle')
const consoleNote = $('#console-note')

function setLoader(progress: number, detail: string) {
  loaderDetail.textContent = detail
  loaderBar.style.width = `${Math.max(6, Math.min(100, progress))}%`
  loaderBar.style.animation = 'none'
  loaderBar.style.transform = 'none'
  loaderBar.style.background =
    'linear-gradient(90deg, rgba(127,227,255,0.2), #7fe3ff, rgba(127,227,255,0.2))'
}

function hideLoader(delay = 300) {
  window.setTimeout(() => loader.classList.add('is-hidden'), delay)
}

function showError(message: string) {
  loader.classList.remove('is-hidden')
  loaderDetail.textContent = message
  loader.classList.add('is-error')
  const title = loader.querySelector('strong')
  if (title) title.textContent = '三维地球加载失败'
  loaderBar.style.width = '100%'
  loaderBar.style.background = 'linear-gradient(90deg, #ff9d7a, #ff6c5c)'
}

let toastTimer = 0
function showToast(message: string, duration = 2600) {
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), duration)
}

/** 读取本地缓存统计（dev / 生产服务器都提供 /tile-cache/stats）。 */
async function fetchTileCacheStats(): Promise<TileCacheStats | null> {
  try {
    const response = await fetch('/tile-cache/stats', { cache: 'no-store' })
    if (!response.ok) return null
    return (await response.json()) as TileCacheStats
  } catch {
    return null
  }
}

function describeCache(stats: TileCacheStats | null): string {
  if (!stats) return '地形与影像优先从本地缓存加载，缺块时自动回源并写盘。'
  const terrainTiles = stats.terrain?.tiles ?? 0
  const imageryTiles = stats.imagery?.tiles ?? 0
  const region = stats.region
  const size = region ? `${(region.sizeMeters / 1000).toFixed(0)} km` : '50 km'
  return (
    `本地缓存 ${region ? `${region.longitude},${region.latitude} ` : ''}${size} 区域：` +
    `地形 ${terrainTiles} 块 · 影像 ${imageryTiles} 块；缺块自动回源并写盘。`
  )
}

function createOverlays(): ImageryLayerOptions[] {
  // 影像优先走本地缓存端点；缺块由本地缓存服务回源 ArcGIS 并写盘。
  return [
    {
      name: 'Cesium / ArcGIS World Imagery（本地缓存）',
      source: {
        type: 'xyz',
        url: '/imagery-cache/{z}/{y}/{x}',
        levels: 19,
        projection: 'EPSG:3857',
        tileDimension: 256
      }
    }
  ]
}

function createTerrainOptions(): TerrainOptions {
  return {
    type: 'url',
    url: '/terrain-cache/layer.json',
    tileLoading: {
      enableTileSplitting: false,
      imageryResolution: 256
    }
  }
}

function createTerrainBadge() {
  terrainStatus.dataset.tone = 'ok'
  const label = terrainStatus.querySelector('span')
  const dot = terrainStatus.querySelector('i')
  if (label) label.textContent = '本地缓存地形'
  if (dot) dot.style.background = 'var(--accent-green)'

  consoleNote.innerHTML =
    '<span class="note-dot"></span><p>地形与影像来自本地缓存 (.cache/tiles)。</p>'
}

function beijingTimeToDate(totalMinutes: number): Date {
  const date = new Date(Date.UTC(2026, 10, 17, 0, 0, 0, 0))
  date.setUTCMinutes(totalMinutes - 8 * 60)
  return date
}

function formatTime(totalMinutes: number): string {
  const minutes = ((totalMinutes % 1440) + 1440) % 1440
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function formatCoordinate(value: number, positive: string, negative: string): string {
  const direction = value >= 0 ? positive : negative
  return `${Math.abs(value).toFixed(2)}°${direction}`
}

function formatAltitude(meters: number): string {
  if (!Number.isFinite(meters)) return '—'
  if (Math.abs(meters) >= 1000) return `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 1)} km`
  return `${meters.toFixed(0)} m`
}

let waterEditor: WaterEditor | null = null

function mountWaterEditor(viewer: InstanceType<typeof tellux.Viewer>) {
  if (waterEditor) return
  waterEditor = new WaterEditor(viewer, { toast: showToast })
  ;(window as unknown as { waterEditor: WaterEditor }).waterEditor = waterEditor
}

async function boot() {
  setLoader(14, '读取本地地形缓存配置…')
  createTerrainBadge()
  setLoader(38, '连接本地地形与影像缓存…')

  const initialView = INITIAL_VIEW
  const initialTime = beijingTimeToDate(930)

  let viewer: InstanceType<typeof tellux.Viewer>
  try {
    viewer = new tellux.Viewer(container, {
      dracoDecoderPath: '/draco/',
      clock: {
        currentTime: initialTime,
        shouldAnimate: false
      },
      camera: {
        destination: {
          longitude: initialView.longitude,
          latitude: initialView.latitude,
          height: initialView.height
        },
        orientation: {
          heading: initialView.heading,
          pitch: initialView.pitch
        },
        projection: {
          near: 1,
          far: 30_000_000,
          fov: 45
        }
      },
      scene: {
        atmosphere: {
          show: true,
          lighting: { mode: 'post-process' },
          sky: { sun: true, moon: true, stars: true }
        },
        clouds: {
          show: false,
          quality: QUALITY_PRESETS[DEFAULT_QUALITY_INDEX],
          coverage: 0.3,
          lightShafts: true,
          layer: {
            altitude: initialView.cloudAltitude,
            height: initialView.cloudThickness
          },
          look: { detail: true, turbulence: true, haze: true },
          shadow: { quality: 'medium' }
        }
      },
      postProcess: {
        smaa: { enabled: true },
        lensFlare: { enabled: false },
        toneMapping: { enabled: true, mode: 'agx', exposure: 5.4 }
      },
      renderer: {
        type: 'webgl',
        antialias: true,
        resolutionScale: Math.min(window.devicePixelRatio || 1, 1.6)
      }
    })
  } catch (error) {
    console.error(error)
    showError(error instanceof Error ? error.message : '无法创建 WebGL 渲染器')
    return
  }

  ;(window as unknown as { viewer: typeof viewer }).viewer = viewer

  for (const overlay of createOverlays()) viewer.overlays.add(overlay)
  viewer.globe.show = true
  viewer.terrain.set(createTerrainOptions())
  const label = terrainStatus.querySelector('span')
  if (label) label.textContent = '本地缓存地形'
  setLoader(100, '就绪')
  hideLoader(260)

  mountWaterEditor(viewer)

  void fetchTileCacheStats().then((stats) => {
    if (stats) {
      consoleNote.innerHTML = `<span class="note-dot"></span><p>${describeCache(stats)}</p>`
    }
  })

  const cloudsToggle = $<HTMLInputElement>('#clouds-toggle')
  const atmosphereToggle = $<HTMLInputElement>('#atmosphere-toggle')
  const coverage = $<HTMLInputElement>('#coverage')
  const coverageValue = $<HTMLOutputElement>('#coverage-value')
  const cloudAltitude = $<HTMLInputElement>('#cloud-altitude')
  const cloudAltitudeValue = $<HTMLOutputElement>('#cloud-altitude-value')
  const cloudHeight = $<HTMLInputElement>('#cloud-height')
  const cloudHeightValue = $<HTMLOutputElement>('#cloud-height-value')
  const cloudSpeed = $<HTMLInputElement>('#cloud-speed')
  const cloudSpeedValue = $<HTMLOutputElement>('#cloud-speed-value')
  const cloudDetail = $<HTMLInputElement>('#cloud-detail')
  const cloudTurbulence = $<HTMLInputElement>('#cloud-turbulence')
  const cloudHaze = $<HTMLInputElement>('#cloud-haze')
  const cloudLightShafts = $<HTMLInputElement>('#cloud-light-shafts')
  const cloudShadowQuality = $<HTMLInputElement>('#cloud-shadow-quality')
  const cloudShadowQualityValue = $<HTMLOutputElement>('#cloud-shadow-quality-value')
  const quality = $<HTMLInputElement>('#quality')
  const qualityValue = $<HTMLOutputElement>('#quality-value')
  const localHour = $<HTMLInputElement>('#local-hour')
  const localHourValue = $<HTMLOutputElement>('#local-hour-value')
  const fpsStatus = $('#fps-status')

  /** 云层流动速度：面板 0–8 档 × 基础值 0.001 UV/s。 */
  const CLOUD_SPEED_UNIT = 0.001

  const persistCloudPrefs = (): void => {
    writeCloudPrefs({
      show: cloudsToggle.checked,
      coverage: Number(coverage.value) / 100,
      altitude: Number(cloudAltitude.value),
      height: Number(cloudHeight.value),
      speed: Number(cloudSpeed.value) * CLOUD_SPEED_UNIT,
      quality: QUALITY_PRESETS[Number(quality.value)] ?? 'high',
      lightShafts: cloudLightShafts.checked,
      detail: cloudDetail.checked,
      turbulence: cloudTurbulence.checked,
      haze: cloudHaze.checked,
      shadow: SHADOW_PRESETS[Number(cloudShadowQuality.value)] ?? 'medium'
    })
  }

  const setCloudAltitude = (meters: number) => {
    viewer.scene.clouds.layer.altitude = meters
    cloudAltitude.value = String(Math.round(meters))
    cloudAltitudeValue.textContent = `${Math.round(meters)} m`
  }

  const setCloudHeight = (meters: number) => {
    viewer.scene.clouds.layer.height = meters
    cloudHeight.value = String(Math.round(meters))
    cloudHeightValue.textContent = `${Math.round(meters)} m`
  }

  cloudsToggle.checked = false
  cloudsToggle.addEventListener('change', () => {
    viewer.scene.clouds.show = cloudsToggle.checked
    const span = cloudStatus.querySelector('span')
    if (span) span.textContent = cloudsToggle.checked ? '已开启' : '已关闭'
    cloudStatus.style.opacity = cloudsToggle.checked ? '1' : '0.55'
    persistCloudPrefs()
  })

  coverage.addEventListener('input', () => {
    const percent = Number(coverage.value)
    viewer.scene.clouds.coverage = percent / 100
    coverageValue.textContent = `${percent}%`
    persistCloudPrefs()
  })

  cloudAltitude.addEventListener('input', () => {
    setCloudAltitude(Number(cloudAltitude.value))
    persistCloudPrefs()
  })
  cloudHeight.addEventListener('input', () => {
    setCloudHeight(Number(cloudHeight.value))
    persistCloudPrefs()
  })

  cloudSpeed.addEventListener('input', () => {
    const factor = Number(cloudSpeed.value)
    viewer.scene.clouds.speed = factor * CLOUD_SPEED_UNIT
    cloudSpeedValue.textContent = `${factor.toFixed(1)}×`
    persistCloudPrefs()
  })

  cloudDetail.addEventListener('change', () => {
    viewer.scene.clouds.look.detail = cloudDetail.checked
    persistCloudPrefs()
  })
  cloudTurbulence.addEventListener('change', () => {
    viewer.scene.clouds.look.turbulence = cloudTurbulence.checked
    persistCloudPrefs()
  })
  cloudHaze.addEventListener('change', () => {
    viewer.scene.clouds.look.haze = cloudHaze.checked
    persistCloudPrefs()
  })
  cloudLightShafts.addEventListener('change', () => {
    viewer.scene.clouds.lightShafts = cloudLightShafts.checked
    persistCloudPrefs()
  })
  cloudShadowQuality.addEventListener('input', () => {
    const index = Math.max(0, Math.min(SHADOW_PRESETS.length - 1, Number(cloudShadowQuality.value)))
    viewer.scene.clouds.shadow.quality = SHADOW_PRESETS[index]
    cloudShadowQualityValue.textContent = SHADOW_LABELS[index]
    persistCloudPrefs()
  })

  quality.addEventListener('input', () => {
    const index = Math.max(0, Math.min(QUALITY_PRESETS.length - 1, Number(quality.value)))
    viewer.scene.clouds.quality = QUALITY_PRESETS[index]
    qualityValue.textContent = QUALITY_LABELS[index]
    persistCloudPrefs()
  })

  atmosphereToggle.addEventListener('change', () => {
    viewer.scene.atmosphere.show = atmosphereToggle.checked
    showToast(atmosphereToggle.checked ? '大气散射已开启' : '大气散射已关闭')
  })

  localHour.addEventListener('input', () => {
    const minutes = Number(localHour.value)
    viewer.clock.currentTime = beijingTimeToDate(minutes)
    localHourValue.textContent = formatTime(minutes)
    const span = fpsStatus.querySelector('span')
    if (span) span.textContent = formatTime(minutes)
  })

  consoleToggle.addEventListener('click', () => {
    const collapsed = consoleElement.dataset.collapsed === 'true'
    consoleElement.dataset.collapsed = collapsed ? 'false' : 'true'
    consoleToggle.setAttribute('aria-expanded', collapsed ? 'true' : 'false')
  })

  if (window.matchMedia('(max-width: 860px)').matches) {
    consoleElement.dataset.collapsed = 'true'
    consoleToggle.setAttribute('aria-expanded', 'false')
  }

  setCloudAltitude(initialView.cloudAltitude)
  cloudAltitudeValue.textContent = `${initialView.cloudAltitude} m`
  setCloudHeight(initialView.cloudThickness)
  cloudHeightValue.textContent = `${initialView.cloudThickness} m`
  cloudSpeed.value = '1'
  cloudSpeedValue.textContent = '1.0×'
  viewer.scene.clouds.speed = CLOUD_SPEED_UNIT
  cloudDetail.checked = true
  cloudTurbulence.checked = true
  cloudHaze.checked = true
  cloudLightShafts.checked = true
  cloudShadowQuality.value = '1'
  cloudShadowQualityValue.textContent = SHADOW_LABELS[1]
  qualityValue.textContent = QUALITY_LABELS[DEFAULT_QUALITY_INDEX]
  quality.value = String(DEFAULT_QUALITY_INDEX)
  localHourValue.textContent = formatTime(930)
  const clockSpan = fpsStatus.querySelector('span')
  if (clockSpan) clockSpan.textContent = formatTime(930)

  // 恢复上次的体积云手动设置（localStorage；没有记录时保持默认值）。
  const storedCloudPrefs = readCloudPrefs()
  const setStoredRange = (
    input: HTMLInputElement,
    value: unknown,
    min: number,
    max: number
  ): void => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    input.value = String(Math.min(max, Math.max(min, value)))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const setStoredChecked = (input: HTMLInputElement, value: unknown): void => {
    if (typeof value !== 'boolean' || input.checked === value) return
    input.checked = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (typeof storedCloudPrefs.quality === 'string') {
    const index = (QUALITY_PRESETS as readonly string[]).indexOf(storedCloudPrefs.quality)
    if (index >= 0) setStoredRange(quality, index, 0, QUALITY_PRESETS.length - 1)
  }
  if (typeof storedCloudPrefs.shadow === 'string') {
    const index = (SHADOW_PRESETS as readonly string[]).indexOf(storedCloudPrefs.shadow)
    if (index >= 0) setStoredRange(cloudShadowQuality, index, 0, SHADOW_PRESETS.length - 1)
  }
  setStoredRange(
    coverage,
    typeof storedCloudPrefs.coverage === 'number' ? storedCloudPrefs.coverage * 100 : undefined,
    0,
    100
  )
  setStoredRange(cloudAltitude, storedCloudPrefs.altitude, 800, 16000)
  setStoredRange(cloudHeight, storedCloudPrefs.height, 120, 4000)
  setStoredRange(
    cloudSpeed,
    typeof storedCloudPrefs.speed === 'number' ? storedCloudPrefs.speed / CLOUD_SPEED_UNIT : undefined,
    0,
    8
  )
  setStoredChecked(cloudDetail, storedCloudPrefs.detail)
  setStoredChecked(cloudTurbulence, storedCloudPrefs.turbulence)
  setStoredChecked(cloudHaze, storedCloudPrefs.haze)
  setStoredChecked(cloudLightShafts, storedCloudPrefs.lightShafts)
  setStoredChecked(cloudsToggle, storedCloudPrefs.show)

  setLoader(100, '就绪')
  hideLoader(260)

  const readoutTimer = window.setInterval(() => {
    const state = viewer.camera.getState()
    const { destination } = state
    const lon = $('#coord-lon')
    const lat = $('#coord-lat')
    const alt = $('#coord-alt')
    lon.textContent = formatCoordinate(destination.longitude, 'E', 'W')
    lat.textContent = formatCoordinate(destination.latitude, 'N', 'S')
    alt.textContent = formatAltitude(destination.height)
  }, 450)

  window.addEventListener('beforeunload', () => {
    window.clearInterval(readoutTimer)
    waterEditor?.dispose()
    viewer.destroy()
  })
}

boot().catch((error) => {
  console.error(error)
  showError(error instanceof Error ? error.message : '未知错误')
})
