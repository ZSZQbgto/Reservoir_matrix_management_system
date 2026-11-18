/**
 * 太阳位置与水面光照配色。
 *
 * - `computeSunDirectionENU` 用 NOAA 简化太阳位置算法（JD/平黄经/平近点角/黄赤交角
 *   + 格林尼治平恒星时），返回单位向量，分量顺序为 **[east, up, north]**。
 * - 调色板返回的是 **水面着色器输出的线性 HDR 值**（AgX tone mapping 之前）。
 *   Tellux 用 `postProcess.toneMapping.mode = 'agx'` + exposure 5.4 在渲染管线末端
 *   统一 tone map；并且在此之前 `AerialPerspectiveEffect` 的后处理光照会把 scene
 *   颜色按太阳高度乘一个色偏因子 F（实测 15.57° 时 F ≈ (0.1485, 0.1087, 0.0904)）。
 *   调色板常量 = AgX 反求(目标显示 sRGB) / F，因此参考光照下显示为目标颜色，
 *   其他时刻随场景整体明暗一起变化。
 */

import * as THREE from 'three'

const DEG = Math.PI / 180
const DAY_MS = 86_400_000
const JULIAN_UNIX_EPOCH = 2_440_587.5
const JULIAN_J2000 = 2_451_545.0

/** 调色板为线性 scene radiance 三元组 [r, g, b]。 */
type Rgb = readonly [number, number, number]

/**
 * 日间调色板（水体空间 HDR 值）。
 *
 * 标定链路：Tellux 的 AgX tone mapping（exposure 5.4）之前还有
 * `AerialPerspectiveEffect` 的后处理光照（sun/sky irradiance / π），
 * 它把 scene 颜色当作 albedo 再乘一个与太阳高度相关的色偏因子 F。
 * 在太阳高度 15.57°（2026-11-17 15:30 北京）实测
 * `F_ref = (0.1485, 0.1087, 0.0904)`；下面的常量 = AgX 反求(目标显示色) / F_ref，
 * 即「在该参考光照下显示为目标 sRGB 色」。太阳高度变化时整幅场景（含地形）
 * 一起被 F 缩放，水面亮度自动跟随场景明暗。
 *
 * 目标显示色：skyZenith ≈ #99c9f2、skyHorizon ≈ #d1e6fa、deep ≈ #1a3d47、
 * shallow ≈ #386659、foam ≈ #cce0e0。
 */
const DAY: {
  skyZenith: Rgb
  skyHorizon: Rgb
  deep: Rgb
  shallow: Rgb
  foam: Rgb
  sun: Rgb
} = {
  skyZenith: [0.076643, 1.24273, 6.145279],
  skyHorizon: [0.963192, 3.454532, 13.247862],
  deep: [0.01543, 0.078404, 0.09264],
  shallow: [0.031008, 0.184196, 0.132991],
  foam: [1.058585, 3.463473, 4.147248],
  sun: [8.832044, 8.906362, 4.103942]
}

/** 黄昏（太阳高度 ≈ 0~8°）：暖橙反射 + 暗青灰水体 + 金色高光。 */
const DUSK: typeof DAY = {
  skyZenith: [0.103567, 0.127077, 0.523969],
  skyHorizon: [2.024886, 0.78014, 0.175138],
  deep: [0.015261, 0.029678, 0.046475],
  shallow: [0.03776, 0.057058, 0.053912],
  foam: [0.773004, 0.967203, 0.770647],
  sun: [1.6, 0.5, 0.12]
}

/** 夜间（太阳高度 < -12°）：深蓝反射 + 近黑水体。 */
const NIGHT: typeof DAY = {
  skyZenith: [0.012995, 0.020254, 0.061562],
  skyHorizon: [0.020856, 0.033806, 0.102972],
  deep: [0.007995, 0.013955, 0.021646],
  shallow: [0.011019, 0.018833, 0.025282],
  foam: [0.02401, 0.038174, 0.054162],
  sun: [0.1, 0.14, 0.26]
}

/** 太阳状态与水面配色。 */
export interface SunState {
  /** ENU 单位方向 [east, up, north]。 */
  direction: THREE.Vector3
  /** 太阳高度角（弧度，地平线以上为正）。 */
  altitude: number
  /** 太阳方位角（弧度，自北向东）。 */
  azimuth: number
  /** 日/黄昏/夜三档权重，和为 1。 */
  dayWeight: number
  duskWeight: number
  nightWeight: number
  /** 天空反射色（水面着色器 HDR 空间，已按参考后处理光照补偿）。 */
  skyZenith: THREE.Color
  skyHorizon: THREE.Color
  /** 太阳高光/波光颜色（着色器 HDR 空间）。 */
  sunGlintColor: THREE.Color
  /** 太阳高光总强度 0..1，夜间接近 0。 */
  glintStrength: number
  /** 深水/浅水水体基色（着色器 HDR 空间）。 */
  waterDeep: THREE.Color
  waterShallow: THREE.Color
  /** 泡沫颜色（着色器 HDR 空间）。 */
  foamColor: THREE.Color
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0 || 1e-6))
  return t * t * (3 - 2 * t)
}

function colorFromRgb(rgb: Rgb): THREE.Color {
  return new THREE.Color(rgb[0], rgb[1], rgb[2])
}

function mixRgb(day: Rgb, dusk: Rgb, night: Rgb, dayW: number, duskW: number, nightW: number): Rgb {
  return [
    day[0] * dayW + dusk[0] * duskW + night[0] * nightW,
    day[1] * dayW + dusk[1] * duskW + night[1] * nightW,
    day[2] * dayW + dusk[2] * duskW + night[2] * nightW
  ]
}

/** 由太阳高度角得到日/黄昏/夜三档权重（平滑、和为 1）。 */
export function sunWeightsForAltitude(altitude: number): {
  dayWeight: number
  duskWeight: number
  nightWeight: number
} {
  const dayWeight = smoothstep(0.06, 0.26, altitude)
  const nightWeight = 1 - smoothstep(-0.32, -0.1, altitude)
  const duskWeight = Math.max(0, 1 - dayWeight - nightWeight)
  const total = dayWeight + duskWeight + nightWeight || 1
  return {
    dayWeight: dayWeight / total,
    duskWeight: duskWeight / total,
    nightWeight: nightWeight / total
  }
}

/**
 * 太阳高度角（弧度）→ 水面天空反射主色（线性辐射亮度）。
 *
 * 日间是亮蓝、黄昏偏暖橙、夜间深蓝。
 */
export function skyTintForSun(altitude: number): THREE.Color {
  const { dayWeight, duskWeight, nightWeight } = sunWeightsForAltitude(altitude)
  return colorFromRgb(
    mixRgb(DAY.skyZenith, DUSK.skyZenith, NIGHT.skyZenith, dayWeight, duskWeight, nightWeight)
  )
}

/** 太阳高度角（弧度）→ 天空反射的「地平线」色（线性辐射亮度）。 */
export function skyHorizonTintForSun(altitude: number): THREE.Color {
  const { dayWeight, duskWeight, nightWeight } = sunWeightsForAltitude(altitude)
  return colorFromRgb(
    mixRgb(DAY.skyHorizon, DUSK.skyHorizon, NIGHT.skyHorizon, dayWeight, duskWeight, nightWeight)
  )
}

/** 太阳高度角（弧度）→ 太阳高光颜色（线性辐射亮度）。 */
export function sunColorForAltitude(altitude: number): THREE.Color {
  const { dayWeight, duskWeight, nightWeight } = sunWeightsForAltitude(altitude)
  return colorFromRgb(mixRgb(DAY.sun, DUSK.sun, NIGHT.sun, dayWeight, duskWeight, nightWeight))
}

/**
 * 由太阳方向（ENU，单位向量）推导完整光照状态。
 *
 * 只读取 up 分量作为太阳高度角，因此传入未归一化向量时会先归一化。
 */
export function sunStateForDirection(directionEnu: THREE.Vector3): SunState {
  const direction = directionEnu.clone().normalize()
  const altitude = Math.asin(Math.min(1, Math.max(-1, direction.y)))
  return sunStateForAltitude(direction, altitude, Math.atan2(direction.x, direction.z))
}

/** 由高度角直接构造光照状态（方位角可任填）。 */
export function sunStateForAltitude(
  direction: THREE.Vector3,
  altitude: number,
  azimuth = 0
): SunState {
  const { dayWeight, duskWeight, nightWeight } = sunWeightsForAltitude(altitude)
  return {
    direction: direction.clone().normalize(),
    altitude,
    azimuth,
    dayWeight,
    duskWeight,
    nightWeight,
    skyZenith: colorFromRgb(
      mixRgb(DAY.skyZenith, DUSK.skyZenith, NIGHT.skyZenith, dayWeight, duskWeight, nightWeight)
    ),
    skyHorizon: colorFromRgb(
      mixRgb(DAY.skyHorizon, DUSK.skyHorizon, NIGHT.skyHorizon, dayWeight, duskWeight, nightWeight)
    ),
    sunGlintColor: colorFromRgb(
      mixRgb(DAY.sun, DUSK.sun, NIGHT.sun, dayWeight, duskWeight, nightWeight)
    ),
    glintStrength: dayWeight * 1 + duskWeight * 0.55 + nightWeight * 0.06,
    waterDeep: colorFromRgb(
      mixRgb(DAY.deep, DUSK.deep, NIGHT.deep, dayWeight, duskWeight, nightWeight)
    ),
    waterShallow: colorFromRgb(
      mixRgb(DAY.shallow, DUSK.shallow, NIGHT.shallow, dayWeight, duskWeight, nightWeight)
    ),
    foamColor: colorFromRgb(
      mixRgb(DAY.foam, DUSK.foam, NIGHT.foam, dayWeight, duskWeight, nightWeight)
    )
  }
}

/** 朱利安日（UTC）。 */
export function julianDay(date: Date): number {
  return date.getTime() / DAY_MS + JULIAN_UNIX_EPOCH
}

/**
 * NOAA 简化太阳位置：返回 ENU 单位方向 [east, up, north]。
 *
 * 精度约 0.01°（未含大气折射），对本项目的太阳高光/天空配色足够。
 */
export function computeSunDirectionENU(
  date: Date,
  longitude: number,
  latitude: number
): THREE.Vector3 {
  const daysSinceJ2000 = julianDay(date) - JULIAN_J2000

  // 平黄经与平近点角（度）。
  const meanLongitude = (280.46 + 0.9856474 * daysSinceJ2000) % 360
  const meanAnomaly = ((357.528 + 0.9856003 * daysSinceJ2000) % 360) * DEG
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG

  // 黄赤交角与黄道坐标 → 赤道坐标。
  const obliquity = (23.439 - 0.0000004 * daysSinceJ2000) * DEG
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude)
  )
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude))

  // 格林尼治平恒星时 → 当地恒星时 → 时角。
  const gmst = (280.46061837 + 360.98564736629 * daysSinceJ2000) % 360
  const localSidereal = (gmst + longitude) * DEG
  const hourAngle = localSidereal - rightAscension

  const latitudeRad = latitude * DEG
  const sinAltitude =
    Math.sin(latitudeRad) * Math.sin(declination) +
    Math.cos(latitudeRad) * Math.cos(declination) * Math.cos(hourAngle)
  const altitude = Math.asin(clamp01((sinAltitude + 1) * 0.5) * 2 - 1)
  const cosAltitude = Math.cos(altitude)

  // 方位角：自北向东，顺时针为正。
  const sinAzimuth = -Math.cos(declination) * Math.sin(hourAngle)
  const cosAzimuthNumerator =
    Math.sin(declination) - Math.sin(altitude) * Math.sin(latitudeRad)
  const cosAzimuthDenominator = Math.max(Math.cos(latitudeRad), 1e-6)
  const azimuth = Math.atan2(sinAzimuth, cosAzimuthNumerator / cosAzimuthDenominator)

  return new THREE.Vector3(
    cosAltitude * Math.sin(azimuth),
    Math.sin(altitude),
    cosAltitude * Math.cos(azimuth)
  ).normalize()
}

/** 计算太阳 ENU 方向并附带完整水面配色。 */
export function computeSunState(date: Date, longitude: number, latitude: number): SunState {
  return sunStateForDirection(computeSunDirectionENU(date, longitude, latitude))
}
