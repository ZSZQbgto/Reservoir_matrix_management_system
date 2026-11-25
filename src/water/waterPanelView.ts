/**
 * 水体编辑器的面板视图：状态 → DOM 的单向同步。
 *
 * 这里只读状态、只写界面，不发请求、不改状态、不触发保存；
 * 数据从哪里来由宿主（`WaterPanelHost`）提供，`WaterEditor` 负责编排。
 */
import type { WaterEditorDom } from './waterEditorDom'
import { escapeHtml, syncRangeFill } from '../shared/dom'
import { formatElevation, formatLonLat } from '../shared/format'
import {
  SIM_RESOLUTION_OPTIONS,
  WATER_DOMAIN,
  type SimStats,
  type TerrainField,
  type WaterSource,
  type WaterState
} from './types'

/** 面板视图需要的只读数据源。 */
export interface WaterPanelHost {
  /** 只读视图：面板只读状态（写入走编辑器的命令方法）。 */
  getState(): Readonly<WaterState>
  getSelectedId(): string | null
  getSelectedSource(): WaterSource | null
  getField(): TerrainField | null
  isBuilding(): boolean
  isPlacing(): boolean
  isDomainReady(): boolean
  getStats(): SimStats
}

export class WaterPanelView {
  constructor(
    private readonly dom: WaterEditorDom,
    private readonly host: WaterPanelHost
  ) {}

  /** 刷新全部面板（模式切换等由编辑器自己处理）。 */
  syncAll(): void {
    this.syncBusy()
    this.syncSourceList()
    this.syncSourceEditor()
    this.syncSimControls()
    this.syncAppearance()
    this.syncDomainMeta()
    this.syncStatus()
    this.syncPill()
  }

  /** 构建模拟域期间禁用会打断流程的按钮；没有水源时「清空」也不可用。 */
  syncBusy(): void {
    const busy = this.host.isBuilding()
    this.dom.addButton.disabled = busy
    this.dom.clearButton.disabled = busy || this.host.getState().sources.length === 0
    this.dom.rebuildButton.disabled = busy
    this.dom.pauseButton.disabled = busy
    this.dom.resetButton.disabled = busy
  }

  syncSourceList(): void {
    this.syncBusy()
    const sources = this.host.getState().sources
    if (sources.length === 0) {
      this.dom.sourceList.innerHTML = '<p class="empty-hint">暂无水源</p>'
      return
    }
    const selectedId = this.host.getSelectedId()
    this.dom.sourceList.innerHTML = sources
      .map((source, index) => {
        const selected = source.id === selectedId ? 'true' : 'false'
        return `
          <div class="water-source-item" data-id="${escapeHtml(source.id)}" data-selected="${selected}" role="listitem" tabindex="0">
            <span class="water-source-index">${index + 1}</span>
            <div class="water-source-copy">
              <b>${escapeHtml(source.name)}</b>
              <small>
                <span>高程 ${formatElevation(source.groundLevel)}</span>
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

  /** 没有选中项时隐藏编辑区。 */
  syncSourceEditor(): void {
    const source = this.host.getSelectedSource()
    this.dom.sourceEditor.hidden = !source
    if (!source) return
    this.dom.sourceName.value = source.name
    this.dom.sourceGround.textContent = formatElevation(source.groundLevel)
    this.dom.sourceRadius.value = String(Math.round(source.radius))
    this.dom.sourceRadiusValue.textContent = `${Math.round(source.radius)} m`
    syncRangeFill(this.dom.sourceRadius)
    this.dom.sourceTarget.value =
      source.targetLevel == null ? '' : String(Number(source.targetLevel.toFixed(2)))
    this.dom.sourceTarget.placeholder =
      source.groundLevel == null ? '不限制' : `不限制（地面 ${source.groundLevel.toFixed(1)} m）`
    this.dom.sourceEnabled.checked = source.enabled
  }

  syncSimControls(): void {
    const sim = this.host.getState().sim
    this.dom.speedInput.value = String(sim.speed)
    this.dom.speedValue.textContent = `${sim.speed.toFixed(1)}×`
    syncRangeFill(this.dom.speedInput)
    this.dom.amountInput.value = String(Math.round(sim.waterAmount))
    this.dom.amountValue.textContent = `${Math.round(sim.waterAmount)} m`
    syncRangeFill(this.dom.amountInput)
    const index = Math.max(0, (SIM_RESOLUTION_OPTIONS as readonly number[]).indexOf(sim.resolution))
    this.dom.resolutionInput.value = String(index)
    this.dom.resolutionValue.textContent = `${sim.resolution}²`
    syncRangeFill(this.dom.resolutionInput)
    this.dom.maxFlowSpeedInput.value = String(sim.maxFlowSpeed)
    this.dom.maxFlowSpeedValue.textContent = `${Math.round(sim.maxFlowSpeed)} m/s`
    syncRangeFill(this.dom.maxFlowSpeedInput)
    this.dom.dampingInput.value = String(sim.damping)
    this.dom.dampingValue.textContent = sim.damping.toFixed(3)
    syncRangeFill(this.dom.dampingInput)
    this.dom.injectIntervalInput.value = String(sim.injectInterval)
    this.dom.injectIntervalValue.textContent = `${(sim.injectInterval / 60).toFixed(3)} s`
    syncRangeFill(this.dom.injectIntervalInput)
    this.dom.pauseButton.textContent = sim.paused ? '继续' : '暂停'
  }

  syncAppearance(): void {
    const visual = this.host.getState().visual
    for (const control of this.dom.visualControls) {
      const value = visual[control.key]
      control.input.value = String(value)
      control.output.textContent = value.toFixed(2)
      syncRangeFill(control.input)
    }
  }

  syncDomainMeta(): void {
    const field = this.host.getField()
    const terrainInfo = field ? `地形 ${field.resolution}²` : '地形采样中'
    const center = formatLonLat(WATER_DOMAIN.longitude, WATER_DOMAIN.latitude)
    if (!this.host.getState().domain) {
      this.dom.domainMeta.textContent = `${center}\n尚未建立`
      return
    }
    this.dom.domainMeta.textContent = `${center}\n${terrainInfo} · 模拟 ${this.host.getState().sim.resolution}²`
  }

  syncStatus(): void {
    if (this.host.isBuilding()) {
      this.dom.statusLine.textContent = this.dom.progressLabel.textContent || '正在构建模拟域…'
      return
    }
    if (!this.host.isDomainReady()) {
      this.dom.statusLine.textContent = '模拟域尚未建立'
      return
    }
    const stats = this.host.getStats()
    const paused = this.host.getState().sim.paused ? ' · 已暂停' : ''
    this.dom.statusLine.textContent = `步数 ${stats.steps} · 湿格 ${stats.wetCells} · 最深 ${stats.maxDepth.toFixed(2)} m${paused}`
  }

  /** 顶部「水体」胶囊：构建 / 关闭 / 放置 / 未构建 / 运行状态。 */
  syncPill(): void {
    const state = this.host.getState()
    const span = this.dom.waterPill.querySelector('span')
    const setState = (tone: 'ok' | 'warn', label: string): void => {
      this.dom.waterPill.dataset.tone = tone
      if (span) span.textContent = label
    }
    if (this.host.isBuilding()) {
      setState('warn', '构建中')
      return
    }
    if (!state.enabled) {
      setState('warn', '已关闭')
      return
    }
    if (this.host.isPlacing()) {
      setState('warn', '放置中')
      return
    }
    if (!this.host.isDomainReady()) {
      setState('warn', state.sources.length > 0 ? '未构建' : '未启用')
      return
    }
    setState('ok', state.sim.paused ? '已暂停' : `运行中 · ${state.sources.length} 源`)
  }

  setProjectStatus(text: string): void {
    this.dom.projectStatus.textContent = text
  }
}
