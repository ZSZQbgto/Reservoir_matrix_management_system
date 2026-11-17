import tellux, { type ImageryLayerOptions, type TerrainOptions } from 'tellux'
import './style.css'

interface AppConfig {
  maptilerUrl: string
  cesiumIonToken: string
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

const fallbackConfig: AppConfig = {
  maptilerUrl: '/maptiler/tiles/terrain-quantized-mesh-v2/',
  cesiumIonToken: ''
}

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

function readCesiumToken(): string {
  const url = new URLSearchParams(window.location.search).get('cesiumToken')
  return url || localStorage.getItem('cesium-ion-token') || ''
}

let configCesiumToken = ''

async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw = (await response.json()) as { maptilerUrl?: string; cesiumIonToken?: string }
    configCesiumToken = raw.cesiumIonToken || ''
    return {
      ...fallbackConfig,
      maptilerUrl: raw.maptilerUrl || fallbackConfig.maptilerUrl,
      cesiumIonToken: configCesiumToken
    }
  } catch {
    return fallbackConfig
  }
}

// Cesium Ion API is not reachable from this network, so default to the
// Cesium quantized-mesh terrain proxy + ArcGIS imagery. `?ion=1&cesiumToken=...`
// can still force Cesium Ion when it is reachable.
const query = new URLSearchParams(window.location.search)
const forceIon = query.get('ion') === '1'
const forceMapTilerTerrain = query.get('terrain') === 'maptiler'
let cesiumToken = forceIon ? readCesiumToken() : ''

function createOverlays(): ImageryLayerOptions[] {
  if (cesiumToken) {
    return [
      {
        name: 'Cesium World Imagery',
        source: {
          type: 'cesium-ion',
          apiToken: cesiumToken,
          assetId: 2
        }
      }
    ]
  }

  // No Cesium Ion token: use Cesium's public ArcGIS World Imagery layer.
  return [
    {
      name: 'Cesium / ArcGIS World Imagery',
      source: {
        type: 'xyz',
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        levels: 19,
        projection: 'EPSG:3857',
        tileDimension: 256
      }
    }
  ]
}

function createTerrainOptions(config: AppConfig): TerrainOptions {
  if (cesiumToken) {
    return {
      type: 'cesium-ion',
      apiToken: cesiumToken,
      assetId: 1,
      tileLoading: {
        enableTileSplitting: false,
        imageryResolution: 256
      }
    }
  }

  return {
    type: 'url',
    url: `${config.maptilerUrl}layer.json`,
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
  if (label) label.textContent = 'Cesium 影像'
  if (dot) dot.style.background = 'var(--accent-green)'

  consoleNote.innerHTML = cesiumToken
    ? '<span class="note-dot"></span><p>已切换到 <b>Cesium 图源</b>：ArcGIS World Imagery。Cesium Ion 地形在当前网络不可达，默认不加载地形。</p>'
    : '<span class="note-dot"></span><p>已切换到 <b>Cesium 图源</b>：ArcGIS World Imagery。Cesium Ion 地形在当前网络不可达，默认不加载地形；<code>?ion=1</code> 可尝试。</p>'
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

async function boot() {
  setLoader(14, '读取 Cesium 图源配置…')
  const config = await loadConfig()
  if (forceIon && !cesiumToken) cesiumToken = config.cesiumIonToken
  createTerrainBadge()
  setLoader(38, '连接 Cesium 地形与影像…')

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
  // Cesium Ion API and the MapTiler URL terrain are currently unreachable /
  // stuck at level 1 on this network, so default to the fast ArcGIS imagery
  // globe. Use ?ion=1 or ?terrain=maptiler to opt back in.
  if (forceIon && cesiumToken) {
    viewer.terrain.set(createTerrainOptions(config))
  } else if (forceMapTilerTerrain) {
    viewer.terrain.set(createTerrainOptions(config))
  }

  const cloudsToggle = $<HTMLInputElement>('#clouds-toggle')
  const atmosphereToggle = $<HTMLInputElement>('#atmosphere-toggle')
  const coverage = $<HTMLInputElement>('#coverage')
  const coverageValue = $<HTMLOutputElement>('#coverage-value')
  const cloudAltitude = $<HTMLInputElement>('#cloud-altitude')
  const cloudAltitudeValue = $<HTMLOutputElement>('#cloud-altitude-value')
  const quality = $<HTMLInputElement>('#quality')
  const qualityValue = $<HTMLOutputElement>('#quality-value')
  const localHour = $<HTMLInputElement>('#local-hour')
  const localHourValue = $<HTMLOutputElement>('#local-hour-value')
  const fpsStatus = $('#fps-status')

  const setCloudAltitude = (meters: number) => {
    viewer.scene.clouds.layer.altitude = meters
    viewer.scene.clouds.layer.height = Math.max(250, Math.min(1100, Math.round(meters * 0.09)))
    cloudAltitude.value = String(Math.round(meters))
    cloudAltitudeValue.textContent = `${Math.round(meters)} m`
  }

  cloudsToggle.checked = false
  cloudsToggle.addEventListener('change', () => {
    viewer.scene.clouds.show = cloudsToggle.checked
    const span = cloudStatus.querySelector('span')
    if (span) span.textContent = cloudsToggle.checked ? '已开启' : '已关闭'
    cloudStatus.style.opacity = cloudsToggle.checked ? '1' : '0.55'
  })

  coverage.addEventListener('input', () => {
    const percent = Number(coverage.value)
    viewer.scene.clouds.coverage = percent / 100
    coverageValue.textContent = `${percent}%`
  })

  cloudAltitude.addEventListener('input', () => setCloudAltitude(Number(cloudAltitude.value)))

  quality.addEventListener('input', () => {
    const index = Math.max(0, Math.min(QUALITY_PRESETS.length - 1, Number(quality.value)))
    viewer.scene.clouds.quality = QUALITY_PRESETS[index]
    qualityValue.textContent = QUALITY_LABELS[index]
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
  qualityValue.textContent = QUALITY_LABELS[DEFAULT_QUALITY_INDEX]
  quality.value = String(DEFAULT_QUALITY_INDEX)
  localHourValue.textContent = formatTime(930)
  const clockSpan = fpsStatus.querySelector('span')
  if (clockSpan) clockSpan.textContent = formatTime(930)

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
    viewer.destroy()
  })
}

boot().catch((error) => {
  console.error(error)
  showError(error instanceof Error ? error.message : '未知错误')
})
