import {
  AppBar,
  Box,
  Button,
  CssBaseline,
  Drawer,
  ThemeProvider,
  Toolbar,
  Typography
} from '@mui/material'
import { useEffect, type ReactElement } from 'react'
import type { Viewer } from 'tellux'
import type { WaterEditor } from '../../water/waterEditor'
import { useLiveState } from './liveState'
import { sceneUrl } from '../../shared/routes'
import { MatrixPanel } from './MatrixPanel'
import { SceneLinkPanel } from './SceneLinkPanel'
import { ToastLayer } from './ToastLayer'
import { getWaterApi, useCameraReadout } from './bridge'
import { reservoirTheme } from './theme'

const LEFT_WIDTH = 360
const RIGHT_WIDTH = 340

export function App({ viewer, editor }: { viewer: Viewer; editor: WaterEditor }): ReactElement {
  const api = getWaterApi()
  const live = useLiveState()
  const camera = useCameraReadout(viewer)

  useEffect(() => {
    viewer.controls.enabled = false
  }, [viewer])

  useEffect(() => {
    const scene = live.state.scene
    if (!api || !scene.water || !scene.camera) return
    let cancelled = false
    const apply = async (): Promise<void> => {
      if (!editor.isDomainReady || api.getMode() !== 'water') await api.enterWaterMode()
      if (cancelled || !editor.isDomainReady) return
      api.applyExternalState(scene.water!)
      viewer.camera.setView({
        destination: {
          longitude: scene.camera!.longitude,
          latitude: scene.camera!.latitude,
          height: scene.camera!.height
        },
        orientation: {
          heading: scene.camera!.heading,
          pitch: scene.camera!.pitch,
          roll: 0
        }
      })
    }
    void apply()
    return () => {
      cancelled = true
    }
  }, [
    api,
    editor,
    viewer,
    live.state.scene.updatedAt,
    live.state.scene.water,
    live.state.scene.camera
  ])

  return (
    <ThemeProvider theme={reservoirTheme}>
      <CssBaseline />
      <Box sx={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 20 }}>
        <AppBar
          position="fixed"
          color="default"
          elevation={0}
          sx={{ pointerEvents: 'auto', zIndex: (theme) => theme.zIndex.drawer + 1 }}
        >
          <Toolbar variant="dense">
            <Typography variant="h6" sx={{ mr: 1 }}>
              TELLUX
            </Typography>
            <Typography variant="body2" color="text.secondary">
              水库矩阵
            </Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ mx: 2 }}>
              {camera.longitude} · {camera.latitude} · {camera.altitude}
            </Typography>
            <Button color="inherit" href={sceneUrl()}>
              场景
            </Button>
          </Toolbar>
        </AppBar>

        <Drawer
          variant="permanent"
          anchor="left"
          open
          sx={{
            width: LEFT_WIDTH,
            flexShrink: 0,
            pointerEvents: 'auto',
            '& .MuiDrawer-paper': { width: LEFT_WIDTH }
          }}
        >
          <Toolbar />
          <MatrixPanel live={live.state} focusSource={live.focusSource} />
        </Drawer>

        <Drawer
          variant="permanent"
          anchor="right"
          open
          sx={{
            width: RIGHT_WIDTH,
            flexShrink: 0,
            pointerEvents: 'auto',
            '& .MuiDrawer-paper': { width: RIGHT_WIDTH }
          }}
        >
          <Toolbar />
          <SceneLinkPanel live={live.state} />
        </Drawer>

        <ToastLayer />
      </Box>
    </ThemeProvider>
  )
}
