/**
 * 面板控件绑定：把表单 / 按钮事件翻译成宿主命令。
 *
 * 这里只做「事件 → 命令 + 少量 DOM 文本刷新」，不持有编辑状态；
 * 状态写入与副作用（模拟、标记、保存）由 `ControlsHost` 负责。
 */
import { clamp } from '../shared/math'
import type { WaterEditorDom } from './waterEditorDom'
import type { WaterPanelView } from './waterPanelView'
import type { WaterState, WaterSource } from './types'
import {
  SIM_RESOLUTION_OPTIONS,
  VISUAL_DEFAULTS,
  SOURCE_RADIUS_PANEL_RANGE,
  MAX_WATER_SOURCES
} from './types'

/** 选中水源被修改的部位：决定宿主需要刷新哪些视图。 */
export type SourceChange = 'name' | 'radius' | 'target' | 'enabled'

export interface ControlsHost {
  readonly dom: WaterEditorDom
  readonly panel: WaterPanelView
  /** 可写状态：绑定层负责改字段，副作用统一走下面的命令。 */
  getState(): WaterState
  getSelectedSource(): WaterSource | null
  applySimState(): void
  applyVisual(): void
  resetSimulation(): void
  rebuildSimulation(): void
  refreshSelectedSource(change: SourceChange): void
  selectSource(id: string | null): void
  deleteSelectedSource(): void
  togglePlacing(): void
  clearSources(): void
  rebuildDomain(): void
  markModeTouched(): void
  enterMode(mode: 'scene' | 'water'): void
  saveNow(manual: boolean): void
  exportProject(): void
  importProject(file: File): void
  scheduleSave(): void
  toast(message: string, duration?: number): void
}

export class WaterControlsBinder {
  constructor(private readonly host: ControlsHost) {}

  attach(): void {
    this.bindModeControls()
    this.bindSimulationControls()
    this.bindSourceControls()
    this.bindAppearanceControls()
    this.bindProjectControls()
  }

  /** 模式切换与模拟域生命周期按钮。 */
  private bindModeControls(): void {
    const { host } = this
    const { dom } = host
    dom.modeScene.addEventListener('click', () => {
      host.markModeTouched()
      host.enterMode('scene')
    })
    dom.modeWater.addEventListener('click', () => {
      host.markModeTouched()
      host.enterMode('water')
    })
    dom.addButton.addEventListener('click', () => host.togglePlacing())
    dom.clearButton.addEventListener('click', () => host.clearSources())
    dom.rebuildButton.addEventListener('click', () => host.rebuildDomain())
  }

  /** 模拟参数：速度、注水量、精度、暂停、重置与水体总开关。 */
  private bindSimulationControls(): void {
    const { host } = this
    const { dom } = host
    const state = () => host.getState()

    dom.speedInput.addEventListener('input', () => {
      state().sim.speed = clamp(Number(dom.speedInput.value), 0.1, 64)
      dom.speedValue.textContent = `${state().sim.speed.toFixed(1)}×`
      host.applySimState()
      host.scheduleSave()
    })

    dom.amountInput.addEventListener('input', () => {
      state().sim.waterAmount = clamp(Number(dom.amountInput.value), 1, 300)
      dom.amountValue.textContent = `${Math.round(state().sim.waterAmount)} m`
      host.applySimState()
      host.scheduleSave()
    })

    dom.resolutionInput.addEventListener('input', () => {
      const index = Math.round(
        clamp(Number(dom.resolutionInput.value), 0, SIM_RESOLUTION_OPTIONS.length - 1)
      )
      const resolution = SIM_RESOLUTION_OPTIONS[index] ?? 256
      if (resolution === state().sim.resolution) return
      state().sim.resolution = resolution
      dom.resolutionValue.textContent = `${resolution}²`
      host.rebuildSimulation()
      host.scheduleSave()
    })

    dom.maxFlowSpeedInput.addEventListener('input', () => {
      state().sim.maxFlowSpeed = clamp(Number(dom.maxFlowSpeedInput.value), 5, 60)
      dom.maxFlowSpeedValue.textContent = `${Math.round(state().sim.maxFlowSpeed)} m/s`
      host.applySimState()
      host.scheduleSave()
    })

    dom.dampingInput.addEventListener('input', () => {
      state().sim.damping = clamp(Number(dom.dampingInput.value), 0.9, 1)
      dom.dampingValue.textContent = state().sim.damping.toFixed(3)
      host.applySimState()
      host.scheduleSave()
    })

    dom.injectIntervalInput.addEventListener('input', () => {
      state().sim.injectInterval = Math.round(clamp(Number(dom.injectIntervalInput.value), 1, 8))
      dom.injectIntervalValue.textContent = `${(state().sim.injectInterval / 60).toFixed(3)} s`
      host.applySimState()
      host.scheduleSave()
    })

    dom.pauseButton.addEventListener('click', () => {
      state().sim.paused = !state().sim.paused
      host.panel.syncSimControls()
      host.applySimState()
      host.panel.syncStatus()
      host.panel.syncPill()
      host.scheduleSave()
    })

    dom.resetButton.addEventListener('click', () => host.resetSimulation())

    dom.waterToggle.addEventListener('change', () => {
      state().enabled = dom.waterToggle.checked
      host.applySimState()
      host.panel.syncPill()
      host.panel.syncStatus()
      host.scheduleSave()
      host.toast(state().enabled ? '水体已开启' : '水体已关闭', 2000)
    })
  }

  /** 水源列表（选择 / 启用 / 删除）与选中水源的编辑控件。 */
  private bindSourceControls(): void {
    const { host } = this
    const { dom } = host

    dom.sourceList.addEventListener('click', (event: MouseEvent) => {
      const target = event.target as HTMLElement
      const item = target.closest<HTMLElement>('.water-source-item')
      if (!item?.dataset.id) return
      const action = target.closest<HTMLElement>('[data-action]')?.dataset.action
      if (action === 'delete') {
        host.deleteSelectedSource()
        return
      }
      host.selectSource(item.dataset.id)
    })

    dom.sourceList.addEventListener('change', (event: Event) => {
      const target = event.target as HTMLInputElement
      if (target.dataset.action !== 'toggle') return
      const item = target.closest<HTMLElement>('.water-source-item')
      if (!item?.dataset.id) return
      const source = host.getState().sources.find((entry) => entry.id === item.dataset.id)
      if (!source) return
      source.enabled = target.checked
      host.refreshSelectedSource('enabled')
    })

    dom.sourceList.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target as HTMLElement
      const item = target.closest<HTMLElement>('.water-source-item')
      if (!item?.dataset.id) return
      event.preventDefault()
      host.selectSource(item.dataset.id)
    })

    dom.sourceName.addEventListener('input', () => {
      const source = host.getSelectedSource()
      if (!source) return
      source.name = dom.sourceName.value.trim().slice(0, 40) || '水源'
      host.refreshSelectedSource('name')
    })

    dom.sourceRadius.addEventListener('input', () => {
      const source = host.getSelectedSource()
      if (!source) return
      source.radius = clamp(
        Number(dom.sourceRadius.value),
        SOURCE_RADIUS_PANEL_RANGE.min,
        SOURCE_RADIUS_PANEL_RANGE.max
      )
      dom.sourceRadiusValue.textContent = `${Math.round(source.radius)} m`
      host.refreshSelectedSource('radius')
    })

    dom.sourceTarget.addEventListener('change', () => {
      const source = host.getSelectedSource()
      if (!source) return
      const raw = dom.sourceTarget.value.trim()
      const value = raw === '' ? Number.NaN : Number(raw)
      source.targetLevel = Number.isFinite(value) ? clamp(value, -1000, 20000) : null
      host.refreshSelectedSource('target')
    })

    dom.sourceEnabled.addEventListener('change', () => {
      const source = host.getSelectedSource()
      if (!source) return
      source.enabled = dom.sourceEnabled.checked
      host.refreshSelectedSource('enabled')
    })

    dom.sourceDelete.addEventListener('click', () => host.deleteSelectedSource())
  }

  /** 外观滑杆：绑定来自同一张 `visualControls` 表，取值同步走 `syncAppearance`。 */
  private bindAppearanceControls(): void {
    const { host } = this
    const { dom } = host
    for (const control of dom.visualControls) {
      control.input.addEventListener('input', () => {
        const value = clamp(Number(control.input.value), control.min, control.max)
        host.getState().visual[control.key] = value
        control.output.textContent = value.toFixed(2)
        host.applyVisual()
        host.scheduleSave()
      })
    }

    dom.appearanceReset.addEventListener('click', () => {
      host.getState().visual = { ...VISUAL_DEFAULTS }
      host.panel.syncAppearance()
      host.applyVisual()
      host.scheduleSave()
      host.toast('水面外观已恢复默认', 2200)
    })
  }

  /** 工程保存 / 导出 / 导入。 */
  private bindProjectControls(): void {
    const { host } = this
    const { dom } = host
    dom.saveButton.addEventListener('click', () => host.saveNow(true))

    dom.exportButton.addEventListener('click', () => host.exportProject())

    dom.importButton.addEventListener('click', () => dom.importInput.click())
    dom.importInput.addEventListener('change', () => {
      const file = dom.importInput.files?.[0]
      if (!file) return
      host.importProject(file)
      dom.importInput.value = ''
    })
  }
}

// 供面板/调试提示复用：水源上限文案只在这里拼一次。
export const MAX_SOURCE_TOAST = `最多 ${MAX_WATER_SOURCES} 个水源`
