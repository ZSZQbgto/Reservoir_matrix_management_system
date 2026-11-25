import tellux, { type ImageryLayerOptions, type TerrainOptions, type Viewer } from 'tellux'
import { WaterEditor } from './water/waterEditor'
import { CLOUD_SCENE_DEFAULTS } from './ui/cloudDefaults'
import { startMuiUi } from './ui/mui/mount'
import { assetPath, STATIC_HOST } from './shared/assets'
import { DEFAULT_TIME_MINUTES, minutesToSceneDate } from './shared/format'

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

const ui = startMuiUi()

function showToast(message: string, duration = 2600): void {
  window.dispatchEvent(new CustomEvent('water-toast', { detail: { message, duration } }))
}

/**
 * 运行期兜底：未捕获错误与未处理的 Promise 拒绝。
 *
 * 视口就绪前把原因写进启动页，就绪后改用 toast。
 */
let viewerReady = false

function reportRuntimeError(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason ?? '未知错误')
  if (viewerReady) {
    showToast(`运行出错：${message}`, 4200)
    return
  }
  ui.error(message)
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
  ui.progress(14, '读取地形缓存配置…')
  ui.progress(38, '连接地形与影像服务…')

  let viewer: Viewer
  try {
    const container = document.getElementById('viewer')
    if (!container) throw new Error('缺少 #viewer')
    viewer = new tellux.Viewer(container, {
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
    ui.error(error instanceof Error ? error.message : '无法创建 WebGL 渲染器')
    return
  }

  window.viewer = viewer

  for (const overlay of createOverlays()) viewer.overlays.add(overlay)
  viewer.globe.show = true
  viewer.terrain.set(createTerrainOptions())

  mountWaterEditor(viewer)
  viewerReady = true

  if (waterEditor) ui.ready(viewer, waterEditor)

  window.addEventListener('beforeunload', () => {
    waterEditor?.dispose()
    viewer.destroy()
  })
}

boot().catch((error) => {
  console.error(error)
  ui.error(error instanceof Error ? error.message : '未知错误')
})
