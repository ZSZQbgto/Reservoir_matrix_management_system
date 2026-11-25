/**
 * 地形采样与相机等待。
 *
 * 建域流程里「飞到域上方 → 等地形瓦片可用 → 等瓦片细化稳定」这段逻辑只依赖
 * `viewer` 与时间，不碰编辑器状态，因此独立成模块，便于单测与复用。
 */
import type { Viewer } from 'tellux'
import { delay } from './async'

export interface CenterPoint {
  longitude: number
  latitude: number
}

/** 采样某点地面高程；瓦片未加载或采样失败时返回 undefined。 */
export function sampleGroundHeight(
  viewer: Viewer,
  longitude: number,
  latitude: number
): number | undefined {
  try {
    const height = viewer.sampleHeight({ longitude, latitude })
    return typeof height === 'number' && Number.isFinite(height) ? height : undefined
  } catch {
    return undefined
  }
}

/** 飞到模拟域正上方，同时促使该区域地形瓦片加载。 */
export async function flyOverDomain(
  viewer: Viewer,
  center: CenterPoint,
  sizeMeters: number
): Promise<void> {
  const ground = sampleGroundHeight(viewer, center.longitude, center.latitude) ?? 0
  const height = Math.max(1500, ground + sizeMeters * 0.92)
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    try {
      viewer.camera.flyTo({
        destination: { longitude: center.longitude, latitude: center.latitude, height },
        orientation: { heading: 0, pitch: -85, roll: 0 },
        duration: 0.95,
        complete: finish,
        cancel: finish
      })
    } catch {
      finish()
    }
    window.setTimeout(finish, 1500)
  })
}

/** 等待模拟域中心能采到地形高度（地形瓦片尚未加载时 sampleHeight 返回 undefined）。 */
export async function waitForTerrainAvailable(
  viewer: Viewer,
  center: CenterPoint,
  maxMs = 15000
): Promise<boolean> {
  const started = performance.now()
  while (performance.now() - started < maxMs) {
    if (typeof sampleGroundHeight(viewer, center.longitude, center.latitude) === 'number') {
      return true
    }
    await delay(350)
  }
  return false
}

/**
 * 等待地形瓦片在当前俯视视角下细化稳定。
 *
 * `viewer.sampleHeight` 只使用已加载瓦片：飞抵新视角后 LOD 会在数秒内连续细化，
 * 过早采样会让模拟地形与随后显示的地形相差十几米。这里要求：
 * - 飞抵后至少再等 3.2 s（瓦片细化通常需要 2–4 s）；
 * - 域中心高度连续 3 次变化小于 0.2 m；
 * - 最多等 12 s，仍未稳定也继续（后续采样后还有漂移复采兜底）。
 */
export async function waitForTerrainStable(
  viewer: Viewer,
  center: CenterPoint,
  maxMs = 12000
): Promise<void> {
  const started = performance.now()
  let previous: number | undefined
  let stableCount = 0
  while (performance.now() - started < maxMs) {
    await delay(320)
    const height = sampleGroundHeight(viewer, center.longitude, center.latitude)
    if (typeof height !== 'number') {
      stableCount = 0
      previous = undefined
      continue
    }
    if (typeof previous === 'number' && Math.abs(height - previous) < 0.2) {
      stableCount += 1
      if (stableCount >= 3 && performance.now() - started >= 3200) return
    } else {
      stableCount = 0
    }
    previous = height
  }
}
