import {
  WATER_MODE_STORAGE_KEY,
  WATER_STORAGE_KEY,
  normalizeWaterState,
  type WaterState
} from './types'

export type EditorMode = 'scene' | 'water'

export function loadStoredState(): WaterState {
  try {
    const raw = localStorage.getItem(WATER_STORAGE_KEY)
    if (!raw) return normalizeWaterState(null)
    return normalizeWaterState(JSON.parse(raw))
  } catch {
    return normalizeWaterState(null)
  }
}

export function storeState(state: WaterState): boolean {
  try {
    localStorage.setItem(WATER_STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function loadStoredMode(): EditorMode | null {
  try {
    const value = localStorage.getItem(WATER_MODE_STORAGE_KEY)
    return value === 'water' || value === 'scene' ? value : null
  } catch {
    return null
  }
}

export function storeMode(mode: EditorMode): void {
  try {
    localStorage.setItem(WATER_MODE_STORAGE_KEY, mode)
  } catch {
    // localStorage 不可用时静默降级。
  }
}

/** 导出工程 JSON（只含水体状态，不含水位/流量）。 */
export function downloadStateJson(state: WaterState): void {
  const timestamp = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  const name = [
    'water-project',
    timestamp.getFullYear(),
    pad(timestamp.getMonth() + 1),
    pad(timestamp.getDate()),
    `${pad(timestamp.getHours())}${pad(timestamp.getMinutes())}`
  ].join('-')
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${name}.json`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export async function readStateFile(file: File): Promise<WaterState | null> {
  try {
    const text = await file.text()
    return normalizeWaterState(JSON.parse(text))
  } catch {
    return null
  }
}
