import { Tune } from '@mui/icons-material'
import {
  Box,
  Collapse,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material'
import { useState, type ReactElement } from 'react'
import { SIM_RESOLUTION_OPTIONS } from '../../water/types'
import type { UiSnapshot, WaterDebugApi } from './bridge'

function ValueLabel({ value, unit }: { value: string; unit: string }): ReactElement {
  return (
    <Typography component="span" variant="caption" sx={{ color: 'text.secondary', ml: 1 }}>
      {value} {unit}
    </Typography>
  )
}

export function SimulationCluster({
  snapshot,
  api
}: {
  snapshot: UiSnapshot
  api: WaterDebugApi
}): ReactElement {
  const [advanced, setAdvanced] = useState(false)
  const sim = snapshot.state.sim

  return (
    <Stack spacing={0.9} sx={{ width: 228 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={0.6} sx={{ alignItems: 'center' }}>
          <Typography variant="overline">水体模拟</Typography>
          <Switch
            size="small"
            checked={snapshot.state.enabled}
            onChange={(event) => api.setEnabled(event.target.checked)}
            slotProps={{ input: { 'aria-label': '水体开关' } }}
          />
        </Stack>
        <Tooltip title="高级参数">
          <IconButton size="small" onClick={() => setAdvanced((value) => !value)}>
            <Tune fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography variant="caption">速度</Typography>
          <ValueLabel value={sim.speed.toFixed(1)} unit="×" />
        </Stack>
        <Slider
          size="small"
          min={0.1}
          max={64}
          step={0.1}
          value={sim.speed}
          onChange={(_event, value) =>
            api.setSimSettings({ speed: Array.isArray(value) ? value[0] : value })
          }
        />
      </Box>

      <Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography variant="caption">注水</Typography>
          <ValueLabel value={sim.waterAmount.toFixed(0)} unit="m" />
        </Stack>
        <Slider
          size="small"
          min={1}
          max={300}
          step={1}
          value={sim.waterAmount}
          onChange={(_event, value) =>
            api.setSimSettings({ waterAmount: Array.isArray(value) ? value[0] : value })
          }
        />
      </Box>

      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="caption">精度</Typography>
        <FormControl size="small" variant="standard" sx={{ minWidth: 76 }}>
          <Select
            value={sim.resolution}
            onChange={(event) => {
              api.setSimSettings({ resolution: Number(event.target.value) })
              api.rebuildSimulation()
            }}
            aria-label="模拟精度"
          >
            {SIM_RESOLUTION_OPTIONS.map((resolution) => (
              <MenuItem key={resolution} value={resolution}>
                {resolution}²
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <Collapse in={advanced}>
        <Stack spacing={0.9}>
          <Box>
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="caption">最大流速</Typography>
              <ValueLabel value={sim.maxFlowSpeed.toFixed(0)} unit="m/s" />
            </Stack>
            <Slider
              size="small"
              min={5}
              max={60}
              step={1}
              value={sim.maxFlowSpeed}
              onChange={(_event, value) =>
                api.setSimSettings({ maxFlowSpeed: Array.isArray(value) ? value[0] : value })
              }
            />
          </Box>
          <Box>
            <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
              <Typography variant="caption">阻尼</Typography>
              <ValueLabel value={sim.damping.toFixed(3)} unit="" />
            </Stack>
            <Slider
              size="small"
              min={0.9}
              max={1}
              step={0.005}
              value={sim.damping}
              onChange={(_event, value) =>
                api.setSimSettings({ damping: Array.isArray(value) ? value[0] : value })
              }
            />
          </Box>
        </Stack>
      </Collapse>
    </Stack>
  )
}
