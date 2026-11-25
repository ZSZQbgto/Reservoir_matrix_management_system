import { sampleFieldHeight } from './terrainField'
import type { SimGate, SimStructure, TerrainField, WaterModelKind } from './types'

/**
 * 贴地模型契约：模型提供自己的几何参数，项目不内置具体模型实例。
 *
 * 后续可以通过文件/接口传入这些字段，再交给 `buildSimStructure` 生成
 * 模拟结构高度场。
 */
export interface DamStructure {
  id: string
  name: string
  kind: Extract<WaterModelKind, 'terrain'>
  /** 坝轴线中心，域平面坐标（米，x 东 / z 北）。 */
  centerX: number
  centerZ: number
  /** 坝轴线方向：0 = 东西向，顺时针为正（度）。 */
  headingDegrees: number
  lengthMeters: number
  /** 坝顶宽度（米）。 */
  crestWidthMeters: number
  /** 坝底宽度（米）。 */
  baseWidthMeters: number
  /** 坝顶绝对椭球高程（米）。 */
  crestElevation: number
  /** 坝底绝对椭球高程（米）。 */
  bottomElevation: number
  /** 坝高（米），= crestElevation - bottomElevation。 */
  heightMeters: number
}

/**
 * 闸门模型契约：闸墙中间留出 `widthMeters` 宽的孔口，闸门叶贴地关闭；
 * 开启时只从底部过流，Q 由开度和上游水头决定。
 *
 * 与 `DamStructure` 共用坝轴线中心和方向时，闸门落在坝体中间的缺口里。
 */
export interface GateStructure {
  id: string
  name: string
  kind: Extract<WaterModelKind, 'gate'>
  centerX: number
  centerZ: number
  headingDegrees: number
  widthMeters: number
  thicknessMeters: number
  /** 闸墙两侧的移水条带宽度（米）。 */
  bandMeters: number
  sillElevation: number
  crestElevation: number
  heightMeters: number
  openingMeters: number
  maxOpeningMeters: number
  /** 流量系数 Cd。 */
  dischargeCoefficient: number
}

/**
 * 把坝体几何采样成模拟网格上的“附加高度场”。
 *
 * 断面是梯形：坝顶宽 `crestWidthMeters`，坝底宽 `baseWidthMeters`；
 * 离坝轴线越远，可挡水高度越低。每个格子取“结构顶面高程 - 地形高程”，
 * 负值夹到 0，因此坝肩会自然埋入更高的山体。
 */
export function buildSimStructure(
  dam: DamStructure,
  field: TerrainField,
  resolution: number,
  gate: GateStructure | null = null
): SimStructure {
  const n = Math.max(2, Math.round(resolution))
  const sizeMeters = field.sizeMeters
  const half = sizeMeters / 2
  const cellWidth = sizeMeters / n
  const heights = new Float32Array(n * n)

  const headingRad = (dam.headingDegrees * Math.PI) / 180
  const axisX = Math.cos(headingRad)
  const axisZ = Math.sin(headingRad)
  const acrossX = -axisZ
  const acrossZ = axisX

  const crestRel = dam.crestElevation - field.baseElevation
  const bottomRel = dam.bottomElevation - field.baseElevation
  // 模拟网格比坝顶宽得多（8 km / 256 ≈ 31 m）：坝顶平台至少覆盖 1.5 个格子，
  // 否则坝顶可能正好落在两个格子中心之间，水会从“看不见的缝”里穿过去。
  const crestHalf = Math.max(dam.crestWidthMeters / 2, cellWidth * 0.75)
  const baseHalf = Math.max(crestHalf + cellWidth, dam.baseWidthMeters / 2)
  const slope = (crestRel - bottomRel) / (baseHalf - crestHalf)
  const halfLength = dam.lengthMeters / 2

  for (let j = 0; j < n; j += 1) {
    const z = -half + (j + 0.5) * cellWidth
    for (let i = 0; i < n; i += 1) {
      const x = -half + (i + 0.5) * cellWidth
      const dx = x - dam.centerX
      const dz = z - dam.centerZ
      const along = dx * axisX + dz * axisZ
      if (Math.abs(along) > halfLength) continue
      // 闸门孔口：把坝体结构挖空，由闸门实体墙单独挡水/过流。
      if (gate && Math.abs(along) <= gate.widthMeters / 2) continue
      const across = Math.abs(dx * acrossX + dz * acrossZ)
      if (across > baseHalf) continue

      const topRel = crestRel - Math.max(0, across - crestHalf) * slope
      const terrainRel = sampleFieldHeight(field, x, z)
      const structureRel = Math.max(0, topRel - terrainRel)
      if (structureRel > 0) heights[j * n + i] = structureRel
    }
  }

  return {
    origin: { ...field.origin },
    sizeMeters,
    resolution: n,
    baseElevation: field.baseElevation,
    heights
  }
}

/** 透水模型契约：只有视觉几何，水可以自由穿过；不写结构场/闸墙。 */
export interface PermeableStructure {
  id: string
  name: string
  kind: Extract<WaterModelKind, 'permeable'>
  centerX: number
  centerZ: number
}

/**
 * 场景模型集合：三类模型各最多一个。
 *
 * 默认是空集合；项目不内置演示模型。后续通过文件/接口把模型描述传入，
 * 调用 `WaterEditor.setWaterModels` 应用。
 */
export interface WaterModelSet {
  terrain: DamStructure | null
  gate: GateStructure | null
  permeable: PermeableStructure | null
}

export function createEmptyWaterModels(): WaterModelSet {
  return { terrain: null, gate: null, permeable: null }
}

/**
 * 闸门实体墙几何：沿坝轴方向 `widthMeters` 宽、厚度至少一格。
 *
 * 这里返回的是给 shader 的矩形参数，不再生成 CPU 实体纹理；水面着色器
 * 在闸墙格直接裁掉水膜，因此不会出现“毛细”吸附。
 */
export function gateSolidGeometry(
  gate: GateStructure,
  cellWidth: number
): {
  halfWidth: number
  halfThickness: number
} {
  return {
    halfWidth: gate.widthMeters / 2 + cellWidth,
    halfThickness: Math.max(gate.thicknessMeters / 2, cellWidth)
  }
}

/** 闸门模型/模拟共用的几何；不包含开度，开度由状态单独驱动。 */
export function toSimGate(gate: GateStructure): SimGate {
  const headingRad = (gate.headingDegrees * Math.PI) / 180
  return {
    centerX: gate.centerX,
    centerZ: gate.centerZ,
    axisX: Math.cos(headingRad),
    axisZ: Math.sin(headingRad),
    widthMeters: gate.widthMeters,
    thicknessMeters: gate.thicknessMeters,
    bandMeters: gate.bandMeters
  }
}

/**
 * 平板闸门底部孔流（可视化级）：
 * Q = Cd · b · a · sqrt(2gH)，H 取上游水面到孔口中心的水头。
 * 开度 a = 0 时 Q = 0，即闸门贴地、没有下泄。
 */
export function computeGateDischarge(
  gate: GateStructure,
  upstreamSurfaceElevation: number
): number {
  const opening = Math.max(0, Math.min(gate.maxOpeningMeters, gate.openingMeters))
  if (opening <= 0) return 0
  const head = Math.max(0, upstreamSurfaceElevation - gate.sillElevation - opening * 0.5)
  if (head <= 0) return 0
  const flow = gate.dischargeCoefficient * gate.widthMeters * opening * Math.sqrt(2 * 9.81 * head)
  return Number.isFinite(flow) ? Math.max(0, flow) : 0
}
