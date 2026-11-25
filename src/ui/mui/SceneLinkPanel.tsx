import { PlayCircleOutlined, PauseCircleOutlined, PublicOutlined } from '@mui/icons-material'
import {
  Button,
  Chip,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography
} from '@mui/material'
import type { ReactElement } from 'react'
import type { LiveState } from './liveState'

export function SceneLinkPanel({ live }: { live: LiveState }): ReactElement {
  const scene = live.scene
  const selected = scene.sources.find((source) => source.id === scene.selectedSourceId) ?? null

  return (
    <Stack spacing={2} sx={{ p: 2 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h6">场景联动</Typography>
        <Chip
          size="small"
          icon={scene.paused ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
          label={scene.paused ? '暂停' : '运行'}
          color={scene.paused ? 'warning' : 'success'}
        />
      </Stack>

      {scene.building ? (
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            场景页重建域中
          </Typography>
          <LinearProgress variant="determinate" value={scene.progress} />
        </Stack>
      ) : null}

      <Divider />

      <List dense disablePadding>
        <ListItem disableGutters>
          <ListItemText primary="水源" secondary={`${scene.sources.length} 个`} />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText
            primary="模拟"
            secondary={`${scene.wetCells} 格 · ${scene.maxDepth.toFixed(2)} m`}
          />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="选中水源" secondary={selected ? selected.name : '未选择'} />
        </ListItem>
        <ListItem disableGutters>
          <ListItemText primary="最大水深" secondary={`${scene.maxDepth.toFixed(2)} m`} />
        </ListItem>
      </List>

      <Button
        variant="outlined"
        startIcon={<PublicOutlined />}
        href={`${window.location.protocol}//${window.location.hostname}:5174/?scene=1`}
      >
        打开场景编辑
      </Button>
    </Stack>
  )
}
