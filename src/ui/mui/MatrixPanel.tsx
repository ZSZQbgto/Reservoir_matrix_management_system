import { WaterDrop } from '@mui/icons-material'
import {
  Alert,
  Box,
  Chip,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Tab,
  Tabs,
  Typography
} from '@mui/material'
import { useState, type ReactElement } from 'react'
import type { LiveState } from './liveState'

const MATRIX_TABS = ['责任', '任务', '风险']

/** 水库矩阵管理系统骨架：本轮只接场景联动，矩阵数据模块后续接入。 */
export function MatrixPanel({
  live,
  focusSource
}: {
  live: LiveState
  focusSource(id: string): void
}): ReactElement {
  const [tab, setTab] = useState(0)
  const sources = live.scene.sources

  return (
    <Stack spacing={2} sx={{ p: 2, height: '100%', overflowY: 'auto' }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h6">水库矩阵</Typography>
        <Chip size="small" color="primary" label="场景联动" />
      </Stack>

      <Tabs value={tab} onChange={(_event, value: number) => setTab(value)} variant="fullWidth">
        {MATRIX_TABS.map((label) => (
          <Tab key={label} label={label} />
        ))}
      </Tabs>

      <Alert severity="info" variant="outlined">
        {MATRIX_TABS[tab]}矩阵待接入
      </Alert>

      <Box>
        <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle2">场景对象</Typography>
          <Typography variant="caption" color="text.secondary">
            {sources.length} 个水源
          </Typography>
        </Stack>
        {sources.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            场景页暂无水源
          </Typography>
        ) : (
          <List dense disablePadding sx={{ mt: 0.5 }}>
            {sources.map((source) => (
              <ListItemButton
                key={source.id}
                onClick={() => focusSource(source.id)}
                selected={live.scene.selectedSourceId === source.id}
                sx={{ borderRadius: 1, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <WaterDrop fontSize="small" />
                </ListItemIcon>
                <ListItemText
                  primary={source.name}
                  secondary={`${source.longitude.toFixed(3)}, ${source.latitude.toFixed(3)}`}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Box>
    </Stack>
  )
}
