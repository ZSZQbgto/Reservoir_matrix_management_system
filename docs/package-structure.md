# 包类结构

相关文档：[MUI 界面与双入口](./mui-ui.md) · [水体模型 API](./water-models-api.md)

## 1. 目录

```text
src/
├─ main.ts                    # 创建 Viewer，挂载无头 WaterEditor 与 MUI
├─ global.d.ts                # window.viewer / window.waterEditor / __waterEditor
├─ assets/                    # favicon、字体
├─ shared/
│  ├─ assets.ts
│  ├─ format.ts
│  └─ math.ts
├─ ui/
│  ├─ cloudDefaults.ts        # 云/大气默认值
│  └─ mui/
│     ├─ App.tsx              # 业务页（5173）
│     ├─ SceneApp.tsx         # 场景控制台（5174/?scene=1）
│     ├─ BusinessPanel.tsx
│     ├─ SourcePanel.tsx
│     ├─ SimulationCluster.tsx
│     ├─ AppearanceControls.tsx
│     ├─ EnvironmentCluster.tsx
│     ├─ ModelStudio.tsx
│     ├─ GuideCluster.tsx
│     ├─ StatusCluster.tsx
│     ├─ ToastLayer.tsx
│     ├─ bridge.ts            # __waterEditor → React 快照/命令
│     ├─ mount.tsx            # MUI 启动页与页面选择
│     ├─ theme.ts
│     └─ base.css
└─ water/
   ├─ types.ts                # 状态、常量、归一化
   ├─ persistence.ts          # localStorage 自动持久化
   ├─ structures.ts           # Dam / Gate / Permeable 契约
   ├─ waterEditor.ts          # 无头领域核心
   ├─ waterPointerController.ts
   ├─ markers.ts
   ├─ waterDomainBuilder.ts
   ├─ domainCache.ts
   ├─ terrainField.ts
   ├─ terrainSampling.ts
   ├─ shallowWater.ts
   ├─ simShaders.ts
   ├─ waterSurface.ts
   ├─ waterShaders.ts
   ├─ waterTextures.ts
   ├─ sun.ts
   └─ async.ts
```

`index.html` 只保留 `#viewer` 与 `#mui-root` 两个挂载点。

## 2. 分层

```text
main.ts
  ├─ tellux.Viewer
  ├─ WaterEditor（无头：状态/模拟/交互/持久化）
  └─ startMuiUi
       ├─ App（业务）
       └─ SceneApp（场景控制）
            ├─ bridge.ts（读取/下发命令）
            └─ MUI 组件
```

- `src/shared`：无业务依赖的叶子模块。
- `src/water`：水体领域。`WaterEditor` 不查询 DOM、不操作 MUI 组件。
- `src/ui/mui`：只使用 `@mui/material` 与 `@mui/icons-material`；通过 `window.__waterEditor` 调用领域命令。
- 可见控件不使用手写边框、按钮、开关样式；布局使用 `AppBar`、`Drawer`、`Tabs`、`Card`、`List`、`Stack`。

## 3. `WaterEditor`

职责：固定 8 km × 8 km 模拟域、地形缓存/采样、水源放置与拖动、浅水模拟、工程持久化。

公开读取：

| 成员                                | 说明                   |
| ----------------------------------- | ---------------------- |
| `currentMode` / `currentState`      | 当前模式与状态快照     |
| `currentModels` / `getModelKinds()` | 外部模型契约与类型摘要 |
| `isDomainReady`                     | 域、模拟、水面齐全     |
| `setGateOpening(meters)`            | 闸门开度               |

`window.__waterEditor` 暴露给 MUI 的命令：

| 命令                                                           | 说明         |
| -------------------------------------------------------------- | ------------ |
| `getMode` / `getState` / `getStats` / `getProgress`            | 读取         |
| `isPlacing` / `isBuilding` / `getSelectedId`                   | 读取交互状态 |
| `getSourceScreenPosition` / `getFieldInfo`                     | 读取投影信息 |
| `enterWaterMode` / `enterSceneMode`                            | 模式         |
| `togglePlacing` / `cancelPlacing` / `placeSourceAt`            | 放置水源     |
| `selectSource` / `deleteSource` / `clearSources` / `setSource` | 水源编辑     |
| `setSimSettings` / `setVisual` / `setEnabled`                  | 模拟与外观   |
| `resetSimulation` / `rebuildSimulation` / `rebuildDomain`      | 重置与重建   |
| `waitReady`                                                    | 等待域完成   |

## 4. 数据流

```text
MUI 控件
  → bridge.ts 命令
  → WaterEditor 状态
  → ShallowWaterSim / WaterSurface / SourceMarkers
  → React 220 ms 轮询快照
  → MUI 控件
```

- `WaterEditor` 是 `WaterState` 唯一写入者。
- `WaterPointerController` 只处理画布指针事件，通过回调调用 `WaterEditor`。
- 模型通过 `WaterModelSet` 注入；本项目不内置具体坝/闸/透水模型。
- 场景控制台的模型 Tab 通过 `viewer.models.add/remove` 加载本地 glTF，不进入水体模拟。

## 5. 端口

| 端口            | 页面       | 内容                    |
| --------------- | ---------- | ----------------------- |
| `5173`          | `App`      | 水库矩阵骨架 + 场景联动 |
| `5174/?scene=1` | `SceneApp` | 环境 / 水体 / 模型      |

```bash
npm run dev        # 业务
npm run dev:scene  # 场景控制
```

## 6. 命令

| 命令                                      | 内容                      |
| ----------------------------------------- | ------------------------- |
| `npm run type-check`                      | `tsc --noEmit`            |
| `npm run lint`                            | ESLint                    |
| `npm run format:check`                    | Prettier 检查             |
| `npm test`                                | 状态单测                  |
| `npm run check`                           | 类型 / lint / 格式 / 测试 |
| `npm run build`                           | 生产构建                  |
| `npm run cache:prefetch` / `cache:static` | 瓦片预热                  |
