import * as THREE from 'three'
import type { Viewer } from 'tellux'
import { ShallowWaterSim } from './shallowWater'
import { WaterSurface } from './waterSurface'
import { DomainBoundary, SourceMarkers } from './markers'
import {
  createLocalProjection,
  resampleTerrain,
  sampleFieldHeight,
  sampleTerrainField,
  type LocalProjection
} from './terrainField'
import { computeSunDirectionENU } from './sun'
import { delay, nextFrame } from './async'
import { requireElement as $, syncRangeFill } from '../ui/dom'
import {
  clearCachedDomainField,
  clearServerDomainField,
  fetchServerDomainField,
  getCachedDomainInfo,
  loadCachedDomainField,
  saveCachedDomainField,
  saveDomainFieldToServer
} from './domainCache'
import {
  MAX_WATER_SOURCES,
  SIM_RESOLUTION_OPTIONS,
  TERRAIN_GRID_SIZE,
  VISUAL_DEFAULTS,
  WATER_DOMAIN,
  clamp,
  cloneState,
  createSourceId,
  normalizeWaterState,
  type SimSource,
  type SurfaceDomain,
  type TerrainField,
  type WaterSource,
  type WaterState,
  type WaterVisualSettings
} from './types'
import {
  downloadStateJson,
  loadStoredMode,
  loadStoredState,
  readStateFile,
  storeMode,
  storeState,
  type EditorMode
} from './persistence'

export interface WaterEditorOptions {
  toast(message: string, duration?: number): void
}

const formatMeters = (value: number | null | undefined): string => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(1)} m`
}

const formatLonLat = (longitude: number, latitude: number): string =>
  `${longitude.toFixed(5)}°, ${latitude.toFixed(5)}°`

interface DragState {
  id: string
  pointerId: number
  startClientX: number
  startClientY: number
}

interface ClickCandidate {
  startClientX: number
  startClientY: number
  pointerId: number
  moved: boolean
}

interface BuildTask {
  token: number
  cancel: { cancelled: boolean }
  promise: Promise<boolean>
}

/** 外观滑杆对应的数值字段。 */
type NumericVisualKey = keyof WaterVisualSettings

/** 一条外观滑杆：状态键、控件与取值范围。 */
interface VisualControl {
  key: NumericVisualKey
  input: HTMLInputElement
  output: HTMLOutputElement
  min: number
  max: number
}

/**
 * 水体编辑器总控：模式切换、模拟域构建、水源放置/拖动、面板与持久化。
 *
 * 水体总开关打开时模拟始终推进，因此从「浏览」模式也能看到水面继续变化；
 * 只有水源标记、放置交互与模拟域边界仅在水体编辑模式出现。
 */
export class WaterEditor {
  private readonly viewer: Viewer
  private readonly options: WaterEditorOptions
  private readonly scene: THREE.Scene
  private readonly renderer: THREE.WebGLRenderer
  private readonly canvas: HTMLCanvasElement

  private state: WaterState
  private mode: EditorMode = 'scene'
  private field: TerrainField | null = null
  private projection: LocalProjection | null = null
  private domain: SurfaceDomain | null = null
  /** 当前模拟域地形来源：本地存储恢复 / 现场采样。 */
  private domainSource: 'cache' | 'sampled' | null = null
  private sim: ShallowWaterSim | null = null
  private surface: WaterSurface | null = null
  private readonly markers: SourceMarkers
  private readonly boundary: DomainBoundary

  private selectedId: string | null = null
  private placing = false
  private drag: DragState | null = null
  private clickCandidate: ClickCandidate | null = null
  private build: BuildTask | null = null
  private buildToken = 0
  private modeTouched = false
  private readonly buildWaiters: Array<(ready: boolean) => void> = []
  private disposed = false

  private animationHandle = 0
  private lastFrameAt = 0
  private lastStatsAt = 0
  private lastSunAt = 0
  private saveTimer = 0
  private restoreTimer = 0
  private statsSnapshot = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }

  // UI 引用
  private readonly body = document.body
  private readonly modeScene = $('#mode-scene')
  private readonly modeWater = $('#mode-water')
  private readonly consoleElement = $('#console')
  private readonly waterLeft = $('#water-left')
  private readonly waterRight = $('#water-right')
  private readonly waterLabels = $('#water-labels')
  private readonly waterToggle = $<HTMLInputElement>('#water-toggle')
  private readonly waterPill = $('#water-status-pill')
  private readonly addButton = $<HTMLButtonElement>('#water-add-source')
  private readonly clearButton = $<HTMLButtonElement>('#water-clear-sources')
  private readonly progress = $('#water-progress')
  private readonly progressBar = $('#water-progress-bar')
  private readonly progressLabel = $('#water-progress-label')
  private readonly sourceList = $('#water-source-list')
  private readonly domainMeta = $('#water-domain-meta')
  private readonly rebuildButton = $<HTMLButtonElement>('#water-rebuild-domain')
  private readonly speedInput = $<HTMLInputElement>('#water-speed')
  private readonly speedValue = $<HTMLOutputElement>('#water-speed-value')
  private readonly amountInput = $<HTMLInputElement>('#water-amount')
  private readonly amountValue = $<HTMLOutputElement>('#water-amount-value')
  private readonly resolutionInput = $<HTMLInputElement>('#water-resolution')
  private readonly resolutionValue = $<HTMLOutputElement>('#water-resolution-value')
  private readonly maxFlowSpeedInput = $<HTMLInputElement>('#water-max-flow-speed')
  private readonly maxFlowSpeedValue = $<HTMLOutputElement>('#water-max-flow-speed-value')
  private readonly dampingInput = $<HTMLInputElement>('#water-damping')
  private readonly dampingValue = $<HTMLOutputElement>('#water-damping-value')
  private readonly injectIntervalInput = $<HTMLInputElement>('#water-inject-interval')
  private readonly injectIntervalValue = $<HTMLOutputElement>('#water-inject-interval-value')
  private readonly pauseButton = $<HTMLButtonElement>('#water-pause')
  private readonly resetButton = $<HTMLButtonElement>('#water-reset')
  private readonly statusLine = $('#water-status')
  private readonly sourceEditor = $('#water-source-editor')
  private readonly sourceName = $<HTMLInputElement>('#water-source-name')
  private readonly sourceGround = $<HTMLOutputElement>('#water-source-ground')
  private readonly sourceRadius = $<HTMLInputElement>('#water-source-radius')
  private readonly sourceRadiusValue = $<HTMLOutputElement>('#water-source-radius-value')
  private readonly sourceTarget = $<HTMLInputElement>('#water-source-target')
  private readonly sourceEnabled = $<HTMLInputElement>('#water-source-enabled')
  private readonly sourceDelete = $<HTMLButtonElement>('#water-source-delete')
  private readonly shimmerInput = $<HTMLInputElement>('#water-shimmer')
  private readonly shimmerValue = $<HTMLOutputElement>('#water-shimmer-value')
  private readonly glintInput = $<HTMLInputElement>('#water-glint')
  private readonly glintValue = $<HTMLOutputElement>('#water-glint-value')
  private readonly reflectionInput = $<HTMLInputElement>('#water-reflection')
  private readonly reflectionValue = $<HTMLOutputElement>('#water-reflection-value')
  private readonly rippleInput = $<HTMLInputElement>('#water-ripple')
  private readonly rippleValue = $<HTMLOutputElement>('#water-ripple-value')
  private readonly rippleScaleInput = $<HTMLInputElement>('#water-ripple-scale')
  private readonly rippleScaleValue = $<HTMLOutputElement>('#water-ripple-scale-value')
  private readonly flowSpeedInput = $<HTMLInputElement>('#water-flow-speed')
  private readonly flowSpeedValue = $<HTMLOutputElement>('#water-flow-speed-value')
  private readonly foamInput = $<HTMLInputElement>('#water-foam')
  private readonly foamValue = $<HTMLOutputElement>('#water-foam-value')
  private readonly appearanceReset = $<HTMLButtonElement>('#water-appearance-reset')
  private readonly clarityInput = $<HTMLInputElement>('#water-clarity')
  private readonly clarityValue = $<HTMLOutputElement>('#water-clarity-value')
  private readonly opacityInput = $<HTMLInputElement>('#water-opacity')
  private readonly opacityValue = $<HTMLOutputElement>('#water-opacity-value')
  private readonly saveButton = $<HTMLButtonElement>('#water-save')
  private readonly exportButton = $<HTMLButtonElement>('#water-export')
  private readonly importButton = $<HTMLButtonElement>('#water-import')
  private readonly importInput = $<HTMLInputElement>('#water-import-file')
  private readonly projectStatus = $('#water-project-status')
  /** 外观滑杆与状态字段的对应表：同步与绑定共用，避免两处各列一遍。 */
  private readonly visualControls: VisualControl[]

  constructor(viewer: Viewer, options: WaterEditorOptions) {
    this.viewer = viewer
    this.options = options
    this.scene = viewer.scene.raw
    this.renderer = viewer.renderer.raw as THREE.WebGLRenderer
    this.canvas = this.renderer.domElement
    this.state = loadStoredState()
    this.markers = new SourceMarkers(viewer, { scene: this.scene, labelContainer: this.waterLabels })
    this.boundary = new DomainBoundary(viewer, this.scene)
    this.visualControls = this.createVisualControls()

    this.bindEvents()
    this.syncAll()
    this.applySimState()

    this.animationHandle = requestAnimationFrame(this.animate)
    window.addEventListener('beforeunload', this.handleBeforeUnload)
    ;(window as unknown as { __waterEditor?: unknown }).__waterEditor = this.debugApi()

    if (loadStoredMode() === 'water') {
      this.restoreTimer = window.setTimeout(() => {
        if (this.disposed || this.modeTouched) return
        void this.enterMode('water')
      }, 900)
    }
  }

  get currentMode(): EditorMode {
    return this.mode
  }

  get currentState(): WaterState {
    return cloneState(this.state)
  }

  get isDomainReady(): boolean {
    return Boolean(this.sim && this.surface && this.domain)
  }

  async enterMode(mode: EditorMode): Promise<void> {
    if (this.mode === mode) {
      if (mode === 'water') await this.ensureDomain()
      return
    }
    this.mode = mode
    this.consoleElement.hidden = mode === 'water'
    this.waterLeft.hidden = mode !== 'water'
    this.waterRight.hidden = mode !== 'water'
    this.markers.setVisible(mode === 'water')
    this.boundary.setVisible(mode === 'water')
    if (mode !== 'water') this.exitPlacing()
    storeMode(mode)
    this.syncModeUI()
    this.syncStatus()
    this.syncPill()
    if (mode === 'water') await this.ensureDomain()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.animationHandle)
    window.clearTimeout(this.saveTimer)
    window.clearTimeout(this.restoreTimer)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    this.detachPointerEvents()
    delete (window as unknown as { __waterEditor?: unknown }).__waterEditor
    if (this.build) this.build.cancel.cancelled = true
    this.disposeSimulation()
    this.markers.dispose()
    this.boundary.dispose()
    this.canvas.style.cursor = ''
  }

  // ---------------------------------------------------------------- 模拟域

  private async ensureDomain(): Promise<boolean> {
    if (this.isDomainReady) return true
    if (this.build) return this.build.promise
    this.state.domain = { ...WATER_DOMAIN }
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    this.filterSourcesToDomain(center, WATER_DOMAIN.sizeMeters)

    // 固定模拟域的地形高度场已在本地存储中：直接恢复，跳过飞行等待与 97² 采样。
    const cached = loadCachedDomainField()
    if (cached) {
      this.applyDomainField(cached, 'cache')
      this.progress.hidden = true
      this.syncBusy()
      this.options.toast(
        `模拟域已从本地存储恢复 · 8 km × 8 km · 地形 ${cached.resolution}²`,
        2800
      )
      // 相机仍飞到固定域正上方，地形瓦片由本地缓存提供。
      void this.flyOverDomain(center, WATER_DOMAIN.sizeMeters)
      return true
    }

    // 浏览器缓存缺失时尝试服务器本地缓存（.cache/tiles/domain），跨浏览器可复用。
    const serverField = await fetchServerDomainField()
    if (serverField) {
      saveCachedDomainField(serverField)
      this.applyDomainField(serverField, 'cache')
      this.progress.hidden = true
      this.syncBusy()
      this.options.toast(
        `模拟域已从服务器本地存储恢复 · 8 km × 8 km · 地形 ${serverField.resolution}²`,
        2800
      )
      void this.flyOverDomain(center, WATER_DOMAIN.sizeMeters)
      return true
    }

    return this.buildDomain(center, WATER_DOMAIN.sizeMeters)
  }

  /** 把水源限制在模拟域内（固定区域或重建后的区域），返回移除数量。 */
  private filterSourcesToDomain(
    center: { longitude: number; latitude: number },
    sizeMeters: number
  ): number {
    const projection = createLocalProjection(center, sizeMeters)
    const before = this.state.sources.length
    this.state.sources = this.state.sources.filter((source) => {
      const local = projection.toLocal(source.longitude, source.latitude)
      return projection.contains(local.x, local.z)
    })
    const removed = before - this.state.sources.length
    if (removed > 0) {
      if (this.selectedId && !this.state.sources.some((entry) => entry.id === this.selectedId)) {
        this.selectedId = null
      }
      this.options.toast(`已移除 ${removed} 个固定模拟区外的水源`, 3200)
    }
    return removed
  }

  /** 用一份地形高度场建立 / 替换模拟域与水面（本地缓存恢复或现场采样共用）。 */
  private applyDomainField(field: TerrainField, source: 'cache' | 'sampled'): void {
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    // 本地缓存恢复路径不经过 buildDomain，必须在这里补齐投影，否则：
    // - toSimSources 返回空数组 -> 水源不注水，水面消失；
    // - 水源拖动 / 圆环贴地 / 域边界都需要 projection。
    this.projection = createLocalProjection(center, WATER_DOMAIN.sizeMeters)
    this.field = field
    this.domain = {
      origin: center,
      sizeMeters: WATER_DOMAIN.sizeMeters,
      resolution: field.resolution,
      baseElevation: field.baseElevation
    }
    this.state.domain = { ...WATER_DOMAIN }
    this.domainSource = source
    this.createSimulation()
    this.syncAll()
    this.scheduleSave()
  }

  private async buildDomain(
    center: { longitude: number; latitude: number },
    sizeMeters: number
  ): Promise<boolean> {
    if (this.build) this.build.cancel.cancelled = true
    const token = ++this.buildToken
    // 固定 8 km × 8 km 模拟域：超出范围的水源在重建时移除（例如旧工程保存的水源）。
    this.filterSourcesToDomain(center, sizeMeters)
    this.state.domain = { longitude: center.longitude, latitude: center.latitude, sizeMeters }
    const cancel = { cancelled: false }
    let resolveBuild: (ready: boolean) => void = () => {}
    const promise = new Promise<boolean>((resolve) => {
      resolveBuild = resolve
    })
    this.build = { token, cancel, promise }
    this.disposeSimulation()
    this.domainSource = null
    this.projection = createLocalProjection(center, sizeMeters)
    this.domain = null
    this.field = null
    this.progress.hidden = false
    this.progressBar.style.width = '4%'
    this.progressLabel.textContent = '正在定位模拟域…'
    this.syncBusy()
    this.syncPill()
    this.syncDomainMeta()
    this.syncStatus()

    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      resolveBuild(ready)
    }

    try {
      await this.flyOverDomain(center, sizeMeters)
      if (token !== this.buildToken) {
        finish(false)
        return false
      }
      this.progressBar.style.width = '8%'
      this.progressLabel.textContent = '正在等待地形加载…'
      this.syncStatus()
      const terrainAvailable = await this.waitForTerrainAvailable(center, 20000)
      if (token !== this.buildToken) {
        finish(false)
        return false
      }
      if (!terrainAvailable) {
        this.options.toast('地形尚未加载完成，无法采样模拟域，请稍后重试', 4200)
        this.syncStatus()
        this.syncPill()
        finish(false)
        this.flushBuildWaiters(false)
        return false
      }
      this.progressLabel.textContent = '正在等待地形细化…'
      await this.waitForTerrainStable(center)
      if (token !== this.buildToken) {
        finish(false)
        return false
      }
      this.progressBar.style.width = '10%'
      this.progressLabel.textContent = '正在采样地形高度…'

      const sampleHeight = (points: Array<{ longitude: number; latitude: number }>) =>
        this.viewer.sampleHeight(points)
      let field: TerrainField | null = null
      for (let attempt = 0; attempt < 3; attempt += 1) {
        field = await sampleTerrainField({
          projection: this.projection,
          sampleHeight,
          gridSize: TERRAIN_GRID_SIZE,
          chunkRows: 4,
          cancel,
          onProgress: (completed, total) => {
            if (token !== this.buildToken) return
            const fraction = 0.1 + (completed / total) * 0.8
            this.progressBar.style.width = `${Math.round(fraction * 100)}%`
            this.progressLabel.textContent = `正在采样地形高度… ${Math.round((completed / total) * 100)}%`
          }
        })
        if (token !== this.buildToken) {
          finish(false)
          return false
        }
        if (!field) break
        // 采样期间地形瓦片可能继续细化：等一拍再比对域中心高程，漂移明显就重新采样。
        await delay(900)
        if (token !== this.buildToken) {
          finish(false)
          return false
        }
        const freshCenter = this.sampleGround(center.longitude, center.latitude)
        const drift =
          typeof freshCenter === 'number' ? Math.abs(freshCenter - field.baseElevation) : 0
        if (typeof freshCenter !== 'number' || drift <= 0.6) break
        this.progressLabel.textContent = '地形仍在细化，重新采样…'
        field = null
      }
      if (!field) {
        this.progress.hidden = true
        this.options.toast('地形高度采样失败，请等地形加载完成后重试', 3600)
        this.syncStatus()
        this.syncPill()
        finish(false)
        this.flushBuildWaiters(false)
        return false
      }

      const cachedSaved = saveCachedDomainField(field)
      const serverSaved = await saveDomainFieldToServer(field)
      this.applyDomainField(field, 'sampled')
      this.progressBar.style.width = '100%'
      this.progressLabel.textContent = '模拟域已就绪'
      await nextFrame()
      this.progress.hidden = true
      this.options.toast(
        `模拟域已就绪 · 8 km × 8 km · 地形 ${field.resolution}²${
          cachedSaved || serverSaved ? ' · 已保存到本地' : ''
        } · 模拟 ${this.state.sim.resolution}²`,
        3400
      )
      finish(true)
      this.flushBuildWaiters(true)
      return true
    } catch (error) {
      console.error('[water-editor] 构建模拟域失败', error)
      if (token === this.buildToken) {
        this.options.toast('构建模拟域时出错，请重试', 3600)
        this.syncStatus()
        this.syncPill()
      }
      finish(false)
      this.flushBuildWaiters(false)
      return false
    } finally {
      if (token === this.buildToken) {
        this.build = null
        this.progress.hidden = true
        this.syncBusy()
        this.syncStatus()
        this.syncPill()
      }
    }
  }

  private flushBuildWaiters(ready: boolean): void {
    while (this.buildWaiters.length > 0) {
      const waiter = this.buildWaiters.shift()
      waiter?.(ready)
    }
  }

  /** 飞到模拟域正上方，既给用户编辑视角，也促使地形瓦片按该区域加载。 */
  private async flyOverDomain(
    center: { longitude: number; latitude: number },
    sizeMeters: number
  ): Promise<void> {
    const ground = this.sampleGround(center.longitude, center.latitude) ?? 0
    const height = Math.max(1500, ground + sizeMeters * 0.92)
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      try {
        this.viewer.camera.flyTo({
          destination: { longitude: center.longitude, latitude: center.latitude, height },
          orientation: { heading: 0, pitch: -85, roll: 0 },
          duration: 0.95,
          complete: finish,
          cancel: finish
        })
      } catch {
        finish()
      }
      window.setTimeout(finish, 1500)
    })
  }

  /**
   * 等待模拟域中心能采到地形高度（地形瓦片尚未加载时 sampleHeight 返回 undefined）。
   */
  private async waitForTerrainAvailable(
    center: { longitude: number; latitude: number },
    maxMs = 15000
  ): Promise<boolean> {
    const started = performance.now()
    while (performance.now() - started < maxMs) {
      if (typeof this.sampleGround(center.longitude, center.latitude) === 'number') return true
      await delay(350)
    }
    return false
  }

  /**
   * 等待地形瓦片在当前俯视视角下细化稳定。
   *
   * `viewer.sampleHeight` 只使用已加载瓦片：飞抵新视角后 LOD 会在数秒内连续细化，
   * 过早采样会让模拟地形与随后显示的地形相差十几米。这里要求：
   * - 飞抵后至少再等 3.2 s（瓦片细化通常需要 2–4 s）；
   * - 域中心高度连续 3 次变化小于 0.2 m；
   * - 最多等 12 s，仍未稳定也继续（后续采样后还有漂移复采兜底）。
   */
  private async waitForTerrainStable(
    center: { longitude: number; latitude: number },
    maxMs = 12000
  ): Promise<void> {
    const started = performance.now()
    let previous: number | undefined
    let stableCount = 0
    while (performance.now() - started < maxMs) {
      await delay(320)
      const height = this.sampleGround(center.longitude, center.latitude)
      if (typeof height !== 'number') {
        stableCount = 0
        previous = undefined
        continue
      }
      if (typeof previous === 'number' && Math.abs(height - previous) < 0.2) {
        stableCount += 1
        if (stableCount >= 3 && performance.now() - started >= 3200) return
      } else {
        stableCount = 0
      }
      previous = height
    }
  }

  /** 用模拟地形高度场取地面高程（与浅水模拟使用同一份地形，保证目标水位一致）。 */
  private groundFromField(longitude: number, latitude: number): number | undefined {
    if (!this.field || !this.projection) return undefined
    const local = this.projection.toLocal(longitude, latitude)
    return this.field.baseElevation + sampleFieldHeight(this.field, local.x, local.z)
  }

  private sampleGround(longitude: number, latitude: number): number | undefined {
    try {
      const height = this.viewer.sampleHeight({ longitude, latitude })
      return typeof height === 'number' && Number.isFinite(height) ? height : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 取某点的地面高程：显式采样值（如点选命中高度）优先，
   * 其次用模拟地形场（与浅水模拟一致），最后回退到 viewer 实时采样。
   */
  private groundLevelAt(
    longitude: number,
    latitude: number,
    preferred?: number | null
  ): number | null {
    if (typeof preferred === 'number' && Number.isFinite(preferred)) return preferred
    const fromField = this.groundFromField(longitude, latitude)
    if (typeof fromField === 'number') return fromField
    return this.sampleGround(longitude, latitude) ?? null
  }

  /** 用当前地形场与投影建立模拟与水面；三者缺一不可（域重建期间会短暂缺失）。 */
  private createSimulation(): void {
    const domain = this.domain
    const field = this.field
    const projection = this.projection
    if (!domain || !field || !projection) return

    for (const source of this.state.sources) {
      const ground = this.groundFromField(source.longitude, source.latitude)
      if (typeof ground === 'number') source.groundLevel = ground
    }
    const simTerrain = resampleTerrain(field, this.state.sim.resolution)
    this.sim = new ShallowWaterSim(this.renderer, simTerrain)
    this.surface = new WaterSurface(
      this.viewer,
      domain,
      this.sim.stateTexture,
      this.state.sim.resolution
    )
    this.applySimState()
    this.updateSun(true)
    this.boundary.setDomain(domain, projection).catch(() => {})
    this.markers.setSources(this.state.sources, this.selectedId, projection)
  }

  private rebuildSimulation(): void {
    if (!this.domain || !this.field) return
    this.disposeSimulation()
    this.createSimulation()
    this.options.toast('模拟精度已切换，水位已重置', 2600)
  }

  private disposeSimulation(): void {
    this.surface?.dispose()
    this.surface = null
    this.sim?.dispose()
    this.sim = null
  }

  private toSimSources(): SimSource[] {
    const projection = this.projection
    if (!projection) return []
    return this.state.sources.map((source) => {
      const local = projection.toLocal(source.longitude, source.latitude)
      return {
        x: local.x,
        z: local.z,
        radius: source.radius,
        targetLevel: source.targetLevel,
        amount: source.amount ?? this.state.sim.waterAmount,
        enabled: source.enabled
      }
    })
  }

  private applySimState(): void {
    if (!this.sim) return
    this.sim.setSettings({
      speed: this.state.sim.speed,
      paused: this.state.sim.paused,
      waterAmount: this.state.sim.waterAmount,
      maxFlowSpeed: this.state.sim.maxFlowSpeed,
      damping: this.state.sim.damping,
      injectInterval: this.state.sim.injectInterval
    })
    this.sim.setSources(this.toSimSources())
    this.surface?.setVisual(this.state.visual)
    this.surface?.setEnabled(this.state.enabled)
  }

  private updateSun(force = false): void {
    if (!this.surface || !this.domain) return
    const now = performance.now()
    if (!force && now - this.lastSunAt < 2000) return
    this.lastSunAt = now
    const date = this.viewer.clock.currentTime
    const direction = computeSunDirectionENU(
      date,
      this.domain.origin.longitude,
      this.domain.origin.latitude
    )
    this.surface.setSunDirection(direction)
  }

  /** 重新采样固定 8 km × 8 km 模拟域（中心固定为 116.77, 36.02）。 */
  private async rebuildFixedDomain(): Promise<void> {
    this.selectedId = null
    this.markers.setSources([], null, null)
    await this.buildDomain(
      { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
      WATER_DOMAIN.sizeMeters
    )
  }

  // ---------------------------------------------------------------- 状态与 UI

  private syncAll(): void {
    this.waterToggle.checked = this.state.enabled
    this.syncModeUI()
    this.syncBusy()
    this.syncSourceList()
    this.syncSourceEditor()
    this.syncSimControls()
    this.syncAppearance()
    this.syncDomainMeta()
    this.syncStatus()
    this.syncPill()
  }

  private syncModeUI(): void {
    this.body.dataset.mode = this.mode
    this.modeScene.classList.toggle('is-active', this.mode === 'scene')
    this.modeWater.classList.toggle('is-active', this.mode === 'water')
    this.modeScene.setAttribute('aria-pressed', String(this.mode === 'scene'))
    this.modeWater.setAttribute('aria-pressed', String(this.mode === 'water'))
    this.consoleElement.hidden = this.mode === 'water'
    this.waterLeft.hidden = this.mode !== 'water'
    this.waterRight.hidden = this.mode !== 'water'
    this.markers.setVisible(this.mode === 'water')
    this.boundary.setVisible(this.mode === 'water')
    this.body.dataset.placing = this.placing ? 'true' : 'false'
    this.addButton.textContent = this.placing ? '取消放置' : '＋ 水源'
    this.addButton.classList.toggle('is-active', this.placing)
    this.canvas.style.cursor = this.placing ? 'crosshair' : ''
  }

  /** 构建模拟域期间禁用会打断流程的按钮；没有水源时「清空」也不可用。 */
  private syncBusy(): void {
    const busy = Boolean(this.build)
    this.addButton.disabled = busy
    this.clearButton.disabled = busy || this.state.sources.length === 0
    this.rebuildButton.disabled = busy
    this.pauseButton.disabled = busy
    this.resetButton.disabled = busy
  }

  private syncSourceList(): void {
    this.syncBusy()
    if (this.state.sources.length === 0) {
      this.sourceList.innerHTML = '<p class="empty-hint">暂无水源</p>'
      return
    }
    this.sourceList.innerHTML = this.state.sources
      .map((source, index) => {
        const selected = source.id === this.selectedId ? 'true' : 'false'
        return `
          <div class="water-source-item" data-id="${source.id}" data-selected="${selected}" role="listitem" tabindex="0">
            <span class="water-source-index">${index + 1}</span>
            <div class="water-source-copy">
              <b>${escapeHtml(source.name)}</b>
              <small>
                <span>高程 ${formatMeters(source.groundLevel)}</span>
                <span>半径 ${Math.round(source.radius)} m</span>
              </small>
            </div>
            <div class="water-source-item-actions">
              <label class="mini-switch">
                <input type="checkbox" data-action="toggle" aria-label="启用 ${escapeHtml(source.name)}" ${source.enabled ? 'checked' : ''} />
                <span></span>
              </label>
              <button type="button" class="icon-button" data-action="delete" aria-label="删除 ${escapeHtml(source.name)}">✕</button>
            </div>
          </div>`
      })
      .join('')
  }

  /** 选中水源编辑区只在有选中项时出现，避免空面板占位。 */
  private syncSourceEditor(): void {
    const source = this.selectedSource()
    this.sourceEditor.hidden = !source
    if (!source) return
    this.sourceName.value = source.name
    this.sourceGround.textContent = formatMeters(source.groundLevel)
    this.sourceRadius.value = String(Math.round(source.radius))
    this.sourceRadiusValue.textContent = `${Math.round(source.radius)} m`
    syncRangeFill(this.sourceRadius)
    this.sourceTarget.value =
      source.targetLevel == null ? '' : String(Number(source.targetLevel.toFixed(2)))
    this.sourceTarget.placeholder =
      source.groundLevel == null ? '不限制' : `不限制（地面 ${source.groundLevel.toFixed(1)} m）`
    this.sourceEnabled.checked = source.enabled
  }

  private syncSimControls(): void {
    const sim = this.state.sim
    this.speedInput.value = String(sim.speed)
    this.speedValue.textContent = `${sim.speed.toFixed(1)}×`
    syncRangeFill(this.speedInput)
    this.amountInput.value = String(Math.round(sim.waterAmount))
    this.amountValue.textContent = `${Math.round(sim.waterAmount)} m`
    syncRangeFill(this.amountInput)
    const index = Math.max(
      0,
      (SIM_RESOLUTION_OPTIONS as readonly number[]).indexOf(sim.resolution)
    )
    this.resolutionInput.value = String(index)
    this.resolutionValue.textContent = `${sim.resolution}²`
    syncRangeFill(this.resolutionInput)
    this.maxFlowSpeedInput.value = String(sim.maxFlowSpeed)
    this.maxFlowSpeedValue.textContent = `${Math.round(sim.maxFlowSpeed)} m/s`
    syncRangeFill(this.maxFlowSpeedInput)
    this.dampingInput.value = String(sim.damping)
    this.dampingValue.textContent = sim.damping.toFixed(3)
    syncRangeFill(this.dampingInput)
    this.injectIntervalInput.value = String(sim.injectInterval)
    this.injectIntervalValue.textContent = `${(sim.injectInterval / 60).toFixed(3)} s`
    syncRangeFill(this.injectIntervalInput)
    this.pauseButton.textContent = sim.paused ? '继续' : '暂停'
  }

  private createVisualControls(): VisualControl[] {
    return [
      { key: 'shimmer', input: this.shimmerInput, output: this.shimmerValue, min: 0, max: 3 },
      { key: 'glint', input: this.glintInput, output: this.glintValue, min: 0.3, max: 2.5 },
      {
        key: 'reflection',
        input: this.reflectionInput,
        output: this.reflectionValue,
        min: 0,
        max: 1.5
      },
      { key: 'ripple', input: this.rippleInput, output: this.rippleValue, min: 0, max: 2 },
      {
        key: 'rippleScale',
        input: this.rippleScaleInput,
        output: this.rippleScaleValue,
        min: 0.4,
        max: 2.5
      },
      { key: 'flowSpeed', input: this.flowSpeedInput, output: this.flowSpeedValue, min: 0, max: 2 },
      { key: 'foam', input: this.foamInput, output: this.foamValue, min: 0, max: 2 },
      { key: 'clarity', input: this.clarityInput, output: this.clarityValue, min: 0, max: 1 },
      { key: 'opacity', input: this.opacityInput, output: this.opacityValue, min: 0, max: 1 }
    ]
  }

  private syncAppearance(): void {
    for (const control of this.visualControls) {
      const value = this.state.visual[control.key]
      control.input.value = String(value)
      control.output.textContent = value.toFixed(2)
      syncRangeFill(control.input)
    }
  }

  private syncDomainMeta(): void {
    const terrainInfo = this.field ? `地形 ${this.field.resolution}²` : '地形采样中'
    const center = formatLonLat(WATER_DOMAIN.longitude, WATER_DOMAIN.latitude)
    if (!this.state.domain) {
      this.domainMeta.textContent = `${center}\n尚未建立`
      return
    }
    this.domainMeta.textContent = `${center}\n${terrainInfo} · 模拟 ${this.state.sim.resolution}²`
  }

  private syncStatus(): void {
    if (this.build) {
      this.statusLine.textContent = this.progressLabel.textContent || '正在构建模拟域…'
      return
    }
    if (!this.isDomainReady) {
      this.statusLine.textContent = '模拟域尚未建立'
      return
    }
    const stats = this.statsSnapshot
    const paused = this.state.sim.paused ? ' · 已暂停' : ''
    this.statusLine.textContent =
      `步数 ${stats.steps} · 湿格 ${stats.wetCells} · 最深 ${stats.maxDepth.toFixed(2)} m${paused}`
  }

  /** 顶部「水体」胶囊：构建 / 关闭 / 放置 / 未构建 / 运行状态。 */
  private syncPill(): void {
    const span = this.waterPill.querySelector('span')
    const setState = (tone: 'ok' | 'warn', label: string): void => {
      this.waterPill.dataset.tone = tone
      if (span) span.textContent = label
    }
    if (this.build) {
      setState('warn', '构建中')
      return
    }
    if (!this.state.enabled) {
      setState('warn', '已关闭')
      return
    }
    if (this.placing) {
      setState('warn', '放置中')
      return
    }
    if (!this.isDomainReady) {
      setState('warn', this.state.sources.length > 0 ? '未构建' : '未启用')
      return
    }
    setState(
      'ok',
      this.state.sim.paused ? '已暂停' : `运行中 · ${this.state.sources.length} 源`
    )
  }

  private setProjectStatus(text: string): void {
    this.projectStatus.textContent = text
  }

  // ---------------------------------------------------------------- 交互

  private bindEvents(): void {
    this.bindModeControls()
    this.bindSimulationControls()
    this.bindSourceControls()
    this.bindAppearanceControls()
    this.bindProjectControls()
    window.addEventListener('keydown', this.handleKeyDown)
    this.attachPointerEvents()
  }

  /** 模式切换与模拟域生命周期按钮。 */
  private bindModeControls(): void {
    this.modeScene.addEventListener('click', () => {
      this.modeTouched = true
      void this.enterMode('scene')
    })
    this.modeWater.addEventListener('click', () => {
      this.modeTouched = true
      void this.enterMode('water')
    })
    this.addButton.addEventListener('click', () => this.togglePlacing())
    this.clearButton.addEventListener('click', () => this.clearSources())
    this.rebuildButton.addEventListener('click', () => void this.rebuildFixedDomain())
  }

  /** 模拟参数：速度、注水量、精度、暂停、重置与水体总开关。 */
  private bindSimulationControls(): void {
    this.speedInput.addEventListener('input', () => {
      this.state.sim.speed = clamp(Number(this.speedInput.value), 0.1, 64)
      this.speedValue.textContent = `${this.state.sim.speed.toFixed(1)}×`
      this.applySimState()
      this.scheduleSave()
    })

    this.amountInput.addEventListener('input', () => {
      this.state.sim.waterAmount = clamp(Number(this.amountInput.value), 1, 300)
      this.amountValue.textContent = `${Math.round(this.state.sim.waterAmount)} m`
      this.applySimState()
      this.scheduleSave()
    })

    this.resolutionInput.addEventListener('input', () => {
      const index = Math.round(
        clamp(Number(this.resolutionInput.value), 0, SIM_RESOLUTION_OPTIONS.length - 1)
      )
      const resolution = SIM_RESOLUTION_OPTIONS[index]
      if (resolution === this.state.sim.resolution) return
      this.state.sim.resolution = resolution
      this.resolutionValue.textContent = `${resolution}²`
      this.rebuildSimulation()
      this.scheduleSave()
    })

    this.maxFlowSpeedInput.addEventListener('input', () => {
      this.state.sim.maxFlowSpeed = clamp(Number(this.maxFlowSpeedInput.value), 5, 60)
      this.maxFlowSpeedValue.textContent = `${Math.round(this.state.sim.maxFlowSpeed)} m/s`
      this.applySimState()
      this.scheduleSave()
    })

    this.dampingInput.addEventListener('input', () => {
      this.state.sim.damping = clamp(Number(this.dampingInput.value), 0.9, 1)
      this.dampingValue.textContent = this.state.sim.damping.toFixed(3)
      this.applySimState()
      this.scheduleSave()
    })

    this.injectIntervalInput.addEventListener('input', () => {
      this.state.sim.injectInterval = Math.round(
        clamp(Number(this.injectIntervalInput.value), 1, 8)
      )
      this.injectIntervalValue.textContent = `${(this.state.sim.injectInterval / 60).toFixed(3)} s`
      this.applySimState()
      this.scheduleSave()
    })

    this.pauseButton.addEventListener('click', () => {
      this.state.sim.paused = !this.state.sim.paused
      this.syncSimControls()
      this.applySimState()
      this.syncStatus()
      this.syncPill()
      this.scheduleSave()
    })

    this.resetButton.addEventListener('click', () => {
      if (this.sim) {
        this.sim.reset()
        this.surface?.setStateTexture(this.sim.stateTexture)
      }
      this.statsSnapshot = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }
      this.syncStatus()
      this.options.toast('模拟已重置，水位归零', 2400)
    })

    this.waterToggle.addEventListener('change', () => {
      this.state.enabled = this.waterToggle.checked
      this.applySimState()
      this.syncPill()
      this.syncStatus()
      this.scheduleSave()
      this.options.toast(this.state.enabled ? '水体已开启' : '水体已关闭', 2000)
    })
  }

  /** 水源列表（选择 / 启用 / 删除）与选中水源的编辑控件。 */
  private bindSourceControls(): void {
    this.sourceList.addEventListener('click', (event) => this.handleSourceListClick(event))
    this.sourceList.addEventListener('change', (event) => this.handleSourceListChange(event))
    this.sourceList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target as HTMLElement
      const item = target.closest<HTMLElement>('.water-source-item')
      if (!item?.dataset.id) return
      event.preventDefault()
      this.selectSource(item.dataset.id)
    })

    this.sourceName.addEventListener('input', () => {
      const source = this.selectedSource()
      if (!source) return
      source.name = this.sourceName.value.trim().slice(0, 40) || '水源'
      this.syncSourceList()
      this.markers.setSources(this.state.sources, this.selectedId, this.projection)
      this.scheduleSave()
    })

    this.sourceRadius.addEventListener('input', () => {
      const source = this.selectedSource()
      if (!source) return
      source.radius = clamp(Number(this.sourceRadius.value), 20, 2000)
      this.sourceRadiusValue.textContent = `${Math.round(source.radius)} m`
      this.syncSourceList()
      this.markers.settleSource(source)
      this.applySimState()
      this.scheduleSave()
    })

    this.sourceTarget.addEventListener('change', () => {
      const source = this.selectedSource()
      if (!source) return
      const raw = this.sourceTarget.value.trim()
      const value = raw === '' ? Number.NaN : Number(raw)
      source.targetLevel = Number.isFinite(value) ? clamp(value, -1000, 20000) : null
      this.syncSourceList()
      this.syncSourceEditor()
      this.applySimState()
      this.scheduleSave()
    })

    this.sourceEnabled.addEventListener('change', () => {
      const source = this.selectedSource()
      if (!source) return
      source.enabled = this.sourceEnabled.checked
      this.syncSourceList()
      this.applySimState()
      this.scheduleSave()
    })

    this.sourceDelete.addEventListener('click', () => {
      if (this.selectedId) this.deleteSource(this.selectedId)
    })
  }

  /** 外观滑杆：绑定来自同一张 `visualControls` 表，取值同步走 `syncAppearance`。 */
  private bindAppearanceControls(): void {
    for (const control of this.visualControls) {
      control.input.addEventListener('input', () => {
        const value = clamp(Number(control.input.value), control.min, control.max)
        this.state.visual[control.key] = value
        control.output.textContent = value.toFixed(2)
        this.surface?.setVisual(this.state.visual)
        this.scheduleSave()
      })
    }

    this.appearanceReset.addEventListener('click', () => {
      this.state.visual = { ...VISUAL_DEFAULTS }
      this.syncAppearance()
      this.surface?.setVisual(this.state.visual)
      this.scheduleSave()
      this.options.toast('水面外观已恢复默认', 2200)
    })
  }

  /** 工程保存 / 导出 / 导入。 */
  private bindProjectControls(): void {
    this.saveButton.addEventListener('click', () => this.saveNow(true))

    this.exportButton.addEventListener('click', () => {
      downloadStateJson(this.state)
      this.setProjectStatus('已导出')
      this.options.toast('已导出水体工程 JSON', 2400)
    })

    this.importButton.addEventListener('click', () => this.importInput.click())
    this.importInput.addEventListener('change', () => {
      const file = this.importInput.files?.[0]
      if (!file) return
      void this.applyImportedFile(file)
      this.importInput.value = ''
    })
  }

  private attachPointerEvents(): void {
    // 捕获阶段先手：按住小球时截断相机手势，避免拖动水源变成平移地球。
    this.canvas.addEventListener('pointerdown', this.handlePointerDown, true)
    document.addEventListener('pointermove', this.handlePointerMove)
    document.addEventListener('pointerup', this.handlePointerUp)
    document.addEventListener('pointercancel', this.handlePointerCancel)
    window.addEventListener('blur', this.handleWindowBlur)
  }

  private detachPointerEvents(): void {
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown, true)
    document.removeEventListener('pointermove', this.handlePointerMove)
    document.removeEventListener('pointerup', this.handlePointerUp)
    document.removeEventListener('pointercancel', this.handlePointerCancel)
    window.removeEventListener('blur', this.handleWindowBlur)
    window.removeEventListener('keydown', this.handleKeyDown)
  }

  /** 结束拖动：恢复相机手势与光标（拖动被取消 / 指针丢失时也走这里）。 */
  private endDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.viewer.controls.enabled = true
    this.canvas.style.cursor = this.placing ? 'crosshair' : ''
  }

  private handleWindowBlur = (): void => {
    this.endDrag()
    this.clickCandidate = null
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.mode !== 'water' || event.button !== 0 || this.build) return
    const rect = this.canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const hit = this.markers.hitTest(x, y, this.viewer.camera.raw, rect.width, rect.height)
    if (hit) {
      event.stopPropagation()
      event.preventDefault()
      this.drag = {
        id: hit,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY
      }
      this.viewer.controls.enabled = false
      this.selectSource(hit)
      this.canvas.style.cursor = 'grabbing'
      return
    }
    this.clickCandidate = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerId: event.pointerId,
      moved: false
    }
  }

  private handlePointerMove = (event: PointerEvent): void => {
    if (this.drag) {
      if (event.pointerId !== this.drag.pointerId) return
      this.moveSourceToPointer(this.drag.id, event.clientX, event.clientY)
      return
    }
    if (!this.clickCandidate || event.pointerId !== this.clickCandidate.pointerId) return
    this.clickCandidate.moved = this.clickCandidate.moved || this.pointerMoved(event)
  }

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.drag && event.pointerId === this.drag.pointerId) {
      const source = this.state.sources.find((item) => item.id === this.drag?.id)
      if (source) {
        source.groundLevel = this.groundLevelAt(source.longitude, source.latitude) ?? source.groundLevel
        this.markers.settleSource(source)
        this.syncSourceEditor()
        this.syncSourceList()
        this.scheduleSave()
      }
      this.endDrag()
      return
    }
    if (this.clickCandidate && event.pointerId === this.clickCandidate.pointerId) {
      const candidate = this.clickCandidate
      this.clickCandidate = null
      if (candidate.moved) return
      const rect = this.canvas.getBoundingClientRect()
      this.handleCanvasClick(
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      )
    }
  }

  private handlePointerCancel = (): void => {
    this.endDrag()
    this.clickCandidate = null
  }

  private pointerMoved(event: PointerEvent): boolean {
    const candidate = this.clickCandidate
    if (!candidate) return false
    return (
      Math.hypot(
        event.clientX - candidate.startClientX,
        event.clientY - candidate.startClientY
      ) > 5
    )
  }

  private handleCanvasClick(x: number, y: number, width: number, height: number): void {
    if (this.mode !== 'water' || this.build) return
    const hit = this.markers.hitTest(x, y, this.viewer.camera.raw, width, height)
    if (hit) {
      this.selectSource(hit)
      return
    }
    if (!this.placing) {
      this.selectSource(null)
      return
    }
    const pick = this.viewer.pickCartographic({ x, y })
    if (!pick) {
      this.options.toast('未命中地形，请对准地表单击', 2400)
      return
    }
    this.placeSource(pick.longitude, pick.latitude, pick.height)
  }

  private moveSourceToPointer(id: string, clientX: number, clientY: number): void {
    const source = this.state.sources.find((item) => item.id === id)
    const projection = this.projection
    if (!source || !projection) return
    const rect = this.canvas.getBoundingClientRect()
    const pick = this.viewer.pickCartographic({
      x: clientX - rect.left,
      y: clientY - rect.top
    })
    if (!pick) return
    const local = projection.toLocal(pick.longitude, pick.latitude)
    if (!projection.contains(local.x, local.z, -Math.min(source.radius, 500))) return
    source.longitude = pick.longitude
    source.latitude = pick.latitude
    source.groundLevel = this.groundLevelAt(pick.longitude, pick.latitude) ?? pick.height
    this.markers.updateSource(source)
    this.syncSourceEditor()
    this.syncSourceList()
    this.applySimState()
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (this.placing) {
      this.exitPlacing()
      event.preventDefault()
      return
    }
    if (this.mode === 'water' && this.selectedId) {
      this.selectSource(null)
      event.preventDefault()
    }
  }

  private togglePlacing(): void {
    if (this.placing) {
      this.exitPlacing()
      return
    }
    if (this.mode !== 'water') void this.enterMode('water')
    if (this.state.sources.length >= MAX_WATER_SOURCES) {
      this.options.toast(`最多 ${MAX_WATER_SOURCES} 个水源`, 2600)
      return
    }
    this.placing = true
    this.syncModeUI()
    this.syncPill()
    this.options.toast('单击地形放置水源', 2400)
  }

  private exitPlacing(): void {
    if (!this.placing) return
    this.placing = false
    this.syncModeUI()
    this.syncPill()
  }

  /** 按「水源 N」的占位顺序取下一个未占用的编号。 */
  private nextSourceName(): string {
    const used = new Set(
      this.state.sources
        .map((source) => /^水源\s*(\d+)$/.exec(source.name)?.[1])
        .filter((value): value is string => Boolean(value))
        .map(Number)
    )
    let index = 1
    while (used.has(index)) index += 1
    return `水源 ${index}`
  }

  private placeSource(longitude: number, latitude: number, groundLevel?: number): void {
    if (this.state.sources.length >= MAX_WATER_SOURCES) {
      this.options.toast(`最多 ${MAX_WATER_SOURCES} 个水源`, 2600)
      this.exitPlacing()
      return
    }
    const projection = this.projection
    if (projection) {
      const local = projection.toLocal(longitude, latitude)
      if (!projection.contains(local.x, local.z)) {
        this.options.toast('水源必须落在模拟域范围内', 2800)
        return
      }
    }
    const ground = this.groundLevelAt(longitude, latitude, groundLevel)
    const source: WaterSource = {
      id: createSourceId(),
      name: this.nextSourceName(),
      longitude,
      latitude,
      radius: 150,
      targetLevel: ground === null ? null : Number((ground + 10).toFixed(2)),
      amount: null,
      enabled: true,
      groundLevel: ground
    }
    this.state.sources.push(source)
    this.selectedId = source.id
    this.markers.setSources(this.state.sources, this.selectedId, this.projection)
    this.applySimState()
    this.syncSourceList()
    this.syncSourceEditor()
    this.syncStatus()
    this.syncPill()
    this.scheduleSave()
    this.revealSourceEditor()
    this.options.toast(`已放置「${source.name}」`, 2000)
    if (this.state.sources.length >= MAX_WATER_SOURCES) this.exitPlacing()
  }

  private selectSource(id: string | null): void {
    const changed = this.selectedId !== id
    this.selectedId = id
    this.markers.setSelected(id)
    this.syncSourceList()
    this.syncSourceEditor()
    if (changed && id) this.revealSourceEditor()
  }

  /** 选中水源后把编辑分组带到可视区（桌面已可见时不产生滚动）。 */
  private revealSourceEditor(): void {
    if (this.sourceEditor.hidden) return
    this.sourceEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  private selectedSource(): WaterSource | null {
    if (!this.selectedId) return null
    return this.state.sources.find((source) => source.id === this.selectedId) ?? null
  }

  private deleteSource(id: string): void {
    const index = this.state.sources.findIndex((source) => source.id === id)
    if (index < 0) return
    const [removed] = this.state.sources.splice(index, 1)
    if (this.selectedId === id) this.selectedId = null
    this.markers.setSources(this.state.sources, this.selectedId, this.projection)
    this.applySimState()
    this.syncSourceList()
    this.syncSourceEditor()
    this.syncStatus()
    this.syncPill()
    this.scheduleSave()
    this.options.toast(`已删除「${removed.name}」`, 2000)
  }

  private clearSources(): void {
    if (this.state.sources.length === 0) return
    const count = this.state.sources.length
    this.state.sources = []
    this.selectedId = null
    this.exitPlacing()
    this.markers.setSources([], null, this.projection)
    this.applySimState()
    this.syncSourceList()
    this.syncSourceEditor()
    this.syncStatus()
    this.syncPill()
    this.scheduleSave()
    this.options.toast(`已清空 ${count} 个水源`, 2200)
  }

  private handleSourceListClick(event: MouseEvent): void {
    const target = event.target as HTMLElement
    const item = target.closest<HTMLElement>('.water-source-item')
    if (!item?.dataset.id) return
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
    if (action === 'delete') {
      this.deleteSource(item.dataset.id)
      return
    }
    this.selectSource(item.dataset.id)
  }

  private handleSourceListChange(event: Event): void {
    const target = event.target as HTMLInputElement
    if (target.dataset.action !== 'toggle') return
    const item = target.closest<HTMLElement>('.water-source-item')
    if (!item?.dataset.id) return
    const source = this.state.sources.find((entry) => entry.id === item.dataset.id)
    if (!source) return
    source.enabled = target.checked
    this.applySimState()
    this.syncSourceEditor()
    this.syncStatus()
    this.scheduleSave()
  }

  private async applyImportedFile(file: File): Promise<void> {
    const imported = await readStateFile(file)
    if (!imported) {
      this.options.toast('无法解析该 JSON，请检查工程文件', 3200)
      return
    }
    this.state = normalizeWaterState(imported)
    this.selectedId = null
    this.exitPlacing()
    this.disposeSimulation()
    this.markers.setSources([], null, null)
    this.boundary.setVisible(false)
    this.field = null
    this.domain = null
    this.projection = null
    this.syncAll()
    if (this.state.domain) {
      if (this.mode !== 'water') await this.enterMode('water')
      else await this.ensureDomain()
    }
    this.saveNow(false)
    this.setProjectStatus('已导入')
    this.options.toast('已导入水体工程', 3000)
  }

  // ---------------------------------------------------------------- 循环与持久化

  private animate = (now: number): void => {
    if (this.disposed) return
    this.animationHandle = requestAnimationFrame(this.animate)
    const dt = this.lastFrameAt > 0 ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60
    this.lastFrameAt = now

    if (this.sim && this.state.enabled) {
      const started = performance.now()
      this.sim.update(dt)
      this.statsSnapshot.simMs = performance.now() - started
      // 模拟状态在两张纹理间 ping-pong：直接切换水面采样纹理，省掉一次全屏拷贝。
      this.surface?.setStateTexture(this.sim.stateTexture)
      this.surface?.update(dt)
    }
    this.updateSun()

    const rect = this.canvas.getBoundingClientRect()
    this.markers.updateFrame(this.viewer.camera.raw, rect.width, rect.height)
    this.boundary.update(this.viewer.camera.raw, rect.height)

    if (now - this.lastStatsAt > 700 && this.sim) {
      this.lastStatsAt = now
      this.statsSnapshot = { ...this.statsSnapshot, ...this.sim.debugStats() }
      this.syncStatus()
      this.syncPill()
    }
  }

  private handleBeforeUnload = (): void => {
    this.saveNow(false)
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(false), 500)
  }

  private saveNow(manual: boolean): void {
    window.clearTimeout(this.saveTimer)
    const ok = storeState(this.state)
    this.setProjectStatus(ok ? '已保存' : '保存失败')
    if (manual) {
      this.options.toast(ok ? '水体工程已保存' : '保存失败：本地存储不可用', 2200)
    }
  }

  // ---------------------------------------------------------------- 调试 API

  private debugApi() {
    return {
      getMode: () => this.mode,
      getState: () => cloneState(this.state),
      getDomain: () =>
        this.domain
          ? {
              origin: { ...this.domain.origin },
              sizeMeters: this.domain.sizeMeters,
              resolution: this.state.sim.resolution,
              baseElevation: this.domain.baseElevation
            }
          : null,
      getFieldInfo: () =>
        this.field
          ? {
              resolution: this.field.resolution,
              sizeMeters: this.field.sizeMeters,
              baseElevation: this.field.baseElevation,
              minHeight: Math.min(...this.field.heights),
              maxHeight: Math.max(...this.field.heights)
            }
          : null,
      isReady: () => this.isDomainReady,
      getDomainSource: () => this.domainSource,
      getDomainCacheInfo: () => getCachedDomainInfo(),
      clearDomainCache: () => {
        clearCachedDomainField()
        void clearServerDomainField()
        this.domainSource = null
        this.syncDomainMeta()
      },
      refreshDomain: () => this.rebuildFixedDomain(),
      /** 丢弃当前内存中的模拟域，按“浏览器缓存 → 服务器缓存 → 重新采样”重新建立（测试/调试用）。 */
      restoreDomainFromStorage: async () => {
        this.disposeSimulation()
        this.field = null
        this.domain = null
        this.projection = null
        this.domainSource = null
        this.progress.hidden = true
        return this.ensureDomain()
      },
      getStats: () => (this.sim ? this.sim.debugStats() : null),
      getSourceMarkers: () =>
        this.state.sources.map((source) => ({ id: source.id, name: source.name })),
      getSelectedId: () => this.selectedId,
      getSourceScreenPosition: (id: string) => {
        const rect = this.canvas.getBoundingClientRect()
        const screen = this.markers.screenPosition(
          id,
          this.viewer.camera.raw,
          rect.width,
          rect.height
        )
        return screen ? { x: screen.x + rect.left, y: screen.y + rect.top } : null
      },
      waitReady: (timeoutMs = 30000) =>
        new Promise<boolean>((resolve) => {
          if (this.isDomainReady) return resolve(true)
          const timeout = window.setTimeout(() => resolve(false), timeoutMs)
          this.buildWaiters.push((ready) => {
            window.clearTimeout(timeout)
            resolve(ready)
          })
        }),
      enterWaterMode: () => this.enterMode('water'),
      enterSceneMode: () => this.enterMode('scene'),
      placeSourceAt: (longitude: number, latitude: number, groundLevel?: number) => {
        this.placeSource(longitude, latitude, groundLevel)
      },
      selectSource: (id: string | null) => this.selectSource(id),
      deleteSource: (id: string) => this.deleteSource(id),
      clearSources: () => this.clearSources(),
      setSource: (id: string, patch: Partial<WaterSource>) => {
        const source = this.state.sources.find((entry) => entry.id === id)
        if (!source) return false
        Object.assign(source, patch)
        this.markers.setSources(this.state.sources, this.selectedId, this.projection)
        this.applySimState()
        this.syncSourceList()
        this.syncSourceEditor()
        this.scheduleSave()
        return true
      },
      setSimSettings: (patch: Partial<WaterState['sim']>) => {
        Object.assign(this.state.sim, patch)
        this.syncSimControls()
        this.applySimState()
        this.scheduleSave()
      },
      setVisual: (patch: Partial<WaterState['visual']>) => {
        Object.assign(this.state.visual, patch)
        this.syncAppearance()
        this.surface?.setVisual(this.state.visual)
        this.scheduleSave()
      },
      rebuildAt: async () => {
        this.selectedId = null
        await this.buildDomain(
          { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
          WATER_DOMAIN.sizeMeters
        )
        return this.isDomainReady
      },
      saveNow: () => this.saveNow(true),
      getCanvasSize: () => {
        const rect = this.canvas.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      },
      getProjection: () => {
        if (!this.projection) return null
        return {
          origin: { ...this.projection.origin },
          sizeMeters: this.projection.sizeMeters,
          mPerDegLat: this.projection.mPerDegLat,
          mPerDegLon: this.projection.mPerDegLon
        }
      }
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
