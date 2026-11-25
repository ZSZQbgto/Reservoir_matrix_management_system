import { GridOn, Pause, PlayArrow, WaterDrop } from '@mui/icons-material'
import { Chip, LinearProgress, Stack, Typography } from '@mui/material'
import type { ReactElement } from 'react'
import type { UiSnapshot } from './bridge'

export function StatusCluster({ snapshot }: { snapshot: UiSnapshot }): ReactElement {
  const { stats, state, building, progress } = snapshot
  const paused = state.sim.paused
  return (
    <Stack direction="row" spacing={0.8} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
      {building ? (
        <Stack spacing={0.4} sx={{ minWidth: 150 }}>
          <Typography variant="caption" color="text.secondary">
            {progress.label || '构建模拟域'}
          </Typography>
          <LinearProgress variant="determinate" value={progress.percent} />
        </Stack>
      ) : (
        <>
          <Chip
            size="small"
            variant="outlined"
            icon={paused ? <Pause /> : <PlayArrow />}
            label={paused ? '已暂停' : '运行中'}
            color={paused ? 'warning' : 'success'}
          />
          <Chip
            size="small"
            variant="outlined"
            icon={<WaterDrop />}
            label={`${stats.maxDepth.toFixed(1)} m`}
          />
          <Chip
            size="small"
            variant="outlined"
            icon={<GridOn />}
            label={`${stats.wetCells.toLocaleString()} 格`}
          />
        </>
      )}
    </Stack>
  )
}
