/**
 * 异步调度小工具：分帧任务与固定等待。
 *
 * 地形采样等同步重活需要让出主线程（`nextFrame`），模拟域构建的
 * 稳定性检测需要固定间隔（`delay`），两者在这里统一，避免各处重复写 Promise。
 */

/** 等到下一次浏览器绘制（无 rAF 环境退回 0 ms 定时器）。 */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else window.setTimeout(resolve, 0)
  })
}

/** 等待指定毫秒数。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
