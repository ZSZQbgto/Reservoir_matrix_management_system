import * as THREE from 'three'
import type { Viewer } from 'tellux'
import type { SurfaceDomain, WaterSource } from './types'
import type { LocalProjection } from './terrainField'

const LABEL_TOLERANCE_PX = 22
const RING_SEGMENTS = 64
/** 标记线/圆环在屏幕上的目标宽度（CSS 像素）。 */
const RIBBON_PIXEL_WIDTH = 2.2

interface SourceVisual {
  source: WaterSource
  group: THREE.Group
  ball: THREE.Mesh
  ballMaterial: THREE.MeshBasicMaterial
  ring: RibbonLine
  label: HTMLDivElement
  ballWorld: THREE.Vector3
}

export interface SourceMarkerOptions {
  scene: THREE.Scene
  labelContainer: HTMLElement
}

/**
 * 贴地细带（替代 THREE.Line）。
 *
 * Tellux 的大气后处理管线对 `Line` 几何使用 NormalPass 光照时缺少法线，
 * 线条会被渲染成近黑色/不可见；这里用带法线的三角形条带模拟线条，
 * 并按屏幕像素宽度逐帧调整宽度，保证远近都清晰。
 */
class RibbonLine {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly positions: Float32Array
  private readonly normals: Float32Array
  private readonly indices: Uint32Array
  private readonly count: number
  private readonly closed: boolean
  private readonly material: THREE.MeshBasicMaterial
  private centerline: Float32Array
  private width = 2

  constructor(count: number, color: number, opacity: number, closed = true) {
    this.count = count
    this.closed = closed
    this.centerline = new Float32Array(count * 3)
    this.positions = new Float32Array(count * 6)
    this.normals = new Float32Array(count * 6)
    for (let i = 0; i < count; i++) {
      this.normals[i * 6 + 1] = 1
      this.normals[i * 6 + 4] = 1
    }
    const segmentCount = closed ? count : count - 1
    this.indices = new Uint32Array(segmentCount * 6)
    for (let i = 0; i < segmentCount; i++) {
      const next = (i + 1) % count
      const base = i * 2
      const nextBase = next * 2
      this.indices[i * 6] = base
      this.indices[i * 6 + 1] = base + 1
      this.indices[i * 6 + 2] = nextBase
      this.indices[i * 6 + 3] = base + 1
      this.indices[i * 6 + 4] = nextBase + 1
      this.indices[i * 6 + 5] = nextBase
    }
    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('normal', new THREE.BufferAttribute(this.normals, 3))
    this.geometry.setIndex(new THREE.BufferAttribute(this.indices, 1))
    this.material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: false
    })
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
  }

  setColor(color: number): void {
    this.material.color.setHex(color)
  }

  setOpacity(opacity: number): void {
    this.material.opacity = opacity
  }

  /** 设置中心线（闭合环或折线），点数组长度必须等于构造时的 count。 */
  setCenterline(points: ArrayLike<number>): void {
    this.centerline = new Float32Array(points)
    this.rebuild()
  }

  /** 设置线宽（局部坐标米）。 */
  setWidth(width: number): void {
    const next = Math.max(0.05, width)
    if (Math.abs(next - this.width) < 1e-4) return
    this.width = next
    this.rebuild()
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }

  private rebuild(): void {
    const count = this.count
    const half = this.width / 2
    for (let i = 0; i < count; i++) {
      const previous = this.closed ? (i - 1 + count) % count : Math.max(0, i - 1)
      const next = this.closed ? (i + 1) % count : Math.min(count - 1, i + 1)
      const x = this.centerline[i * 3]
      const y = this.centerline[i * 3 + 1]
      const z = this.centerline[i * 3 + 2]
      const dx = this.centerline[next * 3] - this.centerline[previous * 3]
      const dz = this.centerline[next * 3 + 2] - this.centerline[previous * 3 + 2]
      const length = Math.hypot(dx, dz) || 1
      const nx = -dz / length
      const nz = dx / length
      this.positions[i * 6] = x + nx * half
      this.positions[i * 6 + 1] = y
      this.positions[i * 6 + 2] = z + nz * half
      this.positions[i * 6 + 3] = x - nx * half
      this.positions[i * 6 + 4] = y
      this.positions[i * 6 + 5] = z - nz * half
    }
    const attribute = this.geometry.getAttribute('position') as THREE.BufferAttribute
    attribute.needsUpdate = true
    this.geometry.computeBoundingSphere()
  }
}

/**
 * 水源标记层：青色小球 + 贴地半径圆环 + DOM 名称标签。
 *
 * 标记只在「水体编辑」模式显示；小球与圆环按屏幕像素保持可见尺寸，
 * 圆环逐点采样地形高度贴地。
 */
export class SourceMarkers {
  private readonly viewer: Viewer
  private readonly scene: THREE.Scene
  private readonly labelContainer: HTMLElement
  private readonly group = new THREE.Group()
  private readonly visuals = new Map<string, SourceVisual>()
  private visible = true
  private selectedId: string | null = null
  private projection: LocalProjection | null = null
  private drapeToken = 0

  constructor(viewer: Viewer, options: SourceMarkerOptions) {
    this.viewer = viewer
    this.scene = options.scene
    this.labelContainer = options.labelContainer
    this.group.name = 'water-source-markers'
    this.scene.add(this.group)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.group.visible = visible
    this.labelContainer.hidden = !visible
  }

  get isVisible(): boolean {
    return this.visible
  }

  setSelected(selectedId: string | null): void {
    this.selectedId = selectedId
    for (const [id, visual] of this.visuals) this.applySelection(id, visual)
  }

  /** 全量重建标记（水源增删、域重建、从存储恢复时调用）。 */
  setSources(
    sources: WaterSource[],
    selectedId: string | null,
    projection: LocalProjection | null
  ): void {
    this.selectedId = selectedId
    this.projection = projection
    const alive = new Set(sources.map((source) => source.id))
    for (const [id, visual] of this.visuals) {
      if (alive.has(id)) continue
      this.disposeVisual(visual)
      this.visuals.delete(id)
    }
    for (const source of sources) {
      let visual = this.visuals.get(source.id)
      if (!visual) {
        visual = this.createVisual(source)
        this.visuals.set(source.id, visual)
      }
      visual.source = source
      this.placeVisual(visual)
      this.applySelection(source.id, visual)
    }
    this.drapeAllRings()
  }

  /** 拖动中的轻量更新：只移动小球/标签/圆环中心，不做地形重采样。 */
  updateSource(source: WaterSource): void {
    const visual = this.visuals.get(source.id)
    if (!visual) return
    visual.source = source
    this.placeVisual(visual)
  }

  /** 拖动结束后重新把圆环逐点贴合地形。 */
  settleSource(source: WaterSource): void {
    const visual = this.visuals.get(source.id)
    if (!visual) return
    this.drapeRing(visual, ++this.drapeToken).catch(() => {})
  }

  /** 每帧更新标签位置、小球屏幕尺寸与圆环像素宽度。 */
  updateFrame(camera: THREE.PerspectiveCamera, width: number, height: number): void {
    if (!this.visible || width <= 0 || height <= 0) return
    const cameraPosition = camera.position
    const focal = height / 2 / Math.tan(((camera.fov * Math.PI) / 180) / 2)
    for (const visual of this.visuals.values()) {
      const { source, ball, label } = visual
      const point = visual.ballWorld
      const distance = Math.max(1, cameraPosition.distanceTo(point))
      const worldRadius = Math.max(14, (7 * distance) / focal)
      ball.scale.setScalar(worldRadius / 18)
      // 圆环局部坐标即为米，屏幕像素宽换算成世界米。
      visual.ring.setWidth((RIBBON_PIXEL_WIDTH * distance) / focal)
      const screen = this.project(point, camera, width, height)
      if (!screen || !this.isVisiblePoint(point, cameraPosition)) {
        label.hidden = true
        continue
      }
      label.hidden = false
      label.style.left = `${Math.round(screen.x)}px`
      label.style.top = `${Math.round(screen.y)}px`
      label.dataset.selected = this.selectedId === source.id ? 'true' : 'false'
      label.textContent = source.name
    }
  }

  /** 屏幕空间命中测试，返回最近的水源 id。 */
  hitTest(
    clientX: number,
    clientY: number,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ): string | null {
    if (!this.visible) return null
    const cameraPosition = camera.position
    let best: string | null = null
    let bestDistance = LABEL_TOLERANCE_PX
    for (const [id, visual] of this.visuals) {
      if (!this.isVisiblePoint(visual.ballWorld, cameraPosition)) continue
      const screen = this.project(visual.ballWorld, camera, width, height)
      if (!screen) continue
      const distance = Math.hypot(screen.x - clientX, screen.y - clientY)
      if (distance < bestDistance) {
        best = id
        bestDistance = distance
      }
    }
    return best
  }

  /** 指定水源小球的屏幕位置（CSS 像素；不可见时返回 null）。 */
  screenPosition(
    id: string,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ): { x: number; y: number } | null {
    const visual = this.visuals.get(id)
    if (!visual || !this.visible) return null
    if (!this.isVisiblePoint(visual.ballWorld, camera.position)) return null
    return this.project(visual.ballWorld, camera, width, height)
  }

  dispose(): void {
    for (const visual of this.visuals.values()) this.disposeVisual(visual)
    this.visuals.clear()
    this.scene.remove(this.group)
    this.labelContainer.innerHTML = ''
  }

  private createVisual(source: WaterSource): SourceVisual {
    const group = new THREE.Group()
    group.name = `water-source-${source.id}`
    const ballMaterial = new THREE.MeshBasicMaterial({
      color: 0x7fe3ff,
      transparent: true,
      opacity: 0.95
    })
    const ball = new THREE.Mesh(new THREE.SphereGeometry(18, 20, 14), ballMaterial)
    ball.renderOrder = 6
    group.add(ball)

    const ring = new RibbonLine(RING_SEGMENTS, 0x7fe3ff, 0.85, true)
    ring.mesh.renderOrder = 5
    group.add(ring.mesh)

    const label = document.createElement('div')
    label.className = 'water-source-label'
    label.dataset.selected = 'false'
    this.labelContainer.appendChild(label)

    this.group.add(group)
    return {
      source,
      group,
      ball,
      ballMaterial,
      ring,
      label,
      ballWorld: new THREE.Vector3()
    }
  }

  private placeVisual(visual: SourceVisual): void {
    const { source } = visual
    const height = source.groundLevel ?? 0
    const matrix = this.viewer.cartographicToMatrix4(
      { longitude: source.longitude, latitude: source.latitude, height },
      { heading: 0, pitch: 0, roll: 0 },
      new THREE.Matrix4()
    )
    visual.group.matrixAutoUpdate = false
    visual.group.matrix.copy(matrix)
    visual.group.matrixWorldNeedsUpdate = true

    visual.ball.position.set(0, 34, 0)
    const up = new THREE.Vector3(0, 1, 0).transformDirection(matrix)
    visual.ballWorld.setFromMatrixPosition(matrix).addScaledVector(up, 34)

    this.setFlatRing(visual)
  }

  /** 未采样地形时的圆环兜底：局部平面圆环（y 抬 2.2 m）。 */
  private setFlatRing(visual: SourceVisual): void {
    const { source, ring } = visual
    const points = new Float32Array(RING_SEGMENTS * 3)
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2
      points[i * 3] = Math.cos(angle) * source.radius
      points[i * 3 + 1] = 2.2
      points[i * 3 + 2] = Math.sin(angle) * source.radius
    }
    ring.setCenterline(points)
  }

  private applySelection(id: string, visual: SourceVisual): void {
    const selected = id === this.selectedId
    visual.ballMaterial.color.setHex(selected ? 0xffffff : 0x7fe3ff)
    visual.ring.setColor(selected ? 0xffcf9a : 0x7fe3ff)
    visual.ring.setOpacity(selected ? 1 : 0.75)
  }

  private drapeAllRings(): void {
    const token = ++this.drapeToken
    for (const visual of this.visuals.values()) {
      this.drapeRing(visual, token).catch(() => {})
    }
  }

  private async drapeRing(visual: SourceVisual, token: number): Promise<void> {
    const { source } = visual
    const projection = this.projection
    if (!projection || !Number.isFinite(source.radius) || source.radius <= 0) return
    const points: Array<{ longitude: number; latitude: number }> = []
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2
      const east = Math.cos(angle) * source.radius
      const north = Math.sin(angle) * source.radius
      points.push({
        longitude: source.longitude + east / projection.mPerDegLon,
        latitude: source.latitude + north / projection.mPerDegLat
      })
    }
    let heights: (number | undefined)[]
    try {
      heights = this.viewer.sampleHeight(points)
    } catch {
      return
    }
    if (token !== this.drapeToken) return
    const firstHit = heights.find((height) => typeof height === 'number')
    const groundLevel = source.groundLevel ?? firstHit
    if (typeof groundLevel !== 'number' || !Number.isFinite(groundLevel)) return
    const centerline = new Float32Array(RING_SEGMENTS * 3)
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2
      centerline[i * 3] = Math.cos(angle) * source.radius
      centerline[i * 3 + 1] = (heights[i] ?? groundLevel) - groundLevel + 2.2
      centerline[i * 3 + 2] = Math.sin(angle) * source.radius
    }
    visual.ring.setCenterline(centerline)
  }

  private project(
    point: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
    width: number,
    height: number
  ): { x: number; y: number } | null {
    const projected = point.clone().project(camera)
    if (projected.z < -1 || projected.z > 1) return null
    return {
      x: ((projected.x + 1) / 2) * width,
      y: ((1 - projected.y) / 2) * height
    }
  }

  private isVisiblePoint(point: THREE.Vector3, cameraPosition: THREE.Vector3): boolean {
    // 球面切点判据：点 P 可见 ⇔ dot(P, C) > |P|²。
    return point.dot(cameraPosition) > point.lengthSq() * 0.99999
  }

  private disposeVisual(visual: SourceVisual): void {
    this.group.remove(visual.group)
    visual.ball.geometry.dispose()
    visual.ballMaterial.dispose()
    visual.ring.dispose()
    visual.label.remove()
  }
}

/**
 * 模拟域边界：贴着地形起伏的浅青色方框，只在水体编辑模式显示。
 *
 * 与水源圆环一样使用带法线的贴地细带，避免 LineBasicMaterial 在 Tellux
 * 后处理管线里变黑的问题。
 */
export class DomainBoundary {
  private readonly viewer: Viewer
  private readonly scene: THREE.Scene
  private readonly ribbon: RibbonLine
  private readonly perEdge = 64
  private readonly centerline = new Float32Array(this.perEdge * 4 * 3)
  /** 复用向量，避免每帧分配。 */
  private readonly worldCenter = new THREE.Vector3()
  private visible = false
  private token = 0

  constructor(viewer: Viewer, scene: THREE.Scene) {
    this.viewer = viewer
    this.scene = scene
    this.ribbon = new RibbonLine(this.perEdge * 4, 0x7fe3ff, 0.4, true)
    this.ribbon.mesh.name = 'water-domain-boundary'
    this.ribbon.mesh.visible = false
    this.ribbon.mesh.renderOrder = 4
    scene.add(this.ribbon.mesh)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.ribbon.mesh.visible = visible
  }

  /** 每帧按相机距离更新屏幕像素宽度。 */
  update(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    if (!this.visible || viewportHeight <= 0) return
    const distance = camera.position.distanceTo(
      this.ribbon.mesh.getWorldPosition(this.worldCenter)
    )
    const focal = viewportHeight / 2 / Math.tan(((camera.fov * Math.PI) / 180) / 2)
    this.ribbon.setWidth((RIBBON_PIXEL_WIDTH * distance) / focal)
  }

  async setDomain(domain: SurfaceDomain, projection: LocalProjection): Promise<void> {
    const token = ++this.token
    const half = domain.sizeMeters / 2
    const perEdge = this.perEdge
    const total = perEdge * 4
    const points: Array<{ longitude: number; latitude: number }> = []
    for (let edge = 0; edge < 4; edge++) {
      for (let i = 0; i < perEdge; i++) {
        const t = i / perEdge
        let x = 0
        let z = 0
        if (edge === 0) {
          x = -half + t * domain.sizeMeters
          z = -half
        } else if (edge === 1) {
          x = half
          z = -half + t * domain.sizeMeters
        } else if (edge === 2) {
          x = half - t * domain.sizeMeters
          z = half
        } else {
          x = -half
          z = half - t * domain.sizeMeters
        }
        points.push(projection.toLonLat(x, z))
      }
    }
    let heights: (number | undefined)[]
    try {
      heights = this.viewer.sampleHeight(points)
    } catch {
      heights = points.map(() => undefined)
    }
    if (token !== this.token) return

    const matrix = this.viewer.cartographicToMatrix4(
      {
        longitude: domain.origin.longitude,
        latitude: domain.origin.latitude,
        height: domain.baseElevation
      },
      { heading: 0, pitch: 0, roll: 0 },
      new THREE.Matrix4()
    )
    this.ribbon.mesh.matrixAutoUpdate = false
    this.ribbon.mesh.matrix.copy(matrix)
    this.ribbon.mesh.matrixWorldNeedsUpdate = true

    for (let i = 0; i < total; i++) {
      const local = points[i]
      const dx = (local.longitude - domain.origin.longitude) * projection.mPerDegLon
      const dz = (local.latitude - domain.origin.latitude) * projection.mPerDegLat
      const height = heights[i]
      this.centerline[i * 3] = -dx
      this.centerline[i * 3 + 1] = (height ?? domain.baseElevation) - domain.baseElevation + 2
      this.centerline[i * 3 + 2] = dz
    }
    this.ribbon.setCenterline(this.centerline)
  }

  dispose(): void {
    this.scene.remove(this.ribbon.mesh)
    this.ribbon.dispose()
  }
}
