import { useCallback, useState } from 'react'
import type { Viewer } from 'tellux'
import { DEFAULT_TIME_MINUTES, minutesToSceneDate } from '../../shared/format'

export type CloudQuality = 'low' | 'medium' | 'high' | 'ultra'

export interface EnvironmentState {
  cloudsShow: boolean
  coverage: number
  altitude: number
  height: number
  speed: number
  quality: CloudQuality
  atmosphere: boolean
  minutes: number
}

export interface EnvironmentActions {
  setCloudsShow(value: boolean): void
  setCoverage(value: number): void
  setAltitude(value: number): void
  setHeight(value: number): void
  setSpeed(value: number): void
  setQuality(value: CloudQuality): void
  setAtmosphere(value: boolean): void
  setMinutes(value: number): void
}

export function useEnvironment(viewer: Viewer | null): [EnvironmentState, EnvironmentActions] {
  const [state, setState] = useState<EnvironmentState>(() => ({
    cloudsShow: false,
    coverage: 30,
    altitude: 9000,
    height: 800,
    speed: 1,
    quality: 'high',
    atmosphere: true,
    minutes: DEFAULT_TIME_MINUTES
  }))

  const setCloudsShow = useCallback(
    (value: boolean) => {
      if (viewer) viewer.scene.clouds.show = value
      setState((current) => ({ ...current, cloudsShow: value }))
    },
    [viewer]
  )

  const setCoverage = useCallback(
    (value: number) => {
      if (viewer) viewer.scene.clouds.coverage = value / 100
      setState((current) => ({ ...current, coverage: value }))
    },
    [viewer]
  )

  const setAltitude = useCallback(
    (value: number) => {
      if (viewer) viewer.scene.clouds.layer.altitude = value
      setState((current) => ({ ...current, altitude: value }))
    },
    [viewer]
  )

  const setHeight = useCallback(
    (value: number) => {
      if (viewer) viewer.scene.clouds.layer.height = value
      setState((current) => ({ ...current, height: value }))
    },
    [viewer]
  )

  const setSpeed = useCallback(
    (value: number) => {
      if (viewer) viewer.scene.clouds.speed = value * 0.001
      setState((current) => ({ ...current, speed: value }))
    },
    [viewer]
  )

  const setQuality = useCallback(
    (value: CloudQuality) => {
      if (viewer) viewer.scene.clouds.quality = value
      setState((current) => ({ ...current, quality: value }))
    },
    [viewer]
  )

  const setAtmosphere = useCallback(
    (value: boolean) => {
      if (viewer) viewer.scene.atmosphere.show = value
      setState((current) => ({ ...current, atmosphere: value }))
    },
    [viewer]
  )

  const setMinutes = useCallback(
    (value: number) => {
      if (viewer) viewer.clock.currentTime = minutesToSceneDate(value)
      setState((current) => ({ ...current, minutes: value }))
    },
    [viewer]
  )

  return [
    state,
    {
      setCloudsShow,
      setCoverage,
      setAltitude,
      setHeight,
      setSpeed,
      setQuality,
      setAtmosphere,
      setMinutes
    }
  ]
}
