import type * as THREE from 'three'
import type { Viewer } from 'tellux'
import { ShallowWaterSim, STATS_MIN_INTERVAL_MS } from './shallowWater'
import { WaterSurface } from './waterSurface'
import { DomainBoundary, SourceMarkers } from './markers'
import {
  createLocalProjection,
  resampleTerrain,
  sampleFieldHeight,
  type LocalProjection
} from './terrainField'
import { computeSunDirectionENU } from './sun'
import { nextFrame } from './async'
import { flyOverDomain, sampleGroundHeight } from './terrainSampling'
import { queryWaterEditorDom, type WaterEditorDom } from './waterEditorDom'
import { WaterPointerController } from './waterPointerController'
import { WaterControlsBinder, type SourceChange } from './waterControlsBinder'
import { WaterPanelView } from './waterPanelView'
import { WaterDomainBuilder } from './waterDomainBuilder'
import { clearCachedDomainField, clearServerDomainField, getCachedDomainInfo } from './domainCache'
import {
  MAX_WATER_SOURCES,
  WATER_DOMAIN,
  cloneState,
  createSourceId,
  normalizeWaterState,
  type SimSource,
  type SurfaceDomain,
  type TerrainField,
  type WaterSource,
  type WaterState
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

interface BuildTask {
  token: number
  cancel: { cancelled: boolean }
  promise: Promise<boolean>
}

/**
 * 水体编辑器总控：模式切换、模拟域构建、水源放置/拖动、面板与持久化。
 *
 * 模拟循环独立于模式：水体开启后浏览模式也推进；水源标记、放置交互与
 * 模拟域边界只在编辑模式启用。
 */
export class WaterEditor {
  private readonly viewer: Viewer
  private readonly options: WaterEditorOptions
  private readonly scene: THREE.Scene
  private readonly renderer: THREE.WebGLRenderer
  private readonly canvas: HTMLCanvasElement
  /** 画布 CSS 尺寸缓存：每帧都要用，不能每帧读布局（getBoundingClientRect 会强制回流）。 */
  private readonly canvasSize = { width: 0, height: 0 }
  private canvasObserver: ResizeObserver | null = null

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
  /** 指针交互：拖动 / 选中 / 放置 / Esc，状态仍留在编辑器里。 */
  private readonly pointer: WaterPointerController
  /** 表单/按钮绑定：事件 → 命令。 */
  private readonly binder: WaterControlsBinder

  private selectedId: string | null = null
  private placing = false
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

  /** 全部 DOM 引用（含外观滑杆表），见 waterEditorDom.ts。 */
  private readonly dom: WaterEditorDom
  /** 面板视图：只做状态 → DOM 的同步。 */
  private readonly panel: WaterPanelView
  /** 建域器：缓存恢复 / 现场采样，进度通过 hooks 回调。 */
  private readonly domainBuilder: WaterDomainBuilder

  constructor(viewer: Viewer, options: WaterEditorOptions) {
    this.viewer = viewer
    this.options = options
    this.scene = viewer.scene.raw
    this.renderer = viewer.renderer.raw as THREE.WebGLRenderer
    this.canvas = this.renderer.domElement
    this.dom = queryWaterEditorDom()
    this.domainBuilder = new WaterDomainBuilder(this.viewer, {
      onProgress: (percent, label) => {
        this.dom.progressBar.style.width = `${Math.round(percent)}%`
        this.dom.progressLabel.textContent = label
      },
      onToast: (message, duration) => this.options.toast(message, duration)
    })
    this.panel = new WaterPanelView(this.dom, {
      getState: () => this.state,
      getSelectedId: () => this.selectedId,
      getSelectedSource: () => this.selectedSource(),
      getField: () => this.field,
      isBuilding: () => Boolean(this.build),
      isPlacing: () => this.placing,
      isDomainReady: () => this.isDomainReady,
      getStats: () => this.statsSnapshot
    })
    this.state = loadStoredState()
    this.markers = new SourceMarkers(viewer, {
      scene: this.scene,
      labelContainer: this.dom.waterLabels
    })
    this.boundary = new DomainBoundary(viewer, this.scene)
    this.pointer = new WaterPointerController({
      viewer: this.viewer,
      canvas: this.canvas,
      markers: this.markers,
      getMode: () => this.mode,
      getProjection: () => this.projection,
      getSources: () => this.state.sources,
      isBuilding: () => Boolean(this.build),
      isPlacing: () => this.placing,
      hasSelection: () => this.selectedId !== null,
      selectSource: (id) => this.selectSource(id),
      placeSource: (longitude, latitude, height) => this.placeSource(longitude, latitude, height),
      groundLevelAt: (longitude, latitude, preferred) =>
        this.groundLevelAt(longitude, latitude, preferred),
      commitDraggedSource: (source) => this.commitDraggedSource(source),
      previewDraggedSource: (source) => this.previewDraggedSource(source),
      exitPlacing: () => this.exitPlacing(),
      toast: (message, duration) => this.options.toast(message, duration)
    })
    this.binder = new WaterControlsBinder({
      dom: this.dom,
      panel: this.panel,
      getState: () => this.state,
      getSelectedSource: () => this.selectedSource(),
      applySimState: () => this.applySimState(),
      applyVisual: () => this.applyVisual(),
      resetSimulation: () => this.resetSimulation(),
      rebuildSimulation: () => this.rebuildSimulation(),
      refreshSelectedSource: (change) => this.refreshSelectedSource(change),
      selectSource: (id) => this.selectSource(id),
      deleteSelectedSource: () => {
        if (this.selectedId) this.deleteSource(this.selectedId)
      },
      togglePlacing: () => this.togglePlacing(),
      clearSources: () => this.clearSources(),
      rebuildDomain: () => {
        void this.rebuildFixedDomain()
      },
      markModeTouched: () => {
        this.modeTouched = true
      },
      enterMode: (mode) => {
        void this.enterMode(mode)
      },
      saveNow: (manual) => this.saveNow(manual),
      exportProject: () => this.exportProject(),
      importProject: (file) => {
        void this.applyImportedFile(file)
      },
      scheduleSave: () => this.scheduleSave(),
      toast: (message, duration) => this.options.toast(message, duration)
    })

    this.syncCanvasSize()
    this.canvasObserver = new ResizeObserver(() => this.syncCanvasSize())
    this.canvasObserver.observe(this.canvas)

    this.binder.attach()
    this.pointer.attach()
    this.syncAll()
    this.applySimState()

    this.animationHandle = requestAnimationFrame(this.animate)
    window.addEventListener('beforeunload', this.handleBeforeUnload)
    window.__waterEditor = this.debugApi()

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
    this.dom.consoleElement.hidden = mode === 'water'
    this.dom.waterLeft.hidden = mode !== 'water'
    this.dom.waterRight.hidden = mode !== 'water'
    this.markers.setVisible(mode === 'water')
    this.boundary.setVisible(mode === 'water')
    if (mode !== 'water') this.exitPlacing()
    storeMode(mode)
    this.syncModeUI()
    this.panel.syncStatus()
    this.panel.syncPill()
    if (mode === 'water') await this.ensureDomain()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.animationHandle)
    window.clearTimeout(this.saveTimer)
    window.clearTimeout(this.restoreTimer)
    window.removeEventListener('beforeunload', this.handleBeforeUnload)
    this.pointer.detach()
    this.canvasObserver?.disconnect()
    this.canvasObserver = null
    delete window.__waterEditor
    if (this.build) this.build.cancel.cancelled = true
    this.disposeSimulation()
    this.markers.dispose()
    this.boundary.dispose()
    this.canvas.style.cursor = ''
  }

  /** 缓存画布 CSS 尺寸：首次挂载与 ResizeObserver 回调共用。 */
  private syncCanvasSize(): void {
    const rect = this.canvas.getBoundingClientRect()
    this.canvasSize.width = rect.width
    this.canvasSize.height = rect.height
  }

  // ---------------------------------------------------------------- 模拟域

  private async ensureDomain(): Promise<boolean> {
    if (this.isDomainReady) return true
    if (this.build) return this.build.promise
    this.state.domain = { ...WATER_DOMAIN }
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    this.filterSourcesToDomain(center, WATER_DOMAIN.sizeMeters)

    // 固定模拟域的地形高度场已在缓存里：直接恢复，跳过飞行等待与 97² 采样。
    const cached = await this.domainBuilder.loadCached()
    if (cached) {
      this.applyDomainField(cached.field, 'cache', cached.projection)
      this.dom.progress.hidden = true
      this.panel.syncBusy()
      const originLabel = cached.origin === 'browser-cache' ? '本地存储' : '服务器本地存储'
      this.options.toast(
        `模拟域已从${originLabel}恢复 · 8 km × 8 km · 地形 ${cached.field.resolution}²`,
        2800
      )
      // 相机仍飞到固定域正上方，地形瓦片由缓存提供。
      void flyOverDomain(this.viewer, center, WATER_DOMAIN.sizeMeters)
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

  /** 用一份地形高度场建立 / 替换模拟域与水面（缓存恢复或现场采样共用）。 */
  private applyDomainField(
    field: TerrainField,
    source: 'cache' | 'sampled',
    projection: LocalProjection
  ): void {
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    // 投影必须和 field 配套：toSimSources、水源拖动、圆环贴地、域边界都依赖它。
    this.projection = projection
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
    // 模拟域外的水源在重建时移除（兼容旧工程数据）。
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
    this.dom.progress.hidden = false
    this.panel.syncBusy()
    this.panel.syncPill()
    this.panel.syncDomainMeta()
    this.panel.syncStatus()

    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      resolveBuild(ready)
    }

    try {
      const result = await this.domainBuilder.sample(center, sizeMeters, {
        cancel,
        isStale: () => token !== this.buildToken
      })
      if (!result || token !== this.buildToken) {
        this.flushBuildWaiters(false)
        finish(false)
        return false
      }
      this.applyDomainField(result.field, 'sampled', result.projection)
      await nextFrame()
      this.dom.progress.hidden = true
      this.options.toast(
        `模拟域已就绪 · 8 km × 8 km · 地形 ${result.field.resolution}² · 模拟 ${this.state.sim.resolution}²`,
        3400
      )
      this.flushBuildWaiters(true)
      finish(true)
      return true
    } catch (error) {
      console.error('[water-editor] 构建模拟域失败', error)
      if (token === this.buildToken) {
        this.options.toast('构建模拟域时出错，请重试', 3600)
        this.panel.syncStatus()
        this.panel.syncPill()
      }
      this.flushBuildWaiters(false)
      finish(false)
      return false
    } finally {
      if (token === this.buildToken) {
        this.build = null
        this.dom.progress.hidden = true
        this.panel.syncBusy()
        this.panel.syncStatus()
        this.panel.syncPill()
      }
    }
  }

  private flushBuildWaiters(ready: boolean): void {
    while (this.buildWaiters.length > 0) {
      const waiter = this.buildWaiters.shift()
      waiter?.(ready)
    }
  }

  /** 用模拟地形高度场取地面高程（与浅水模拟使用同一份地形，保证目标水位一致）。 */
  private groundFromField(longitude: number, latitude: number): number | undefined {
    if (!this.field || !this.projection) return undefined
    const local = this.projection.toLocal(longitude, latitude)
    return this.field.baseElevation + sampleFieldHeight(this.field, local.x, local.z)
  }

  private sampleGround(longitude: number, latitude: number): number | undefined {
    return sampleGroundHeight(this.viewer, longitude, latitude)
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

  /** 重新采样当前模拟域。 */
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
    this.dom.waterToggle.checked = this.state.enabled
    this.syncModeUI()
    this.panel.syncAll()
  }

  private syncModeUI(): void {
    this.dom.body.dataset.mode = this.mode
    this.dom.modeScene.classList.toggle('is-active', this.mode === 'scene')
    this.dom.modeWater.classList.toggle('is-active', this.mode === 'water')
    this.dom.modeScene.setAttribute('aria-pressed', String(this.mode === 'scene'))
    this.dom.modeWater.setAttribute('aria-pressed', String(this.mode === 'water'))
    this.dom.consoleElement.hidden = this.mode === 'water'
    this.dom.waterLeft.hidden = this.mode !== 'water'
    this.dom.waterRight.hidden = this.mode !== 'water'
    this.markers.setVisible(this.mode === 'water')
    this.boundary.setVisible(this.mode === 'water')
    this.dom.body.dataset.placing = this.placing ? 'true' : 'false'
    this.dom.addButton.textContent = this.placing ? '取消放置' : '＋ 水源'
    this.dom.addButton.classList.toggle('is-active', this.placing)
    this.canvas.style.cursor = this.placing ? 'crosshair' : ''
  }

  // ---------------------------------------------------------------- 交互

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
    this.panel.syncPill()
    this.options.toast('单击地形放置水源', 2400)
  }

  private exitPlacing(): void {
    if (!this.placing) return
    this.placing = false
    this.syncModeUI()
    this.panel.syncPill()
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
    this.panel.syncSourceList()
    this.panel.syncSourceEditor()
    this.panel.syncStatus()
    this.panel.syncPill()
    this.scheduleSave()
    this.revealSourceEditor()
    this.options.toast(`已放置「${source.name}」`, 2000)
    if (this.state.sources.length >= MAX_WATER_SOURCES) this.exitPlacing()
  }

  private selectSource(id: string | null): void {
    const changed = this.selectedId !== id
    this.selectedId = id
    this.markers.setSelected(id)
    this.panel.syncSourceList()
    this.panel.syncSourceEditor()
    if (changed && id) this.revealSourceEditor()
  }

  /** 选中水源后把编辑分组带到可视区（桌面已可见时不产生滚动）。 */
  private revealSourceEditor(): void {
    if (this.dom.sourceEditor.hidden) return
    this.dom.sourceEditor.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  private applyVisual(): void {
    this.surface?.setVisual(this.state.visual)
  }

  /** 重置按钮：清空水位与统计。 */
  private resetSimulation(): void {
    if (this.sim) {
      this.sim.reset()
      this.surface?.setStateTexture(this.sim.stateTexture)
    }
    this.statsSnapshot = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }
    this.panel.syncStatus()
    this.options.toast('模拟已重置，水位归零', 2400)
  }

  /** 导出按钮：下载 JSON 并提示。 */
  private exportProject(): void {
    downloadStateJson(this.state)
    this.panel.setProjectStatus('已导出')
    this.options.toast('已导出水体工程 JSON', 2400)
  }

  /** 选中水源被编辑后，按改动部位刷新对应视图。 */
  private refreshSelectedSource(change: SourceChange): void {
    const source = this.selectedSource()
    if (!source) return
    this.panel.syncSourceList()
    switch (change) {
      case 'name':
        this.markers.setSources(this.state.sources, this.selectedId, this.projection)
        break
      case 'radius':
        this.markers.settleSource(source)
        this.applySimState()
        break
      case 'target':
        this.panel.syncSourceEditor()
        this.applySimState()
        break
      case 'enabled':
        this.applySimState()
        break
    }
    this.scheduleSave()
  }

  /** 拖动中：只更新标记与面板读数，不做地形重采样。 */
  private previewDraggedSource(source: WaterSource): void {
    this.markers.updateSource(source)
    this.panel.syncSourceEditor()
    this.panel.syncSourceList()
    this.applySimState()
  }

  /** 拖动结束：按落点重新贴地，刷新面板并保存。 */
  private commitDraggedSource(source: WaterSource): void {
    source.groundLevel = this.groundLevelAt(source.longitude, source.latitude) ?? source.groundLevel
    this.markers.settleSource(source)
    this.panel.syncSourceEditor()
    this.panel.syncSourceList()
    this.scheduleSave()
  }

  private selectedSource(): WaterSource | null {
    if (!this.selectedId) return null
    return this.state.sources.find((source) => source.id === this.selectedId) ?? null
  }

  private deleteSource(id: string): void {
    const index = this.state.sources.findIndex((source) => source.id === id)
    if (index < 0) return
    const [removed] = this.state.sources.splice(index, 1)
    if (!removed) return
    if (this.selectedId === id) this.selectedId = null
    this.markers.setSources(this.state.sources, this.selectedId, this.projection)
    this.applySimState()
    this.panel.syncSourceList()
    this.panel.syncSourceEditor()
    this.panel.syncStatus()
    this.panel.syncPill()
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
    this.panel.syncSourceList()
    this.panel.syncSourceEditor()
    this.panel.syncStatus()
    this.panel.syncPill()
    this.scheduleSave()
    this.options.toast(`已清空 ${count} 个水源`, 2200)
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
    this.panel.setProjectStatus('已导入')
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

    this.markers.updateFrame(this.viewer.camera.raw, this.canvasSize.width, this.canvasSize.height)
    this.boundary.update(this.viewer.camera.raw, this.canvasSize.height)

    if (now - this.lastStatsAt > STATS_MIN_INTERVAL_MS && this.sim) {
      this.lastStatsAt = now
      this.statsSnapshot = { ...this.statsSnapshot, ...this.sim.debugStats() }
      this.panel.syncStatus()
      this.panel.syncPill()
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
    this.panel.setProjectStatus(ok ? '已保存' : '保存失败')
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
        this.panel.syncDomainMeta()
      },
      refreshDomain: () => this.rebuildFixedDomain(),
      /** 丢弃当前内存中的模拟域，按“浏览器缓存 → 服务器缓存 → 重新采样”重新建立（测试/调试用）。 */
      restoreDomainFromStorage: async () => {
        this.disposeSimulation()
        this.field = null
        this.domain = null
        this.projection = null
        this.domainSource = null
        this.dom.progress.hidden = true
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
        this.panel.syncSourceList()
        this.panel.syncSourceEditor()
        this.scheduleSave()
        return true
      },
      setSimSettings: (patch: Partial<WaterState['sim']>) => {
        Object.assign(this.state.sim, patch)
        this.panel.syncSimControls()
        this.applySimState()
        this.scheduleSave()
      },
      setVisual: (patch: Partial<WaterState['visual']>) => {
        Object.assign(this.state.visual, patch)
        this.panel.syncAppearance()
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
