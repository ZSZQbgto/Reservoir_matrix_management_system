import tellux, { type ImageryLayerOptions, type TerrainOptions, type Viewer } from 'tellux'
import { domId } from './shared/domIds'
import { WaterEditor } from './water/waterEditor'
import { initUiShell } from './ui/shell'
import { CLOUD_SCENE_DEFAULTS, initCloudControls } from './ui/cloudControls'
import { assetPath, STATIC_HOST } from './shared/assets'
import { requireElement } from './shared/dom'
import {
  DEFAULT_TIME_MINUTES,
  formatAltitude,
  formatClockTime,
  formatCoordinate,
  minutesToSceneDate
} from './shared/format'
import './style.css'

const INITIAL_VIEW = {
  longitude: 116.77,
  latitude: 36.015,
  height: 7600,
  heading: 0,
  pitch: -75
}

/**
 * 静态托管（GitHub Pages）下直接使用 Cesium Ion 的地形 / 影像服务；
 * token 由构建时注入 `VITE_CESIUM_ION_TOKEN`，因此会出现在前端产物里。
 * 本地 / 自建服务器仍走 .cache/tiles + 本地中间件。
 */
const ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? '').trim()
const USE_CESIUM_ION = STATIC_HOST && ION_TOKEN.length > 0
const CESIUM_TERRAIN_ASSET_ID = 1
const CESIUM_IMAGERY_ASSET_ID = 2

const loader = requireElement(domId('loader'))
const loaderDetail = requireElement(domId('loader-detail'))
const loaderBar = requireElement<HTMLElement>(domId('loader-bar'))
const toast = requireElement(domId('toast'))

function setLoader(progress: number, detail: string): void {
  loaderDetail.textContent = detail
  loaderBar.style.width = `${Math.max(6, Math.min(100, progress))}%`
  loaderBar.style.animation = 'none'
  loaderBar.style.transform = 'none'
  loaderBar.style.background =
    'linear-gradient(90deg, rgba(127,227,255,0.2), #7fe3ff, rgba(127,227,255,0.2))'
}

function hideLoader(delay = 300): void {
  window.setTimeout(() => loader.classList.add('is-hidden'), delay)
}

function showError(message: string): void {
  loader.classList.remove('is-hidden')
  loaderDetail.textContent = message
  loader.classList.add('is-error')
  const title = loader.querySelector('strong')
  if (title) title.textContent = '三维地球加载失败'
  loaderBar.style.width = '100%'
  // 清掉 setLoader 写的内联背景，让 .loader.is-error 的样式生效。
  loaderBar.style.background = ''
}

let toastTimer = 0
function showToast(message: string, duration = 2600): void {
  toast.textContent = message
  toast.classList.add('is-visible')
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), duration)
}

/**
 * 运行期兜底：未捕获错误与未处理的 Promise 拒绝。
 *
 * 视口就绪前把原因写进加载层，就绪后改用 toast，
 * 避免一次偶发错误把已经渲染好的场景替换成错误页。
 */
let viewerReady = false

function reportRuntimeError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason ?? '未知错误')
  if (viewerReady) {
    showToast(`运行出错：${message}`, 4200)
    return
  }
  showError(message)
}

window.addEventListener('error', (event) => {
  console.error('[app] 未捕获错误', event.error ?? event.message)
  reportRuntimeError(event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('[app] 未处理的 Promise 拒绝', event.reason)
  reportRuntimeError(event.reason)
})

/** 影像：静态托管直连 Cesium Ion；本地走缓存中间件。 */
function createOverlays(): ImageryLayerOptions[] {
  if (USE_CESIUM_ION) {
    return [
      {
        name: 'Cesium World Imagery（Cesium Ion）',
        source: {
          type: 'cesium-ion',
          assetId: CESIUM_IMAGERY_ASSET_ID,
          apiToken: ION_TOKEN
        }
      }
    ]
  }
  return [
    {
      name: 'Cesium / ArcGIS World Imagery（本地缓存）',
      source: {
        type: 'xyz',
        url: assetPath('imagery-cache/{z}/{y}/{x}.jpg'),
        levels: 19,
        projection: 'EPSG:3857',
        tileDimension: 256
      }
    }
  ]
}

/** 地形：静态托管直连 Cesium World Terrain；本地走缓存中间件。 */
function createTerrainOptions(): TerrainOptions {
  if (USE_CESIUM_ION) {
    return {
      type: 'cesium-ion',
      apiToken: ION_TOKEN,
      assetId: CESIUM_TERRAIN_ASSET_ID,
      tileLoading: { enableTileSplitting: false, imageryResolution: 256 }
    }
  }
  return {
    type: 'url',
    url: assetPath('terrain-cache/layer.json'),
    tileLoading: { enableTileSplitting: false, imageryResolution: 256 }
  }
}

let waterEditor: WaterEditor | null = null

function mountWaterEditor(viewer: Viewer): void {
  if (waterEditor) return
  waterEditor = new WaterEditor(viewer, { toast: showToast })
  window.waterEditor = waterEditor
}

async function boot(): Promise<void> {
  setLoader(14, '读取地形缓存配置…')
  setLoader(38, '连接地形与影像服务…')

  let viewer: Viewer
  try {
    viewer = new tellux.Viewer(requireElement<HTMLElement>(domId('viewer')), {
      dracoDecoderPath: assetPath('draco/'),
      clock: {
        currentTime: minutesToSceneDate(DEFAULT_TIME_MINUTES),
        shouldAnimate: false
      },
      camera: {
        destination: {
          longitude: INITIAL_VIEW.longitude,
          latitude: INITIAL_VIEW.latitude,
          height: INITIAL_VIEW.height
        },
        orientation: {
          heading: INITIAL_VIEW.heading,
          pitch: INITIAL_VIEW.pitch
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
          show: CLOUD_SCENE_DEFAULTS.show,
          quality: CLOUD_SCENE_DEFAULTS.quality,
          coverage: CLOUD_SCENE_DEFAULTS.coverage,
          lightShafts: CLOUD_SCENE_DEFAULTS.lightShafts,
          layer: {
            altitude: CLOUD_SCENE_DEFAULTS.altitude,
            height: CLOUD_SCENE_DEFAULTS.height
          },
          look: {
            detail: CLOUD_SCENE_DEFAULTS.detail,
            turbulence: CLOUD_SCENE_DEFAULTS.turbulence,
            haze: CLOUD_SCENE_DEFAULTS.haze
          },
          shadow: { quality: CLOUD_SCENE_DEFAULTS.shadowQuality }
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

  window.viewer = viewer

  for (const overlay of createOverlays()) viewer.overlays.add(overlay)
  viewer.globe.show = true
  viewer.terrain.set(createTerrainOptions())

  mountWaterEditor(viewer)
  initUiShell()
  viewerReady = true

  const clockValue = requireElement('#clock-status span')
  initCloudControls({
    viewer,
    showToast,
    onTimeChange: (minutes) => {
      clockValue.textContent = formatClockTime(minutes)
    }
  })

  setLoader(100, '就绪')
  hideLoader(260)

  // 底部相机读数：低频刷新，避免每帧写 DOM。
  const coordLon = requireElement(domId('coord-lon'))
  const coordLat = requireElement(domId('coord-lat'))
  const coordAlt = requireElement(domId('coord-alt'))
  const readoutTimer = window.setInterval(() => {
    const { destination } = viewer.camera.getState()
    coordLon.textContent = formatCoordinate(destination.longitude, 'E', 'W')
    coordLat.textContent = formatCoordinate(destination.latitude, 'N', 'S')
    coordAlt.textContent = formatAltitude(destination.height)
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
