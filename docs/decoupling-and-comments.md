# 解耦与注释规范

本文分两部分：**A. 解耦**约束模块之间如何依赖、如何通过端口与组合根连接；**B. 注释规范**约束注释写什么、不写什么、写在哪。两部分都以当前代码为准。

相关文档：[包类结构](./package-structure.md) · [方法规范](./method-conventions.md)

---

# A. 解耦

## A1. 目标与判据

解耦不是“文件多”，而是改动能否局部化。满足以下任一判据，说明耦合在可接受范围：

1. 修改模拟算法（`shallowWater.ts` / `simShaders.ts`）不需要改 DOM 与样式。
2. 修改面板结构（`index.html` / `waterPanelView.ts`）不需要改模拟与渲染。
3. 新增一个水源字段，只触碰 `types.ts`、对应视图与必要的模拟 uniform。
4. 视图类可以在没有 `WaterEditor` 实例的情况下，用假的 `WaterPanelHost` 单独驱动。
5. `scripts/` 与 `server.mjs` 不 import `src/`，可独立运行。

## A2. 分层与强制规则

```text
main.ts
├─ ui/        （界面外壳、场景控件）
├─ water/     （水体领域）
└─ shared/    （无业务依赖的叶子）
```

| 规则 | 内容                                                                            | 执行位置                                     |
| ---- | ------------------------------------------------------------------------------- | -------------------------------------------- |
| R1   | `shared/` 不得 import `ui/`、`water/`                                           | `eslint.config.js` → `no-restricted-imports` |
| R2   | `ui/` 不得 import `water/`                                                      | 同上                                         |
| R3   | `water/` 不得 import `ui/`                                                      | 同上                                         |
| R4   | `scripts/`、`server.mjs` 不 import `src/`；`tests/` 只允许 `src/water/types.ts` | 约定（Node 侧独立；测试直接运行源码）        |
| R5   | `main.ts` 是唯一组合根                                                          | 约定                                         |

`src/shared` 的 `assets.ts`、`dom.ts`、`domIds.ts`、`format.ts`、`math.ts` 是跨层共享的
唯一通道。需要新的跨层能力时，先判断能否做成无状态纯函数下沉到 `shared/`，再考虑放宽分层。

## A3. 端口与适配器

视图与交互类不直接依赖 `WaterEditor`，而是依赖各自声明的宿主接口；`WaterEditor` 在构造时
注入箭头函数实现。依赖方向从实现指向抽象。

### WaterPanelHost

- 声明：`waterPanelView.ts`；消费方：`WaterPanelView`；实现：`WaterEditor`。
- 用途：面板读取状态与派生信息，不允许写入。
- 方法：`getState()`（`Readonly<WaterState>`）、`getSelectedId()`、`getSelectedSource()`、
  `getField()`、`isBuilding()`、`isPlacing()`、`isDomainReady()`、`getStats()`。

### ControlsHost

- 声明：`waterControlsBinder.ts`；消费方：`WaterControlsBinder`；实现：`WaterEditor`。
- 资源：`dom`（`WaterEditorDom`）、`panel`（`WaterPanelView`）。
- 状态：`getState()`（可写）、`getSelectedSource()`。
- 运行时命令：`applySimState()`、`applyVisual()`、`resetSimulation()`、`rebuildSimulation()`、
  `refreshSelectedSource(change)`、`rebuildDomain()`、`enterMode(mode)`、`markModeTouched()`。
- 水源命令：`selectSource(id)`、`deleteSelectedSource()`、`togglePlacing()`、`clearSources()`。
- 工程命令：`saveNow(manual)`、`scheduleSave()`、`exportProject()`、`importProject(file)`、
  `toast(message, duration?)`。

### PointerHost

- 声明：`waterPointerController.ts`；消费方：`WaterPointerController`；实现：`WaterEditor`。
- 资源：`viewer`、`canvas`、`markers`（`SourceMarkers`）。
- 查询：`getMode()`、`getProjection()`、`getSources()`、`isBuilding()`、`isPlacing()`、
  `hasSelection()`、`groundLevelAt(longitude, latitude, preferred?)`。
- 命令：`selectSource(id)`、`placeSource(longitude, latitude, height?)`、
  `previewDraggedSource(source)`、`commitDraggedSource(source)`、`exitPlacing()`、
  `toast(message, duration?)`。

### DomainBuildHooks

- 声明：`waterDomainBuilder.ts`；消费方：`WaterDomainBuilder`；实现：`WaterEditor`。
- 方法：`onProgress(percent, label)`、`onToast(message, duration?)`。

### WaterEditorOptions

- 声明：`waterEditor.ts`；消费方：`WaterEditor`；实现：`main.ts`。
- 方法：`toast(message, duration?)`。

约束：

- 端口只声明消费方真正使用的能力，不把整个编辑器作为参数传入。
- 端口方法只传递值或命令，不返回内部可变对象；`getState` 在面板端口上标注 `Readonly`。
- 新增能力时先扩端口方法，再在 `WaterEditor` 实现；不要在消费方里 `import` 编辑器类型。
- 宿主接口的注释只说明契约（只读、写后需同步等），不描述业务需求。

## A4. 组合根

`main.ts` 是唯一知道所有具体类的地方：

```text
boot()
├─ new tellux.Viewer(...)
├─ mountWaterEditor(viewer) → new WaterEditor(viewer, { toast })
├─ initUiShell()
├─ initCloudControls({ viewer, showToast, onTimeChange })
└─ 全局错误与卸载处理
```

- `WaterEditor` 内部再装配 `WaterPanelView`、`WaterPointerController`、`WaterControlsBinder`、
  `SourceMarkers`、`DomainBoundary`、`WaterDomainBuilder`，并传入端口实现。
- `ui/` 模块只接收 `viewer` 与回调，不持有 `WaterEditor`。
- 除 `window.viewer`、`window.waterEditor`、`window.__waterEditor` 三个调试句柄外，不新增全局单例。
- 模块级可变状态只允许出现在资源缓存（程序化纹理、材质）中，且必须能在 `dispose` 中释放。

## A5. 状态所有权

`WaterState` 的所有权完全在 `WaterEditor`：

| 角色                     | 权限           | 手段                                                   |
| ------------------------ | -------------- | ------------------------------------------------------ |
| `WaterEditor`            | 读写           | 私有字段 `state`                                       |
| `WaterPanelView`         | 只读           | `WaterPanelHost.getState(): Readonly<WaterState>`      |
| `WaterControlsBinder`    | 经宿主写入字段 | `ControlsHost.getState()` + 命令方法                   |
| `WaterPointerController` | 只读 + 命令    | `PointerHost.getSources()` / `commitDraggedSource`     |
| 外部 / 测试              | 快照           | `currentState`、`debugApi().getState()` → `cloneState` |

派生数据（`SimTerrain`、`SimSource`、`SimSettings`、`SurfaceDomain`、`SunState`）在边界处
生成并立即交给消费方，不写回 `WaterState`：

- `toSimSources()` 把经纬度转成域内米制偏移。
- `resampleTerrain()` 把 97² 高度场重采样到模拟分辨率。
- `sunStateForDirection()` 把太阳方向转成 HDR 调色板。

## A6. DOM 解耦

DOM 契约集中在三层：

```text
index.html（id 声明）
  └─ src/shared/domIds.ts（生成：DOM_IDS / DomId / domId）
      ├─ waterEditorDom.ts（编辑器元素 → WaterEditorDom）
      └─ ui/shell.ts、ui/cloudControls.ts、main.ts
```

- 领域代码不写 CSS 选择器字符串；一律 `domId('...')`，拼错时编译失败。
- `waterEditorDom.ts` 是编辑器元素的唯一查询点，查询失败由 `requireElement` 立即抛错。
- `visualControls` 表把外观滑杆的 `key`、DOM、范围放在一处，`syncAppearance` 与
  `bindAppearanceControls` 共享，避免两处各列一遍。
- 样式与行为分离：`dom.dataset.mode` / `data-placing` / `data-selected` 作为状态钩子，
  具体视觉在 CSS；JS 不写内联颜色（加载条除外，见 `main.ts` 的 `setLoader`）。
- 每帧逻辑不读布局：`canvasSize` 由 `ResizeObserver` 维护，`waterEditor` 只读缓存。

## A7. 模拟、渲染与 UI 的契约

三者通过数据契约连接，而不是互相调用：

| 契约     | 定义                                                          | 生产者                            | 消费者                           |
| -------- | ------------------------------------------------------------- | --------------------------------- | -------------------------------- |
| 状态纹理 | RGBA32F / HalfFloat；R 水深、G 东速、B 北速、A 相对地形       | `ShallowWaterSim`                 | `WaterSurface`                   |
| 地形纹理 | `resolution²` Float32，相对 `baseElevation`                   | `WaterEditor` / `resampleTerrain` | `ShallowWaterSim`                |
| 域信息   | `SurfaceDomain`（origin / size / resolution / baseElevation） | `WaterEditor`                     | `WaterSurface`、`DomainBoundary` |
| 外观参数 | `WaterVisualSettings`                                         | `WaterState`                      | `WaterSurface.setVisual`         |
| 太阳状态 | `SunState`                                                    | `sun.ts`                          | `WaterSurface.setSunDirection`   |
| 模拟参数 | `SimSettings`                                                 | `WaterEditor`                     | `ShallowWaterSim.setSettings`    |

实现约束：

- 模拟层不 import `three` 之外的渲染对象；不操作 DOM，不读 `viewer`。
- 渲染层（`WaterSurface`、`markers`）不读 `WaterState`，只接收 `SurfaceDomain`、设置与纹理。
- GLSL 以字符串常量导出，TS 侧只通过 uniform 名称交互；uniform 缺失时 `ShallowWaterSim.uniform`
  抛错，避免静默写 `undefined`。
- GLSL 数组长度必须是编译期常量：`DEPTH_FRAGMENT` 用 `__MAX_SOURCES__` 占位，由
  `depthShaderSource()` 注入 `MAX_SOURCE_COUNT`；统计块边长由 `statsFragment(blockSize)` 生成。

## A8. 基础设施解耦

| 能力        | 模块                               | 解耦方式                                       |
| ----------- | ---------------------------------- | ---------------------------------------------- |
| 存储        | `persistence.ts`、`domainCache.ts` | 失败返回 `null` / `false`，调用方决定提示      |
| 网络        | `domainCache.ts`                   | 超时 + 两级缓存；静态托管下跳过服务器接口      |
| 时间 / 分帧 | `async.ts`                         | `nextFrame` / `delay`，不直接散落 `setTimeout` |
| 地形可用性  | `terrainSampling.ts`               | 只依赖 `Viewer` 与时间，不碰编辑器状态         |
| 建域流程    | `waterDomainBuilder.ts`            | 进度通过 hooks，不碰 DOM                       |
| 瓦片缓存    | `tile-cache.mjs`                   | 同时被 Vite 中间件与生产服务器复用             |

## A9. 反模式

| 反模式                                      | 后果                      | 替代                        |
| ------------------------------------------- | ------------------------- | --------------------------- |
| `water/` 直接 `document.querySelector`      | 领域与 DOM 绑定，无法测试 | 通过 `WaterEditorDom` 注入  |
| `ui/` import `WaterEditor`                  | 界面与领域循环依赖        | 回调 + options              |
| 面板直接改 `state` 并调用 `sim.setSettings` | 写入路径分散              | 宿主命令方法                |
| 把 `WaterState` 引用传给外部                | 外部可绕过归一化          | `cloneState`                |
| 在 `WaterSurface` 里读 `WaterState`         | 渲染层依赖状态结构        | 传设置与域信息              |
| 在 shader 字符串里硬编码数组长度            | TS 常量与 GLSL 漂移       | 占位符 + 生成函数           |
| 复制 `WATER_DOMAIN` 到多个模块              | 数值不一致                | 单一常量；Node 侧注明同步点 |
| 在事件回调里直接 `localStorage.setItem`     | 无法统一防抖 / 失败处理   | `scheduleSave` / `saveNow`  |

## A10. 扩展路径

| 改动           | 需要触碰                                                                                                                              | 不需要触碰                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 新增水源字段   | `types.ts`（接口、默认值、归一化、测试）→ 视图 → 必要时 `SimSource` / uniform                                                         | 渲染 shader（除非要显示） |
| 新增外观滑杆   | `types.ts`（`WaterVisualSettings`）→ `index.html` → `gen:dom` → `waterEditorDom.visualControls` → `waterSurface.setVisual` / shader   | 模拟层                    |
| 新增模拟参数   | `types.ts`（`WaterSimSettings` / `SimSettings`）→ `WaterControlsBinder` → `WaterEditor.applySimState` → `ShallowWaterSim.setSettings` | 面板视图（除输出文案）    |
| 新增渲染模块   | `src/water/` 新文件 → `WaterEditor` 组合 → 生命周期 `dispose`                                                                         | `ui/`                     |
| 新增场景控件   | `src/ui/` → `index.html` → `main.ts` 装配                                                                                             | `water/`                  |
| 新增 Node 脚本 | `scripts/` → `package.json`                                                                                                           | `src/`                    |
| 新增服务端路由 | `server.mjs` / `tile-cache.mjs` → E2E                                                                                                 | `src/`                    |

## A11. 检查手段

- `npm run lint`：分层 import 规则、禁止 `any`、类型导入。
- `npm run type-check`：接口与实现一致、`noUncheckedIndexedAccess`。
- `npm run check:conventions`：DOM id 与生成文件同步。
- `npm test`：状态归一化边界。
- `npm run verify`：跨层行为（模式、建域、拖动、持久化）。

---

# B. 注释规范

## B1. 原则

注释只解释**代码为什么这样写**，以及**不写就会踩坑的技术约束**。不解释产品需求、交互取舍或
项目计划；这些内容不进入代码。

三条硬规则：

1. **技术性**：只写机制、不变量、单位、边界、性能与兼容性。
2. **必要性**：代码本身能表达的（类型、命名、结构）不再重复。
3. **同步性**：行为改变时同一次提交更新注释；过期注释比没有注释更糟。

## B2. 文件头

每个模块顶部用块注释说明职责与关键不变量，2–6 行，不写背景故事：

```ts
/**
 * 水面程序化纹理：可平铺的法线贴图与泡沫噪声。
 *
 * 全部在 CPU 一次性生成 256² 的 RGBA8 DataTexture，不依赖图片资源；
 * 采样约定：u 沿东、v 沿北。
 */
```

要求：

- 第一行是“模块做什么”，不是“为什么做这个功能”。
- 需要时补充坐标、通道、单位、缓存位置等跨模块契约。
- 不从“需求 / 目标 / 用户”开头；功能背景放在文档，不放代码。

## B3. 类型与成员

导出的接口、类型、类、公共方法使用 `/** ... */`；私有成员在语义不自明时使用单行注释。

必须写的情况：

| 情况        | 示例                                               |
| ----------- | -------------------------------------------------- |
| 单位 / 范围 | `/** 单格允许的最大流速（m/s）5–60。 */`           |
| `null` 语义 | `/** 目标水面绝对高程（米）；null = 不限制。 */`   |
| 坐标 / 通道 | `/** 相对域中心的东向偏移（米）。 */`              |
| 生命周期    | `/** 模拟分辨率变化时由调用方销毁并重建。 */`      |
| 失败语义    | `/** 不可用时返回 null，调用方回退到现场采样。 */` |
| 副作用顺序  | `/** 写入后需调用 applySimState 才会生效。 */`     |

不写的情况：

- 类型已表达的（`/** @param name 名称 */`、`@returns` 之类）。
- 显而易见的赋值（`/** 设置宽度 */` 紧挨 `setWidth`）。
- 设计模式名词堆砌（“这里使用策略模式……”）。

## B4. 内联注释

只在“为什么”不明显时使用，放在被解释代码的上方，单行优先：

```ts
// WGS84 子午圈 / 卯酉圈在给定纬度的每度弧长（米）。
const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * latRad) + ...
```

适合内联注释的内容：

- 非直观公式的来源与近似条件。
- 平台 / 驱动 / 浏览器兼容性（如 WebGL 浮点纹理降级、`AbortSignal.timeout` 缺失）。
- 顺序约束（必须先 `endDrag` 再恢复光标、先解绑再释放）。
- 性能约束（每帧不读布局、低频统计读回、GPU 同步等待）。
- 迁移逻辑（旧字段兼容、单位换算）。

不适合：

- 复述下一行代码。
- 大段设计说明；应放到文件头或文档。
- 注释掉的旧实现。

## B5. 禁止内容

| 禁止                                         | 原因                       | 应该写在哪                 |
| -------------------------------------------- | -------------------------- | -------------------------- |
| 产品需求、验收标准、“用户希望”               | 代码仓库不是需求库         | 需求 / 设计文档            |
| 交互与视觉取舍（“优先保留”“避免争夺注意力”） | 会随产品变化，注释迅速过期 | 设计说明；代码只写技术效果 |
| 版本历史、日期、作者、重构记录               | Git 已有                   | 提交信息                   |
| 注释掉的代码                                 | 无法维护、易误解           | 删除，依赖 Git             |
| 装饰性 ASCII 大图                            | 增加噪声                   | 允许简短的分节线，见下     |
| `TODO` 没有具体条件                          | 永久遗留                   | 写清触发条件与替代方案     |

允许的结构性分节：TS 中用 `// ------------------- 模拟域`，CSS 中用
`/* ===== 设置分组与行 ===== */`。分节线只做导航，不写句子。

## B6. 语言与格式

- 注释用中文；标识符、类型名、命令用反引号：`` `WaterState` ``、`` `npm run gen:dom` ``。
- 使用全角标点；句末不加多余空格；每行不超过 Prettier 的 100 列。
- `//` 后保留一个空格；块注释对齐 `*`。
- 不用 emoji、感叹号、第一人称。
- 生成文件由生成器写头注释，不手改：

  ```ts
  /**
   * 由 scripts/generate-dom-ids.mjs 从 index.html 生成，请勿手改。
   *
   * id 变化后运行 `npm run gen:dom`；`npm run check:conventions` 校验同步。
   */
  ```

- GLSL 模板保留 `/* glsl */` 标记，供编辑器高亮与格式化。
- 不为注释加 JSDoc 类型标签（`@param` / `@returns`）；TypeScript 已提供类型。

## B7. 示例

### 好

```ts
/** 单帧最大推进时间，避免切页 / 卡顿导致波纹瞬间跳变。 */
const MAX_FRAME_DT = 0.1

// 开放吸收边界：域外虚拟格水深为 0、地形与当前格相同，边界格只出不进。
const outsideDepth = 0.0

/** 模拟域外的水源在重建时移除（兼容旧工程数据）。 */
this.filterSourcesToDomain(center, sizeMeters)

// 面板阻尼以 1/60 s 为参考；当前子步更长，按幂次换算保持每秒衰减不变。
const dampingRatio = SUBSTEP_SECONDS / REFERENCE_SUBSTEP_SECONDS
```

### 差

```ts
// 需求：左栏在窄屏改为抽屉，优先保留地形与水体状态。
// 用户希望拖动时不要平移地球。
// 2025-11 重构：把这里拆成三个方法。
// TODO: 以后优化。
// this.surface.dispose()  旧实现
```

改写方式：

| 原注释                             | 问题     | 改写                                                  |
| ---------------------------------- | -------- | ----------------------------------------------------- |
| “窄屏优先保留地形与水体状态”       | 产品取舍 | “≤900px：隐藏第 3、4 个状态胶囊。”                    |
| “用户能看到失败在哪一步”           | 用户视角 | “视口就绪前写入加载层，就绪后改用 toast。”            |
| “面板不得修改状态”                 | 规范口吻 | “面板只读状态（写入走编辑器的命令方法）。”            |
| “不限制目标水位不代表可以无限注水” | 需求解释 | “无目标水位时以水源处地形 + 每次注水量作为压力水头。” |
| “保持与 index.html 同步”           | 流程要求 | “由 index.html 生成；check:conventions 校验同步。”    |

## B8. 工具链

| 工具                | 对注释的作用                                     |
| ------------------- | ------------------------------------------------ |
| Prettier            | 统一缩进、换行、Markdown 表格；`printWidth: 100` |
| ESLint              | 不检查注释内容；`no-restricted-imports` 守护分层 |
| TypeScript          | `skipLibCheck`、严格模式；注释不参与类型         |
| `check:conventions` | 校验生成文件头与 id 引用                         |

提交前：

```bash
npm run type-check && npm run lint && npm run format:check && npm run check:conventions && npm test
```

## B9. 评审清单

- [ ] 文件头说明职责与技术不变量，不写产品背景。
- [ ] 单位、范围、`null` 语义、坐标与通道有注释。
- [ ] 非直观公式、平台兼容、顺序与性能约束有“为什么”。
- [ ] 没有需求、验收、用户故事、版本历史与注释掉的代码。
- [ ] 注释与当前行为一致，没有引用已删除的文件或脚本。
- [ ] 生成文件未被手改，头注释由生成器维护。
- [ ] `npm run check` 全部通过。
