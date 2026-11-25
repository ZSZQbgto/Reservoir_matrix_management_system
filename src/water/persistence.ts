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
