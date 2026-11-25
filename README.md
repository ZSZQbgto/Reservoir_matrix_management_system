# 水库矩阵管理系统 · Tellux Earth

基于 Tellux / Three.js 的单水库数字孪生与水库矩阵管理前端。

当前版本由两个独立入口组成：

- **业务端**：水库矩阵管理系统骨架，暂只实现与场景编辑的联动。
- **场景编辑端**：云层 / 天气 / 时间、水体模拟、水源、视觉模型编辑。

两端通过本地共享状态文件实时同步，业务端只读镜像场景，不提供第二套场景控制。

> 当前阶段说明：矩阵的数据模型、CRUD、责任 / 任务 / 风险流转尚未实现。业务端已为这些能力预留页面结构和联动接口。

---

## 1. 当前状态

| 模块                   | 状态   | 说明                                     |
| ---------------------- | ------ | ---------------------------------------- |
| 三维地球 / 地形 / 影像 | 可用   | Tellux + Cesium World Terrain / 本地缓存 |
| 固定模拟域             | 可用   | 116.77°E, 36.02°N，8 km × 8 km           |
| GPU 浅水模拟           | 可用   | 默认 256² 网格，通量 / 水深两步          |
| 水源放置、拖动、编辑   | 可用   | 场景编辑端「水体」页                     |
| 水体外观 / 模拟参数    | 可用   | 速度、注水、精度、最大流速、阻尼、外观   |
| 云层 / 大气 / 时间     | 可用   | 场景编辑端「环境」页                     |
| 本地 GLB / glTF 模型   | 可用   | 添加、移动、缩放、定位；不参与水体模拟   |
| 业务矩阵页面骨架       | 可用   | 责任 / 任务 / 风险 Tab；数据待接入       |
| 业务 ↔ 场景联动        | 可用   | 场景状态镜像、水源定位、选中状态同步     |
| 矩阵数据 CRUD          | 未实现 | 后续任务                                 |
| 手动保存 / 导出 / 导入 | 已移除 | 编辑器只在本地自动持久化                 |

---

## 2. 功能

### 2.1 场景编辑端（5174）

- **环境**
  - 体积云开关、云量、云底高度、云层厚度、质量。
  - 大气散射开关。
  - 场景时间。
- **水体**
  - 水源列表、选中、编辑、启用 / 关闭、删除、清空。
  - 放置水源（点击地形）。
  - 模拟速度、注水量、分辨率、最大流速、阻尼。
  - 水面外观：高光、高光锐度、天空反射、波纹、波纹尺度、平流速度、泡沫、清澈度、不透明度。
- **模型**
  - 从本地选择 GLB / glTF。
  - 添加、选中、删除。
  - 修改经纬高、朝向、缩放并应用。
  - 定位到模型。
- **域维护**
  - 顶栏「重建域」：重新采样 / 恢复模拟域。

### 2.2 业务端（5173）

- 水库矩阵管理系统骨架：
  - 责任 / 任务 / 风险三个 Tab。
  - 当前仅展示「待接入」占位和场景对象列表。
- 场景联动：
  - 实时读取场景编辑端的运行状态、水深、湿格、水源、模型数量、选中水源。
  - 点击场景对象，场景编辑端选中并飞行到对应水源。
  - 业务端 3D 画面镜像场景编辑端的水体状态与相机视角。
- 业务端不提供场景控制，`viewer.controls.enabled = false`。

---

## 3. 技术栈

| 层          | 技术                                            |
| ----------- | ----------------------------------------------- |
| 三维引擎    | `tellux` 0.3.0、`three` 0.184                   |
| 地形 / 影像 | Cesium World Terrain / Cesium Ion、本地瓦片缓存 |
| 水体模拟    | GPU 浅水方程，WebGL2                            |
| 构建        | Vite 8、TypeScript 5.9                          |
| UI          | React 19、MUI 9、Emotion                        |
| 状态        | React Hooks + 轻量跨端口文件状态                |
| 测试        | Node 原生测试运行器                             |

---

## 4. 快速开始

### 4.1 环境要求

- Node.js ≥ 20.12（推荐 22+）
- npm
- 有头 Chrome（仅 E2E / 本地验证需要）
- Cesium Ion token（地形 / 影像回源需要）

### 4.2 安装

```bash
npm install
cp .env.example .env
# 编辑 .env，填入 CESIUM_ION_TOKEN
```

`CESIUM_ION_TOKEN` 只在服务端 / Vite 中间件使用，浏览器不直接接触。

### 4.3 环境变量

| 变量                    | 必需 | 说明                                 |
| ----------------------- | ---- | ------------------------------------ |
| `CESIUM_ION_TOKEN`      | 是   | 地形 / 影像回源与瓦片预热            |
| `HOST`                  | 否   | 生产服务器监听地址，默认 `127.0.0.1` |
| `PORT`                  | 否   | 生产服务器端口，默认 `8090`          |
| `TILE_CACHE_DIR`        | 否   | 瓦片缓存目录，默认 `.cache/tiles`    |
| `BASE_PATH`             | 否   | GitHub Pages 子路径构建前缀          |
| `VITE_CESIUM_ION_TOKEN` | 否   | 静态托管直连 Cesium Ion 时使用       |

### 4.4 启动

```bash
# 业务端
npm run dev
# http://127.0.0.1:5173/

# 场景编辑端（另开终端）
npm run dev:scene
# http://127.0.0.1:5174/?scene=1
```

两个端口可同时运行；业务端的「场景」按钮和场景端的「业务」按钮可互相跳转。

### 4.5 生产构建

```bash
npm run build
npm start
# 默认 http://127.0.0.1:8090
```

生产服务器同时提供静态产物、瓦片缓存、域缓存与 `/api/live-state`。

---

## 5. 双端联动

```text
场景编辑端 (5174)
  ├─ WaterEditor（唯一写入者）
  ├─ 每 1.2 s 发布：水体状态、相机、水源、统计、选中水源
  └─ 读取业务选中水源 → 选中 + 飞行
          │
          ▼
.cache/live-state.json  ←→  /api/live-state
          │
          ▼
业务端 (5173)
  ├─ 每 700 ms 轮询
  ├─ 镜像水体状态与相机
  └─ 矩阵面板点击场景对象 → 写入 focusSourceId
```

- 共享状态文件：`.cache/live-state.json`。
- 开发环境：`vite.config.ts` 中间件，两个 Vite server 共用同一文件。
- 生产环境：`server.mjs` 的 `/api/live-state`。
- 写入按 `matrix` / `scene` 分段合并，矩阵和场景互不覆盖。
- 业务端只读场景；矩阵数据最终也走同一状态接口。

> 这是面向演示 / 单机的联动实现，不是多用户实时协同。多实例部署时应替换为数据库或 WebSocket 服务。

---

## 6. 目录结构

```text
.
├─ index.html                 # 仅 #viewer + #mui-root
├─ src/
│  ├─ main.ts                 # Viewer 启动、WaterEditor、MUI 挂载
│  ├─ global.d.ts             # window.viewer / waterEditor / __waterEditor
│  ├─ assets/                 # favicon、字体
│  ├─ shared/
│  │  ├─ assets.ts
│  │  ├─ format.ts
│  │  ├─ math.ts
│  │  └─ routes.ts          # 业务 / 场景地址（Pages 与 dev 端口自适应）
│  ├─ ui/
│  │  ├─ cloudDefaults.ts
│  │  └─ mui/
│  │     ├─ App.tsx           # 业务端
│  │     ├─ SceneApp.tsx      # 场景编辑端
│  │     ├─ MatrixPanel.tsx   # 矩阵骨架 + 场景对象
│  │     ├─ SceneLinkPanel.tsx
│  │     ├─ SourcePanel.tsx
│  │     ├─ SimulationCluster.tsx
│  │     ├─ AppearanceControls.tsx
│  │     ├─ EnvironmentCluster.tsx
│  │     ├─ ModelStudio.tsx
│  │     ├─ StatusCluster.tsx
│  │     ├─ ToastLayer.tsx
│  │     ├─ liveState.ts       # 跨端口状态类型、轮询、写入
│  │     ├─ bridge.ts         # __waterEditor → React
│  │     ├─ mount.tsx         # 启动页与页面选择
│  │     ├─ theme.ts
│  │     └─ base.css
│  └─ water/
│     ├─ types.ts             # 状态、常量、归一化
│     ├─ persistence.ts       # 本地自动持久化
│     ├─ waterEditor.ts       # 无头领域核心
│     ├─ waterPointerController.ts
│     ├─ waterDomainBuilder.ts
│     ├─ domainCache.ts
│     ├─ terrainField.ts
│     ├─ terrainSampling.ts
│     ├─ shallowWater.ts
│     ├─ simShaders.ts
│     ├─ waterSurface.ts
│     ├─ waterShaders.ts
│     ├─ waterTextures.ts
│     ├─ markers.ts
│     ├─ structures.ts        # Dam / Gate / Permeable 契约
│     ├─ sun.ts
│     └─ async.ts
├─ scripts/
│  ├─ tile-cache.mjs
│  ├─ live-state.mjs          # 跨端口文件状态
│  ├─ cache-region.mjs
│  ├─ cache-static.mjs
│  └─ export-static-cache.mjs
├─ docs/
├─ tests/
│  └─ water-state.test.mjs
├─ server.mjs
├─ vite.config.ts
└─ package.json
```

---

## 7. 运行机制

### 7.1 无头 `WaterEditor`

`WaterEditor` 不查询 DOM，不依赖 React。MUI 通过 `window.__waterEditor` 读取快照、下发命令：

```text
MUI 控件
  → bridge.ts
  → WaterEditor 命令
  → ShallowWaterSim / WaterSurface / SourceMarkers
  → React 轮询
  → MUI 控件
```

主要命令：

| 命令                                                      | 作用                   |
| --------------------------------------------------------- | ---------------------- |
| `enterWaterMode` / `enterSceneMode`                       | 模式                   |
| `togglePlacing` / `placeSourceAt`                         | 放置水源               |
| `selectSource` / `deleteSource` / `setSource`             | 水源编辑               |
| `setSimSettings` / `setVisual` / `setEnabled`             | 模拟与外观             |
| `resetSimulation` / `rebuildSimulation` / `rebuildDomain` | 重置 / 重建            |
| `applyExternalState`                                      | 业务端镜像场景水体状态 |
| `waitReady`                                               | 等待域完成             |

### 7.2 水体模型契约

项目**不内置**具体坝、闸门、透水模型，也不提供水体模型加载 UI。

保留：

- `DamStructure`
- `GateStructure`
- `PermeableStructure`
- `WaterModelSet`
- `WaterEditor.setWaterModels`
- 结构高度场、闸门实体墙、底孔过流、水面裁切等通用能力

后续由外部文件 / 调用方转换为契约后注入。详见 [水体模型 API](docs/water-models-api.md)。

### 7.3 视觉模型

场景编辑端「模型」页通过 `viewer.models.add/remove` 加载本地 GLB / glTF：

- 只参与三维显示。
- 不写入 `WaterModelSet`。
- 不影响浅水模拟。

---

## 8. 命令

| 命令                          | 说明                      |
| ----------------------------- | ------------------------- |
| `npm run dev`                 | 业务端 `5173`             |
| `npm run dev:scene`           | 场景编辑端 `5174`         |
| `npm run build`               | 生产构建                  |
| `npm run preview`             | 预览构建                  |
| `npm start`                   | 生产服务器，默认 `8090`   |
| `npm run type-check`          | TypeScript 检查           |
| `npm run lint`                | ESLint                    |
| `npm run format:check`        | Prettier 检查             |
| `npm test`                    | 状态归一化单测            |
| `npm run check`               | 类型 / lint / 格式 / 单测 |
| `npm run cache:prefetch`      | 按区域预热瓦片            |
| `npm run cache:static`        | 静态站点两段预热          |
| `npm run build:pages:offline` | 构建并导出静态瓦片        |

---

## 9. 质量与验证

```bash
npm run check
npm run build
```

当前通过：

- TypeScript `--noEmit`
- ESLint
- Prettier
- 14 项水体状态单测
- 生产构建

浏览器验证覆盖：

- 业务端 / 场景端启动
- 场景端水源放置
- 场景端模型添加 / 移动
- 业务端场景镜像
- 业务端场景对象联动

---

## 10. GitHub Pages 与 GitHub Actions

部署配置见 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)。

### 10.1 必填 Secrets / Variables

| 类型     | 名称               | 说明                                                         |
| -------- | ------------------ | ------------------------------------------------------------ |
| Secret   | `CESIUM_ION_TOKEN` | 构建时注入 `VITE_CESIUM_ION_TOKEN`；缺失时 workflow 直接失败 |
| Variable | `PAGES_BASE_PATH`  | 可选，覆盖 Pages 子路径；项目站点默认 `/<仓库名>/`           |

workflow 会执行：

1. `npm ci`
2. `npm run check`
3. 校验 `CESIUM_ION_TOKEN`
4. `BASE_PATH=... VITE_STATIC_HOST=1 npm run build:pages`
5. 上传 `dist/` 并部署 `github-pages`

### 10.2 静态托管的差异

GitHub Pages 没有 `/api/live-state`。构建时注入 `VITE_STATIC_HOST=1` 后：

- 业务端 / 场景端仍使用同一个 `index.html`，仅通过 `?scene=1` 区分。
- 联动状态从服务端文件自动切换为 **同源 `localStorage` + `BroadcastChannel`**。
- 两个页面必须在**同一站点、同一浏览器**的两个标签页中打开，才能联动。
- 页面链接使用 `BASE_URL`，不写死端口；`5173` / `5174` 只在本地开发时使用。

### 10.3 本地模拟静态构建

```bash
BASE_PATH=/your-repo/ VITE_STATIC_HOST=1 VITE_CESIUM_ION_TOKEN=... npm run build
```

---

## 11. 已知限制

- 矩阵数据模型、CRUD、责任 / 任务 / 风险流转未实现。
- 业务端目前是矩阵系统骨架，只完成场景联动。
- 手动保存 / 导出 / 导入已移除；仅有本地自动持久化。
- 联动使用本地 JSON + 轮询，只适合单机演示。
- 没有账号、权限、审计、多用户并发。
- 模拟域固定为 8 km × 8 km。
- 水体模型需要外部契约输入，项目不内置资产。
- 视觉模型与水体模拟解耦。

---

## 12. 后续路线

1. **矩阵系统**
   - 责任 / 任务 / 风险数据模型。
   - 矩阵行 CRUD、筛选、状态流转。
   - 矩阵行与水源 / 场景对象绑定。
   - 业务指标与场景统计的双向联动。
2. **服务端**
   - 用数据库 / WebSocket 替换文件联动。
   - 账号、权限、审计。
3. **场景能力**
   - 模型放置与地形贴合增强。
   - 水体模型契约的文件解析与注入。
   - 更多水工结构与调度规则。

---

## 13. 文档

- [MUI 界面与双入口](docs/mui-ui.md)
- [包类结构](docs/package-structure.md)
- [水体模型接口](docs/water-models-api.md)
