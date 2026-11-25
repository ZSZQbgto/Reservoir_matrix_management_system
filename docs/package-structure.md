# 包类结构

本文描述当前源码的目录组织、分层依赖、领域模型、类职责与运行时装配关系。以 `src/` 下代码为准；生成文件与常量若与本文冲突，以源码为准并同步更新本文。

相关文档：[方法规范](./method-conventions.md) · [解耦与注释规范](./decoupling-and-comments.md)

---

## 1. 目录总览

```text
.
├─ index.html                 # DOM 契约：所有 id 在此声明
├─ src/
│  ├─ main.ts                 # 组合根：创建 Viewer、装配 UI、启动水体编辑器
│  ├─ global.d.ts             # window.viewer / window.waterEditor / __waterEditor
│  ├─ vite-env.d.ts           # Vite 环境变量类型
│  ├─ style.css               # 样式入口，只保留 @import
│  ├─ styles/
│  │  ├─ foundation.css       # 字体、设计令牌、重置、全局动效
│  │  ├─ hud.css              # 头部 / 舞台 / 底部骨架
│  │  ├─ panels.css           # 面板、控件、覆盖层
│  │  └─ responsive.css       # 断点、触控与减弱动效
│  ├─ assets/
│  │  ├─ favicon.svg
│  │  └─ fonts/               # Manrope / DM Mono woff2
│  ├─ shared/                 # 无业务依赖的叶子模块
│  │  ├─ assets.ts
│  │  ├─ dom.ts
│  │  ├─ domIds.ts            # 由 index.html 生成，勿手改
│  │  ├─ format.ts
│  │  └─ math.ts
│  ├─ ui/                     # 界面外壳与场景控制
│  │  ├─ shell.ts
│  │  ├─ cloudControls.ts
│  │  └─ cloudTuning.ts
│  └─ water/                  # 水体领域：状态、模拟、渲染、交互
│     ├─ types.ts             # 状态模型、常量、校验与归一化
│     ├─ persistence.ts       # localStorage 与工程 JSON
│     ├─ async.ts             # nextFrame / delay
│     ├─ terrainField.ts      # 切平面投影、地形采样、重采样
│     ├─ terrainSampling.ts   # 相机飞行与地形可用性等待
│     ├─ domainCache.ts       # 模拟域高度场：浏览器 / 服务器缓存
│     ├─ waterDomainBuilder.ts # 缓存恢复 / 现场采样流程
│     ├─ shallowWater.ts      # GPU 浅水模拟
│     ├─ simShaders.ts        # 模拟 GLSL 与统计着色器
│     ├─ waterSurface.ts      # 水面网格、材质与生命周期
│     ├─ waterShaders.ts      # 水面 GLSL
│     ├─ waterTextures.ts     # 程序化法线 / 泡沫纹理
│     ├─ sun.ts               # 太阳方向与水面配色
│     ├─ markers.ts           # 水源标记、域边界、贴地细带
│     ├─ waterEditorDom.ts    # 编辑器 DOM 元素集中查询
│     ├─ waterPanelView.ts    # 状态 → DOM 单向同步
│     ├─ waterControlsBinder.ts # 表单事件 → 宿主命令
│     ├─ waterPointerController.ts # 指针事件 → 宿主命令
│     └─ waterEditor.ts       # 总控：域、模拟、交互、持久化
├─ public/
│  └─ draco/                  # Draco 解码器（静态资源）
├─ scripts/
│  ├─ tile-cache.mjs          # 瓦片缓存中间件与预热
│  ├─ cache-region.mjs        # CLI：预热指定区域
│  ├─ cache-static.mjs        # CLI：静态站点两段预热
│  ├─ export-static-cache.mjs # 导出瓦片到 dist/
│  ├─ generate-dom-ids.mjs    # index.html → domIds.ts
│  ├─ check-conventions.mjs   # DOM id 静态校验
│  └─ verify.mjs              # Playwright E2E
├─ tests/
│  └─ water-state.test.mjs    # 状态归一化单测
├─ server.mjs                 # 生产服务器：静态产物 + 瓦片缓存
├─ vite.config.ts             # 基础路径、瓦片中间件、构建配置
├─ eslint.config.js           # 分层依赖守卫
├─ tsconfig.json
├─ .prettierrc.json
└─ .env / .env.example        # CESIUM_ION_TOKEN 等
```

## 2. 分层与依赖方向

```text
                main.ts（组合根）
               /       |        \
          ui/        water/     shared/
       shell.ts    waterEditor     dom.ts
   cloudControls  shallowWater    format.ts
    cloudTuning   waterSurface    math.ts
                  markers …       assets.ts
                       \           /
                        shared/（叶子）
```

| 层                       | 可依赖                     | 禁止依赖        | 强制手段                            |
| ------------------------ | -------------------------- | --------------- | ----------------------------------- |
| `main.ts`                | `ui/`、`water/`、`shared/` | —               | 无                                  |
| `shared/`                | 仅第三方库与自身           | `ui/`、`water/` | ESLint `no-restricted-imports`      |
| `ui/`                    | `shared/`、第三方库        | `water/`        | ESLint `no-restricted-imports`      |
| `water/`                 | `shared/`、第三方库        | `ui/`           | ESLint `no-restricted-imports`      |
| `scripts/`、`server.mjs` | Node 内置模块、`scripts/`  | `src/`          | 约定；`tile-cache.mjs` 复制领域常量 |
| `tests/`                 | `src/water/types.ts`       | 其余运行时模块  | 约定                                |

要点：

- `shared/` 是唯一能被两侧同时引用的层，只放纯函数、DOM 查询与格式化。
- `ui/` 与 `water/` 之间没有直接引用；共享的 DOM 与格式化能力已经下沉。
- `scripts/` 与 `server.mjs` 运行在 Node 侧，不引用 `src/` 模块。`tile-cache.mjs` 中的
  `DOMAIN_STORE` 与 `src/water/types.ts` 的 `WATER_DOMAIN`、`TERRAIN_GRID_SIZE` 保持一致。
- `tests/` 通过显式 `.ts` 后缀直接运行源码，因此 `types.ts` 内部对 `clamp` 使用了带后缀的引用。

## 3. 模块职责

### 3.1 `src/shared/`

| 模块        | 关键导出                                                                                                         | 职责                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `assets.ts` | `ASSET_BASE`、`assetPath`、`STATIC_HOST`                                                                         | 拼接 `BASE_URL` 前缀；判断纯静态托管 |
| `dom.ts`    | `requireElement`、`pickElement`、`syncRangeFill`、`escapeHtml`                                                   | DOM 查询、滑杆填充、HTML 转义        |
| `domIds.ts` | `DOM_IDS`、`DomId`、`domId`                                                                                      | `index.html` 的 id 清单（生成）      |
| `format.ts` | `minutesToSceneDate`、`formatClockTime`、`formatCoordinate`、`formatAltitude`、`formatElevation`、`formatLonLat` | 场景时间与 HUD 文案                  |
| `math.ts`   | `clamp`                                                                                                          | 数值夹取；被 `types.ts` 重导出       |

### 3.2 `src/ui/`

| 模块               | 关键导出                                                                                                                                            | 职责                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `shell.ts`         | `initUiShell`                                                                                                                                       | 测量头尾高度、模式滑块、面板折叠、水源抽屉、滑杆填充 |
| `cloudControls.ts` | `CLOUD_SCENE_DEFAULTS`、`CloudControlsOptions`、`initCloudControls`                                                                                 | 体积云 / 大气 / 时间控件与偏好持久化                 |
| `cloudTuning.ts`   | `CloudTuning`、`CLOUD_TUNING_DEFAULTS`、`CLOUD_TUNING_RANGES`、`resolveCloudsEffect`、`readCloudTuning`、`applyCloudTuning`、`normalizeCloudTuning` | 通过 Tellux 内部 `CloudsEffect` 读写高级云参数       |

### 3.3 `src/water/`

| 模块                        | 关键导出                                                                                                                                                                                                      | 职责                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `types.ts`                  | `WaterState`、`WaterSource`、`TerrainField`、`SimTerrain`、`SimSource`、`SimSettings`、`WaterDomainState`、`SurfaceDomain`、常量、`normalizeWaterState`、`cloneState`、`createDefaultState`、`createSourceId` | 三层共享的数据模型与边界校验            |
| `persistence.ts`            | `EditorMode`、`loadStoredState`、`storeState`、`loadStoredMode`、`storeMode`、`downloadStateJson`、`readStateFile`                                                                                            | localStorage 与工程 JSON 导入导出       |
| `async.ts`                  | `nextFrame`、`delay`                                                                                                                                                                                          | 分帧与延时                              |
| `terrainField.ts`           | `LocalProjection`、`createLocalProjection`、`sampleTerrainField`、`resampleTerrain`、`sampleFieldHeight`                                                                                                      | 经纬度 ↔ 域平面、地形采样与双线性重采样 |
| `terrainSampling.ts`        | `sampleGroundHeight`、`flyOverDomain`、`waitForTerrainAvailable`、`waitForTerrainStable`                                                                                                                      | 相机定位与地形 LOD 等待                 |
| `domainCache.ts`            | `loadCachedDomainField`、`saveCachedDomainField`、`clearCachedDomainField`、`getCachedDomainInfo`、`fetchServerDomainField`、`saveDomainFieldToServer`、`clearServerDomainField`                              | 高度场的两级缓存                        |
| `waterDomainBuilder.ts`     | `WaterDomainBuilder`、`DomainBuildResult`、`DomainBuildHooks`                                                                                                                                                 | 缓存恢复与现场采样两条建域路径          |
| `shallowWater.ts`           | `ShallowWaterSim`                                                                                                                                                                                             | 通量 / 水深两步 GPU 模拟、统计读回      |
| `simShaders.ts`             | `FULLSCREEN_VERTEX`、`INIT_FRAGMENT`、`FLUX_FRAGMENT`、`DEPTH_FRAGMENT`、`statsFragment`                                                                                                                      | 模拟 GLSL                               |
| `waterSurface.ts`           | `WaterSurface`                                                                                                                                                                                                | 切平面网格、水面材质、波纹推进          |
| `waterShaders.ts`           | `WATER_VERTEX_SHADER`、`WATER_FRAGMENT_SHADER`                                                                                                                                                                | 水面 GLSL                               |
| `waterTextures.ts`          | `WaterDetailTextures`、`createWaterDetailTextures`、`disposeWaterDetailTextures`                                                                                                                              | 可平铺法线与泡沫纹理                    |
| `sun.ts`                    | `SunState`、`sunStateForDirection`、`computeSunDirectionENU`                                                                                                                                                  | NOAA 太阳位置与 HDR 调色板              |
| `markers.ts`                | `SourceMarkers`、`DomainBoundary`                                                                                                                                                                             | 水源标记、标签、域边界                  |
| `waterEditorDom.ts`         | `WaterEditorDom`、`VisualControl`、`queryWaterEditorDom`                                                                                                                                                      | DOM 元素与外观滑杆的集中映射            |
| `waterPanelView.ts`         | `WaterPanelHost`、`WaterPanelView`                                                                                                                                                                            | 只读状态 → DOM                          |
| `waterControlsBinder.ts`    | `ControlsHost`、`WaterControlsBinder`、`MAX_SOURCE_TOAST`                                                                                                                                                     | 表单事件 → 命令                         |
| `waterPointerController.ts` | `PointerHost`、`WaterPointerController`                                                                                                                                                                       | 指针拖动 / 选中 / 放置                  |
| `waterEditor.ts`            | `WaterEditor`、`WaterEditorOptions`                                                                                                                                                                           | 领域总控与生命周期                      |

### 3.4 入口、脚本与服务

| 模块                              | 职责                                                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `main.ts`                         | 创建 `tellux.Viewer`；挂载 `WaterEditor`、`initUiShell`、`initCloudControls`；全局错误兜底；相机读数 |
| `index.html`                      | 静态 DOM 契约与 ARIA 关系；所有 `id` 的唯一来源                                                      |
| `server.mjs`                      | 托管 `dist/`、SPA 回退、`/healthz`、瓦片与模拟域缓存接口                                             |
| `scripts/tile-cache.mjs`          | `createTileCache`、`prefetchRegion`、区域 / 瓦片范围换算                                             |
| `scripts/cache-region.mjs`        | `npm run cache:prefetch`：按参数预热                                                                 |
| `scripts/cache-static.mjs`        | `npm run cache:static`：全球低层 + 区域高层两段预热                                                  |
| `scripts/export-static-cache.mjs` | 把 `.cache/tiles` 导出到 `dist/terrain-cache`、`dist/imagery-cache`                                  |
| `scripts/generate-dom-ids.mjs`    | 从 `index.html` 生成 `src/shared/domIds.ts`                                                          |
| `scripts/check-conventions.mjs`   | 校验 id 唯一性、生成文件同步、引用存在性                                                             |
| `scripts/verify.mjs`              | 启动 Vite + 有头 Chrome 的 E2E 验证                                                                  |
| `tests/water-state.test.mjs`      | 状态默认值、归一化、范围、id 规则                                                                    |

## 4. 领域模型与常量

### 4.1 状态树

```text
WaterState
├─ version: number
├─ enabled: boolean                 # 水面渲染与模拟推进的总开关
├─ domain: WaterDomainState | null  # 中心 + 边长；null = 未建立
├─ sim: WaterSimSettings
│  ├─ speed / waterAmount / resolution
│  ├─ paused
│  └─ maxFlowSpeed / damping / injectInterval
├─ visual: WaterVisualSettings
│  ├─ shimmer / glint / reflection
│  ├─ ripple / rippleScale / flowSpeed / foam
│  └─ clarity / opacity
└─ sources: WaterSource[]
   ├─ id / name / longitude / latitude
   ├─ radius / targetLevel / amount
   ├─ enabled
   └─ groundLevel
```

派生结构（不进入 `WaterState`）：

| 类型            | 生产者                         | 消费者                           | 说明                             |
| --------------- | ------------------------------ | -------------------------------- | -------------------------------- |
| `TerrainField`  | `sampleTerrainField`           | 编辑器 / 缓存                    | 97²，相对 `baseElevation` 的米数 |
| `SimTerrain`    | `resampleTerrain`              | `ShallowWaterSim`                | 重采样到模拟分辨率               |
| `SimSource`     | `WaterEditor.toSimSources`     | `ShallowWaterSim`                | 域内米制偏移                     |
| `SimSettings`   | `WaterEditor.applySimState`    | `ShallowWaterSim`                | 已夹取的模拟参数                 |
| `SurfaceDomain` | `WaterEditor.applyDomainField` | `WaterSurface`、`DomainBoundary` | 原点、边长、分辨率、基准高程     |
| `SunState`      | `sunStateForDirection`         | `WaterSurface`                   | 方向、权重、HDR 颜色             |

### 4.2 常量

| 常量                        | 值                                                                                                  | 用途                        |
| --------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------- |
| `WATER_STATE_VERSION`       | `1`                                                                                                 | 状态版本                    |
| `WATER_STORAGE_KEY`         | `tellux-water-editor-v1`                                                                            | localStorage 键             |
| `WATER_MODE_STORAGE_KEY`    | `tellux-water-editor-mode-v1`                                                                       | 模式持久化键                |
| `MAX_WATER_SOURCES`         | `8`                                                                                                 | 水源数量上限                |
| `WATER_DOMAIN`              | `{ 116.77, 36.02, 8000 }`                                                                           | 固定模拟域（中心 + 边长米） |
| `SIM_RESOLUTION_OPTIONS`    | `[192, 256, 384]`                                                                                   | 模拟网格档位                |
| `TERRAIN_GRID_SIZE`         | `97`                                                                                                | 地形采样网格边长            |
| `SOURCE_RADIUS_RANGE`       | `20–3000`                                                                                           | 数据层半径（米）            |
| `SOURCE_RADIUS_PANEL_RANGE` | `20–2000`                                                                                           | 面板滑杆半径（米）          |
| `SOURCE_AMOUNT_RANGE`       | `0.5–300`                                                                                           | 单次注水深度（米）          |
| `SIM_DEFAULTS`              | speed 1 / amount 15 / res 256 / flow 30 / damping 0.995 / interval 2                                | 模拟默认值                  |
| `VISUAL_DEFAULTS`           | shimmer / glint / reflection / ripple / rippleScale / flowSpeed / foam = 1；clarity 0.62；opacity 0 | 外观默认值                  |

### 4.3 坐标与单位

| 空间             | 约定                                                               | 说明                                  |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------- |
| 经纬度           | WGS84 `longitude` / `latitude`，度                                 | 与 Cesium / Tellux 一致               |
| 域平面           | `x` 向东、`z` 向北，单位米，原点为域中心                           | `LocalProjection`                     |
| 地形高度场       | 行主序 `j * N + i`，`i` 向东、`j` 向北；值相对 `baseElevation`     | `TerrainField` / `SimTerrain`         |
| 模拟纹理         | `uv = ((i + 0.5) / N, (j + 0.5) / N)`，`v = 0` 在南                | `simShaders.ts`                       |
| 模拟状态通道     | `R` 水深 m；`G` 东向速度 m/s；`B` 北向速度 m/s；`A` 相对地形高程 m | `ShallowWaterSim.stateTexture`        |
| 水面网格局部坐标 | `+X = 西`、`+Y = 上`、`+Z = 北`；顶点 `x = -east`                  | `waterSurface.ts` / `waterShaders.ts` |
| 水面 UV          | `u` 沿东、`v` 沿北                                                 | 与模拟纹理一致                        |
| 高度             | 米；`targetLevel` 为绝对椭球高，地形通道为相对 `baseElevation`     | 混用前先确认基准                      |

## 5. 类结构

### 5.1 `WaterEditor`（总控）

构造依赖：`Viewer` + `WaterEditorOptions { toast }`。构造时创建全部协作者并启动 RAF：

| 协作者                   | 作用                        |
| ------------------------ | --------------------------- |
| `WaterEditorDom`         | 全部 DOM 引用与外观滑杆映射 |
| `WaterPanelView`         | 状态 → DOM                  |
| `WaterDomainBuilder`     | 缓存恢复 / 现场采样         |
| `SourceMarkers`          | 水源小球、标签、贴地圆环    |
| `DomainBoundary`         | 模拟域边界                  |
| `WaterPointerController` | 指针拖动 / 选中 / 放置      |
| `WaterControlsBinder`    | 表单事件绑定                |

字段分组：

| 组         | 代表字段                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------- |
| 渲染上下文 | `viewer`、`scene`、`renderer`、`canvas`、`canvasSize`                                     |
| 领域状态   | `state`、`mode`、`selectedId`、`placing`、`modeTouched`                                   |
| 模拟域     | `field`、`projection`、`domain`、`domainSource`、`build`、`buildToken`、`buildWaiters`    |
| 运行时对象 | `sim`、`surface`、`markers`、`boundary`、`pointer`、`binder`、`panel`、`domainBuilder`    |
| 调度       | `animationHandle`、`lastFrameAt`、`lastStatsAt`、`lastSunAt`、`saveTimer`、`restoreTimer` |
| 统计       | `statsSnapshot`                                                                           |

公开 API：

| 成员                           | 语义                                     |
| ------------------------------ | ---------------------------------------- |
| `constructor(viewer, options)` | 建立协作者、绑定事件、恢复状态、启动循环 |
| `get currentMode`              | 当前模式                                 |
| `get currentState`             | `cloneState` 后的只读快照                |
| `get isDomainReady`            | `sim`、`surface`、`domain` 三者齐全      |
| `enterMode(mode)`              | 切换模式；进入水体时确保模拟域           |
| `dispose()`                    | 取消 RAF / 定时器、解绑、释放 GPU 与标记 |

私有方法按职责分组：

| 组       | 方法                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------- |
| 模拟域   | `ensureDomain`、`buildDomain`、`applyDomainField`、`filterSourcesToDomain`、`rebuildFixedDomain`、`flushBuildWaiters` |
| 高程     | `groundFromField`、`sampleGround`、`groundLevelAt`                                                                    |
| 模拟     | `createSimulation`、`rebuildSimulation`、`disposeSimulation`、`toSimSources`、`applySimState`、`updateSun`            |
| 面板同步 | `syncAll`、`syncModeUI`、`applyVisual`、`panel.sync*`                                                                 |
| 交互     | `togglePlacing`、`exitPlacing`、`placeSource`、`selectSource`、`revealSourceEditor`、`deleteSource`、`clearSources`   |
| 拖动     | `previewDraggedSource`、`commitDraggedSource`、`refreshSelectedSource`                                                |
| 持久化   | `scheduleSave`、`saveNow`、`exportProject`、`applyImportedFile`、`handleBeforeUnload`                                 |
| 循环     | `animate`                                                                                                             |
| 调试     | `debugApi`                                                                                                            |

`WaterEditor` 是 `WaterState` 的唯一写入者；`WaterPanelView` 只读，`WaterControlsBinder` 通过
`ControlsHost` 修改字段后调用命令方法完成同步与持久化。

### 5.2 `ShallowWaterSim`

| 成员                             | 说明                                           |
| -------------------------------- | ---------------------------------------------- |
| `constructor(renderer, terrain)` | 校验分辨率、高度数组长度、域边长与浮点纹理扩展 |
| `readonly resolution`            | 模拟网格边长                                   |
| `get stateTexture`               | 当前 ping-pong 状态纹理                        |
| `setSources(sources)`            | 更新水源 uniform 与上限                        |
| `setSettings(settings)`          | 夹取参数、换算阻尼、暂停时清空累积             |
| `update(dtSeconds)`              | 按固定子步 `1/30 s` 推进，单帧 dt 上限 0.1 s   |
| `reset()`                        | 重新初始化地形通道、清零水位与统计             |
| `debugStats()`                   | 低频读回统计                                   |
| `dispose()`                      | 释放 render target、材质、几何与纹理           |

模拟内部为两个全屏 pass：`FLUX_FRAGMENT`（四邻域出流，开放吸收边界）与 `DEPTH_FRAGMENT`
（水深 / 速度更新、注水、全局水位上限）。统计由 `statsFragment(STATS_BLOCK)` 降采样后读回。

### 5.3 `WaterSurface`

| 成员                                                       | 说明                                              |
| ---------------------------------------------------------- | ------------------------------------------------- |
| `constructor(viewer, domain, stateTexture, simResolution)` | 建网格、程序化纹理与材质，加入 `viewer.scene.raw` |
| `readonly mesh`                                            | 场景中的水面网格                                  |
| `setEnabled(enabled)`                                      | 显隐（总开关 / 退出编辑）                         |
| `setStateTexture(texture)`                                 | 切换 ping-pong 状态纹理                           |
| `setVisual(visual)`                                        | 写入外观 uniform，越界值夹取                      |
| `setSunDirection(enu)`                                     | 太阳方向换算到局部坐标                            |
| `update(dtSeconds)`                                        | 推进波纹时间与流速                                |
| `dispose()`                                                | 移除网格并释放材质、几何、纹理                    |

### 5.4 `SourceMarkers`、`DomainBoundary`、`RibbonLine`

| 类               | 可见性 | 职责                                                                                                                              |
| ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `SourceMarkers`  | 导出   | 青色小球 + 贴地圆环 + DOM 名称标签；提供 `setSources`、`updateSource`、`settleSource`、`updateFrame`、`hitTest`、`screenPosition` |
| `DomainBoundary` | 导出   | 贴着地形的闭合边界；`setDomain(domain, projection)` 异步重建，`update` 按相机距离调整像素宽度                                     |
| `RibbonLine`     | 模块内 | 带法线的三角形条带，替代在大气后处理下发黑的 `THREE.Line`                                                                         |

### 5.5 视图与交互类

| 类                       | 构造依赖                            | 公开方法                                  | 约束                                                |
| ------------------------ | ----------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| `WaterPanelView`         | `WaterEditorDom` + `WaterPanelHost` | `syncAll`、各 `sync*`、`setProjectStatus` | 只读状态、只写 DOM，不发请求、不保存                |
| `WaterControlsBinder`    | `ControlsHost`                      | `attach`                                  | 只做事件 → 命令，不持有编辑状态                     |
| `WaterPointerController` | `PointerHost`                       | `attach`、`detach`                        | 拖动期间禁用相机手势；`pointercancel` / `blur` 收敛 |
| `WaterDomainBuilder`     | `Viewer` + `DomainBuildHooks`       | `loadCached`、`sample`                    | 不碰 DOM、不碰编辑器状态；通过 hooks 报进度         |

宿主接口（端口）定义在各消费方模块内，由 `WaterEditor` 在构造时注入实现：

- `WaterPanelHost`：状态与只读派生数据。
- `ControlsHost`：可写状态 + 命令。
- `PointerHost`：相机、画布、标记与命令。
- `DomainBuildHooks`：`onProgress`、`onToast`。

### 5.6 函数式模块

| 模块                 | 形态            | 说明                                                    |
| -------------------- | --------------- | ------------------------------------------------------- |
| `persistence.ts`     | 纯函数          | localStorage 读写失败静默降级；JSON 解析失败返回 `null` |
| `domainCache.ts`     | 纯函数 + fetch  | 两级缓存；服务器接口超时后回退                          |
| `terrainField.ts`    | 工厂 + 异步函数 | `LocalProjection` 闭包；采样按行分帧                    |
| `terrainSampling.ts` | 异步函数        | 飞行、可用性与 LOD 稳定等待                             |
| `waterTextures.ts`   | 工厂 + 释放函数 | 一次性生成 256² RGBA8 `DataTexture`                     |
| `sun.ts`             | 纯函数          | NOAA 太阳位置与三档调色                                 |
| `cloudControls.ts`   | 初始化函数      | 绑定 DOM、恢复偏好、写入 Tellux 场景                    |
| `cloudTuning.ts`     | 纯函数          | 字段探测、范围裁剪、归一化                              |
| `shell.ts`           | 初始化函数      | 布局测量与外壳交互                                      |

## 6. 运行时装配与数据流

### 6.1 启动顺序（`main.ts`）

```text
boot()
├─ setLoader(14/38)
├─ new tellux.Viewer(#viewer, { terrain, imagery, clock, camera, scene, postProcess, renderer })
├─ viewer.overlays.add(createOverlays())
├─ viewer.terrain.set(createTerrainOptions())
├─ mountWaterEditor(viewer)         # new WaterEditor(viewer, { toast })
├─ initUiShell()
├─ initCloudControls({ viewer, showToast, onTimeChange })
├─ hideLoader()
└─ setInterval(450ms) 更新坐标读数
```

`beforeunload` 时清理读数定时器、`waterEditor.dispose()`、`viewer.destroy()`。

### 6.2 每帧循环（`WaterEditor.animate`）

```text
requestAnimationFrame
├─ dt = min(0.1, now - lastFrameAt)
├─ if state.enabled && sim:
│  ├─ sim.update(dt)
│  ├─ surface.setStateTexture(sim.stateTexture)
│  └─ surface.update(dt)
├─ updateSun()                    # 2 s 节流
├─ markers.updateFrame(camera, width, height)
├─ boundary.update(camera, height)
└─ 每 700 ms: sim.debugStats() → panel.syncStatus / syncPill
```

### 6.3 建域流程

```text
enterMode('water')
└─ ensureDomain()
   ├─ isDomainReady → true
   ├─ 已有 build → 复用 promise
   ├─ domainBuilder.loadCached()
   │  ├─ localStorage 命中 → applyDomainField(..., 'cache')
   │  └─ 服务器 /domain-cache/domain.json 命中 → 写浏览器缓存后恢复
   └─ 未命中 → buildDomain()
      ├─ 取消旧 build（cancel + buildToken）
      ├─ filterSourcesToDomain
      ├─ domainBuilder.sample()
      │  ├─ flyOverDomain → waitForTerrainAvailable → waitForTerrainStable
      │  ├─ sampleTerrainField(97², 每帧 4 行)
      │  ├─ 中心高程漂移重采（最多 3 次）
      │  └─ saveCachedDomainField + saveDomainFieldToServer
      └─ applyDomainField → createSimulation → syncAll → scheduleSave
```

`buildWaiters` 用于 `debugApi().waitReady()`；构建被取代时以 `false` 结束。

### 6.4 状态写入与保存

```text
事件（binder / pointer）
└─ 修改 state 字段
   ├─ applySimState() / applyVisual()      # 推送到 sim / surface
   ├─ panel.sync*()                       # 状态 → DOM
   └─ scheduleSave()                      # 500 ms 防抖 → localStorage
```

手动保存、导入、导出与 `beforeunload` 走 `saveNow` / `persistence`。工程 JSON 只含
`WaterState`，不含水位、流量与统计。

## 7. DOM 契约与生成代码

- `index.html` 是 id 的唯一来源；`scripts/generate-dom-ids.mjs` 生成 `src/shared/domIds.ts`
  的 `DOM_IDS`、`DomId`、`domId()`。
- `scripts/check-conventions.mjs` 校验：id 唯一、生成文件同步、代码引用存在、ARIA 关系有效。
- `waterEditorDom.ts` 通过 `requireElement(domId('...'))` 一次性查询并缓存全部元素；
  查询失败立即抛错。
- `visualControls` 把外观滑杆的 DOM、状态键、数值范围集中为一张表，`syncAppearance`
  与 `bindAppearanceControls` 共用。
- 新增控件顺序：`index.html` 加 id → `npm run gen:dom` → `waterEditorDom.ts` 加字段 →
  `waterPanelView` / `waterControlsBinder` 接入 → `npm run check`。

## 8. 构建、脚本与测试

| 命令                                      | 内容                                       |
| ----------------------------------------- | ------------------------------------------ |
| `npm run dev`                             | Vite dev server（含瓦片中间件）            |
| `npm run build`                           | Vite 生产构建到 `dist/`                    |
| `npm run preview`                         | 预览 `dist/`                               |
| `npm start`                               | `server.mjs`，默认 `127.0.0.1:8090`        |
| `npm run type-check`                      | `tsc --noEmit`                             |
| `npm run lint`                            | ESLint（含分层守卫）                       |
| `npm run format:check`                    | Prettier 检查                              |
| `npm run gen:dom`                         | 重新生成 `domIds.ts`                       |
| `npm run check:conventions`               | DOM id 一致性                              |
| `npm test`                                | 状态单测                                   |
| `npm run check`                           | 以上类型 / lint / 格式 / 约定 / 测试串联   |
| `npm run verify`                          | Playwright E2E（需要 token 与有头 Chrome） |
| `npm run cache:prefetch` / `cache:static` | 瓦片预热                                   |
| `npm run build:pages:offline`             | 构建并导出静态瓦片                         |

生产服务器路由：

| 路径                                   | 行为                                               |
| -------------------------------------- | -------------------------------------------------- |
| `/`、`/assets/*`                       | `dist/` 静态文件；未知路径回退 `index.html`        |
| `/healthz`                             | `{ ok: true, uptime }`                             |
| `/tile-cache/stats`                    | 缓存块数与字节数                                   |
| `/terrain-cache/*`、`/imagery-cache/*` | 命中磁盘缓存，缺块回源并写盘                       |
| `/domain-cache/domain.json`            | `GET` 读取、`POST` 覆盖、`DELETE` 清除模拟域高度场 |

测试：`tests/water-state.test.mjs` 使用 `node:assert/strict` 与最小 `test()` 运行器，直接
`import '../src/water/types.ts'`（Node 原生类型剥离），覆盖默认值、归一化、范围、id 规则。

## 9. 新代码落位

| 新增内容                   | 落位                            | 同步修改                                             |
| -------------------------- | ------------------------------- | ---------------------------------------------------- |
| 纯数值 / 格式化 / DOM 工具 | `src/shared/`                   | 使用方 import                                        |
| 场景控件、HUD 行为         | `src/ui/`                       | `main.ts` 装配                                       |
| 状态字段                   | `src/water/types.ts`            | `createDefaultState`、`normalizeWaterState`、单测    |
| 模拟参数                   | `types.ts` + `SimSettings`      | `ShallowWaterSim.setSettings`、面板、`applySimState` |
| 渲染特性                   | `water/` 新模块或现有 shader    | `WaterSurface` / `ShallowWaterSim` uniform           |
| DOM 控件                   | `index.html`                    | `gen:dom`、`waterEditorDom.ts`、view / binder        |
| Node 工具                  | `scripts/`                      | `package.json` scripts                               |
| 服务端路由                 | `server.mjs` / `tile-cache.mjs` | E2E 断言、文档                                       |
