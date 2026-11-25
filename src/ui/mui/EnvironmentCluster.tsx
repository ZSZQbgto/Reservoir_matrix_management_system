import { CloudOutlined, Tune, WbSunnyOutlined } from '@mui/icons-material'
import {
  Box,
  Collapse,
  FormControl,
  IconButton,
  MenuItem,
  Select,
  Slider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography
} from '@mui/material'
import { useState, type ReactElement } from 'react'
import type { Viewer } from 'tellux'
import { formatClockTime } from '../../shared/format'
import { useEnvironment, type CloudQuality } from './useEnvironment'

const QUALITY_LABELS: Record<CloudQuality, string> = {
  low: '低',
  medium: '中',
  high: '高',
  ultra: '极致'
}

export function EnvironmentCluster({ viewer }: { viewer: Viewer | null }): ReactElement {
  const [state, actions] = useEnvironment(viewer)
  const [advanced, setAdvanced] = useState(false)

  return (
    <Stack spacing={0.9} sx={{ width: 228 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="overline">环境</Typography>
        <Tooltip title="云层细节">
          <IconButton size="small" onClick={() => setAdvanced((value) => !value)}>
            <Tune fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <ToggleButtonGroup size="small" exclusive>
          <ToggleButton
            value="clouds"
            selected={state.cloudsShow}
            onClick={() => actions.setCloudsShow(!state.cloudsShow)}
            aria-label="体积云"
          >
            <CloudOutlined fontSize="small" />
          </ToggleButton>
          <ToggleButton
            value="atmosphere"
            selected={state.atmosphere}
            onClick={() => actions.setAtmosphere(!state.atmosphere)}
            aria-label="大气散射"
          >
            <WbSunnyOutlined fontSize="small" />
          </ToggleButton>
        </ToggleButtonGroup>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {formatClockTime(state.minutes)}
        </Typography>
      </Stack>

      <Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography variant="caption">云量</Typography>
          <Typography variant="caption" color="text.secondary">
            {state.coverage.toFixed(0)}%
          </Typography>
        </Stack>
        <Slider
          size="small"
          min={0}
          max={100}
          step={1}
          value={state.coverage}
          onChange={(_event, value) => actions.setCoverage(Array.isArray(value) ? value[0] : value)}
        />
      </Box>

      <Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography variant="caption">云底</Typography>
          <Typography variant="caption" color="text.secondary">
            {(state.altitude / 1000).toFixed(1)} km
          </Typography>
        </Stack>
        <Slider
          size="small"
          min={800}
          max={16000}
          step={100}
          value={state.altitude}
          onChange={(_event, value) => actions.setAltitude(Array.isArray(value) ? value[0] : value)}
        />
      </Box>

      <Box>
        <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
          <Typography variant="caption">时间</Typography>
          <Typography variant="caption" color="text.secondary">
            {formatClockTime(state.minutes)}
          </Typography>
        </Stack>
        <Slider
          size="small"
          min={0}
          max={1439}
          step={30}
          value={state.minutes}
          onChange={(_event, value) => actions.setMinutes(Array.isArray(value) ? value[0] : value)}
        />
      </Box>

      <Collapse in={advanced}>
        <Stack spacing={0.9}>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption">云层厚度</Typography>
            <Slider
              size="small"
              min={120}
              max={4000}
              step={20}
              value={state.height}
              onChange={(_event, value) =>
                actions.setHeight(Array.isArray(value) ? value[0] : value)
              }
              sx={{ width: 120 }}
            />
          </Stack>
          <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption">质量</Typography>
            <FormControl size="small" variant="standard" sx={{ minWidth: 68 }}>
              <Select
                value={state.quality}
                onChange={(event) => actions.setQuality(event.target.value as CloudQuality)}
                aria-label="云质量"
              >
                {(Object.keys(QUALITY_LABELS) as CloudQuality[]).map((quality) => (
                  <MenuItem key={quality} value={quality}>
                    {QUALITY_LABELS[quality]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </Stack>
      </Collapse>
    </Stack>
  )
}
