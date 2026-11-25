# 水体模型接口

本文只描述**模型接口与接入契约**。当前项目内**不实现、也不内置任何具体模型**（没有演示坝、闸门、透水栅，没有模型文件、加载按钮或模型解析器）。后续模型通过外部文件/接口传入，再由调用方转换为本文的契约结构。

相关文档：[包类结构](./package-structure.md) · [MUI 界面](./mui-ui.md)

---

## 1. 设计边界

项目保留：

- 三类模型的**数据契约**：`DamStructure`、`GateStructure`、`PermeableStructure`；
- 模型集合契约：`WaterModelSet`；
- 把契约应用到水体模拟的入口：`WaterEditor.setWaterModels`；
- 贴地结构、闸门实体墙、底孔过流、闸墙水面裁切等**通用模拟能力**。

项目不包含：

- 任何具体模型实例或默认模型；
- 模型 glTF/3D Tiles 资产；
- 模型文件解析器、文件选择器、加载按钮（**水体模拟模型**不提供；场景控制台的「模型」Tab 仅做视觉模型，见下）；
- 模型 UI 开关；
- 演示模型生成脚本或演示 E2E。

默认 `WaterModelSet` 为空，场景只有地球、地形、影像和水体。

> 场景控制端口 `5174/?scene=1` 的「模型」Tab 使用 `viewer.models.add/remove` 加载本地
> GLB / glTF，并支持经纬高、朝向、缩放调整；它**不会**写入 `WaterModelSet`，也不参与浅水模拟。

---

## 2. 模型契约

### 2.1 集合

```ts
interface WaterModelSet {
  terrain: DamStructure | null
  gate: GateStructure | null
  permeable: PermeableStructure | null
}
```

三类模型各最多一个。`createEmptyWaterModels()` 返回空集合。

### 2.2 贴地模型 `DamStructure`

```ts
interface DamStructure {
  id: string
  name: string
  kind: 'terrain'
  centerX: number
  centerZ: number
  headingDegrees: number
  lengthMeters: number
  crestWidthMeters: number
  baseWidthMeters: number
  crestElevation: number
  bottomElevation: number
  heightMeters: number
}
```

- `centerX/centerZ`：模拟域平面坐标，x 东、z 北，单位米；
- `crestElevation/bottomElevation`：绝对椭球高程，单位米；
- `headingDegrees`：0 = 东西向，顺时针为正；
- 该模型通过 `buildSimStructure` 变成模拟附加高度场；
- `kind: 'terrain'` 表示“贴地并参与模拟场”。

### 2.3 闸门模型 `GateStructure`

```ts
interface GateStructure {
  id: string
  name: string
  kind: 'gate'
  centerX: number
  centerZ: number
  headingDegrees: number
  widthMeters: number
  thicknessMeters: number
  bandMeters: number
  sillElevation: number
  crestElevation: number
  heightMeters: number
  openingMeters: number
  maxOpeningMeters: number
  dischargeCoefficient: number
}
```

- 闸墙沿坝轴方向宽 `widthMeters`、厚 `thicknessMeters`；
- 两侧移水条带 `bandMeters` 用于底部过流；
- `sillElevation` 闸底高程，`crestElevation` 闸顶高程；
- `openingMeters` 当前开度，`maxOpeningMeters` 最大开度；
- `dischargeCoefficient` 流量系数；
- 该模型不抬高地形，由模拟 shader 按实体矩形裁水，水面片元也在同一矩形内裁切。

### 2.4 透水模型 `PermeableStructure`

```ts
interface PermeableStructure {
  id: string
  name: string
  kind: 'permeable'
  centerX: number
  centerZ: number
}
```

只有位置契约，不参与模拟；具体视觉资产由外部加载。

---

## 3. 公开 API

`WaterEditor` 提供以下成员（`window.waterEditor` 可访问）：

| 成员                     | 说明                                       |
| ------------------------ | ------------------------------------------ |
| `currentModels`          | 当前模型集合快照                           |
| `setWaterModels(models)` | 应用模型集合；域已建立时重建模拟并重置水位 |
| `clearWaterModels()`     | 清空模型集合                               |
| `setGateOpening(meters)` | 设置闸门开度（0–`maxOpeningMeters`）       |
| `getModelKinds()`        | 当前模型类型摘要，供外部 UI 使用           |

默认不调用任何模型 API 时，`currentModels` 为：

```ts
{ terrain: null, gate: null, permeable: null }
```

### 3.1 从文件接入

文件格式由调用方定义；项目只要求最终映射为 `WaterModelSet`：

```ts
const raw = JSON.parse(await file.text()) // 文件内容由外部约定
const models: WaterModelSet = {
  terrain: raw.terrain ?? null,
  gate: raw.gate ?? null,
  permeable: raw.permeable ?? null
}
waterEditor.setWaterModels(models)
```

示意文件结构（**项目不提供该文件，也不解析它**）：

```json
{
  "terrain": {
    "id": "reservoir-dam",
    "name": "某水库大坝",
    "kind": "terrain",
    "centerX": 0,
    "centerZ": 0,
    "headingDegrees": 0,
    "lengthMeters": 1200,
    "crestWidthMeters": 10,
    "baseWidthMeters": 120,
    "crestElevation": 150,
    "bottomElevation": 90,
    "heightMeters": 60
  },
  "gate": {
    "id": "spillway-gate",
    "name": "溢洪道闸门",
    "kind": "gate",
    "centerX": 0,
    "centerZ": 0,
    "headingDegrees": 0,
    "widthMeters": 40,
    "thicknessMeters": 6,
    "bandMeters": 100,
    "sillElevation": 100,
    "crestElevation": 150,
    "heightMeters": 50,
    "openingMeters": 0,
    "maxOpeningMeters": 5,
    "dischargeCoefficient": 0.62
  },
  "permeable": {
    "id": "permeable-grate",
    "name": "透水栅",
    "kind": "permeable",
    "centerX": 300,
    "centerZ": 500
  }
}
```

### 3.2 视觉模型

`WaterModelSet` 只覆盖**水体模拟契约**。模型的 3D 外观（glTF / 3D Tiles / 程序化网格）由外部加载，例如：

```ts
viewer.models.add({
  type: 'gltf',
  id: 'reservoir-dam',
  url: '/models/reservoir-dam.glb',
  coordinates: { longitude, latitude, height: bottomElevation },
  scale: [lengthMeters, heightMeters, baseWidthMeters],
  heading: headingDegrees
})
```

项目不内置 `modelUrl` 字段或模型资产；调用方需要保证视觉模型与 `DamStructure`/`GateStructure` 使用同一组位置、朝向和尺寸参数。

---

## 4. 应用生命周期

```text
setWaterModels(models)
  ├─ 拷贝模型集合
  ├─ 域已建立：rebuildSimulation()
  │   ├─ disposeSimulation()
  │   ├─ createSimulation()
  │   │   ├─ buildSimStructure(terrain, field, resolution, gate)
  │   │   ├─ ShallowWaterSim.setGate(gate)
  │   │   └─ WaterSurface.setGate(gate)
  │   └─ syncAll()
  └─ 域未建立：仅记录配置，建域时应用
```

- 模型变化会重建模拟并**重置水位**；
- 默认场景不调用任何模型 API，因此不创建结构/闸门；
- 模型集合不做持久化，刷新后为空；
- 项目不自动发现模型文件，必须由外部代码读取文件后调用 `setWaterModels`。

---

## 5. 闸门过流（通用能力）

```text
Q = Cd · b · a · sqrt(2gH)
```

- `Cd`：`dischargeCoefficient`；
- `b`：`widthMeters`；
- `a`：`openingMeters`；
- `H`：上游水面到孔口中心的水头，负值取 0。

开度 0 时 `Q = 0`，即闸门叶贴地、无下泄。`WaterEditor` 每 250 ms 读取上游探针水深，计算 Q 后写入模拟 uniform。

这是演示级/可视化级公式，不用于真实闸门水力计算。

---

## 6. 当前未实现的内容

- 模型文件格式与解析器；
- 模型资产加载与坐标标定；
- 模型 UI（没有加载/清空开关）；
- 默认模型与演示模型；
- 闸门叶的视觉升降（只有模拟层的开度与流量）；
- 动态闸门结构（`setStructure` 会重置水位）。

后续接入模型时，只需新增「文件读取 → `WaterModelSet`」这一层，水体侧的 `setWaterModels` 契约保持不变。
