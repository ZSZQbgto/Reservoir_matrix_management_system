import { Add, DeleteOutlined, WaterDrop } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Paper,
  Slider,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material'
import type { ReactElement } from 'react'
import type { UiSnapshot, WaterDebugApi } from './bridge'
import { GuideCluster } from './GuideCluster'

export function SourcePanel({
  snapshot,
  api
}: {
  snapshot: UiSnapshot
  api: WaterDebugApi
}): ReactElement {
  const sources = snapshot.state.sources
  const selected = sources.find((source) => source.id === snapshot.selectedId) ?? null

  return (
    <Stack spacing={1.5} sx={{ p: 2 }}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Stack direction="row" spacing={0.8} sx={{ alignItems: 'center' }}>
          <Typography variant="h6">水源</Typography>
          <Chip size="small" label={sources.length} />
        </Stack>
        <Button
          size="small"
          variant={snapshot.placing ? 'contained' : 'outlined'}
          startIcon={<Add />}
          onClick={() => api.togglePlacing()}
        >
          {snapshot.placing ? '取消' : '添加'}
        </Button>
      </Stack>

      <GuideCluster snapshot={snapshot} />

      {sources.length === 0 ? (
        <Alert severity="info" variant="outlined">
          点击「添加」，然后在地形上放置水源
        </Alert>
      ) : (
        <List dense disablePadding>
          {sources.map((source) => (
            <ListItemButton
              key={source.id}
              selected={source.id === snapshot.selectedId}
              onClick={() => api.selectSource(source.id)}
              sx={{ borderRadius: 1, mb: 0.5 }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                <WaterDrop fontSize="small" color={source.enabled ? 'primary' : 'disabled'} />
              </ListItemIcon>
              <ListItemText
                primary={source.name}
                secondary={`${Math.round(source.radius)} m`}
                slotProps={{ secondary: { variant: 'caption' } }}
              />
              <Switch
                size="small"
                checked={source.enabled}
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => api.setSource(source.id, { enabled: event.target.checked })}
                slotProps={{ input: { 'aria-label': `${source.name} 启用` } }}
              />
              <IconButton
                size="small"
                aria-label={`删除 ${source.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  api.deleteSource(source.id)
                }}
              >
                <DeleteOutlined fontSize="small" />
              </IconButton>
            </ListItemButton>
          ))}
        </List>
      )}

      {selected ? (
        <>
          <Divider />
          <Paper variant="outlined" sx={{ p: 1.4 }}>
            <Stack spacing={1.2}>
              <TextField
                size="small"
                label="名称"
                value={selected.name}
                onChange={(event) => api.setSource(selected.id, { name: event.target.value })}
              />
              <Box>
                <Stack direction="row" sx={{ justifyContent: 'space-between' }}>
                  <Typography variant="caption">注水半径</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {Math.round(selected.radius)} m
                  </Typography>
                </Stack>
                <Slider
                  size="small"
                  min={20}
                  max={2000}
                  step={10}
                  value={selected.radius}
                  onChange={(_event, value) =>
                    api.setSource(selected.id, {
                      radius: Array.isArray(value) ? value[0] : value
                    })
                  }
                />
              </Box>
              <TextField
                size="small"
                label="目标水位"
                type="number"
                placeholder="不限制"
                value={selected.targetLevel ?? ''}
                onChange={(event) => {
                  const value = event.target.value.trim()
                  api.setSource(selected.id, {
                    targetLevel: value === '' ? null : Number(value)
                  })
                }}
              />
            </Stack>
          </Paper>
        </>
      ) : null}

      {sources.length > 0 ? (
        <Button size="small" color="inherit" onClick={() => api.clearSources()}>
          清空全部
        </Button>
      ) : null}
    </Stack>
  )
}
