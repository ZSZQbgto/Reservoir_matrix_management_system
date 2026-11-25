import { BusinessOutlined, RestartAlt } from '@mui/icons-material'
import {
  AppBar,
  Box,
  Button,
  CircularProgress,
  CssBaseline,
  Divider,
  Drawer,
  Stack,
  Tab,
  Tabs,
  ThemeProvider,
  Toolbar,
  Typography
} from '@mui/material'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { Viewer } from 'tellux'
import type { WaterEditor } from '../../water/waterEditor'
import { useLiveState } from './liveState'
import { businessUrl } from '../../shared/routes'
import { AppearanceControls } from './AppearanceControls'
import { EnvironmentCluster } from './EnvironmentCluster'
import { ModelStudio } from './ModelStudio'
import { SimulationCluster } from './SimulationCluster'
import { SourcePanel } from './SourcePanel'
import { StatusCluster } from './StatusCluster'
import { ToastLayer } from './ToastLayer'
import { getWaterApi, useCameraReadout, useWaterSnapshot } from './bridge'
import { reservoirTheme } from './theme'

const DRAWER_WIDTH = 380

export function SceneApp({
  viewer,
  editor
}: {
  viewer: Viewer
  editor: WaterEditor
}): ReactElement {
  const api = getWaterApi()
  const snapshot = useWaterSnapshot(api, editor)
  const camera = useCameraReadout(viewer)
  const live = useLiveState()
  const liveRef = useRef(live)
  liveRef.current = live
  const [tab, setTab] = useState(0)
  const started = useRef(false)
  const lastFocus = useRef(0)

  useEffect(() => {
    if (!api || started.current) return
    started.current = true
    void api.enterWaterMode()
  }, [api])

  useEffect(() => {
    if (!api) return
    const publish = (): void => {
      const state = api.getState()
      const stats = api.getStats()
      const view = viewer.camera.getState()
      liveRef.current.publishScene({
        mode: api.getMode(),
        enabled: state.enabled,
        paused: state.sim.paused,
        sources: state.sources.map((source) => ({
          id: source.id,
          name: source.name,
          longitude: source.longitude,
          latitude: source.latitude
        })),
        selectedSourceId: api.getSelectedId(),
        modelCount: viewer.models.list().length,
        maxDepth: stats?.maxDepth ?? 0,
        wetCells: stats?.wetCells ?? 0,
        building: api.isBuilding(),
        progress: api.getProgress().percent,
        updatedAt: Date.now(),
        water: state,
        camera: {
          longitude: view.destination.longitude,
          latitude: view.destination.latitude,
          height: view.destination.height,
          heading: view.orientation.heading,
          pitch: view.orientation.pitch
        },
        focusSourceId: liveRef.current.state.scene.focusSourceId ?? null,
        focusNonce: liveRef.current.state.scene.focusNonce ?? 0
      })
    }
    publish()
    const timer = window.setInterval(publish, 1200)
    return () => window.clearInterval(timer)
  }, [api, viewer])

  useEffect(() => {
    const focus = live.state.scene
    if (!api || !focus.focusSourceId || !focus.focusNonce) return
    if (focus.focusNonce === lastFocus.current) return
    lastFocus.current = focus.focusNonce
    const source = api.getState().sources.find((entry) => entry.id === focus.focusSourceId)
    if (!source) return
    api.selectSource(source.id)
    viewer.camera.flyTo({
      destination: {
        longitude: source.longitude,
        latitude: source.latitude,
        height: Math.max(420, (source.groundLevel ?? 100) + 320)
      },
      orientation: { heading: 0, pitch: -55, roll: 0 },
      duration: 1.1
    })
  }, [api, viewer, live.state.scene.focusNonce, live.state.scene.focusSourceId])

  if (!api || !snapshot) {
    return (
      <ThemeProvider theme={reservoirTheme}>
        <CssBaseline />
        <Box sx={{ display: 'grid', placeItems: 'center', height: '100%' }}>
          <CircularProgress />
        </Box>
      </ThemeProvider>
    )
  }

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
              场景控制
            </Typography>
            <Typography variant="body2" color="text.secondary">
              水库孪生
            </Typography>
            <Box sx={{ flexGrow: 1 }} />
            <StatusCluster snapshot={snapshot} />
            <Typography variant="caption" color="text.secondary" sx={{ mx: 2 }}>
              {camera.longitude} · {camera.latitude} · {camera.altitude}
            </Typography>
            <Button color="inherit" startIcon={<RestartAlt />} onClick={() => api.rebuildDomain()}>
              重建域
            </Button>
            <Button color="inherit" startIcon={<BusinessOutlined />} href={businessUrl()}>
              业务
            </Button>
          </Toolbar>
        </AppBar>

        <Drawer
          variant="permanent"
          anchor="left"
          open
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            pointerEvents: 'auto',
            '& .MuiDrawer-paper': { width: DRAWER_WIDTH }
          }}
        >
          <Toolbar />
          <Tabs value={tab} onChange={(_event, value: number) => setTab(value)} variant="fullWidth">
            <Tab label="环境" />
            <Tab label="水体" />
            <Tab label="模型" />
          </Tabs>
          <Box sx={{ p: 2, overflowY: 'auto' }}>
            {tab === 0 ? <EnvironmentCluster viewer={viewer} /> : null}
            {tab === 1 ? (
              <Stack spacing={2}>
                <SourcePanel snapshot={snapshot} api={api} />
                <SimulationCluster snapshot={snapshot} api={api} />
                <Divider />
                <AppearanceControls snapshot={snapshot} api={api} />
              </Stack>
            ) : null}
            {tab === 2 ? <ModelStudio viewer={viewer} api={api} /> : null}
          </Box>
        </Drawer>

        <ToastLayer />
      </Box>
    </ThemeProvider>
  )
}
