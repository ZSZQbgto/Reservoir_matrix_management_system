import { useCallback, useEffect, useRef, useState } from 'react'
import type { WaterState } from '../../water/types'

export type MatrixKind = 'responsibility' | 'task' | 'risk'
export type MatrixStatus = '待办' | '进行中' | '完成' | '阻塞'
export type MatrixLevel = '低' | '中' | '高'

export interface MatrixRow {
  id: string
  kind: MatrixKind
  title: string
  owner: string
  status: MatrixStatus
  level: MatrixLevel
  sceneSourceId: string | null
}

export interface LiveMatrix {
  rows: MatrixRow[]
  selectedId: string | null
}

export interface LiveSource {
  id: string
  name: string
  longitude: number
  latitude: number
}

export interface LiveCamera {
  longitude: number
  latitude: number
  height: number
  heading: number
  pitch: number
}

export interface LiveScene {
  mode: 'scene' | 'water'
  enabled: boolean
  paused: boolean
  sources: LiveSource[]
  selectedSourceId: string | null
  modelCount: number
  maxDepth: number
  wetCells: number
  building: boolean
  progress: number
  updatedAt: number
  /** 场景页发布的完整水体快照；业务页只读并镜像。 */
  water?: WaterState
  camera?: LiveCamera
  focusSourceId?: string | null
  focusNonce?: number
}

export interface LiveState {
  revision: number
  updatedAt: number
  matrix: LiveMatrix
  scene: LiveScene
}

export const DEFAULT_LIVE_STATE: LiveState = {
  revision: 0,
  updatedAt: 0,
  matrix: { rows: [], selectedId: null },
  scene: {
    mode: 'scene',
    enabled: false,
    paused: false,
    sources: [],
    selectedSourceId: null,
    modelCount: 0,
    maxDepth: 0,
    wetCells: 0,
    building: false,
    progress: 0,
    updatedAt: 0
  }
}

async function parseResponse(response: Response): Promise<LiveState | null> {
  if (!response.ok) return null
  const body = (await response.json()) as LiveState
  return body && typeof body.revision === 'number' ? body : null
}

const LOCAL_KEY = 'tellux-live-state-v1'
const STATIC_HOST = import.meta.env.VITE_STATIC_HOST === '1'
let channel: BroadcastChannel | null = null

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null
  channel ??= new BroadcastChannel('tellux-live-state')
  return channel
}

function cloneDefault(): LiveState {
  return {
    ...DEFAULT_LIVE_STATE,
    matrix: { ...DEFAULT_LIVE_STATE.matrix },
    scene: { ...DEFAULT_LIVE_STATE.scene }
  }
}

function readLocal(): LiveState {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (!raw) return cloneDefault()
    const parsed = JSON.parse(raw) as LiveState
    return parsed && typeof parsed.revision === 'number' ? parsed : cloneDefault()
  } catch {
    return cloneDefault()
  }
}

function writeLocal(next: LiveState): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式等场景下静默降级。
  }
  getChannel()?.postMessage(next)
}

function mergeLocal(patch: { matrix?: LiveMatrix; scene?: Partial<LiveScene> }): LiveState {
  const current = readLocal()
  const next: LiveState = {
    revision: current.revision + 1,
    updatedAt: Date.now(),
    matrix: patch.matrix ?? current.matrix,
    scene: patch.scene ? { ...current.scene, ...patch.scene, updatedAt: Date.now() } : current.scene
  }
  writeLocal(next)
  return next
}

export async function fetchLiveState(): Promise<LiveState | null> {
  if (STATIC_HOST) return readLocal()
  try {
    const response = await fetch('/api/live-state', { cache: 'no-store' })
    const remote = await parseResponse(response)
    return remote ?? readLocal()
  } catch {
    return readLocal()
  }
}

async function patchLiveState(patch: {
  matrix?: LiveMatrix
  scene?: Partial<LiveScene>
}): Promise<LiveState | null> {
  if (STATIC_HOST) return mergeLocal(patch)
  try {
    const response = await fetch('/api/live-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch)
    })
    const remote = await parseResponse(response)
    return remote ?? mergeLocal(patch)
  } catch {
    return mergeLocal(patch)
  }
}

export interface LiveStateApi {
  state: LiveState
  publishMatrix(matrix: LiveMatrix): void
  publishScene(scene: LiveScene): void
  focusSource(sourceId: string | null): void
}

/** 两个端口共享 `.cache/live-state.json`；轮询 700ms，写入按矩阵/场景分段合并。 */
export function useLiveState(): LiveStateApi {
  const [state, setState] = useState<LiveState>(DEFAULT_LIVE_STATE)
  const revision = useRef(0)
  const lastScene = useRef('')

  useEffect(() => {
    let stopped = false
    const accept = (next: LiveState | null): void => {
      if (stopped || !next || next.revision === revision.current) return
      revision.current = next.revision
      setState(next)
    }
    const poll = async (): Promise<void> => {
      accept(await fetchLiveState())
    }
    const onChannel = (event: MessageEvent<LiveState>): void => accept(event.data)
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== LOCAL_KEY || !event.newValue) return
      try {
        accept(JSON.parse(event.newValue) as LiveState)
      } catch {
        // 忽略无效的跨标签消息。
      }
    }
    const localChannel = getChannel()
    localChannel?.addEventListener('message', onChannel)
    window.addEventListener('storage', onStorage)
    void poll()
    const timer = window.setInterval(() => void poll(), 700)
    return () => {
      stopped = true
      window.clearInterval(timer)
      localChannel?.removeEventListener('message', onChannel)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const publishMatrix = useCallback((matrix: LiveMatrix) => {
    setState((current) => ({ ...current, matrix }))
    void patchLiveState({ matrix }).then((next) => {
      if (!next) return
      revision.current = next.revision
      setState(next)
    })
  }, [])

  const publishScene = useCallback((scene: LiveScene) => {
    const key = JSON.stringify({ ...scene, updatedAt: 0 })
    if (key === lastScene.current) return
    lastScene.current = key
    setState((current) => ({ ...current, scene }))
    void patchLiveState({ scene }).then((next) => {
      if (!next) return
      revision.current = next.revision
      setState(next)
    })
  }, [])

  const focusSource = useCallback((sourceId: string | null) => {
    const focusNonce = Date.now()
    setState((current) => ({
      ...current,
      scene: { ...current.scene, focusSourceId: sourceId, focusNonce }
    }))
    void patchLiveState({
      scene: { focusSourceId: sourceId, focusNonce }
    })
  }, [])

  return { state, publishMatrix, publishScene, focusSource }
}
