import * as THREE from 'three'
import type { SimSettings, SimSource, SimStats, SimTerrain } from './types'
import { clamp, toFiniteNumber } from './types'
import { sampleFieldHeight } from './terrainField'
import {
  DEPTH_FRAGMENT,
  FLUX_FRAGMENT,
  FULLSCREEN_VERTEX,
  INIT_FRAGMENT,
  STATS_FRAGMENT
} from './simShaders'

/**
 * GPU 浅水模拟（虚拟管道 / 通量 + 水深两步法）。
 *
 * 每个子步两个全屏 pass（ping-pong RGBA32F）：
 * 1. 通量 pass：由水面高程差算出四邻域出流（m³/s），按可用水量整体缩放；
 *    域边界按开放吸收边界处理，水流出域外即被吸收；
 * 2. 深度 / 速度 pass：加总邻居入流更新水深，处理注水与全局水位上限，
 *    再由净通量换算速度场。
 *
 * 对外 `stateTexture` 直接指向当前 ping-pong 状态纹理，水面层每帧跟随；
 * 不再做额外的全分辨率拷贝 pass。状态纹理使用 NearestFilter，数值读取一律
 * texelFetch（水面着色器自己做双线性），因此插值不会污染模拟。
 *
 * 坐标约定见 `src/water/types.ts`。
 */

/**
 * 1x 速度下每个子步代表的模拟时间（1/30 s）。
 *
 * 相比旧的 1/60 s，每个子步覆盖两倍模拟时间：同样观感下每秒子步数减半、
 * GPU pass 数减半；保持与旧版相同的每帧开销时则可推进两倍模拟时间。
 * 稳定性由通量 pass 里含 uDt 的 CFL 缩放自动保证。
 */
const SUBSTEP_SECONDS = 1 / 30
/** 界面参数的参考时间基准：注水间隔等仍以 1/60 s 为一“步”。 */
const REFERENCE_SUBSTEP_SECONDS = 1 / 60
/** 单次 update 最多推进的子步数（64 子步 × 1/30 s ≈ 2.1 s 模拟时间）。 */
const MAX_SUBSTEPS_PER_UPDATE = 64
/** 单帧传入 dt 的上限（秒）。 */
const MAX_FRAME_DT = 0.1
const MAX_SOURCE_COUNT = 8
const GRAVITY = 9.81
/** 默认通量方向最大虚拟流速（m/s），可由 SimSettings.maxFlowSpeed 覆盖。 */
const DEFAULT_MAX_FLOW_SPEED = 30
/** 默认通量阻尼，帮助静水收敛，可由 SimSettings.damping 覆盖。 */
const DEFAULT_FLOW_DAMPING = 0.995
/** 默认每 2 个 1/60 s 参考步长注水一次，可由 SimSettings.injectInterval 覆盖。 */
const DEFAULT_INJECT_INTERVAL = 2
/** 水深安全上限（m），避免极端注水下数值溢出。 */
const MAX_DEPTH = 20_000
/** 统计降采样的块边长（每块 4x4 模拟格）。 */
const STATS_BLOCK = 4
/** 统计读回的最小间隔（ms），与面板 700 ms 的刷新节奏对齐，减少 GPU 同步等待。 */
const STATS_MIN_INTERVAL_MS = 700

type StatsArray = Float32Array | Uint16Array

export class ShallowWaterSim {
  /** 模拟网格边长（= terrain.resolution）。 */
  readonly resolution: number
  /** 地形相对基准高程（米），来自 SimTerrain。 */
  private readonly terrain: SimTerrain
  private readonly renderer: THREE.WebGLRenderer
  private readonly sizeMeters: number
  private readonly cellWidth: number
  private readonly useFloatTextures: boolean

  private readonly stateTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private readonly fluxTarget: THREE.WebGLRenderTarget
  private readonly statsTarget: THREE.WebGLRenderTarget
  private readonly statsSize: number
  private readonly terrainTexture: THREE.DataTexture

  private readonly scene: THREE.Scene
  private readonly camera: THREE.OrthographicCamera
  private readonly geometry: THREE.BufferGeometry
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  private readonly initMaterial: THREE.ShaderMaterial
  private readonly fluxMaterial: THREE.ShaderMaterial
  private readonly depthMaterial: THREE.ShaderMaterial
  private readonly statsMaterial: THREE.ShaderMaterial

  private sources: SimSource[] = []
  private settings: SimSettings = {
    speed: 1,
    paused: false,
    waterAmount: 15,
    maxFlowSpeed: DEFAULT_MAX_FLOW_SPEED,
    damping: DEFAULT_FLOW_DAMPING,
    injectInterval: DEFAULT_INJECT_INTERVAL
  }
  private stateIndex = 0
  private steps = 0
  private accumulator = 0
  /** 距上次注水累积的模拟秒数（按模拟时间触发，不受子步 dt 影响）。 */
  private injectClock = 0
  private lastSimMs = 0
  private statsStale = true
  private lastStatsAt = Number.NEGATIVE_INFINITY
  private cachedWetCells = 0
  private cachedMaxDepth = 0
  private statsBuffer: StatsArray | null = null
  private disposed = false

  constructor(renderer: THREE.WebGLRenderer, terrain: SimTerrain) {
    if (!renderer || typeof renderer.render !== 'function') {
      throw new Error('ShallowWaterSim: 需要有效的 THREE.WebGLRenderer')
    }
    const resolution = Math.round(terrain?.resolution ?? 0)
    if (!Number.isFinite(resolution) || resolution < 2 || resolution > 2048) {
      throw new Error(`ShallowWaterSim: 非法模拟分辨率 ${String(terrain?.resolution)}`)
    }
    if (terrain.heights.length !== resolution * resolution) {
      throw new Error('ShallowWaterSim: terrain.heights 长度与 resolution 不一致')
    }
    if (!(Number.isFinite(terrain.sizeMeters) && terrain.sizeMeters > 0)) {
      throw new Error('ShallowWaterSim: 非法模拟域边长')
    }

    this.renderer = renderer
    this.terrain = terrain
    this.resolution = resolution
    this.sizeMeters = terrain.sizeMeters
    this.cellWidth = terrain.sizeMeters / resolution

    const floatSupported = renderer.extensions.has('EXT_color_buffer_float')
    const halfFloatSupported =
      renderer.extensions.has('EXT_color_buffer_half_float') || floatSupported
    if (!floatSupported) {
      console.warn(
        '[ShallowWaterSim] 当前环境不支持 EXT_color_buffer_float，降级到 HalfFloat 模拟纹理（精度与统计读回精度会下降）'
      )
    }
    if (!halfFloatSupported) {
      throw new Error('ShallowWaterSim: 需要 EXT_color_buffer_float 或 EXT_color_buffer_half_float')
    }
    this.useFloatTextures = floatSupported

    const textureType = floatSupported ? THREE.FloatType : THREE.HalfFloatType
    const targetOptions: THREE.RenderTargetOptions = {
      type: textureType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace
    }

    this.stateTargets = [
      new THREE.WebGLRenderTarget(resolution, resolution, targetOptions),
      new THREE.WebGLRenderTarget(resolution, resolution, targetOptions)
    ]
    this.fluxTarget = new THREE.WebGLRenderTarget(resolution, resolution, targetOptions)
    this.statsSize = Math.ceil(resolution / STATS_BLOCK)
    this.statsTarget = new THREE.WebGLRenderTarget(this.statsSize, this.statsSize, targetOptions)

    this.terrainTexture = new THREE.DataTexture(
      terrain.heights,
      resolution,
      resolution,
      THREE.RedFormat,
      THREE.FloatType
    )
    this.terrainTexture.minFilter = THREE.NearestFilter
    this.terrainTexture.magFilter = THREE.NearestFilter
    this.terrainTexture.wrapS = THREE.ClampToEdgeWrapping
    this.terrainTexture.wrapT = THREE.ClampToEdgeWrapping
    this.terrainTexture.needsUpdate = true

    this.geometry = new THREE.BufferGeometry()
    const positions = new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0])
    const uvs = new Float32Array([0, 0, 2, 0, 0, 2])
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))

    this.scene = new THREE.Scene()
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

    const sources = this.createVector4Array()
    const targets = this.createVector4Array()

    this.initMaterial = this.createMaterial(INIT_FRAGMENT, {
      uTerrain: { value: this.terrainTexture }
    })
    this.fluxMaterial = this.createMaterial(FLUX_FRAGMENT, {
      uState: { value: null },
      uResolution: { value: resolution },
      uCellWidth: { value: this.cellWidth },
      uDt: { value: SUBSTEP_SECONDS },
      uGravity: { value: GRAVITY },
      uMaxFlowSpeed: { value: this.settings.maxFlowSpeed },
      // 初始值同样按子步时间补偿；setSettings 会再写一次。
      uDamping: {
        value: Math.pow(this.settings.damping, SUBSTEP_SECONDS / REFERENCE_SUBSTEP_SECONDS)
      }
    })
    this.depthMaterial = this.createMaterial(DEPTH_FRAGMENT, {
      uState: { value: null },
      uFlux: { value: null },
      uResolution: { value: resolution },
      uCellWidth: { value: this.cellWidth },
      uDt: { value: SUBSTEP_SECONDS },
      uDomainSize: { value: this.sizeMeters },
      uInject: { value: 0 },
      uSourceCount: { value: 0 },
      uSources: { value: sources },
      uTargets: { value: targets },
      uFallbackAmount: { value: this.settings.waterAmount },
      uHasCap: { value: 0 },
      uCapRel: { value: 0 },
      uMaxDepth: { value: MAX_DEPTH }
    })
    this.statsMaterial = this.createMaterial(STATS_FRAGMENT, {
      // 每次读回统计前绑定当前 ping-pong 状态纹理。
      uState: { value: null },
      uResolution: { value: resolution },
      uOutSize: { value: this.statsSize },
      uBlock: { value: STATS_BLOCK }
    })

    this.quad = new THREE.Mesh(this.geometry, this.initMaterial)
    this.quad.frustumCulled = false
    this.scene.add(this.quad)

    this.initializeState()
    this.applySourceUniforms()
  }

  /**
   * 当前 ping-pong 状态纹理（RGBA32F；不支持浮点颜色缓冲时为 HalfFloat）。
   * R = 水深 m，G = 东向速度 m/s，B = 北向速度 m/s，A = 相对 baseElevation 地形高程 m。
   * 每个子步会在两张纹理之间交换，水面层每帧通过 `setStateTexture` 跟随。
   */
  get stateTexture(): THREE.Texture {
    return this.stateTargets[this.stateIndex].texture
  }

  setSources(sources: SimSource[]): void {
    if (this.disposed) return
    const next: SimSource[] = []
    if (Array.isArray(sources)) {
      for (const source of sources) {
        if (next.length >= MAX_SOURCE_COUNT) break
        if (!source || typeof source !== 'object') continue
        const raw = source as unknown as Record<string, unknown>
        const x = toFiniteNumber(raw.x)
        const z = toFiniteNumber(raw.z)
        if (x === null || z === null) continue
        const radius = toFiniteNumber(raw.radius)
        const amount = toFiniteNumber(raw.amount)
        const targetLevel = toFiniteNumber(raw.targetLevel)
        next.push({
          x,
          z,
          radius: radius === null ? 0 : clamp(radius, 0, 6000),
          amount: amount === null ? 0 : clamp(amount, 0, 6000),
          targetLevel,
          enabled: raw.enabled !== false
        })
      }
    }
    this.sources = next
    this.applySourceUniforms()
  }

  setSettings(settings: SimSettings): void {
    if (this.disposed || !settings) return
    this.settings = {
      speed: clamp(toFiniteNumber(settings.speed) ?? 1, 0.1, 64),
      paused: settings.paused === true,
      waterAmount: clamp(toFiniteNumber(settings.waterAmount) ?? 15, 1, 300),
      maxFlowSpeed: clamp(
        toFiniteNumber(settings.maxFlowSpeed) ?? DEFAULT_MAX_FLOW_SPEED,
        5,
        60
      ),
      damping: clamp(toFiniteNumber(settings.damping) ?? DEFAULT_FLOW_DAMPING, 0.9, 1),
      injectInterval: Math.round(
        clamp(toFiniteNumber(settings.injectInterval) ?? DEFAULT_INJECT_INTERVAL, 1, 8)
      )
    }
    this.depthMaterial.uniforms.uFallbackAmount.value = this.settings.waterAmount
    this.fluxMaterial.uniforms.uMaxFlowSpeed.value = this.settings.maxFlowSpeed
    // 面板阻尼以 1/60 s 为参考；当前子步更长，按幂次换算保持每秒衰减不变。
    const dampingRatio = SUBSTEP_SECONDS / REFERENCE_SUBSTEP_SECONDS
    this.fluxMaterial.uniforms.uDamping.value = Math.pow(this.settings.damping, dampingRatio)
    if (this.settings.paused) this.accumulator = 0
  }

  update(dtSeconds: number): void {
    if (this.disposed) return
    if (this.settings.paused) {
      this.accumulator = 0
      return
    }
    const frameDt = toFiniteNumber(dtSeconds)
    if (frameDt === null) return
    const clampedDt = Math.min(Math.max(frameDt, 0), MAX_FRAME_DT)
    if (clampedDt <= 0) return

    // 以秒为单位累积；1x 速度下每秒 30 个子步（每个 1/30 s）。
    this.accumulator += clampedDt * this.settings.speed
    let substeps = Math.floor((this.accumulator + 1e-6) / SUBSTEP_SECONDS)
    if (substeps <= 0) return
    if (substeps > MAX_SUBSTEPS_PER_UPDATE) substeps = MAX_SUBSTEPS_PER_UPDATE
    this.accumulator = Math.max(
      0,
      Math.min(
        this.accumulator - substeps * SUBSTEP_SECONDS,
        MAX_SUBSTEPS_PER_UPDATE * SUBSTEP_SECONDS
      )
    )

    const start = performance.now()
    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      for (let i = 0; i < substeps; i++) this.step()
    } finally {
      this.renderer.autoClear = previousAutoClear
      this.renderer.setRenderTarget(previousTarget)
    }
    this.lastSimMs = performance.now() - start
    this.statsStale = true
  }

  reset(): void {
    if (this.disposed) return
    this.initializeState()
    this.steps = 0
    this.accumulator = 0
    this.injectClock = 0
    this.lastSimMs = 0
    this.cachedWetCells = 0
    this.cachedMaxDepth = 0
    this.statsStale = true
  }

  debugStats(): SimStats {
    if (!this.disposed) {
      const now = performance.now()
      if (this.statsStale && now - this.lastStatsAt >= STATS_MIN_INTERVAL_MS) {
        this.readStats()
        this.lastStatsAt = now
        this.statsStale = false
      }
    }
    return {
      steps: this.steps,
      wetCells: this.cachedWetCells,
      maxDepth: this.cachedMaxDepth,
      simMs: this.lastSimMs
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scene.remove(this.quad)
    this.stateTargets[0].dispose()
    this.stateTargets[1].dispose()
    this.fluxTarget.dispose()
    this.statsTarget.dispose()
    this.terrainTexture.dispose()
    this.initMaterial.dispose()
    this.fluxMaterial.dispose()
    this.depthMaterial.dispose()
    this.statsMaterial.dispose()
    this.geometry.dispose()
    this.statsBuffer = null
  }

  private createVector4Array(): THREE.Vector4[] {
    const values: THREE.Vector4[] = []
    for (let i = 0; i < MAX_SOURCE_COUNT; i++) values.push(new THREE.Vector4())
    return values
  }

  private createMaterial(
    fragmentShader: string,
    uniforms: Record<string, THREE.IUniform>
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      transparent: false,
      toneMapped: false
    })
  }

  /** 用 init pass 把地形写进 A 通道、水深清零。 */
  private initializeState(): void {
    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      this.stateIndex = 0
      this.renderPass(this.initMaterial, this.stateTargets[0])
    } finally {
      this.renderer.autoClear = previousAutoClear
      this.renderer.setRenderTarget(previousTarget)
    }
    this.statsStale = true
  }

  /** 帧内多个 pass 复用一个 render target 恢复 / autoClear 恢复。 */
  private renderPass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = material
    this.renderer.setRenderTarget(target)
    this.renderer.render(this.scene, this.camera)
  }

  private step(): void {
    this.steps += 1
    const inject = this.tickInjection()
    const readTarget = this.stateTargets[this.stateIndex]
    const writeTarget = this.stateTargets[1 - this.stateIndex]

    const flux = this.fluxMaterial.uniforms
    flux.uState.value = readTarget.texture
    this.renderPass(this.fluxMaterial, this.fluxTarget)

    const depth = this.depthMaterial.uniforms
    depth.uState.value = readTarget.texture
    depth.uFlux.value = this.fluxTarget.texture
    depth.uInject.value = inject ? 1 : 0
    this.renderPass(this.depthMaterial, writeTarget)

    this.stateIndex = 1 - this.stateIndex
  }

  /**
   * 按模拟时间决定本子步是否注水。
   *
   * `injectInterval` 以 1/60 s 为单位，换算成秒后与子步 dt 无关，
   * 因此把子步从 1/60 s 改成 1/30 s 后每模拟秒的注水次数保持不变。
   */
  private tickInjection(): boolean {
    const intervalSeconds = this.settings.injectInterval * REFERENCE_SUBSTEP_SECONDS
    this.injectClock += SUBSTEP_SECONDS
    if (this.injectClock + 1e-9 < intervalSeconds) return false
    this.injectClock = Math.max(0, this.injectClock - intervalSeconds)
    return true
  }

  /** 把水源参数写成 uniform；同时推导全局水位上限。 */
  private applySourceUniforms(): void {
    const uniformSources = this.depthMaterial.uniforms.uSources.value as THREE.Vector4[]
    const uniformTargets = this.depthMaterial.uniforms.uTargets.value as THREE.Vector4[]
    let hasTargetCap = false
    let hasUnbounded = false
    let capRel = 0

    for (let i = 0; i < MAX_SOURCE_COUNT; i++) {
      const source = this.sources[i]
      const uniformSource = uniformSources[i]
      const uniformTarget = uniformTargets[i]
      if (!source) {
        uniformSource.set(0, 0, 0, 0)
        uniformTarget.set(0, 0, 0, 0)
        continue
      }
      const enabled = source.enabled !== false
      uniformSource.set(source.x, source.z, enabled ? source.radius : 0, source.amount)
      if (!enabled) {
        uniformTarget.set(0, 0, 0, 0)
        continue
      }
      if (source.targetLevel === null) {
        hasUnbounded = true
        // 「不限制目标水位」不代表可以无限注水：用「水源处地形 + 每次注水量」
        // 作为本地压力水头，注满后停止、水排走后再补充，避免数秒灌到千米级。
        const terrainRel = sampleFieldHeight(this.terrain, source.x, source.z)
        uniformTarget.set(terrainRel + Math.max(source.amount, 0.5), 2, 0, 0)
      } else {
        const targetRel = source.targetLevel - this.terrain.baseElevation
        hasTargetCap = true
        capRel = Math.max(capRel, targetRel)
        uniformTarget.set(targetRel, 1, 0, 0)
      }
    }

    this.depthMaterial.uniforms.uSourceCount.value = this.sources.length
    const capEnabled = hasTargetCap && !hasUnbounded
    this.depthMaterial.uniforms.uHasCap.value = capEnabled ? 1 : 0
    this.depthMaterial.uniforms.uCapRel.value = capEnabled ? capRel : 0
  }

  /** 同步读回统计：先渲染 4x4 降采样统计，再读回小纹理（远小于整张状态纹理）。 */
  private readStats(): void {
    const size = this.statsSize
    const pixelCount = size * size
    const requiredLength = pixelCount * 4
    let buffer = this.statsBuffer
    if (!buffer || buffer.length !== requiredLength) {
      buffer = this.useFloatTextures ? new Float32Array(requiredLength) : new Uint16Array(requiredLength)
      this.statsBuffer = buffer
    }

    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      this.statsMaterial.uniforms.uState.value = this.stateTexture
      this.renderPass(this.statsMaterial, this.statsTarget)
    } catch (error) {
      console.warn('[ShallowWaterSim] 统计 pass 失败', error)
      return
    } finally {
      this.renderer.autoClear = previousAutoClear
      this.renderer.setRenderTarget(previousTarget)
    }

    try {
      this.renderer.readRenderTargetPixels(this.statsTarget, 0, 0, size, size, buffer)
    } catch (error) {
      console.warn('[ShallowWaterSim] 统计读回失败', error)
      return
    }

    let wetCells = 0
    let maxDepth = 0
    if (this.useFloatTextures) {
      const floats = buffer as Float32Array
      for (let i = 0; i < pixelCount; i++) {
        const wet = floats[i * 4]
        const depth = floats[i * 4 + 1]
        if (Number.isFinite(wet) && wet > 0) wetCells += Math.round(wet)
        if (Number.isFinite(depth) && depth > maxDepth) maxDepth = depth
      }
    } else {
      const half = buffer as Uint16Array
      for (let i = 0; i < pixelCount; i++) {
        const wet = THREE.DataUtils.fromHalfFloat(half[i * 4])
        const depth = THREE.DataUtils.fromHalfFloat(half[i * 4 + 1])
        if (Number.isFinite(wet) && wet > 0) wetCells += Math.round(wet)
        if (Number.isFinite(depth) && depth > maxDepth) maxDepth = depth
      }
    }
    this.cachedWetCells = wetCells
    this.cachedMaxDepth = maxDepth
  }
}
