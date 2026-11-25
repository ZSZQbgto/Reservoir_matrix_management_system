# MUI 界面与双入口

前端只保留 MUI 组件层；原 `index.html` 静态 HUD 与 `waterEditorDom` / `waterPanelView` /
`waterControlsBinder` 已移除。`WaterEditor` 不查询 DOM，MUI 通过 `window.__waterEditor`
读取状态、下发命令。

## 1. 两个入口

| 入口     | 开发命令            | 地址                             | 当前职责                    |
| -------- | ------------------- | -------------------------------- | --------------------------- |
| 业务     | `npm run dev`       | `http://127.0.0.1:5173/`         | 水库矩阵管理骨架 + 场景联动 |
| 场景编辑 | `npm run dev:scene` | `http://127.0.0.1:5174/?scene=1` | 环境 / 水体 / 模型 / 重建域 |

`startMuiUi` 根据 `?scene=1` 挂载 `SceneApp` 或 `App`。业务页右上角「场景」、场景页右上角
「业务」互相跳转。

## 2. 业务页

- `AppBar`：`TELLUX 水库矩阵`、相机读数、`场景`入口。
- 左 `Drawer`：`MatrixPanel`，责任 / 任务 / 风险三个 Tab；当前为矩阵系统骨架，数据模块待接入。
- 右 `Drawer`：`SceneLinkPanel`，显示场景页的实时运行状态、水源、模拟统计、选中水源。
- 点击「场景对象」中的水源，会写入 `focusSourceId`，场景页选中并飞向该水源。
- 业务页 3D 画面为只读镜像：水体状态和相机视角跟随场景页。
- 业务页不提供水源、模拟、模型、云层控制。

## 3. 场景编辑端

- `AppBar`：运行状态、相机读数、`重建域`、`业务`入口。
- 左 `Drawer` 三个 Tab：
  - **环境**：体积云、云量、云底、云层厚度、质量、大气、时间。
  - **水体**：`SourcePanel` 水源列表 / 编辑 / 放置 / 清空，模拟参数，水面外观。
  - **模型**：本地 GLB / glTF 添加、移动、缩放、定位、删除。
- 顶部「重建域」调用 `rebuildDomain`，重新采样 / 恢复模拟域。
- 场景页每 1.2s 发布水体快照、相机、水源、模型数量、统计与选中水源。

## 4. 跨端口联动

```text
场景页 (5174) ──发布──▶ .cache/live-state.json ◀──轮询── 业务页 (5173)
      ▲                         │
      └──────── focusSourceId ──┘
```

- 开发环境由 `vite.config.ts` 中间件提供 `/api/live-state`；生产由 `server.mjs` 提供。
- 两个 Vite server 共用 `.cache/live-state.json`。
- 写入按 `matrix` / `scene` 分段合并，矩阵与场景互不覆盖。
- 业务端 `applyExternalState()` 镜像水体；`viewer.camera.setView()` 镜像相机。
- 仅适合单机 / 演示；多实例部署需改为数据库或 WebSocket。

## 5. 状态桥

`src/ui/mui/bridge.ts` 定义 `WaterDebugApi`，每 220ms 读取：

- `getMode()`、`getState()`、`getStats()`、`getProgress()`、`isPlacing()`、`isBuilding()`
- `getSelectedId()`、`getGate()`、`getFieldInfo()`、`getSourceScreenPosition()`

命令：

- 水源：`togglePlacing`、`placeSourceAt`、`selectSource`、`deleteSource`、`clearSources`、`setSource`
- 模拟：`setSimSettings`、`setVisual`、`setEnabled`、`resetSimulation`、`rebuildSimulation`
- 域：`rebuildDomain`
- 镜像：`applyExternalState`
- 模式：`enterWaterMode`、`enterSceneMode`

MUI 不直接操作 Three.js、`ShallowWaterSim` 或 `WaterSurface`。

## 6. 约定

- 可见控件全部来自 `@mui/material` / `@mui/icons-material`；不手写按钮、边框、开关样式。
- 页面布局使用 `AppBar`、`Drawer`、`Tabs`、`Card`、`List`、`Table`、`Stack` 等 MUI 组件。
- 文案以动作和状态为主，避免长段说明；必要时用 MUI `Tooltip` / `Alert`。
- 颜色、字体、圆角由 `reservoirTheme` 统一控制。
- 手动保存 / 导出 / 导入入口已移除；`WaterEditor` 仅在本地自动持久化。
