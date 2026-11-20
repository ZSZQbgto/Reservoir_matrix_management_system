/**
 * 水面渲染层。
 *
 * 在模拟域中心建立一个 `sizeMeters × sizeMeters` 的切平面规则网格，加入
 * `viewer.scene.raw`，由 Tellux 的渲染管线（HDR + 大气后处理 + AgX tone mapping）
 * 统一处理。顶点着色器按模拟纹理的 R/A 通道沿局部 +Y 位移，片元着色器完成
 * 菲涅尔天空反射、太阳高光、Beer-Lambert 深度吸收、程序化波纹与泡沫。
 *
 * 切平面局部坐标约定（由 `viewer.cartographicToMatrix4` 给出）：
 * **+X = 西、+Y = 上、+Z = 北**；网格顶点使用 `(x=-east, y=height, z=north)`。
 *
 * 模拟纹理契约（详见 `./types.ts`）：RGBA，R=水深(m)、G=东向流速(m/s)、
 * B=北向流速(m/s)、A=相对 baseElevation 的地形高程(m)；
 * `uv = (east/size + 0.5, north/size + 0.5)`（v=0 南、v=1 北）。
 */

import * as THREE from 'three'
import type { Viewer } from 'tellux'
import type { SurfaceDomain, WaterVisualSettings } from './types'
import { VISUAL_DEFAULTS, clamp } from './types'
import { WATER_FRAGMENT_SHADER, WATER_VERTEX_SHADER } from './waterShaders'
import {
  createWaterDetailTextures,
  disposeWaterDetailTextures,
  type WaterDetailTextures
} from './waterTextures'
import { sunStateForDirection } from './sun'

/** 网格段数范围：192 段 ≈ 37k 顶点，足以贴合 8 m 级模拟网格。 */
const MIN_SEGMENTS = 160
const MAX_SEGMENTS = 192
/** 目标网格间距（米），按域尺寸自适应段数。 */
const TARGET_SPACING = 11
/** 水面相对地形/水深的抬升（米），避免与 Cesium 地形 z-fighting。 */
const SURFACE_LIFT = 0.42
/** 默认太阳方向（ENU）：约 36° 高度角、东南偏南。 */
const DEFAULT_SUN_ENU = new THREE.Vector3(0.28, 0.6, 0.75)
/** 单帧最大推进时间，避免切页/卡顿导致波纹瞬间跳变。 */
const MAX_STEP_SECONDS = 0.1

function resolveSegments(sizeMeters: number): number {
  const desired = Math.round(sizeMeters / TARGET_SPACING)
  return clamp(Number.isFinite(desired) ? desired : MAX_SEGMENTS, MIN_SEGMENTS, MAX_SEGMENTS)
}

/**
 * 构造切平面网格：position.x = -east、position.z = north，uv 与模拟纹理一一对应。
 */
function buildWaterGeometry(sizeMeters: number, segments: number): THREE.BufferGeometry {
  const vertexCount = (segments + 1) * (segments + 1)
  const positions = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const uvs = new Float32Array(vertexCount * 2)
  const indices = new Uint32Array(segments * segments * 6)

  let vertex = 0
  let uv = 0
  for (let j = 0; j <= segments; j += 1) {
    const north = (j / segments - 0.5) * sizeMeters
    for (let i = 0; i <= segments; i += 1) {
      const east = (i / segments - 0.5) * sizeMeters
      positions[vertex] = -east
      positions[vertex + 1] = 0
      positions[vertex + 2] = north
      // 顶点法线朝上：Tellux 的 NormalPass / 大气后处理光照会读取几何法线，
      // 缺失 normal 属性会让水面法线退化成异常值并把颜色打黑。
      normals[vertex] = 0
      normals[vertex + 1] = 1
      normals[vertex + 2] = 0
      vertex += 3
      uvs[uv] = east / sizeMeters + 0.5
      uvs[uv + 1] = north / sizeMeters + 0.5
      uv += 2
    }
  }

  let index = 0
  const stride = segments + 1
  for (let j = 0; j < segments; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = j * stride + i
      const b = a + 1
      const c = a + stride
      const d = c + 1
      // 逆时针（从 +Y/上方看）→ 法线朝上。
      indices[index] = a
      indices[index + 1] = b
      indices[index + 2] = c
      indices[index + 3] = b
      indices[index + 4] = d
      indices[index + 5] = c
      index += 6
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.name = 'TelluxWaterSurfaceGeometry'
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(0, 0, 0),
    Math.hypot(sizeMeters, sizeMeters) * 0.75
  )
  return geometry
}

/** 水面渲染对象。模拟分辨率变化时由调用方销毁并重建。 */
export class WaterSurface {
  /** 场景中的水面网格（已加入 `viewer.scene.raw`）。 */
  readonly mesh: THREE.Mesh

  private readonly domain: SurfaceDomain
  private readonly material: THREE.ShaderMaterial
  private readonly geometry: THREE.BufferGeometry
  private readonly textures: WaterDetailTextures
  private readonly uniforms: Record<string, THREE.IUniform>
  private readonly segments: number
  private readonly simResolution: number

  private readonly sunLocalUniform = new THREE.Vector3(0, 1, 0)
  private readonly sunColor = new THREE.Color()
  private readonly skyZenith = new THREE.Color()
  private readonly skyHorizon = new THREE.Color()
  private readonly deepColor = new THREE.Color()
  private readonly shallowColor = new THREE.Color()
  private readonly foamColor = new THREE.Color()
  private readonly viewRotation = new THREE.Matrix3()
  private readonly scratchMatrix4 = new THREE.Matrix4()

  private visual: WaterVisualSettings = { ...VISUAL_DEFAULTS }
  private time = 0
  private enabled = true
  private disposed = false

  constructor(
    viewer: Viewer,
    domain: SurfaceDomain,
    stateTexture: THREE.Texture,
    simResolution: number
  ) {
    this.domain = { ...domain, origin: { ...domain.origin } }
    this.simResolution = Math.max(2, Math.floor(simResolution) || 256)
    this.segments = resolveSegments(domain.sizeMeters)
    this.textures = createWaterDetailTextures()

    this.geometry = buildWaterGeometry(domain.sizeMeters, this.segments)

    this.uniforms = {
      uStateTexture: { value: stateTexture },
      uSimResolution: { value: this.simResolution },
      uSize: { value: domain.sizeMeters },
      uLift: { value: SURFACE_LIFT },
      uNormalBroad: { value: this.textures.normalBroad },
      uNormalFine: { value: this.textures.normalFine },
      uFoamTexture: { value: this.textures.foam },
      uTime: { value: 0 },
      uShimmer: { value: this.visual.shimmer },
      uGlint: { value: this.visual.glint },
      uReflection: { value: this.visual.reflection },
      uRipple: { value: this.visual.ripple },
      uRippleScale: { value: this.visual.rippleScale },
      uFlowSpeed: { value: this.visual.flowSpeed },
      uFoam: { value: this.visual.foam },
      uClarity: { value: this.visual.clarity },
      uOpacity: { value: this.visual.opacity },
      uSunLocal: { value: this.sunLocalUniform },
      uSunColor: { value: this.sunColor },
      uSkyZenith: { value: this.skyZenith },
      uSkyHorizon: { value: this.skyHorizon },
      uDeepColor: { value: this.deepColor },
      uShallowColor: { value: this.shallowColor },
      uFoamColor: { value: this.foamColor },
      uGlintStrength: { value: 1 },
      uViewRotation: { value: this.viewRotation }
    }

    this.material = new THREE.ShaderMaterial({
      name: 'TelluxWaterSurfaceMaterial',
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: WATER_VERTEX_SHADER,
      fragmentShader: WATER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
      fog: false
    })

    const frame = viewer.cartographicToMatrix4(
      {
        longitude: this.domain.origin.longitude,
        latitude: this.domain.origin.latitude,
        height: this.domain.baseElevation
      },
      { heading: 0, pitch: 0, roll: 0 }
    )

    const mesh = new THREE.Mesh(this.geometry, this.material)
    mesh.name = 'TelluxWaterSurface'
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(frame)
    mesh.matrixWorldNeedsUpdate = true
    mesh.frustumCulled = false
    mesh.renderOrder = 10
    mesh.visible = this.enabled
    mesh.onBeforeRender = (_renderer, _scene, camera) => {
      // 片元着色器需要「局部方向 → 视图空间」的旋转矩阵（片元里没有 modelViewMatrix）。
      if (this.disposed) return
      this.scratchMatrix4.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld)
      this.viewRotation.setFromMatrix4(this.scratchMatrix4)
    }
    this.mesh = mesh

    viewer.scene.raw.add(mesh)
    this.applySunState(sunStateForDirection(DEFAULT_SUN_ENU))
  }

  /** 显隐（水体总开关 / 退出水体编辑）。 */
  setEnabled(enabled: boolean): void {
    if (this.disposed) return
    this.enabled = enabled === true
    this.mesh.visible = this.enabled
  }

  /** 切换到当前模拟状态纹理（模拟器 ping-pong 时每帧调用，避免额外拷贝 pass）。 */
  setStateTexture(texture: THREE.Texture): void {
    if (this.disposed) return
    this.uniforms.uStateTexture.value = texture
  }

  /** 设置外观参数；越界值会被裁剪到契约范围。 */
  setVisual(visual: WaterVisualSettings): void {
    if (this.disposed) return
    this.visual = {
      shimmer: clamp(visual.shimmer, 0, 3),
      glint: clamp(visual.glint ?? VISUAL_DEFAULTS.glint, 0.3, 2.5),
      reflection: clamp(visual.reflection ?? VISUAL_DEFAULTS.reflection, 0, 1.5),
      ripple: clamp(visual.ripple, 0, 2),
      rippleScale: clamp(visual.rippleScale ?? VISUAL_DEFAULTS.rippleScale, 0.4, 2.5),
      flowSpeed: clamp(visual.flowSpeed ?? VISUAL_DEFAULTS.flowSpeed, 0, 2),
      foam: clamp(visual.foam ?? VISUAL_DEFAULTS.foam, 0, 2),
      clarity: clamp(visual.clarity, 0, 1),
      opacity: clamp(visual.opacity ?? VISUAL_DEFAULTS.opacity, 0, 1)
    }
    this.uniforms.uShimmer.value = this.visual.shimmer
    this.uniforms.uGlint.value = this.visual.glint
    this.uniforms.uReflection.value = this.visual.reflection
    this.uniforms.uRipple.value = this.visual.ripple
    this.uniforms.uRippleScale.value = this.visual.rippleScale
    this.uniforms.uFlowSpeed.value = this.visual.flowSpeed
    this.uniforms.uFoam.value = this.visual.foam
    this.uniforms.uClarity.value = this.visual.clarity
    this.uniforms.uOpacity.value = this.visual.opacity
  }

  /** 设置太阳方向：单位向量，分量顺序 [east, up, north]。 */
  setSunDirection(enu: THREE.Vector3): void {
    if (this.disposed) return
    const direction = enu.clone()
    if (direction.lengthSq() < 1e-8) direction.set(0, 1, 0)
    direction.normalize()
    this.applySunState(sunStateForDirection(direction))
  }

  /** 每帧调用：推进波纹动画与流速平流（不做任何 GPU 回读）。 */
  update(dtSeconds: number): void {
    if (this.disposed || !this.enabled) return
    const step =
      Number.isFinite(dtSeconds) && dtSeconds > 0
        ? Math.min(dtSeconds, MAX_STEP_SECONDS)
        : 0
    this.time += step
    this.uniforms.uTime.value = this.time
  }

  /** 从场景移除并释放 GPU 资源（可重复调用）。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.mesh.onBeforeRender = () => {}
    this.mesh.removeFromParent()
    this.geometry.dispose()
    this.material.dispose()
    disposeWaterDetailTextures(this.textures)
  }

  private applySunState(state: ReturnType<typeof sunStateForDirection>): void {
    // ENU → 局部坐标：局部 +X = 西 = -east，+Y = up，+Z = north。
    this.sunLocalUniform.set(-state.direction.x, state.direction.y, state.direction.z)
    this.sunColor.copy(state.sunGlintColor)
    this.skyZenith.copy(state.skyZenith)
    this.skyHorizon.copy(state.skyHorizon)
    this.deepColor.copy(state.waterDeep)
    this.shallowColor.copy(state.waterShallow)
    this.foamColor.copy(state.foamColor)
    this.uniforms.uGlintStrength.value = state.glintStrength
  }
}
