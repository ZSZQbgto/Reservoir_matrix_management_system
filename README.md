# Tellux Earth · Cesium 地形 · 浅水水体编辑

基于 [Tellux 0.3](https://github.com/cyanfish-x/tellux) 的三维地球站点，并在此基础上增加了
**基于浅水方程的水体编辑器**：在固定 8 km × 8 km 模拟域内点选放置水源，水面按浅水方程在 GPU 上
流动、漫溢、蓄积，可调整模拟参数与外观、保存/导出水体工程。

## 当前内容

- **地形**：Cesium World Terrain（Cesium Ion asset `1`），经本地磁盘缓存提供
- **影像**：Cesium / ArcGIS World Imagery，经本地磁盘缓存提供
- **本地缓存**：默认预热中心 `116.77, 36.02`、50 km × 50 km 的地形与影像瓦片到
  `.cache/tiles`，之后启动/浏览优先读本地，不再每次从网上加载；缺块时按需回源并写盘
- **大气/云**：Takram 大气散射、星空、体积云；体积云默认关闭，支持手动调整云量、云底高度、
  云层厚度、流动速度、渲染质量、云形细节、湍流、薄雾、体积光柱与云影质量
- **水体编辑**：GPU 浅水模拟、固定 8 km × 8 km 模拟域（中心 116.77, 36.02）、最多 8 个可拖动水源、
  目标水位与全局水位上限、菲涅尔/太阳高光/深度吸收/泡沫水面渲染、本地自动保存与 JSON 导入导出

## 快速开始

环境要求：Node.js ≥ 22（`tests/` 直接运行 `.ts` 依赖 Node 原生类型剥离）、支持 WebGL2 的浏览器；
`npm run verify` 需要本机安装 Chrome 或 Edge（有头模式，headless 下 Cesium 地形无法加载）。

```bash
npm install
npm run cache:prefetch   # 首次：预热 116.77,36.02 附近 50×50 km 地形与影像（可跳过，浏览时按需缓存）
npm run build
npm start
```

打开 <http://127.0.0.1:8090>。

### 开发

```bash
npm run dev        # vite 开发服务器 http://127.0.0.1:5173
```

dev / preview / 生产服务器都内置同一套本地瓦片缓存中间件：页面直接请求
`/terrain-cache/*` 与 `/imagery-cache/*`，命中磁盘即本地返回，缺块才回源 Cesium Ion /
ArcGIS 并写盘。浏览器端不再需要 Cesium token。

## 配置

`.env` 中的 Cesium Ion token 用于本地**服务端回源与预热**；GitHub Actions 使用工作流内置
token（或 secret 覆盖）在 CI 预热。前端不直接访问 Cesium Ion：

```dotenv
CESIUM_ION_TOKEN=你的_cesium_ion_token
```

## 本地地形与影像缓存

### 默认区域

- 中心：`116.77, 36.02`（东平湖附近），边长 **50 km × 50 km**
- 地形：Cesium World Terrain quantized-mesh，默认 0–14 级
- 影像：ArcGIS World Imagery，默认 8–15 级
- 目录：`.cache/tiles`（已 gitignore，可用 `TILE_CACHE_DIR` 或 `--cache-dir` 改到任意磁盘位置）

缓存目录结构：

```text
.cache/tiles/
├── terrain/
│   ├── layer.json
│   └── {z}/{x}/{y}.terrain
├── imagery/
│   └── {z}/{y}/{x}.jpg
├── domain/
│   └── domain.json        # 固定模拟域地形高度场（与浏览器 localStorage 双向兜底）
└── manifest.json          # 区域、层级、块数、字节数、更新时间
```

### 预热

```bash
npm run cache:prefetch
```

默认下载上文 50×50 km 区域（地形约 800 块 / 影像约 3600 块，合计约 60–100 MB，
首次约 2–5 分钟，取决于网络）。可选参数：

| 参数 | 说明 |
| --- | --- |
| `--center <lon,lat>` | 区域中心，默认 `116.77,36.02` |
| `--size <meters>` | 区域边长，默认 `50000` |
| `--terrain-levels <a-b>` | 地形层级，默认 `0-14` |
| `--imagery-levels <a-b>` | 影像层级，默认 `8-15` |
| `--concurrency <n>` | 并发下载数，默认 8 |
| `--cache-dir <dir>` | 缓存目录 |

示例：把范围放大、影像提到 16 级：

```bash
npm run cache:prefetch -- --size 80000 --imagery-levels 8-16
```

### 按需缓存

没预热也能用：浏览到缓存范围外或更高层级时，中间件会实时回源并把瓦片写入 `.cache/tiles`，
下次同一位置就完全走本地。移除 `.cache/tiles` 即可清空缓存。

### 实现位置

- `scripts/tile-cache.mjs`：共享缓存中间件（dev / preview / 生产）+ 预热实现 +
  `/domain-cache/domain.json`（GET / POST / DELETE）模拟域本地存储接口
- `scripts/cache-region.mjs`：`npm run cache:prefetch` 命令
- `src/water/domainCache.ts`：模拟域地形高度场编解码、浏览器 localStorage 与服务器缓存读写
- `vite.config.ts`：dev / preview 挂载缓存中间件，并按 `BASE_PATH` 生成子路径构建
- `server.mjs`：生产服务器挂载缓存中间件，并在启动日志输出缓存块数与目录
- `scripts/export-static-cache.mjs`：把 `.cache/tiles` 导出为静态站点资源（GitHub Pages）
- `.github/workflows/deploy-pages.yml`：Pages 的构建 / 预热 / 发布工作流
- `src/ui/assets.ts`：静态资源基础路径与静态托管标记

## 体积云与大气

「场景控制」面板中的体积云分组提供手动调节（对应 Tellux `viewer.scene.clouds` 运行时 API）：

| 参数 | 范围 / 默认 | 说明 |
| --- | --- | --- |
| 云层开关 | 开 / 关（关） | 体积云总开关；状态同步到顶部「体积云」胶囊 |
| 云量 | 0–100%（30%） | 云覆盖率 |
| 云底高度 | 800–16000 m（9000 m） | 低云层组云底绝对高度 |
| 云层厚度 | 120–4000 m（800 m） | 低云层组厚度（独立可调，不再由云底高度推算） |
| 流动速度 | 0–8×（1×） | 天气纹理水平运动速度，1× = 0.001 UV/s |
| 渲染质量 | 低 / 中 / 高 / 极致（高） | 体积云采样质量档位，影响性能 |
| 云形细节 | 开 / 关（开） | shape detail |
| 湍流扰动 | 开 / 关（开） | 云体湍流 |
| 薄雾质感 | 开 / 关（开） | 云体雾霾 |
| 体积光柱 | 开 / 关（开） | 阳光穿过云层的体积光 |
| 云影质量 | 低 / 中 / 高（中） | 云影采样质量 |
| 最小步长 | 30–150 m（60） | 主光线的采样步长，越大采样越少、越省 GPU，但可能出现步进纹 |
| 主步进上限 | 120–500（400） | 主光线步进次数上限，直接决定每像素采样成本 |
| 太阳步进上限 | 0–4（2） | 朝太阳方向的二次步进次数，影响透光/阴影精度 |
| 散射强度 | 0.2–2（1.0） | 云体散射系数，越大越亮越厚 |
| 吸收强度 | 0–0.5（0.0） | 云体吸收系数，越大暗部与自遮挡越重 |
| 湍流位移 | 0–1000 m（350） | 开启湍流时的形体扰动幅度 |

「云体与性能」是一组直接作用于 Takram `CloudsEffect` 的数值参数（Tellux 公开 API 之外的
底层能力），比开关更适合权衡性能与观感。新装默认把最小步长放宽到 60 m、主步进降到 400，
相比默认「高」预设约省三成云渲染成本；切换「渲染质量」时，这组滑杆会跟随该预设的默认值，
之后的手动微调会一直保留并覆盖预设。

大气散射开关与北京时间滑杆在「大气与时间」分组中。以上体积云设置会写入
`localStorage`（键 `tellux-cloud-prefs-v1`），刷新后保持；水体外观参数则随水体工程一起保存。

## 水体编辑器

顶栏「浏览 / 水体编辑」切换模式；水体编辑模式下左右两栏分别是**水源列表**与**参数面板**，
场景控制台自动隐藏。水面与模拟不受模式限制：切回「浏览」后水面继续推进，只有水源标记、
放置交互与模拟域边界仅在水体编辑模式出现。

### 模拟域

- 模拟域**固定**为以 `116.77, 36.02` 为中心、边长 **8 km × 8 km** 的正方形，
  不再随视角位置或尺寸选择变化；第一次进入水体编辑时相机自动飞到域中心正上方俯视，
  便于观察整个域并促使该区域地形瓦片细化加载
- 模拟域内的地形高度在建立时按 **97 × 97** 网格采样（约 0.2 ms/点），换算为相对域中心
  椭球高的米数；模拟网格按「模拟精度」双线性重采样到 192² / 256² / 384²
- 「重建模拟域」会按固定中心与 8 km 范围重新采样地形（区外的旧水源会被移除并提示），
  拉远视角后再重建能采到更细的地形，水面会重新从干地开始模拟
- 地形高度场采样成功后同时写入两处本地存储：浏览器 `localStorage`（键
  `tellux-water-domain-v1`，97² × Float32 约 50 KB）与服务器 `.cache/tiles/domain/domain.json`；
  再次进入水体编辑 / 刷新页面时直接恢复（优先浏览器缓存，其次服务器缓存），
  不再等待 6–7 s 的相机飞行与地形采样；「重建模拟域」会重新采样并覆盖两处存储
- 模拟域边界以浅青色贴地线框显示，仅水体编辑模式可见；边界是**开放的**：
  水流出域外会被自动吸收，不会在边缘积成一圈水墙

### 放置与拖动水源

1. 点「＋ 水源」进入放置模式：画布变为十字准星，按钮变为「取消放置」，顶部「水体」胶囊显示「放置中」
2. 在地形上**单击**放置水源（左键拖动仍是相机手势，不会误放），可连续放置，最多 8 个
3. `Esc`、再点一次「取消放置」可退出放置模式
4. 水源在场景里显示为**青色小球 + 贴地半径圆环 + 名称标签**；小球在屏幕上保持恒定大小
5. 按住小球可水平拖动（拖动期间相机让位，松开后提交），单击小球或左侧列表选中水源；
   选中后小球变白、圆环变黄，右侧「选中水源」分组随之出现
6. 水源标记只在水体编辑模式显示；`Esc` 在未放置时取消选择

### 模拟参数

| 参数 | 范围 / 默认 | 说明 |
| --- | --- | --- |
| 模拟速度 | 0.1–64×（1.0×） | 1× = 实时；每个子步 1/30 s，单次 update 最多推进 64 子步（64× 在 60 fps 下约 32 子步/帧） |
| 每次注水量 | 1–300 m（15 m） | 每个水源每次注水的目标水深，单个水源可覆盖 |
| 注水间隔 | 1–8（2） | 以 1/60 s 为单位（面板显示秒）；越小注水越频繁 |
| 模拟精度 | 192² / 256² / 384²（256²） | 模拟网格边长；切换会重建模拟缓冲并重置水位 |
| 最大流速 | 5–60 m/s（30） | 单格流速上限，越高水扩散越快，过高会放大数值振荡 |
| 流动阻尼 | 0.90–1.00（0.995） | 通量阻尼，越低静水收敛越快、流动更“黏” |
| 暂停 / 继续 | — | 暂停时不再推进模拟，但水面保持显示 |
| 重置模拟 | — | 水深与流速全部清零，地形与水源配置保留 |

### 选中水源

| 参数 | 范围 / 默认 | 说明 |
| --- | --- | --- |
| 名称 | 默认「水源 N」 | 同时显示在场景标签与列表中 |
| 地面高程 | 只读 | 按水源位置采样；新水源目标水位默认 = 地面 + 10 m |
| 水源半径 | 20–2000 m（150 m） | 注水范围，场景圆环按此半径贴地绘制；导入 JSON 时归一化接受 20–3000 |
| 目标水面高程 | 米；留空 = 不限制 | 注到该绝对椭球高程就停止注水 |
| 启用 | 默认开 | 停用的水源不注水，也不参与全局水位上限 |
| 删除该水源 | — | 已流进模拟里的水会保留 |

**全局水位上限**：取所有启用且设置了目标水位的水源中的最高值；只要有任一启用水源
「不限制」，就没有全局上限。超过上限的水会被排掉（相当于溢洪道），避免多水源把整张地图无限灌高。
「不限制」的水源仍以「水源处地面高程 + 每次注水量」作为本地压力水头：注满即停、水被排走后再补充，
因此不会无限抬升（也不会在几秒内把相机淹进水里）。

### 外观

右栏「光照」与「波纹与泡沫」两组控件均可实时调节，改动自动保存到工程；
「恢复默认外观」一键回到下列默认值。

| 参数 | 范围 / 默认 | 说明 |
| --- | --- | --- |
| 太阳高光 | 0–3（1.0） | 太阳镜面与掠射波光强度，太阳方向跟随场景时钟 |
| 高光锐度 | 0.3–2.5（1.0） | 太阳反射的集中程度：越大越锐利、越小越柔和 |
| 天空反射 | 0–1.5（1.0） | Schlick 菲涅尔天空反射的混合强度 |
| 水体清澈度 | 0–1（0.62） | 0 浑浊、1 通透；控制深度吸收与不透明度 |
| 水面不透明度 | 0–1（0） | 0 按清澈度与水深深浅透出水下地形；向 1 过渡时深水逐渐变为完全不透明，浅水与域边界始终淡出 |
| 波纹强度 | 0–2（1.0） | 程序化法线波纹的扰动强度 |
| 波纹尺度 | 0.4–2.5（1.0） | 波纹纹理频率：越大波纹越细、越小越宽缓 |
| 波纹流速 | 0–2（1.0） | 法线纹理沿净流速平流的快慢 |
| 泡沫强度 | 0–2（1.0） | 岸线泡沫与急流白浪的整体强度 |

### 浅水模拟

- 每个子步 2 个全屏 GPU pass：**通量 pass** 用虚拟管道模型计算四邻域出流并按 CFL
  缩放保证水深非负；**深度/速度 pass** 用水量散度更新水深、由净通量换算流速。
  通量上限（最大流速）与阻尼、注水间隔都可在「模拟参数」里调
- **子步时间为 1/30 s**：1× 下每秒 30 个子步，和旧版 1/60 s 子步相比，同样的观感
  只需一半 pass；保持旧版每帧开销时最多可推进两倍模拟时间，速度上限因此提高到 64×。
  注水节奏与阻尼都按模拟时间做了换算，避免改 dt 后水注入速率或衰减速度发生变化
- 状态纹理为 RGBA32F（不支持浮点颜色缓冲时自动退半浮点）：R=水深、G=东向速度、
  B=北向速度、A=相对基准的地形高程；状态在两张纹理间 ping-pong，水面直接采样当前
  纹理，不再每帧额外做一次全分辨率拷贝 pass
- 模拟域边界为**开放吸收边界**：域外按「同地形、水深 0」的虚拟格处理，水流到边界
  就向域外排出并被吸收，不会像墙一样在边缘堆积、反射；边界处的浅水由水面着色器淡出
- 水源注入按模拟时间触发（「注水间隔」以 1/60 s 为单位），圆形范围内平滑衰减；
  有目标水位时只注到目标水位
- 每帧统计通过节流读回得到：步数、湿格数与最大水深显示在右面板状态行，读回间隔
  700 ms 与面板刷新对齐，减少 GPU 同步等待；
  顶部「水体」状态胶囊显示运行 / 暂停 / 构建中 / 已关闭与水源数
- 水面渲染：覆盖全域的网格在顶点着色器里按模拟水位位移；片元里做程序化波纹法线
  （沿净流速平流）、Schlick 菲涅尔、太阳高光、Beer-Lambert 深度吸收与岸线/急流泡沫，
  并在域边界与浅水处平滑淡出；「水面不透明度」在透明与不透明之间连续过渡

### 持久化

- 任何编辑 500 ms 后自动写入 `localStorage`（键 `tellux-water-editor-v1`），
  同时记住上次模式（键 `tellux-water-editor-mode-v1`）
- 刷新时：上次停在水体编辑模式会自动回到水体编辑并恢复模拟域、按保存的水源与参数
  从干地重新开始模拟；上次停在浏览模式则先不建域，切到「水体编辑」时按保存的域重建
- 模拟域地形高度场不属于工程 JSON，单独存于浏览器 `localStorage`（键
  `tellux-water-domain-v1`）与服务器 `.cache/tiles/domain/domain.json`：首次采样后
  刷新/重新进入直接恢复（浏览器缓存优先、服务器缓存兜底，换浏览器也能秒开），
  省去 6–7 s 的相机飞行与 97² 地形采样；「重建模拟域」重新采样并覆盖；
  清除浏览器站点数据 + 删除服务器 domain 缓存后会退回首次采样
- 面板「保存」立即落盘；「导出 JSON / 导入 JSON」读写水体工程
- 工程只保存水源、模拟/外观参数与模拟域，**不保存当前水位/流量**：恢复后从干地重新注水

工程 JSON 结构：

```json
{
  "version": 1,
  "enabled": true,
  "domain": { "longitude": 116.77, "latitude": 36.02, "sizeMeters": 8000 },
  "sim": {
    "speed": 1,
    "waterAmount": 15,
    "injectInterval": 2,
    "resolution": 256,
    "maxFlowSpeed": 30,
    "damping": 0.995,
    "paused": false
  },
  "visual": {
    "shimmer": 1,
    "glint": 1,
    "reflection": 1,
    "ripple": 1,
    "rippleScale": 1,
    "flowSpeed": 1,
    "foam": 1,
    "clarity": 0.62,
    "opacity": 0
  },
  "sources": [
    {
      "id": "wsrc_…",
      "name": "水源 1",
      "longitude": 116.77,
      "latitude": 36.015,
      "radius": 150,
      "targetLevel": 95,
      "amount": null,
      "enabled": true,
      "groundLevel": 85
    }
  ]
}
```

导入时会做归一化：缺失字段补默认、非法坐标的水源丢弃、数值夹到合法范围，
非 192/256/384 的模拟精度归到最近档位。

## 代码结构与约定

```text
src/
├── main.ts               # 启动：Viewer、相机读数、UI 装配
├── style.css             # 全部样式与设计令牌
├── ui/
│   ├── shell.ts          # 布局测量、模式滑块、面板折叠、水源抽屉
│   ├── cloudControls.ts  # 场景控制台：体积云 / 大气 / 时间
│   ├── cloudTuning.ts    # 云步进 / 散射 / 湍流等底层数值
│   ├── dom.ts            # 必选 / 可选 DOM 查询、滑杆轨道填充
│   ├── assets.ts         # 基础路径与静态托管标记（GitHub Pages）
│   └── format.ts         # HUD 文案（时间、坐标、高度）
└── water/
    ├── types.ts          # 状态模型与三层共享契约（含 clamp / 数值校验）
    ├── async.ts          # nextFrame / delay
    ├── persistence.ts    # localStorage 与 JSON 导入导出
    ├── domainCache.ts    # 模拟域地形高度场：浏览器 + 服务器缓存
    ├── terrainField.ts   # 切平面投影、地形采样、重采样、双线性取值
    ├── shallowWater.ts   # GPU 浅水模拟（通量 / 水深两步）
    ├── simShaders.ts     # 模拟用 GLSL
    ├── waterSurface.ts   # 水面网格与材质
    ├── waterShaders.ts   # 水面 GLSL
    ├── waterTextures.ts  # 程序化法线与泡沫纹理
    ├── sun.ts            # 太阳位置与水面配色
    ├── markers.ts        # 水源标记与模拟域边界
    └── waterEditor.ts    # 编辑器总控：模式、建域、交互、面板
```

约定：

- **单一数据源**：`WaterState` 只在 `types.ts` 定义，UI / 模拟 / 渲染都从它派生；
  外部输入（localStorage、导入 JSON、调试 API）一律经 `normalizeWaterState` 归一化。
- **坐标契约**：切平面原点、网格索引、纹理 uv 与高度基准写在 `types.ts` 头部注释，
  四层实现不得各自发明。
- **注释写「为什么」**：不重复代码字面含义，只解释约束、数值来源与踩坑原因；
  面向使用者的说明留在 README，界面里只保留状态与操作反馈。
- **小工具集中**：`clamp` / `toFiniteNumber`（`types.ts`）、`nextFrame` / `delay`
  （`async.ts`）、DOM 查询（`ui/dom.ts`）不各自复制。
- **可读性优先**：事件处理器按「模式 / 模拟 / 水源 / 外观 / 工程」拆分，一个方法只做一件事。

## 脚本

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（`127.0.0.1:5173`，带本地瓦片缓存中间件） |
| `npm run build` | 生产构建到 `dist/` |
| `npm run build:pages` | 静态托管构建：`vite build` + 把 `.cache/tiles` 导出为 `dist/terrain-cache`、`dist/imagery-cache` |
| `npm start` | 运行 `server.mjs`，托管 `dist/` 并提供本地瓦片缓存 |
| `npm run cache:prefetch` | 预热 116.77,36.02 附近 50×50 km 的地形与影像瓦片（支持参数，见上节） |
| `npm run type-check` | TypeScript 类型检查（`strict` + 未使用变量检查） |
| `npm run check` | 类型检查 + 单元测试，提交前跑一遍 |
| `npm test` | 水体工程 JSON 归一化与状态模型单元测试 |
| `npm run verify` | 浏览器端端到端验证（模拟域 / 放置拖动 / 浅水模拟 / 暂停重置 / 持久化 / 模式切换 / 云与水面参数），截图输出到 `tests/out/` |

`npm run verify` 会自动在 5199 端口启动 Vite（同样挂载本地缓存）、用本机 Chrome / Edge
**有头模式**跑一遍完整流程；地形与影像走本地缓存，缺少的瓦片会自动回源（需要 `.env` 中的
`CESIUM_ION_TOKEN` 且能访问 Cesium Ion / ArcGIS）。

## GitHub Pages 部署

仓库自带 [`.github/workflows/deploy-pages.yml`](<.github/workflows/deploy-pages.yml>)：
推送到 `master` / `main` 或手动触发时，自动预热瓦片、按 Pages 子路径构建并发布。

### 首次配置

1. 仓库 **Settings → Pages → Build and deployment → Source** 设为 **GitHub Actions**。
2. Token：工作流里已内置一个 Cesium Ion token，CI 会用它联网预热地形/影像；也可以添加
   repository secret `CESIUM_ION_TOKEN` 覆盖内置值。
   - ⚠️ 仓库是公开的，内置 token 会随工作流文件一起公开，请只使用可随时轮换的 token；
     更安全的做法是删除工作流里的内置值，只在 **Settings → Secrets and variables → Actions**
     配置 `CESIUM_ION_TOKEN`。
3. 推送到默认分支，等待 Actions 里的 *Deploy to GitHub Pages* 完成。

默认地址为 `https://<用户名>.github.io/Reservoir_matrix_management_system/`。工作流会根据
仓库名自动计算 `BASE_PATH`；用户/组织站点（`<用户名>.github.io`）会自动使用 `/`。

### 可选仓库 Variables

| Variable | 默认 | 说明 |
| --- | --- | --- |
| `PAGES_BASE_PATH` | 自动 | 自定义域名或特殊子路径时覆盖，例如 `/` |
| `PREFETCH_SIZE` | `50000` | 预热区域边长（米），默认与本地缓存一致，覆盖初始视角与 8 km 模拟域 |
| `PREFETCH_TERRAIN_LEVELS` | `0-14` | 地形层级 |
| `PREFETCH_IMAGERY_LEVELS` | `8-15` | 影像层级 |
| `PREFETCH_CONCURRENCY` | `8` | 瓦片并发下载数 |

### 工作流做了什么

1. `npm ci` + `npm run check`；
2. 从 Actions Cache 恢复 `.cache/tiles`，用内置 token（或 `CESIUM_ION_TOKEN` secret）执行
   `cache:prefetch` 联网补齐瓦片（已有文件会跳过）；
3. `BASE_PATH=/<仓库名>/ VITE_STATIC_HOST=1 npm run build:pages`；
4. 构建后由 `scripts/export-static-cache.mjs` 把瓦片复制成
   `dist/terrain-cache`、`dist/imagery-cache`，并写入 `.nojekyll`；
5. 上传 `dist/` 为 Pages artifact 并部署。

瓦片数据**不进入 git 仓库**：`.cache/tiles/` 与 `dist/` 都在 `.gitignore` 中，只在 Actions
运行时联网下载并以 Actions Cache 复用；Pages artifact 是部署产物，不是仓库内容。

### 静态托管的差异

- 没有 `/terrain-cache`、`/imagery-cache`、`/domain-cache` 等服务端中间件：地形/影像直接从
  `dist/` 里的静态瓦片读取；`/domain-cache` 在静态构建下自动关闭（浏览器 localStorage
  自动保存仍然有效，服务器端共享缓存不可用）。
- 站点只包含预热范围内的瓦片与层级；平移到范围外或放大超过预热层级时，缺失瓦片会 404，
  可通过上面的 Variables 扩大预热范围/层级。
- Cesium Ion token 只在 CI 预热时使用，不会出现在前端产物中。
- 本地预览静态产物：

  ```bash
  BASE_PATH=/Reservoir_matrix_management_system/ VITE_STATIC_HOST=1 npm run build:pages
  npm run preview   # http://127.0.0.1:4173/Reservoir_matrix_management_system/
  ```

  Windows PowerShell 可用 `$env:BASE_PATH='/...'; $env:VITE_STATIC_HOST='1'; npm run build:pages`。

## 已知限制

- 模拟域固定为 116.77, 36.02 附近的 8 km × 8 km 切平面，不是全球水体模型；域外不参与模拟，
  边界为开放吸收边界（水流出域外即被吸收，不会回流）
- 地形高度在建立/重建模拟域时采样，精度约等于当前视角的地形 LOD；拉远视角后请「重建模拟域」
- 本地模拟域地形是最近一次采样的快照；地形数据源或采样精度变化后，点「重建模拟域」刷新并覆盖浏览器与服务器本地存储
- 浅水模型为可视化级实时模拟（虚拟管道方案），不用于真实洪水演进或工程计算
- 模拟需要 WebGL2 + 浮点颜色缓冲；没有 `EXT_color_buffer_float` 时降级为半浮点，精度略低
- 默认只预热 50×50 km 区域；区域外或更高层级首次浏览仍需联网回源一次，之后走本地缓存
- 缓存只存地形 / 影像瓦片与模拟域地形，不含 Cesium token；删除 `.cache/tiles` 后需重新预热或按需回源
