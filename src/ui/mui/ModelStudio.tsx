import { Add, DeleteOutlined, FolderOpen, PlaceOutlined } from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useRef, useState, type ReactElement } from 'react'
import type { Viewer } from 'tellux'
import { WATER_DOMAIN } from '../../water/types'
import type { WaterDebugApi } from './bridge'

interface StudioModel {
  id: string
  name: string
  url: string
  longitude: number
  latitude: number
  height: number
  heading: number
  scale: number
}

export function ModelStudio({ viewer, api }: { viewer: Viewer; api: WaterDebugApi }): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [models, setModels] = useState<StudioModel[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = api.getFieldInfo()?.baseElevation ?? 119
  const selected = models.find((model) => model.id === selectedId) ?? null

  const addModel = (): void => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const id = `scene-model-${Date.now()}`
    const item: StudioModel = {
      id,
      name: file.name,
      url,
      longitude: WATER_DOMAIN.longitude,
      latitude: WATER_DOMAIN.latitude,
      height: base,
      heading: 0,
      scale: 1
    }
    setError(null)
    try {
      const layer = viewer.models.add({
        type: 'gltf',
        id,
        url,
        coordinates: {
          longitude: item.longitude,
          latitude: item.latitude,
          height: item.height
        },
        heading: item.heading,
        scale: item.scale,
        alignToGround: true,
        materialMode: 'preserve'
      })
      layer.ready.catch(() => {
        setError(`无法加载 ${item.name}`)
        viewer.models.remove(id)
        URL.revokeObjectURL(url)
        setModels((current) => current.filter((entry) => entry.id !== id))
      })
    } catch {
      setError(`无法加载 ${file.name}`)
      URL.revokeObjectURL(url)
      return
    }
    setModels((current) => [...current, item])
    setSelectedId(id)
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  const applyTransform = (): void => {
    if (!selected) return
    viewer.models.remove(selected.id)
    setError(null)
    try {
      const layer = viewer.models.add({
        type: 'gltf',
        id: selected.id,
        url: selected.url,
        coordinates: {
          longitude: selected.longitude,
          latitude: selected.latitude,
          height: selected.height
        },
        heading: selected.heading,
        scale: selected.scale,
        alignToGround: true,
        materialMode: 'preserve'
      })
      layer.ready.catch(() => setError(`无法重新加载 ${selected.name}`))
    } catch {
      setError(`无法移动 ${selected.name}`)
    }
  }

  const removeModel = (id: string): void => {
    const item = models.find((model) => model.id === id)
    viewer.models.remove(id)
    if (item) URL.revokeObjectURL(item.url)
    setModels((current) => current.filter((model) => model.id !== id))
    setSelectedId((current) => (current === id ? null : current))
  }

  const updateSelected = (patch: Partial<StudioModel>): void => {
    if (!selected) return
    setModels((current) =>
      current.map((model) => (model.id === selected.id ? { ...model, ...patch } : model))
    )
  }

  const flyToSelected = (): void => {
    if (!selected) return
    viewer.camera.flyTo({
      destination: {
        longitude: selected.longitude,
        latitude: selected.latitude,
        height: Math.max(240, selected.height + 320)
      },
      orientation: { heading: 0, pitch: -55, roll: 0 },
      duration: 1.1
    })
  }

  return (
    <Stack spacing={1.5}>
      <Typography variant="h6">模型</Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}

      <input
        ref={fileRef}
        hidden
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        onChange={(event) => setFile(event.target.files?.[0] ?? null)}
      />
      <Button
        variant="outlined"
        startIcon={<FolderOpen />}
        onClick={() => fileRef.current?.click()}
      >
        {file ? file.name : '选择 GLB / glTF'}
      </Button>
      <Button variant="contained" startIcon={<Add />} disabled={!file} onClick={addModel}>
        添加模型
      </Button>

      {models.length > 0 ? (
        <>
          <Divider />
          <List dense disablePadding>
            {models.map((model) => (
              <ListItemButton
                key={model.id}
                selected={model.id === selectedId}
                onClick={() => setSelectedId(model.id)}
                sx={{ borderRadius: 1, mb: 0.5 }}
              >
                <ListItemIcon sx={{ minWidth: 32 }}>
                  <PlaceOutlined fontSize="small" />
                </ListItemIcon>
                <ListItemText primary={model.name} secondary="场景模型" />
                <IconButton
                  size="small"
                  aria-label={`删除 ${model.name}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    removeModel(model.id)
                  }}
                >
                  <DeleteOutlined fontSize="small" />
                </IconButton>
              </ListItemButton>
            ))}
          </List>
        </>
      ) : null}

      {selected ? (
        <>
          <Divider />
          <Typography variant="subtitle2">移动 {selected.name}</Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="经度"
              type="number"
              value={selected.longitude}
              onChange={(event) => updateSelected({ longitude: Number(event.target.value) })}
            />
            <TextField
              size="small"
              label="纬度"
              type="number"
              value={selected.latitude}
              onChange={(event) => updateSelected({ latitude: Number(event.target.value) })}
            />
          </Stack>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              label="高度"
              type="number"
              value={selected.height}
              onChange={(event) => updateSelected({ height: Number(event.target.value) })}
            />
            <TextField
              size="small"
              label="朝向"
              type="number"
              value={selected.heading}
              onChange={(event) => updateSelected({ heading: Number(event.target.value) })}
            />
            <TextField
              size="small"
              label="缩放"
              type="number"
              value={selected.scale}
              onChange={(event) => updateSelected({ scale: Number(event.target.value) })}
            />
          </Stack>
          <Box>
            <Button variant="contained" onClick={applyTransform}>
              应用位置
            </Button>
            <Button variant="outlined" sx={{ ml: 1 }} onClick={flyToSelected}>
              定位
            </Button>
          </Box>
        </>
      ) : null}
    </Stack>
  )
}
