/**
 * 纯数值工具。
 *
 * 不依赖 ui / water，两个方向都可安全引用；只包含无副作用的纯函数。
 */

/** 把数值夹到 [min, max]；NaN 会原样变成 NaN，调用方负责先校验。 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
