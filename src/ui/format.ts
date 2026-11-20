/**
 * HUD 文案格式化。
 *
 * 界面时间统一用「北京时间分钟数」（0–1439）表示，换算到固定场景日期：
 * 太阳方向随滑杆变化，而不是随真实运行时刻漂移，方便对比与截图。
 */

/** 场景固定日期（UTC）：2026-11-17 00:00。 */
const SCENE_DATE_UTC = Date.UTC(2026, 10, 17, 0, 0, 0)
const BEIJING_OFFSET_MINUTES = 8 * 60
const MINUTES_PER_DAY = 1440

/** 默认场景时间：北京时间 15:30。 */
export const DEFAULT_TIME_MINUTES = 930

/** 北京时间分钟数 → 场景时钟的 Date（UTC 时刻）。 */
export function minutesToSceneDate(totalMinutes: number): Date {
  const date = new Date(SCENE_DATE_UTC)
  date.setUTCMinutes(totalMinutes - BEIJING_OFFSET_MINUTES)
  return date
}

/** 北京时间分钟数 → `HH:MM`，自动按天回卷。 */
export function formatClockTime(totalMinutes: number): string {
  const minutes = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  const hour = String(Math.floor(minutes / 60)).padStart(2, '0')
  const minute = String(minutes % 60).padStart(2, '0')
  return `${hour}:${minute}`
}

/** 经度 / 纬度 → `116.77°E`。 */
export function formatCoordinate(value: number, positive: string, negative: string): string {
  const direction = value >= 0 ? positive : negative
  return `${Math.abs(value).toFixed(2)}°${direction}`
}

/** 相机高度 → `7.6 km` / `850 m`。 */
export function formatAltitude(meters: number): string {
  if (!Number.isFinite(meters)) return '—'
  if (Math.abs(meters) >= 1000) {
    return `${(meters / 1000).toFixed(meters >= 100_000 ? 0 : 1)} km`
  }
  return `${meters.toFixed(0)} m`
}
