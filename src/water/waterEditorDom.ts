/**
 * 水体编辑器的 DOM 元素定义。
 *
 * 元素在 `index.html` 静态声明，此处集中查询；`WaterEditor` 只通过 `dom` 访问界面。
 * 查询失败会立刻抛错（`requireElement`），避免运行到一半才空引用。
 */
import { requireElement as $ } from '../shared/dom'
import { domId } from '../shared/domIds'
import type { WaterVisualSettings } from './types'

/** 外观滑杆对应的数值字段。 */
export type NumericVisualKey = keyof WaterVisualSettings

/** 一条外观滑杆：状态键、控件与取值范围。 */
export interface VisualControl {
  key: NumericVisualKey
  input: HTMLInputElement
  output: HTMLOutputElement
  min: number
  max: number
}

export interface WaterEditorDom {
  readonly body: HTMLElement
  /** 模式按钮 */
  readonly modeScene: HTMLElement
  readonly modeWater: HTMLElement
  /** 面板容器 */
  readonly consoleElement: HTMLElement
  readonly waterLeft: HTMLElement
  readonly waterRight: HTMLElement
  readonly waterLabels: HTMLElement
  /** 顶栏状态与开关 */
  readonly waterToggle: HTMLInputElement
  readonly waterPill: HTMLElement
  /** 水源列表与建域进度 */
  readonly addButton: HTMLButtonElement
  readonly clearButton: HTMLButtonElement
  readonly progress: HTMLElement
  readonly progressBar: HTMLElement
  readonly progressLabel: HTMLElement
  readonly sourceList: HTMLElement
  readonly domainMeta: HTMLElement
  readonly rebuildButton: HTMLButtonElement
  /** 模拟参数 */
  readonly speedInput: HTMLInputElement
  readonly speedValue: HTMLOutputElement
  readonly amountInput: HTMLInputElement
  readonly amountValue: HTMLOutputElement
  readonly resolutionInput: HTMLInputElement
  readonly resolutionValue: HTMLOutputElement
  readonly maxFlowSpeedInput: HTMLInputElement
  readonly maxFlowSpeedValue: HTMLOutputElement
  readonly dampingInput: HTMLInputElement
  readonly dampingValue: HTMLOutputElement
  readonly injectIntervalInput: HTMLInputElement
  readonly injectIntervalValue: HTMLOutputElement
  readonly pauseButton: HTMLButtonElement
  readonly resetButton: HTMLButtonElement
  readonly statusLine: HTMLElement
  /** 选中水源编辑区 */
  readonly sourceEditor: HTMLElement
  readonly sourceName: HTMLInputElement
  readonly sourceGround: HTMLOutputElement
  readonly sourceRadius: HTMLInputElement
  readonly sourceRadiusValue: HTMLOutputElement
  readonly sourceTarget: HTMLInputElement
  readonly sourceEnabled: HTMLInputElement
  readonly sourceDelete: HTMLButtonElement
  /** 外观滑杆 */
  readonly shimmerInput: HTMLInputElement
  readonly shimmerValue: HTMLOutputElement
  readonly glintInput: HTMLInputElement
  readonly glintValue: HTMLOutputElement
  readonly reflectionInput: HTMLInputElement
  readonly reflectionValue: HTMLOutputElement
  readonly rippleInput: HTMLInputElement
  readonly rippleValue: HTMLOutputElement
  readonly rippleScaleInput: HTMLInputElement
  readonly rippleScaleValue: HTMLOutputElement
  readonly flowSpeedInput: HTMLInputElement
  readonly flowSpeedValue: HTMLOutputElement
  readonly foamInput: HTMLInputElement
  readonly foamValue: HTMLOutputElement
  readonly appearanceReset: HTMLButtonElement
  readonly clarityInput: HTMLInputElement
  readonly clarityValue: HTMLOutputElement
  readonly opacityInput: HTMLInputElement
  readonly opacityValue: HTMLOutputElement
  /** 工程 */
  readonly saveButton: HTMLButtonElement
  readonly exportButton: HTMLButtonElement
  readonly importButton: HTMLButtonElement
  readonly importInput: HTMLInputElement
  readonly projectStatus: HTMLElement
  /** 外观滑杆与状态字段的对应表：同步与绑定共用，避免两处各列一遍。 */
  readonly visualControls: VisualControl[]
}

/** 查询并校验编辑器需要的全部元素。 */
export function queryWaterEditorDom(): WaterEditorDom {
  const dom: WaterEditorDom = {
    body: document.body,
    modeScene: $(domId('mode-scene')),
    modeWater: $(domId('mode-water')),
    consoleElement: $(domId('console')),
    waterLeft: $(domId('water-left')),
    waterRight: $(domId('water-right')),
    waterLabels: $(domId('water-labels')),
    waterToggle: $<HTMLInputElement>(domId('water-toggle')),
    waterPill: $(domId('water-status-pill')),
    addButton: $<HTMLButtonElement>(domId('water-add-source')),
    clearButton: $<HTMLButtonElement>(domId('water-clear-sources')),
    progress: $(domId('water-progress')),
    progressBar: $(domId('water-progress-bar')),
    progressLabel: $(domId('water-progress-label')),
    sourceList: $(domId('water-source-list')),
    domainMeta: $(domId('water-domain-meta')),
    rebuildButton: $<HTMLButtonElement>(domId('water-rebuild-domain')),
    speedInput: $<HTMLInputElement>(domId('water-speed')),
    speedValue: $<HTMLOutputElement>(domId('water-speed-value')),
    amountInput: $<HTMLInputElement>(domId('water-amount')),
    amountValue: $<HTMLOutputElement>(domId('water-amount-value')),
    resolutionInput: $<HTMLInputElement>(domId('water-resolution')),
    resolutionValue: $<HTMLOutputElement>(domId('water-resolution-value')),
    maxFlowSpeedInput: $<HTMLInputElement>(domId('water-max-flow-speed')),
    maxFlowSpeedValue: $<HTMLOutputElement>(domId('water-max-flow-speed-value')),
    dampingInput: $<HTMLInputElement>(domId('water-damping')),
    dampingValue: $<HTMLOutputElement>(domId('water-damping-value')),
    injectIntervalInput: $<HTMLInputElement>(domId('water-inject-interval')),
    injectIntervalValue: $<HTMLOutputElement>(domId('water-inject-interval-value')),
    pauseButton: $<HTMLButtonElement>(domId('water-pause')),
    resetButton: $<HTMLButtonElement>(domId('water-reset')),
    statusLine: $(domId('water-status')),
    sourceEditor: $(domId('water-source-editor')),
    sourceName: $<HTMLInputElement>(domId('water-source-name')),
    sourceGround: $<HTMLOutputElement>(domId('water-source-ground')),
    sourceRadius: $<HTMLInputElement>(domId('water-source-radius')),
    sourceRadiusValue: $<HTMLOutputElement>(domId('water-source-radius-value')),
    sourceTarget: $<HTMLInputElement>(domId('water-source-target')),
    sourceEnabled: $<HTMLInputElement>(domId('water-source-enabled')),
    sourceDelete: $<HTMLButtonElement>(domId('water-source-delete')),
    shimmerInput: $<HTMLInputElement>(domId('water-shimmer')),
    shimmerValue: $<HTMLOutputElement>(domId('water-shimmer-value')),
    glintInput: $<HTMLInputElement>(domId('water-glint')),
    glintValue: $<HTMLOutputElement>(domId('water-glint-value')),
    reflectionInput: $<HTMLInputElement>(domId('water-reflection')),
    reflectionValue: $<HTMLOutputElement>(domId('water-reflection-value')),
    rippleInput: $<HTMLInputElement>(domId('water-ripple')),
    rippleValue: $<HTMLOutputElement>(domId('water-ripple-value')),
    rippleScaleInput: $<HTMLInputElement>(domId('water-ripple-scale')),
    rippleScaleValue: $<HTMLOutputElement>(domId('water-ripple-scale-value')),
    flowSpeedInput: $<HTMLInputElement>(domId('water-flow-speed')),
    flowSpeedValue: $<HTMLOutputElement>(domId('water-flow-speed-value')),
    foamInput: $<HTMLInputElement>(domId('water-foam')),
    foamValue: $<HTMLOutputElement>(domId('water-foam-value')),
    appearanceReset: $<HTMLButtonElement>(domId('water-appearance-reset')),
    clarityInput: $<HTMLInputElement>(domId('water-clarity')),
    clarityValue: $<HTMLOutputElement>(domId('water-clarity-value')),
    opacityInput: $<HTMLInputElement>(domId('water-opacity')),
    opacityValue: $<HTMLOutputElement>(domId('water-opacity-value')),
    saveButton: $<HTMLButtonElement>(domId('water-save')),
    exportButton: $<HTMLButtonElement>(domId('water-export')),
    importButton: $<HTMLButtonElement>(domId('water-import')),
    importInput: $<HTMLInputElement>(domId('water-import-file')),
    projectStatus: $(domId('water-project-status')),
    visualControls: []
  }

  dom.visualControls.push(
    { key: 'shimmer', input: dom.shimmerInput, output: dom.shimmerValue, min: 0, max: 3 },
    { key: 'glint', input: dom.glintInput, output: dom.glintValue, min: 0.3, max: 2.5 },
    {
      key: 'reflection',
      input: dom.reflectionInput,
      output: dom.reflectionValue,
      min: 0,
      max: 1.5
    },
    { key: 'ripple', input: dom.rippleInput, output: dom.rippleValue, min: 0, max: 2 },
    {
      key: 'rippleScale',
      input: dom.rippleScaleInput,
      output: dom.rippleScaleValue,
      min: 0.4,
      max: 2.5
    },
    {
      key: 'flowSpeed',
      input: dom.flowSpeedInput,
      output: dom.flowSpeedValue,
      min: 0,
      max: 2
    },
    { key: 'foam', input: dom.foamInput, output: dom.foamValue, min: 0, max: 2 },
    { key: 'clarity', input: dom.clarityInput, output: dom.clarityValue, min: 0, max: 1 },
    { key: 'opacity', input: dom.opacityInput, output: dom.opacityValue, min: 0, max: 1 }
  )

  return dom
}
