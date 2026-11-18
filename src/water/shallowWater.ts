import * as THREE from 'three'
import type { SimSettings, SimSource, SimStats, SimTerrain } from './types'
import {
  COPY_FRAGMENT,
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
 * 2. 深度 / 速度 pass：加总邻居入流更新水深，处理注水与全局水位上限，
 *    再由净通量换算速度场。
 *
 * 对外 `stateTexture` 是每个 update 末尾拷贝出来的展示纹理（身份稳定），
 * 模拟本身使用 NearestFilter 的 ping-pong 目标，避免插值污染数值。
 *
 * 坐标约定见 `src/water/types.ts`。
 */

/** 1x 速度下每个子步代表的固定时间（60Hz）。 */
const SUBSTEP_SECONDS = 1 / 60
/** 单次 update 最多推进的子步数（支持 32× 加速，同时防止掉帧时补跑过多）。 */
const MAX_SUBSTEPS_PER_UPDATE = 64
/** 单帧传入 dt 的上限（秒）。 */
const MAX_FRAME_DT = 0.1
const MAX_SOURCE_COUNT = 8
const GRAVITY = 9.81
/** 通量方向的最大虚拟流速（m/s）。 */
const MAX_FLOW_SPEED = 30
/** 通量轻微阻尼，帮助静水收敛。 */
const FLOW_DAMPING = 0.995
/** 水深安全上限（m），避免极端注水下数值溢出。 */
const MAX_DEPTH = 20_000
/** 统计降采样的块边长（每块 4x4 模拟格）。 */
const STATS_BLOCK = 4
/** 统计读回的最小间隔（ms）。 */
const STATS_MIN_INTERVAL_MS = 400

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
  private readonly presentTarget: THREE.WebGLRenderTarget
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
  private readonly copyMaterial: THREE.ShaderMaterial
  private readonly statsMaterial: THREE.ShaderMaterial

  private sources: SimSource[] = []
  private settings: SimSettings = { speed: 1, paused: false, waterAmount: 15 }
  private stateIndex = 0
  private steps = 0
  private accumulator = 0
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

    // 展示纹理允许线性过滤，让水面渲染更平滑（浮点线性过滤缺失时退回最近邻）。
    const linearSupported = floatSupported
      ? renderer.extensions.has('OES_texture_float_linear')
      : true
    const presentOptions: THREE.RenderTargetOptions = {
      ...targetOptions,
      minFilter: linearSupported ? THREE.LinearFilter : THREE.NearestFilter,
      magFilter: linearSupported ? THREE.LinearFilter : THREE.NearestFilter
    }

    this.stateTargets = [
      new THREE.WebGLRenderTarget(resolution, resolution, targetOptions),
      new THREE.WebGLRenderTarget(resolution, resolution, targetOptions)
    ]
    this.fluxTarget = new THREE.WebGLRenderTarget(resolution, resolution, targetOptions)
    this.presentTarget = new THREE.WebGLRenderTarget(resolution, resolution, presentOptions)
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
      uMaxFlowSpeed: { value: MAX_FLOW_SPEED },
      uDamping: { value: FLOW_DAMPING }
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
    this.copyMaterial = this.createMaterial(COPY_FRAGMENT, {
      uState: { value: null }
    })
    this.statsMaterial = this.createMaterial(STATS_FRAGMENT, {
      uState: { value: this.presentTarget.texture },
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
   * 对外展示的模拟状态纹理（RGBA32F；不支持浮点颜色缓冲时为 HalfFloat）。
   * R = 水深 m，G = 东向速度 m/s，B = 北向速度 m/s，A = 相对 baseElevation 地形高程 m。
   * 每次 update 结束后内容刷新，纹理对象身份保持不变。
   */
  get stateTexture(): THREE.Texture {
    return this.presentTarget.texture
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
      speed: clamp(toFiniteNumber(settings.speed) ?? 1, 0.1, 32),
      paused: settings.paused === true,
      waterAmount: clamp(toFiniteNumber(settings.waterAmount) ?? 15, 1, 300)
    }
    this.depthMaterial.uniforms.uFallbackAmount.value = this.settings.waterAmount
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

    // 以秒为单位累积；1x 速度下 60Hz 每帧恰好 1 子步（用 1e-6 s 容差抵消浮点误差）。
    this.accumulator += clampedDt * this.settings.speed
    let substeps = Math.floor((this.accumulator + 1e-6) / SUBSTEP_SECONDS)
    if (substeps <= 0) return
    if (substeps > MAX_SUBSTEPS_PER_UPDATE) substeps = MAX_SUBSTEPS_PER_UPDATE
    this.accumulator = Math.max(
      0,
      Math.min(this.accumulator - substeps * SUBSTEP_SECONDS, MAX_SUBSTEPS_PER_UPDATE * SUBSTEP_SECONDS)
    )

    const start = performance.now()
    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      for (let i = 0; i < substeps; i++) this.step()
      const copy = this.copyMaterial.uniforms
      copy.uState.value = this.stateTargets[this.stateIndex].texture
      this.renderPass(this.copyMaterial, this.presentTarget)
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
    this.presentTarget.dispose()
    this.statsTarget.dispose()
    this.terrainTexture.dispose()
    this.initMaterial.dispose()
    this.fluxMaterial.dispose()
    this.depthMaterial.dispose()
    this.copyMaterial.dispose()
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

  /** 用 init pass 把地形写进 A 通道、水深清零，再同步展示纹理。 */
  private initializeState(): void {
    const previousTarget = this.renderer.getRenderTarget()
    const previousAutoClear = this.renderer.autoClear
    this.renderer.autoClear = false
    try {
      this.stateIndex = 0
      this.renderPass(this.initMaterial, this.stateTargets[0])
      this.quad.material = this.copyMaterial
      this.copyMaterial.uniforms.uState.value = this.stateTargets[0].texture
      this.renderPass(this.copyMaterial, this.presentTarget)
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
    const inject = this.steps % 2 === 1
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
        const terrainRel = this.terrainRelativeAt(source.x, source.z)
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

  /** 双线性读取模拟域内任意位置的地形相对高程（米），用于「不限制」水源的本地水头。 */
  private terrainRelativeAt(x: number, z: number): number {
    const n = this.resolution
    const half = this.sizeMeters / 2
    const gx = Math.max(0, Math.min(n - 1, ((x + half) / this.sizeMeters) * (n - 1)))
    const gz = Math.max(0, Math.min(n - 1, ((z + half) / this.sizeMeters) * (n - 1)))
    const x0 = Math.floor(gx)
    const z0 = Math.floor(gz)
    const x1 = Math.min(n - 1, x0 + 1)
    const z1 = Math.min(n - 1, z0 + 1)
    const fx = gx - x0
    const fz = gz - z0
    const h00 = this.terrain.heights[z0 * n + x0]
    const h10 = this.terrain.heights[z0 * n + x1]
    const h01 = this.terrain.heights[z1 * n + x0]
    const h11 = this.terrain.heights[z1 * n + x1]
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
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

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
