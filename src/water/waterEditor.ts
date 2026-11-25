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
import { WaterPointerController } from './waterPointerController'
import { WaterDomainBuilder } from './waterDomainBuilder'
import {
  buildSimStructure,
  computeGateDischarge,
  createEmptyWaterModels,
  gateSolidGeometry,
  toSimGate,
  type DamStructure,
  type GateStructure,
  type WaterModelSet
} from './structures'
import { clearCachedDomainField, clearServerDomainField, getCachedDomainInfo } from './domainCache'
import {
  GATE_MAX_OPENING_METERS,
  MAX_WATER_SOURCES,
  WATER_DOMAIN,
  cloneState,
  createSourceId,
  normalizeWaterState,
  type SimSource,
  type SimStructure,
  type SurfaceDomain,
  type TerrainField,
  type WaterSource,
  type WaterState
} from './types'
import {
  loadStoredMode,
  loadStoredState,
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
 * 姘翠綋缂栬緫鍣ㄦ€绘帶锛氭ā寮忓垏鎹€佹ā鎷熷煙鏋勫缓銆佹按婧愭斁缃?鎷栧姩銆侀潰鏉夸笌鎸佷箙鍖栥€? *
 * 妯℃嫙寰幆鐙珛浜庢ā寮忥細姘翠綋寮€鍚悗娴忚妯″紡涔熸帹杩涳紱姘存簮鏍囪銆佹斁缃氦浜掍笌
 * 妯℃嫙鍩熻竟鐣屽彧鍦ㄧ紪杈戞ā寮忓惎鐢ㄣ€? */
export class WaterEditor {
  private readonly viewer: Viewer
  private readonly options: WaterEditorOptions
  private readonly scene: THREE.Scene
  private readonly renderer: THREE.WebGLRenderer
  private readonly canvas: HTMLCanvasElement
  /** 鐢诲竷 CSS 灏哄缂撳瓨锛氭瘡甯ч兘瑕佺敤锛屼笉鑳芥瘡甯ц甯冨眬锛坓etBoundingClientRect 浼氬己鍒跺洖娴侊級銆?*/
  private readonly canvasSize = { width: 0, height: 0 }
  private canvasObserver: ResizeObserver | null = null

  private state: WaterState
  private mode: EditorMode = 'scene'
  private field: TerrainField | null = null
  private projection: LocalProjection | null = null
  private domain: SurfaceDomain | null = null
  /** 褰撳墠妯℃嫙鍩熷湴褰㈡潵婧愶細鏈湴瀛樺偍鎭㈠ / 鐜板満閲囨牱銆?*/
  private domainSource: 'cache' | 'sampled' | null = null
  private sim: ShallowWaterSim | null = null
  private surface: WaterSurface | null = null
  /** 褰撳墠鍦烘櫙妯″瀷闆嗗悎锛涢粯璁ょ┖锛屼笉鑷姩鏀炬紨绀烘ā鍨嬨€?*/
  private models: WaterModelSet = createEmptyWaterModels()
  /** 褰撳墠妯℃嫙缁撴瀯/闂搁棬瀹氫箟锛涜瑙夋ā鍨嬬敱澶栭儴鏂囦欢鍔犺浇锛岀紪杈戝櫒鍙秷璐瑰绾︺€?*/
  private dam: DamStructure | null = null
  private structure: SimStructure | null = null
  private gate: GateStructure | null = null
  private lastGateFlowAt = 0
  private lastGateFlow = 0
  private readonly markers: SourceMarkers
  private readonly boundary: DomainBoundary
  /** 鎸囬拡浜や簰锛氭嫋鍔?/ 閫変腑 / 鏀剧疆 / Esc锛岀姸鎬佷粛鐣欏湪缂栬緫鍣ㄩ噷銆?*/
  private readonly pointer: WaterPointerController

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
  private buildProgress = { percent: 0, label: '' }

  /** 寤哄煙鍣細缂撳瓨鎭㈠ / 鐜板満閲囨牱锛岃繘搴﹂€氳繃 hooks 鍥炶皟銆?*/
  private readonly domainBuilder: WaterDomainBuilder

  constructor(viewer: Viewer, options: WaterEditorOptions) {
    this.viewer = viewer
    this.options = options
    this.scene = viewer.scene.raw
    this.renderer = viewer.renderer.raw as THREE.WebGLRenderer
    this.canvas = this.renderer.domElement
    this.state = loadStoredState()
    this.domainBuilder = new WaterDomainBuilder(this.viewer, {
      onProgress: (percent, label) => {
        this.buildProgress = { percent, label }
      },
      onToast: (message, duration) => this.options.toast(message, duration)
    })
    this.markers = new SourceMarkers(viewer, {
      scene: this.scene,
      labelContainer: document.createElement('div')
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

    this.syncCanvasSize()
    this.canvasObserver = new ResizeObserver(() => this.syncCanvasSize())
    this.canvasObserver.observe(this.canvas)

    this.pointer.attach()
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

  /** 褰撳墠鍦烘櫙妯″瀷闆嗗悎鐨勫彧璇诲揩鐓с€?*/
  get currentModels(): WaterModelSet {
    return this.copyModels(this.models)
  }

  get isDomainReady(): boolean {
    return Boolean(this.sim && this.surface && this.domain)
  }

  /**
   * 璁剧疆鍦烘櫙妯″瀷闆嗗悎銆?   *
   * 妯″瀷鍙樺寲浼氶噸寤烘ā鎷熷煙锛堥噴鏀炬棫妯″瀷/缁撴瀯骞堕噸寤猴級锛屽洜姝や細閲嶇疆姘翠綅锛?   * 鍩熷皻鏈缓绔嬫椂鍙褰曢厤缃紝绛?`createSimulation` 鏃跺啀搴旂敤銆?   */
  setWaterModels(models: WaterModelSet): boolean {
    if (!models) return false
    this.models = this.copyModels(models)
    if (this.isDomainReady) {
      this.rebuildSimulation('模型已更新，水位已重置')
    } else {
      this.syncAll()
    }
    return true
  }

  /** 娓呯┖鍦烘櫙妯″瀷锛涙ā鎷熺户缁繍琛岋紝浣嗕笉鍐嶆湁鍧?闂搁棬/閫忔按妯″瀷銆?*/
  clearWaterModels(): boolean {
    const applied = this.setWaterModels(createEmptyWaterModels())
    if (applied) this.options.toast('模型已清空', 2200)
    return applied
  }

  /** 璁剧疆闂搁棬寮€搴︼紙绫筹級锛? = 璐村湴鍏抽棴锛?0 = 搴曢儴杩囨祦銆?*/
  setGateOpening(meters: number): number {
    this.applyGateOpening(meters)
    return this.state.gateOpeningMeters
  }

  /** UI 鐢ㄧ殑妯″瀷绫诲瀷鎽樿銆?*/
  getModelKinds(): string[] {
    const kinds: string[] = []
    if (this.models.terrain) kinds.push('贴地')
    if (this.models.gate) kinds.push('闸门')
    if (this.models.permeable) kinds.push('透水')
    return kinds
  }

  async enterMode(mode: EditorMode): Promise<void> {
    if (this.mode === mode) {
      if (mode === 'water') await this.ensureDomain()
      return
    }
    this.mode = mode
    this.markers.setVisible(mode === 'water')
    this.boundary.setVisible(mode === 'water')
    if (mode !== 'water') this.exitPlacing()
    storeMode(mode)
    this.syncModeUI()
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

  /** 缂撳瓨鐢诲竷 CSS 灏哄锛氶娆℃寕杞戒笌 ResizeObserver 鍥炶皟鍏辩敤銆?*/
  private syncCanvasSize(): void {
    const rect = this.canvas.getBoundingClientRect()
    this.canvasSize.width = rect.width
    this.canvasSize.height = rect.height
  }

  // ---------------------------------------------------------------- 妯℃嫙鍩?
  private async ensureDomain(): Promise<boolean> {
    if (this.isDomainReady) return true
    if (this.build) return this.build.promise
    this.state.domain = { ...WATER_DOMAIN }
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    this.filterSourcesToDomain(center, WATER_DOMAIN.sizeMeters)

    const cached = await this.domainBuilder.loadCached()
    if (cached) {
      this.applyDomainField(cached.field, 'cache', cached.projection)
      const originLabel = cached.origin === 'browser-cache' ? '本地缓存' : '服务器缓存'
      this.options.toast(
        `模拟域已从${originLabel}恢复 · 8 km × 8 km · 地形 ${cached.field.resolution}²`,
        2800
      )
      void flyOverDomain(this.viewer, center, WATER_DOMAIN.sizeMeters)
      return true
    }

    return this.buildDomain(center, WATER_DOMAIN.sizeMeters)
  }

  /** 鎶婃按婧愰檺鍒跺湪妯℃嫙鍩熷唴锛堝浐瀹氬尯鍩熸垨閲嶅缓鍚庣殑鍖哄煙锛夛紝杩斿洖绉婚櫎鏁伴噺銆?*/
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
      this.options.toast(`已移除 ${removed} 个水源`, 3200)
    }
    return removed
  }

  /** 鐢ㄤ竴浠藉湴褰㈤珮搴﹀満寤虹珛 / 鏇挎崲妯℃嫙鍩熶笌姘撮潰锛堢紦瀛樻仮澶嶆垨鐜板満閲囨牱鍏辩敤锛夈€?*/
  private applyDomainField(
    field: TerrainField,
    source: 'cache' | 'sampled',
    projection: LocalProjection
  ): void {
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
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
      this.options.toast(
        `模拟域已从 ${result.field.resolution}² 重采样到 ${this.state.sim.resolution}²`,
        3400
      )
      this.flushBuildWaiters(true)
      finish(true)
      return true
    } catch (error) {
      console.error('[water-editor] build failed', error)
      if (token === this.buildToken) {
        this.options.toast('构建模拟域失败，请重试', 3600)
      }
      this.flushBuildWaiters(false)
      finish(false)
      return false
    } finally {
      if (token === this.buildToken) {
        this.build = null
      }
    }
  }

  private flushBuildWaiters(ready: boolean): void {
    while (this.buildWaiters.length > 0) {
      const waiter = this.buildWaiters.shift()
      waiter?.(ready)
    }
  }

  /** 鐢ㄦā鎷熷湴褰㈤珮搴﹀満鍙栧湴闈㈤珮绋嬶紙涓庢祬姘存ā鎷熶娇鐢ㄥ悓涓€浠藉湴褰紝淇濊瘉鐩爣姘翠綅涓€鑷达級銆?*/
  private groundFromField(longitude: number, latitude: number): number | undefined {
    if (!this.field || !this.projection) return undefined
    const local = this.projection.toLocal(longitude, latitude)
    return this.field.baseElevation + sampleFieldHeight(this.field, local.x, local.z)
  }

  private sampleGround(longitude: number, latitude: number): number | undefined {
    return sampleGroundHeight(this.viewer, longitude, latitude)
  }

  /**
   * 鍙栨煇鐐圭殑鍦伴潰楂樼▼锛氭樉寮忛噰鏍峰€硷紙濡傜偣閫夊懡涓珮搴︼級浼樺厛锛?   * 鍏舵鐢ㄦā鎷熷湴褰㈠満锛堜笌娴呮按妯℃嫙涓€鑷达級锛屾渶鍚庡洖閫€鍒?viewer 瀹炴椂閲囨牱銆?   */
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

  /** 鐢ㄥ綋鍓嶅湴褰㈠満涓庢姇褰卞缓绔嬫ā鎷熶笌姘撮潰锛涗笁鑰呯己涓€涓嶅彲锛堝煙閲嶅缓鏈熼棿浼氱煭鏆傜己澶憋級銆?*/
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
    const dam = this.models.terrain
    const gate = this.models.gate
    if (gate) gate.openingMeters = this.clampGateOpening(this.state.gateOpeningMeters)
    const structure = dam ? buildSimStructure(dam, field, this.state.sim.resolution, gate) : null
    this.dam = dam
    this.gate = gate
    this.structure = structure
    this.sim = new ShallowWaterSim(this.renderer, simTerrain, structure)
    this.sim.setGate(gate ? toSimGate(gate) : null)
    this.sim.setGateFlow(0)
    this.surface = new WaterSurface(
      this.viewer,
      domain,
      this.sim.stateTexture,
      this.state.sim.resolution
    )
    this.surface.setGate(
      gate ? toSimGate(gate) : null,
      domain.sizeMeters / this.state.sim.resolution
    )
    this.applySimState()
    this.updateSun(true)
    this.boundary.setDomain(domain, projection).catch(() => {})
    this.markers.setSources(this.state.sources, this.selectedId, projection)
  }

  private clampGateOpening(value: number): number {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(GATE_MAX_OPENING_METERS, value))
  }

  /** 娣辨嫹璐濇ā鍨嬪畾涔夛紝閬垮厤澶栭儴瀵硅薄涓庤繍琛屾椂鍏变韩鍙彉瀛楁锛堝 gate.opening锛夈€?*/
  private copyModels(models: WaterModelSet): WaterModelSet {
    return {
      terrain: models.terrain ? { ...models.terrain } : null,
      gate: models.gate ? { ...models.gate } : null,
      permeable: models.permeable ? { ...models.permeable } : null
    }
  }

  private rebuildSimulation(message = '模型已更新，水位已重置'): void {
    if (!this.domain || !this.field) return
    this.disposeSimulation()
    this.createSimulation()
    this.syncAll()
    this.options.toast(message, 2600)
  }

  private disposeSimulation(): void {
    this.surface?.dispose()
    this.surface = null
    this.sim?.dispose()
    this.sim = null
    this.dam = null
    this.structure = null
    this.gate = null
    this.lastGateFlow = 0
    this.lastGateFlowAt = 0
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

  private setEnabled(enabled: boolean): void {
    this.state.enabled = enabled
    this.applySimState()
    this.scheduleSave()
  }

  /** 鏇存柊闂搁棬寮€搴︼細鐘舵€?鈫?妯″瀷鍙朵綅 鈫?涓嬩竴娆℃祦閲忚绠椼€?*/
  private applyGateOpening(value: number): void {
    const opening = this.clampGateOpening(value)
    this.state.gateOpeningMeters = opening
    if (this.gate) this.gate.openingMeters = opening
    this.lastGateFlowAt = 0
    if (opening <= 0) {
      this.sim?.setGateFlow(0)
      this.lastGateFlow = 0
    }
    this.scheduleSave()
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

  /**
   * 闂搁棬娴侀噺锛氱敤涓婃父鎺㈤拡姘存繁绠楁按澶达紝Q 鍐欏叆妯℃嫙 uniform銆?   *
   * 250 ms 鑺傛祦锛涘崟鐐?GPU 鍥炶鍙湪杩欎釜浣庨璺緞閲岋紝涓嶈繘鍏ユ瘡甯у惊鐜€?   */
  private updateGateFlow(now: number): void {
    if (!this.sim || !this.gate || !this.field) return
    if (now - this.lastGateFlowAt < 250) return
    this.lastGateFlowAt = now
    const gate = this.gate
    gate.openingMeters = this.clampGateOpening(this.state.gateOpeningMeters)
    if (!this.state.enabled || gate.openingMeters <= 0) {
      this.sim.setGateFlow(0)
      this.lastGateFlow = 0
      return
    }
    const headingRad = (gate.headingDegrees * Math.PI) / 180
    const normalX = -Math.sin(headingRad)
    const normalZ = Math.cos(headingRad)
    const probeDistance = gate.thicknessMeters / 2 + gate.bandMeters + 100
    const probeX = gate.centerX + normalX * probeDistance
    const probeZ = gate.centerZ + normalZ * probeDistance
    const depth = this.sim.debugDepthAt(probeX, probeZ)
    const terrainRel = sampleFieldHeight(this.field, probeX, probeZ)
    const upstreamSurface = this.field.baseElevation + terrainRel + depth
    const flow = computeGateDischarge(gate, upstreamSurface)
    this.sim.setGateFlow(flow)
    this.lastGateFlow = flow
  }

  /** 閲嶆柊閲囨牱褰撳墠妯℃嫙鍩熴€?*/
  private async rebuildFixedDomain(): Promise<void> {
    this.selectedId = null
    this.markers.setSources([], null, null)
    await this.buildDomain(
      { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
      WATER_DOMAIN.sizeMeters
    )
  }

  // ---------------------------------------------------------------- 鐘舵€佷笌 UI

  private syncAll(): void {
    this.syncModeUI()
  }

  private syncModeUI(): void {
    this.markers.setVisible(this.mode === 'water')
    this.boundary.setVisible(this.mode === 'water')
    this.canvas.style.cursor = this.placing ? 'crosshair' : ''
  }

  // ---------------------------------------------------------------- 浜や簰

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
    this.options.toast('单击地形放置水源', 2400)
  }

  private exitPlacing(): void {
    if (!this.placing) return
    this.placing = false
    this.syncModeUI()
  }

  /** 鎸夈€屾按婧?N銆嶇殑鍗犱綅椤哄簭鍙栦笅涓€涓湭鍗犵敤鐨勭紪鍙枫€?*/
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
        this.options.toast('水源已移到新位置', 2800)
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
    this.scheduleSave()
    this.options.toast(`已选中 ${source.name}`, 2000)
    this.exitPlacing()
  }

  private selectSource(id: string | null): void {
    this.selectedId = id
    this.markers.setSelected(id)
  }

  /** 閲嶇疆鎸夐挳锛氭竻绌烘按浣嶄笌缁熻銆?*/
  private resetSimulation(): void {
    if (this.sim) {
      this.sim.reset()
      this.surface?.setStateTexture(this.sim.stateTexture)
    }
    this.statsSnapshot = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }
    this.options.toast('模拟已重置', 2400)
  }

  /** 鎷栧姩涓細鍙洿鏂版爣璁颁笌闈㈡澘璇绘暟锛屼笉鍋氬湴褰㈤噸閲囨牱銆?*/
  private previewDraggedSource(source: WaterSource): void {
    this.markers.updateSource(source)
    this.applySimState()
  }

  /** 鎷栧姩缁撴潫锛氭寜钀界偣閲嶆柊璐村湴锛屽埛鏂伴潰鏉垮苟淇濆瓨銆?*/
  private commitDraggedSource(source: WaterSource): void {
    source.groundLevel = this.groundLevelAt(source.longitude, source.latitude) ?? source.groundLevel
    this.markers.settleSource(source)
    this.scheduleSave()
  }

  private deleteSource(id: string): void {
    const index = this.state.sources.findIndex((source) => source.id === id)
    if (index < 0) return
    const [removed] = this.state.sources.splice(index, 1)
    if (!removed) return
    if (this.selectedId === id) this.selectedId = null
    this.markers.setSources(this.state.sources, this.selectedId, this.projection)
    this.applySimState()
    this.scheduleSave()
    this.options.toast(`已删除 ${removed.name}`, 2000)
  }

  private clearSources(): void {
    if (this.state.sources.length === 0) return
    const count = this.state.sources.length
    this.state.sources = []
    this.selectedId = null
    this.exitPlacing()
    this.markers.setSources([], null, this.projection)
    this.applySimState()
    this.scheduleSave()
    this.options.toast(`已清空 ${count} 个水源`, 2200)
  }

  // ---------------------------------------------------------------- 寰幆涓庢寔涔呭寲

  private animate = (now: number): void => {
    if (this.disposed) return
    this.animationHandle = requestAnimationFrame(this.animate)
    const dt = this.lastFrameAt > 0 ? Math.min(0.1, (now - this.lastFrameAt) / 1000) : 1 / 60
    this.lastFrameAt = now

    if (this.sim && this.state.enabled) {
      const started = performance.now()
      this.sim.update(dt)
      this.statsSnapshot.simMs = performance.now() - started
      this.surface?.setStateTexture(this.sim.stateTexture)
      this.surface?.update(dt)
    }
    this.updateSun()
    this.updateGateFlow(now)

    this.markers.updateFrame(this.viewer.camera.raw, this.canvasSize.width, this.canvasSize.height)
    this.boundary.update(this.viewer.camera.raw, this.canvasSize.height)

    if (now - this.lastStatsAt > STATS_MIN_INTERVAL_MS && this.sim) {
      this.lastStatsAt = now
      this.statsSnapshot = { ...this.statsSnapshot, ...this.sim.debugStats() }
    }
  }

  private handleBeforeUnload = (): void => {
    this.saveNow()
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => this.saveNow(), 500)
  }

  /** 仅自动持久化，不再提供手动保存/导出入口。 */
  private saveNow(): void {
    window.clearTimeout(this.saveTimer)
    storeState(this.state)
  }

  // ---------------------------------------------------------------- 璋冭瘯 API

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
      getDam: () => (this.dam ? { ...this.dam } : null),
      getModels: () => this.currentModels,
      getModelKinds: () => this.getModelKinds(),
      clearModels: () => this.clearWaterModels(),
      getStructureInfo: () => {
        if (!this.structure) return null
        let maxHeight = 0
        let nonZero = 0
        for (const height of this.structure.heights) {
          if (height > maxHeight) maxHeight = height
          if (height > 0) nonZero += 1
        }
        return {
          resolution: this.structure.resolution,
          sizeMeters: this.structure.sizeMeters,
          baseElevation: this.structure.baseElevation,
          maxHeight,
          nonZero
        }
      },
      getGate: () => (this.gate ? { ...this.gate, flow: this.lastGateFlow } : null),
      getGateUniforms: () => this.sim?.debugGateUniforms() ?? null,
      debugSetGateSolid: (width: number, thickness: number) => {
        this.sim?.debugSetGateSolid(width, thickness)
      },
      /** 璋冭瘯鐢細鏌愪釜鍩熷钩闈㈠潗鏍囨槸鍚﹁惤鍦ㄩ椄闂ㄥ疄浣撳鍐呫€?*/
      isSolidAt: (x: number, z: number) => {
        if (!this.gate || !this.structure) return false
        const n = this.structure.resolution
        const cellWidth = this.structure.sizeMeters / n
        const { halfWidth, halfThickness } = gateSolidGeometry(this.gate, cellWidth)
        const headingRad = (this.gate.headingDegrees * Math.PI) / 180
        const axisX = Math.cos(headingRad)
        const axisZ = Math.sin(headingRad)
        const dx = x - this.gate.centerX
        const dz = z - this.gate.centerZ
        const along = Math.abs(dx * axisX + dz * axisZ)
        const across = Math.abs(dx * -axisZ + dz * axisX)
        return along <= halfWidth && across <= halfThickness
      },
      /** 闂搁棬寮€搴︼紙绫筹級锛? = 鍏抽棴璐村湴銆?*/
      setGateOpening: (value: number) => {
        this.applyGateOpening(value)
        return this.state.gateOpeningMeters
      },
      getStructureHeightAt: (x: number, z: number) => {
        if (!this.structure) return null
        const n = this.structure.resolution
        const half = this.structure.sizeMeters / 2
        const i = Math.floor(
          Math.max(0, Math.min(n - 1, ((x + half) / this.structure.sizeMeters) * n))
        )
        const j = Math.floor(
          Math.max(0, Math.min(n - 1, ((z + half) / this.structure.sizeMeters) * n))
        )
        return this.structure.heights[j * n + i] ?? 0
      },
      /** 璋冭瘯鐢細涓存椂绉婚櫎/鎭㈠鍧濅綋缁撴瀯锛岄獙璇佲€滄湁姘村伐缁撴瀯鈥濅笌鈥滄棤缁撴瀯鈥濈殑瀵圭収銆?*/
      setDamEnabled: (enabled: boolean) => {
        if (!this.sim) return false
        this.sim.setStructure(enabled ? this.structure : null)
        this.sim.setGate(enabled && this.gate ? toSimGate(this.gate) : null)
        this.surface?.setGate(
          enabled && this.gate ? toSimGate(this.gate) : null,
          this.domain ? this.domain.sizeMeters / this.state.sim.resolution : 1
        )
        this.statsSnapshot = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }
        return true
      },
      /** 璇诲彇鍩熷钩闈㈠潗鏍?(x, z) 鐨勬按娣憋紙绫筹級锛涗粎璋冭瘯/E2E 浣跨敤銆?*/
      getWaterDepthAt: (x: number, z: number) => this.sim?.debugDepthAt(x, z) ?? null,
      getDomainCacheInfo: () => getCachedDomainInfo(),
      clearDomainCache: () => {
        clearCachedDomainField()
        void clearServerDomainField()
        this.domainSource = null
      },
      refreshDomain: () => this.rebuildFixedDomain(),
      /** 涓㈠純褰撳墠鍐呭瓨涓殑妯℃嫙鍩燂紝鎸夆€滄祻瑙堝櫒缂撳瓨 鈫?鏈嶅姟鍣ㄧ紦瀛?鈫?閲嶆柊閲囨牱鈥濋噸鏂板缓绔嬶紙娴嬭瘯/璋冭瘯鐢級銆?*/
      restoreDomainFromStorage: async () => {
        this.disposeSimulation()
        this.field = null
        this.domain = null
        this.projection = null
        this.domainSource = null
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
      isPlacing: () => this.placing,
      isBuilding: () => Boolean(this.build),
      getProgress: () => ({ ...this.buildProgress }),
      togglePlacing: () => this.togglePlacing(),
      cancelPlacing: () => this.exitPlacing(),
      setEnabled: (enabled: boolean) => this.setEnabled(enabled),
      resetSimulation: () => this.resetSimulation(),
      rebuildSimulation: () => this.rebuildSimulation(),
      rebuildDomain: () => {
        void this.rebuildFixedDomain()
      },
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
        this.scheduleSave()
        return true
      },
      setSimSettings: (patch: Partial<WaterState['sim']>) => {
        Object.assign(this.state.sim, patch)
        this.applySimState()
        this.scheduleSave()
      },
      setVisual: (patch: Partial<WaterState['visual']>) => {
        Object.assign(this.state.visual, patch)
        this.surface?.setVisual(this.state.visual)
        this.scheduleSave()
      },
      applyExternalState: (incoming: WaterState) => {
        this.state = normalizeWaterState(incoming)
        this.selectedId = null
        this.markers.setSources(this.state.sources, null, this.projection)
        this.surface?.setVisual(this.state.visual)
        this.surface?.setEnabled(this.state.enabled)
        this.applySimState()
        this.syncAll()
      },
      rebuildAt: async () => {
        this.selectedId = null
        await this.buildDomain(
          { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude },
          WATER_DOMAIN.sizeMeters
        )
        return this.isDomainReady
      },
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
