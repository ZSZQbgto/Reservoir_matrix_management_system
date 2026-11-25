# 方法规范

本文约束方法（函数、类成员、事件处理器、异步任务）的命名、签名、状态写入、错误处理与生命周期。目标是让调用点可预测：看名字知道副作用，看签名知道输入输出，看实现知道失败路径。

相关文档：[包类结构](./package-structure.md) · [解耦与注释规范](./decoupling-and-comments.md)

---

## 1. 总则

1. **一个方法一个动作**：查询、同步、应用、保存、提示分开；不要在同一个方法里既改状态又写 DOM 又落盘。
2. **副作用写在名字里**：`sync*` 只写 DOM，`apply*` 只推运行时，`save*` 只落盘。
3. **状态只有一个写入者**：`WaterState` 由 `WaterEditor` 修改；视图类只读。
4. **边界处夹取**：外部输入在进入领域时归一化，内部不再重复防御。
5. **失败有明确出口**：抛错、返回 `null`、静默降级三选一，并在注释中说明。

## 2. 命名

方法名 = 动词 + 名词，必要时带单位或限定词。既有前缀含义如下（新增方法沿用）：

| 前缀 / 形式                    | 语义                            | 示例                                                          |
| ------------------------------ | ------------------------------- | ------------------------------------------------------------- |
| `get*`                         | 读取派生值，不产生副作用        | `getStats`、`getSelectedSource`、`getProjection`              |
| `is*` / `has*`                 | 布尔判断                        | `isBuilding`、`isDomainReady`、`hasSelection`                 |
| `set*`                         | 覆盖式写入；可能夹取或重建资源  | `setSources`、`setSettings`、`setVisual`、`setDomain`         |
| `sync*`                        | 状态 → DOM 的单向刷新           | `syncAll`、`syncBusy`、`syncSourceList`、`syncModeUI`         |
| `apply*`                       | 状态 → 运行时对象 / uniform     | `applySimState`、`applyVisual`、`applyCloudTuning`            |
| `load*` / `fetch*`             | 读取存储或网络，失败返回 `null` | `loadCached`、`loadStoredState`、`fetchServerDomainField`     |
| `store*` / `save*`             | 写入持久化                      | `storeState`、`saveNow`、`saveCachedDomainField`              |
| `schedule*`                    | 安排延迟任务                    | `scheduleSave`                                                |
| `build*` / `create*`           | 构造对象或资源                  | `buildDomain`、`createSimulation`、`createSourceId`           |
| `query*` / `resolve*`          | 查询 DOM / 解析可选依赖         | `queryWaterEditorDom`、`resolveCloudsEffect`                  |
| `ensure*`                      | 幂等地保证前置条件              | `ensureDomain`                                                |
| `enter*` / `exit*` / `toggle*` | 模式与交互状态                  | `enterMode`、`exitPlacing`、`togglePlacing`                   |
| `update*`                      | 每帧或阶段性推进                | `update`、`updateSun`、`updateFrame`                          |
| `attach` / `detach`            | 事件订阅的对称入口              | `WaterControlsBinder.attach`、`WaterPointerController.detach` |
| `handle*`                      | 事件回调                        | `handleBeforeUnload`、`handlePointerDown`                     |
| `bind*`                        | 建立一组 DOM 事件绑定           | `bindModeControls`、`bindProjectControls`                     |
| `normalize*`                   | 把任意输入收敛到合法结构        | `normalizeWaterState`、`normalizeCloudTuning`                 |
| `refresh*` / `reveal*`         | 局部刷新 / 滚动到可视区         | `refreshSelectedSource`、`revealSourceEditor`                 |
| `reset*` / `clear*`            | 归零 / 清空                     | `resetSimulation`、`clearSources`                             |
| `dispose`                      | 释放资源，必须可重复调用        | `WaterSurface.dispose`、`ShallowWaterSim.dispose`             |

补充规则：

- 布尔成员用 `is` / `has` 前缀；开关字段用形容词（`enabled`、`paused`、`visible`）。
- 单位写进名字：`sizeMeters`、`dtSeconds`、`durationMs`、`mPerDegLat`、`groundLevel`。
- 避免缩写；允许的短名：`dt`、`uv`、`x` / `z`、`lon` / `lat`、`id`。
- 私有方法仍在类内保持一致前缀，不用 `_` 或 `#`。

## 3. 签名与类型

### 3.1 返回值

- 导出的公共方法显式标注返回类型；事件回调与短箭头函数可推断。
- 只有副作用的方法返回 `void`；不要返回 `this` 做链式调用。
- 可能失败的操作返回 `boolean` 或 `T | null`，不要用抛错表达业务失败。
- 异步方法返回 `Promise<T>`；不要返回 `Promise<void>` 以外再包一层。

### 3.2 参数

- 参数超过 3 个，或包含多个布尔开关时，使用 options 对象：
  `TerrainSampleOptions`、`CloudControlsOptions`、`WaterEditorOptions`。
- 依赖注入的构造参数加 `private readonly`，例如
  `constructor(private readonly host: PointerHost)`。
- 只读输入用 `Readonly<WaterState>` 或 `Readonly<T>` 表达，例如
  `WaterPanelHost.getState(): Readonly<WaterState>`。
- 回调参数写明签名：`onProgress(percent: number, label: string): void`。
- 不使用 `any`；外部数据用 `unknown` 接收，再由 `normalize*` 或类型守卫收窄。
- 类型导入使用 `import type`（`verbatimModuleSyntax` + ESLint 强制）。

### 3.3 `null` 与 `undefined`

| 值          | 语义                                 | 示例                                           |
| ----------- | ------------------------------------ | ---------------------------------------------- |
| `null`      | 领域上的“不存在 / 不限制”            | `domain: null`、`targetLevel: null`            |
| `undefined` | 查询未命中或可选参数缺省             | `groundFromField` 未命中、`preferred?: number` |
| `??`        | 仅在 `null` / `undefined` 时取默认值 | `options.cacheDir ?? defaultCacheRoot(root)`   |
| `== null`   | 同时判断两者                         | `source.targetLevel == null`                   |

公共 API 不返回 `undefined` 表示业务失败；业务失败用 `null` 或明确错误。

### 3.4 数字与布尔

- 布尔参数只允许一个，且语义从上下文明显（`saveNow(manual)`）；多个开关必须收敛为
  options 或独立方法。
- 数值参数命名带单位；角度写明弧度 / 度（`rad` / `deg` 或注释说明）。
- 不从 DOM 直接读取数值进入领域：先在 binder 中 `Number(...)` + `clamp`。

## 4. 可见性与成员形式

- 默认 `private`；只有组合根、测试钩子或跨模块契约需要 `public`。
- 类字段尽量 `private readonly`；需要替换的运行时对象（`sim`、`surface`）用可变字段。
- 事件处理器使用箭头函数字段，保证 `this` 指向实例，且 `attach` / `detach` 能拿到同一引用：

  ```ts
  private handleBeforeUnload = (): void => {
    this.saveNow(false)
  }
  ```

- 只读派生值用 `get`（`currentMode`、`stateTexture`、`isVisible`）；需要参数或计算的用方法。
- 内部辅助函数放在类内 `private`，模块级工具放同文件顶部；跨模块复用才提取到 `shared/`。

## 5. 方法与状态

状态写入遵循固定顺序：

```text
mutate → apply*（运行时） → sync*（DOM） → scheduleSave（持久化）
```

| 步骤       | 责任方                                | 示例                                             |
| ---------- | ------------------------------------- | ------------------------------------------------ |
| 修改字段   | `WaterEditor` / `WaterControlsBinder` | `state.sim.speed = clamp(...)`                   |
| 推送运行时 | `applySimState` / `applyVisual`       | `sim.setSettings(...)`、`surface.setVisual(...)` |
| 刷新界面   | `panel.sync*`                         | `syncSimControls`、`syncPill`                    |
| 延迟保存   | `scheduleSave`                        | 500 ms 防抖                                      |

具体约束：

- `WaterPanelView` 的方法只写 DOM，不调用 `apply*`、不落盘、不发请求。
- `WaterControlsBinder` 只改字段并调用宿主命令；不直接操作 `sim` / `surface`。
- `WaterEditor` 的私有命令方法负责把上述步骤组合完整；不要在事件回调里拆散。
- 读取当前状态给外部时使用 `cloneState`，禁止把内部对象引用交出去。
- 状态结构变化后必须同步更新 `normalizeWaterState` 与默认值，保持旧数据可迁移。

## 6. 数值与边界

- **外部输入在入口夹取**：`setSettings`、`setVisual`、`applyCloudTuning`、
  `normalizeWaterState` 都对范围与有限性做检查；调用方不必重复。
- **内部计算不再防御**：已经校验过的 `SimTerrain`、`LocalProjection` 直接使用。
- 使用 `clamp(value, min, max)` 与 `toFiniteNumber` / `isFiniteNumber`，不要手写 `Math.min/Math.max` 链。
- 整数参数显式 `Math.round`：`injectInterval`、`resolution`、`cloud tuning` 的整数键。
- 浮点比较带容差：地形漂移阈值 `0.6 m`、累积子步 `1e-6`。
- 范围常量只维护一份：面板范围用 `SOURCE_RADIUS_PANEL_RANGE`，数据范围用
  `SOURCE_RADIUS_RANGE`，滑杆 `min/max` 与 TS 常量同步。
- 时间统一用秒或毫秒并在名字中注明；`ShallowWaterSim.update(dtSeconds)` 的 `dt` 上限 0.1 s。

## 7. 错误处理

| 场景         | 策略                                                    | 示例                                                     |
| ------------ | ------------------------------------------------------- | -------------------------------------------------------- |
| 构造参数非法 | 抛 `Error('模块名: 原因')`                              | `ShallowWaterSim` 校验 renderer / terrain / 分辨率       |
| 外部数据损坏 | 归一化或返回默认值                                      | `normalizeWaterState(null)`、`readStateFile` 返回 `null` |
| 存储不可用   | 静默降级：`storeState` 返回 `false`，其余写操作直接返回 | `storeState`、`storeMode`、`writeCloudPrefs`             |
| 网络失败     | 返回 `null` / 走下一级缓存                              | `fetchServerDomainField`                                 |
| 用户可见失败 | `toast` 提示 + 恢复状态                                 | 建域失败、导入失败                                       |
| 未预期异常   | `console.error` 记录，边界处 `toast`                    | `buildDomain` 的 `catch`                                 |
| 脚本失败     | `process.exitCode = 1` 或 `process.exit(1)`             | `cache-region.mjs`                                       |

规则：

- 不使用空 `catch`；若确实要忽略，写注释说明（如 localStorage 不可用）。
- 不吞掉 Promise：顶层用 `void` 标记 fire-and-forget，或在调用处 `catch`。
- 公共异步方法不把内部异常原样抛给 UI；在 `WaterEditor` 边界转换为提示与状态回滚。
- 错误信息格式：`[模块] 说明`（日志）或 `模块名: 说明`（异常）。

## 8. 生命周期

创建 → 绑定 → 使用 → 释放：

```text
new WaterSurface(...)
  ├─ 分配 geometry / material / textures
  └─ 加入 viewer.scene.raw
attach()/update()/set*()
dispose()
  ├─ this.disposed = true
  ├─ scene.remove(mesh)
  └─ geometry / material / textures.dispose()
```

约定：

- `dispose()` 必须幂等：入口 `if (this.disposed) return`，重复调用安全。
- 释放顺序：先停调度（RAF / timer），再解绑事件，再释放 GPU 与 DOM。
- `attach` 与 `detach` 成对出现，注册与移除使用同一函数引用与同一捕获标志。
- 重建而非原地修改：模拟精度变化走 `disposeSimulation` → `createSimulation`。
- 构造函数不读取布局尺寸用于每帧计算；需要时缓存（`canvasSize`）。
- 全局副作用（`window.__waterEditor`、RAF、`ResizeObserver`）必须能在 `dispose` 中撤销。

## 9. 异步与取消

- 统一 `async/await`，不用裸 `.then` 链；顺序流程直接 `await`。
- 需要让出主线程的循环用 `await nextFrame()`；固定等待用 `await delay(ms)`。
- 长任务携带取消令牌：

  ```ts
  const control = { cancel, isStale: () => token !== this.buildToken }
  const result = await this.domainBuilder.sample(center, size, control)
  ```

- 每次 `await` 之后重新检查 `isStale()` / `disposed`，避免旧任务写回新状态。
- 并发请求合并：已有 `build.promise` 时直接复用，不重复建域。
- 超时显式设置：服务器缓存请求 4 s、地形可用等待 20 s、地形稳定等待 12 s。
- 不阻塞首帧：地形按行分帧采样（每帧 4 行）。
- `void promise` 仅用于“失败已内部处理”的调用，如 `void flyOverDomain(...)`。

## 10. 事件与 DOM

- DOM 查询只在 `main.ts`、`waterEditorDom.ts`、`cloudControls.ts`、`shell.ts` 等边界进行；
  编辑器内部通过 `this.dom` 访问。
- 事件绑定集中在 `WaterControlsBinder` 与 `WaterPointerController`；`WaterEditor` 不直接 `addEventListener`
  （全局 `beforeunload` 除外）。
- 指针事件：`pointerdown` 捕获阶段拦截，拖动期间 `viewer.controls.enabled = false`；
  `pointerup` / `pointercancel` / `window.blur` 都收敛到 `endDrag()`。
- 键盘：`Escape` 退出放置 / 关闭抽屉；焦点移动用 `focus({ preventScroll: true })`。
- 文本写入优先 `textContent`；`innerHTML` 只用于列表模板，且所有动态字符串过 `escapeHtml`。
- 每帧不读布局：画布尺寸由 `ResizeObserver` 写入 `canvasSize`；相机读数用 450 ms 定时器。
- 程序化修改滑杆值后调用 `syncRangeFill(input)`，保证 `--fill` 与值一致。

## 11. 公共 API 与测试钩子

- `WaterEditor` 对外只暴露 `enterMode`、`dispose`、`currentMode`、`currentState`、`isDomainReady`。
- E2E 需要的额外能力放在 `debugApi()`，通过 `window.__waterEditor` 暴露，不扩大类 API。
- 调试 API 返回快照（`cloneState`、投影副本），不返回内部对象。
- `window.viewer` / `window.waterEditor` 仅用于调试与 E2E，业务代码通过构造参数获取依赖。
- 新增测试钩子时同步更新 `scripts/verify.mjs` 与 `src/global.d.ts`。

## 12. 模板与反例

### 12.1 边界 setter

```ts
setSettings(settings: SimSettings): void {
  if (this.disposed || !settings) return
  this.settings = {
    speed: clamp(toFiniteNumber(settings.speed) ?? 1, 0.1, 64),
    paused: settings.paused,
    waterAmount: clamp(toFiniteNumber(settings.waterAmount) ?? 15, 1, 300)
  }
}
```

### 12.2 同步方法

```ts
syncBusy(): void {
  const busy = this.host.isBuilding()
  this.dom.addButton.disabled = busy
  this.dom.clearButton.disabled = busy || this.host.getState().sources.length === 0
}
```

### 12.3 可取消异步

```ts
const result = await this.domainBuilder.sample(center, sizeMeters, control)
if (!result || token !== this.buildToken) return false
this.applyDomainField(result.field, 'sampled', result.projection)
```

### 12.4 反例

| 反例                                                        | 问题                 | 改法                                     |
| ----------------------------------------------------------- | -------------------- | ---------------------------------------- |
| `handleClick()` 里改状态、写 DOM、存 localStorage、弹 toast | 无法复用、难测试     | 拆成命令方法，内部按顺序调用             |
| `getState()` 直接返回 `this.state`                          | 外部可绕过归一化修改 | `cloneState(this.state)`                 |
| `setMode(mode, animate, save)`                              | 布尔参数陷阱         | options 对象或拆分方法                   |
| `catch {}` 吞掉建域异常                                     | 进度条卡死且无日志   | `console.error` + `toast` + 结束 waiters |
| `update()` 中 `canvas.getBoundingClientRect()`              | 每帧强制回流         | 缓存尺寸，`ResizeObserver` 更新          |
| `any` 接 JSON                                               | 运行时形状失控       | `unknown` + `normalizeWaterState`        |

## 13. 评审清单

- [ ] 方法名能看出副作用与返回值。
- [ ] 公共方法显式返回类型；参数与字段带单位。
- [ ] 状态修改集中在 `WaterEditor`，视图类只读。
- [ ] 外部输入在入口夹取，内部不重复防御。
- [ ] 失败路径明确：抛错 / `null` / 静默降级均有理由。
- [ ] `attach` 与 `detach`、创建与 `dispose` 成对。
- [ ] `dispose()` 幂等，能取消定时器、RAF、监听器与 GPU 资源。
- [ ] 异步任务在每次 `await` 后检查取消 / 陈旧标记。
- [ ] 没有每帧 DOM 读取、无 `innerHTML` 未转义、无悬空 Promise。
- [ ] 新增 DOM 引用走 `index.html` → `gen:dom` → `waterEditorDom`。
