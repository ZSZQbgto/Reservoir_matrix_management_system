/**
 * 水源指针交互：拖动 / 单击选中 / 放置 / Esc 取消。
 *
 * 只负责「指针事件 → 宿主命令」的转换，不持有编辑状态：
 * 选中、放置、贴地、保存都由 `PointerHost` 实现，编辑器把自身适配进来即可。
 */
import type { Viewer } from 'tellux'
import type { SourceMarkers } from './markers'
import type { LocalProjection } from './terrainField'
import type { WaterSource } from './types'
import type { EditorMode } from './persistence'

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

/** 指针控制器的宿主：编辑器提供这些命令与只读数据。 */
export interface PointerHost {
  readonly viewer: Viewer
  readonly canvas: HTMLCanvasElement
  readonly markers: SourceMarkers
  getMode(): EditorMode
  getProjection(): LocalProjection | null
  getSources(): WaterSource[]
  isBuilding(): boolean
  isPlacing(): boolean
  hasSelection(): boolean
  selectSource(id: string | null): void
  placeSource(longitude: number, latitude: number, height?: number): void
  groundLevelAt(longitude: number, latitude: number, preferred?: number | null): number | null
  /** 拖动结束：贴合地形、刷新面板并保存。 */
  commitDraggedSource(source: WaterSource): void
  /** 拖动过程中：只移动标记与读数，不做地形重采样。 */
  previewDraggedSource(source: WaterSource): void
  exitPlacing(): void
  toast(message: string, duration?: number): void
}

export class WaterPointerController {
  private drag: DragState | null = null
  private clickCandidate: ClickCandidate | null = null

  constructor(private readonly host: PointerHost) {}

  attach(): void {
    // 捕获阶段先手：按住小球时截断相机手势，避免拖动水源变成平移地球。
    this.host.canvas.addEventListener('pointerdown', this.handlePointerDown, true)
    document.addEventListener('pointermove', this.handlePointerMove)
    document.addEventListener('pointerup', this.handlePointerUp)
    document.addEventListener('pointercancel', this.handlePointerCancel)
    window.addEventListener('blur', this.handleWindowBlur)
    window.addEventListener('keydown', this.handleKeyDown)
  }

  detach(): void {
    this.host.canvas.removeEventListener('pointerdown', this.handlePointerDown, true)
    document.removeEventListener('pointermove', this.handlePointerMove)
    document.removeEventListener('pointerup', this.handlePointerUp)
    document.removeEventListener('pointercancel', this.handlePointerCancel)
    window.removeEventListener('blur', this.handleWindowBlur)
    window.removeEventListener('keydown', this.handleKeyDown)
    this.endDrag()
    this.clickCandidate = null
  }

  /** 结束拖动：恢复相机手势与光标（取消 / 指针丢失时也走这里）。 */
  private endDrag(): void {
    if (!this.drag) return
    this.drag = null
    this.host.viewer.controls.enabled = true
    this.host.canvas.style.cursor = this.host.isPlacing() ? 'crosshair' : ''
  }

  private handleWindowBlur = (): void => {
    this.endDrag()
    this.clickCandidate = null
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (this.host.getMode() !== 'water' || event.button !== 0 || this.host.isBuilding()) return
    const rect = this.host.canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const hit = this.host.markers.hitTest(
      x,
      y,
      this.host.viewer.camera.raw,
      rect.width,
      rect.height
    )
    if (hit) {
      event.stopPropagation()
      event.preventDefault()
      this.drag = {
        id: hit,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY
      }
      this.host.viewer.controls.enabled = false
      this.host.selectSource(hit)
      this.host.canvas.style.cursor = 'grabbing'
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
      const draggedId = this.drag.id
      const source = this.host.getSources().find((item) => item.id === draggedId)
      if (source) this.host.commitDraggedSource(source)
      this.endDrag()
      return
    }
    if (this.clickCandidate && event.pointerId === this.clickCandidate.pointerId) {
      const candidate = this.clickCandidate
      this.clickCandidate = null
      if (candidate.moved) return
      const rect = this.host.canvas.getBoundingClientRect()
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
      Math.hypot(event.clientX - candidate.startClientX, event.clientY - candidate.startClientY) > 5
    )
  }

  private handleCanvasClick(x: number, y: number, width: number, height: number): void {
    if (this.host.getMode() !== 'water' || this.host.isBuilding()) return
    const hit = this.host.markers.hitTest(x, y, this.host.viewer.camera.raw, width, height)
    if (hit) {
      this.host.selectSource(hit)
      return
    }
    if (!this.host.isPlacing()) {
      this.host.selectSource(null)
      return
    }
    const pick = this.host.viewer.pickCartographic({ x, y })
    if (!pick) {
      this.host.toast('未命中地形，请对准地表单击', 2400)
      return
    }
    this.host.placeSource(pick.longitude, pick.latitude, pick.height)
  }

  private moveSourceToPointer(id: string, clientX: number, clientY: number): void {
    const source = this.host.getSources().find((item) => item.id === id)
    const projection = this.host.getProjection()
    if (!source || !projection) return
    const rect = this.host.canvas.getBoundingClientRect()
    const pick = this.host.viewer.pickCartographic({
      x: clientX - rect.left,
      y: clientY - rect.top
    })
    if (!pick) return
    const local = projection.toLocal(pick.longitude, pick.latitude)
    if (!projection.contains(local.x, local.z, -Math.min(source.radius, 500))) return
    source.longitude = pick.longitude
    source.latitude = pick.latitude
    source.groundLevel = this.host.groundLevelAt(pick.longitude, pick.latitude) ?? pick.height
    this.host.previewDraggedSource(source)
  }

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    if (this.host.isPlacing()) {
      this.host.exitPlacing()
      event.preventDefault()
      return
    }
    if (this.host.getMode() === 'water' && this.host.hasSelection()) {
      this.host.selectSource(null)
      event.preventDefault()
    }
  }
}
