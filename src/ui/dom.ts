/**
 * DOM 查询工具。
 *
 * 页面元素在 `index.html` 中静态声明，缺失即为装配错误：必须存在的元素用
 * `requireElement`（立即抛出带选择器的错误），可选项用 `pickElement`。
 */

/** 查询必须存在的元素；缺失时抛错，避免后续空引用。 */
export function requireElement<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T {
  const element = root.querySelector<T>(selector)
  if (!element) throw new Error(`页面缺少必要元素：${selector}`)
  return element
}

/** 查询可能不存在的元素。 */
export function pickElement<T extends Element = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T | null {
  return root.querySelector<T>(selector)
}

/** 把滑杆当前值换算成 0–100 的 `--fill`，供轨道着色（程序化赋值后也要调用）。 */
export function syncRangeFill(input: HTMLInputElement): void {
  const min = Number(input.min || 0)
  const max = Number(input.max || 100)
  const value = Number(input.value)
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= min) return
  const percent = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100))
  input.style.setProperty('--fill', `${percent.toFixed(1)}%`)
}
