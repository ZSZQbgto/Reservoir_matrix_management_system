import { createRoot } from 'react-dom/client'
import {
  Alert,
  Box,
  CircularProgress,
  CssBaseline,
  LinearProgress,
  Stack,
  ThemeProvider,
  Typography
} from '@mui/material'
import { useSyncExternalStore, type ReactElement } from 'react'
import type { Viewer } from 'tellux'
import type { WaterEditor } from '../../water/waterEditor'
import { App } from './App'
import { SceneApp } from './SceneApp'
import { reservoirTheme } from './theme'
import './base.css'

interface BootState {
  ready: boolean
  percent: number
  detail: string
  error: string | null
  viewer: Viewer | null
  editor: WaterEditor | null
  scene: boolean
}

let state: BootState = {
  ready: false,
  percent: 0,
  detail: '正在启动三维场景…',
  error: null,
  viewer: null,
  editor: null,
  scene: new URLSearchParams(window.location.search).get('scene') === '1'
}
const listeners = new Set<() => void>()

function setState(patch: Partial<BootState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function useBoot(): BootState {
  return useSyncExternalStore(subscribe, () => state)
}

function BootScreen({ boot }: { boot: BootState }): ReactElement {
  return (
    <Box sx={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <Stack spacing={2} sx={{ width: 280, alignItems: 'center' }}>
        {boot.error ? (
          <Alert severity="error">{boot.error}</Alert>
        ) : (
          <>
            <CircularProgress />
            <Typography variant="body2" color="text.secondary">
              {boot.detail}
            </Typography>
            <LinearProgress variant="determinate" value={boot.percent} sx={{ width: '100%' }} />
          </>
        )}
      </Stack>
    </Box>
  )
}

function UiHost(): ReactElement {
  const boot = useBoot()
  return (
    <ThemeProvider theme={reservoirTheme}>
      <CssBaseline />
      {boot.error ? (
        <BootScreen boot={boot} />
      ) : boot.ready && boot.viewer && boot.editor ? (
        boot.scene ? (
          <SceneApp viewer={boot.viewer} editor={boot.editor} />
        ) : (
          <App viewer={boot.viewer} editor={boot.editor} />
        )
      ) : (
        <BootScreen boot={boot} />
      )}
    </ThemeProvider>
  )
}

export interface MuiBoot {
  progress(percent: number, detail: string): void
  error(message: string): void
  ready(viewer: Viewer, editor: WaterEditor): void
}

export function startMuiUi(): MuiBoot {
  const container = document.getElementById('mui-root')
  if (!container) throw new Error('缺少 #mui-root')
  document.body.dataset.mui = 'true'
  createRoot(container).render(<UiHost />)
  return {
    progress: (percent, detail) => setState({ percent, detail }),
    error: (message) => setState({ error: message }),
    ready: (viewer, editor) => {
      document.title = state.scene ? '场景控制 · 水库孪生' : '水库业务 · Tellux'
      setState({ ready: true, viewer, editor, percent: 100 })
    }
  }
}
