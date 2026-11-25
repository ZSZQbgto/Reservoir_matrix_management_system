import { useEffect, useState } from 'react'
import type { Viewer } from 'tellux'
import type { WaterEditor } from '../../water/waterEditor'
import type { SimStats, WaterState } from '../../water/types'
import { formatAltitude, formatCoordinate } from '../../shared/format'

export interface GateUiState {
  openingMeters: number
  maxOpeningMeters: number
  flow: number
  heightMeters: number
}

export interface WaterDebugApi {
  getMode(): 'scene' | 'water'
  getState(): WaterState
  getStats(): SimStats | null
  getProgress(): { percent: number; label: string }
  isPlacing(): boolean
  isBuilding(): boolean
  getSelectedId(): string | null
  getGate(): GateUiState | null
  getFieldInfo(): { baseElevation: number } | null
  getSourceScreenPosition(id: string): { x: number; y: number } | null
  togglePlacing(): void
  cancelPlacing(): void
  setEnabled(enabled: boolean): void
  setSimSettings(patch: Partial<WaterState['sim']>): void
  setVisual(patch: Partial<WaterState['visual']>): void
  applyExternalState(state: WaterState): void
  setSource(id: string, patch: Record<string, unknown>): boolean
  selectSource(id: string | null): void
  deleteSource(id: string): void
  clearSources(): void
  resetSimulation(): void
  rebuildSimulation(): void
  rebuildDomain(): void
  setGateOpening(value: number): number
  enterWaterMode(): Promise<void>
  enterSceneMode(): Promise<void>
}

export interface UiSnapshot {
  mode: 'scene' | 'water'
  state: WaterState
  stats: SimStats
  progress: { percent: number; label: string }
  placing: boolean
  building: boolean
  ready: boolean
  selectedId: string | null
  gate: GateUiState | null
}

const EMPTY_STATS: SimStats = { steps: 0, wetCells: 0, maxDepth: 0, simMs: 0 }

export function getWaterApi(): WaterDebugApi | null {
  return (window.__waterEditor as WaterDebugApi | undefined) ?? null
}

export function readSnapshot(api: WaterDebugApi, editor: WaterEditor | null): UiSnapshot {
  return {
    mode: api.getMode(),
    state: api.getState(),
    stats: api.getStats() ?? EMPTY_STATS,
    progress: api.getProgress(),
    placing: api.isPlacing(),
    building: api.isBuilding(),
    ready: Boolean(editor?.isDomainReady),
    selectedId: api.getSelectedId(),
    gate: api.getGate()
  }
}

export function useWaterSnapshot(
  api: WaterDebugApi | null,
  editor: WaterEditor | null
): UiSnapshot | null {
  const [snapshot, setSnapshot] = useState<UiSnapshot | null>(() =>
    api ? readSnapshot(api, editor) : null
  )

  useEffect(() => {
    if (!api) return
    let cancelled = false
    const update = (): void => {
      if (!cancelled) setSnapshot(readSnapshot(api, editor))
    }
    update()
    const timer = window.setInterval(update, 220)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [api, editor])

  return snapshot
}

export interface ToastMessage {
  id: number
  message: string
  duration: number
}

let toastId = 0

export function useToasts(): ToastMessage[] {
  const [toasts, setToasts] = useState<ToastMessage[]>([])
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{ message: string; duration?: number }>).detail
      if (!detail?.message) return
      toastId += 1
      setToasts((current) => [
        ...current.slice(-2),
        { id: toastId, message: detail.message, duration: detail.duration ?? 2400 }
      ])
    }
    window.addEventListener('water-toast', handler)
    return () => window.removeEventListener('water-toast', handler)
  }, [])
  useEffect(() => {
    if (toasts.length === 0) return
    const timer = window.setTimeout(() => setToasts((current) => current.slice(1)), 2600)
    return () => window.clearTimeout(timer)
  }, [toasts])
  return toasts
}

export interface CameraReadout {
  longitude: string
  latitude: string
  altitude: string
}

export function useCameraReadout(viewer: Viewer | null): CameraReadout {
  const [readout, setReadout] = useState<CameraReadout>({
    longitude: '—',
    latitude: '—',
    altitude: '—'
  })
  useEffect(() => {
    if (!viewer) return
    const update = (): void => {
      const { destination } = viewer.camera.getState()
      setReadout({
        longitude: formatCoordinate(destination.longitude, 'E', 'W'),
        latitude: formatCoordinate(destination.latitude, 'N', 'S'),
        altitude: formatAltitude(destination.height)
      })
    }
    update()
    const timer = window.setInterval(update, 500)
    return () => window.clearInterval(timer)
  }, [viewer])
  return readout
}
