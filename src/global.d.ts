/**
 * 全局类型声明：挂在 `window` 上的调试句柄。
 *
 * - `viewer` / `waterEditor`：供 MUI 页面与人工排查使用；
 * - `__waterEditor`：`WaterEditor` 暴露的命令 API，结构随实现变化，故为 unknown。
 *
 * 模块内的依赖一律走 import，只有这三个字段进入全局作用域。
 */
import type { Viewer } from 'tellux'
import type { WaterEditor } from './water/waterEditor'

declare global {
  interface Window {
    /** Tellux 三维视口实例。 */
    viewer?: Viewer
    /** 水体编辑器实例。 */
    waterEditor?: WaterEditor
    /** 水体编辑器调试 API（供 scripts/verify.mjs 断言）。 */
    __waterEditor?: unknown
    /** 页面入口标记：`scene` 时挂载三维场景控制台。 */
    __DSH_PAGE__?: 'scene'
  }
}

export {}
