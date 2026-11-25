import { Box, Slider, Stack, Typography } from '@mui/material'
import type { ReactElement } from 'react'
import type { WaterVisualSettings } from '../../water/types'
import type { UiSnapshot, WaterDebugApi } from './bridge'

const VISUAL_ROWS: Array<{
  key: keyof WaterVisualSettings
  label: string
  min: number
  max: number
}> = [
  { key: 'shimmer', label: '高光', min: 0, max: 3 },
  { key: 'glint', label: '高光锐度', min: 0.3, max: 2.5 },
  { key: 'reflection', label: '天空反射', min: 0, max: 1.5 },
  { key: 'ripple', label: '波纹', min: 0, max: 2 },
  { key: 'rippleScale', label: '波纹尺度', min: 0.4, max: 2.5 },
  { key: 'flowSpeed', label: '平流速度', min: 0, max: 2 },
  { key: 'foam', label: '泡沫', min: 0, max: 2 },
  { key: 'clarity', label: '清澈度', min: 0, max: 1 },
  { key: 'opacity', label: '不透明度', min: 0, max: 1 }
]

export function AppearanceControls({
  snapshot,
  api
}: {
  snapshot: UiSnapshot
  api: WaterDebugApi
}): ReactElement {
  return (
    <Stack spacing={1}>
      {VISUAL_ROWS.map((row) => (
        <Box key={row.key}>
          <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
            <Typography variant="caption">{row.label}</Typography>
            <Typography variant="caption" color="text.secondary">
              {snapshot.state.visual[row.key].toFixed(2)}
            </Typography>
          </Stack>
          <Slider
            size="small"
            min={row.min}
            max={row.max}
            step={0.01}
            value={snapshot.state.visual[row.key]}
            onChange={(_event, value) =>
              api.setVisual({
                [row.key]: Array.isArray(value) ? value[0] : value
              } as Partial<WaterVisualSettings>)
            }
          />
        </Box>
      ))}
    </Stack>
  )
}
