# Tellux Earth · Cesium 图源

基于 [Tellux 0.3](https://github.com/cyanfish-x/tellux) 的三维地球站点。已移除本地 8 km 地形、天地图图源和临时校准工具，改为 Cesium 图源。

## 当前数据源

- **影像**：Cesium / ArcGIS World Imagery（默认，加载快）
- **地形**：默认不加载。当前网络访问 Cesium Ion API 超时，`?ion=1` 可尝试 Cesium World Terrain；`?terrain=maptiler` 可尝试本地代理的 MapTiler quantized-mesh 地形（LOD 可能停在低级别）
- **大气/云**：Takram 大气散射、星空、体积云；体积云默认关闭

## 快速开始

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:8090>。

## 启用 Cesium World Terrain

Cesium Ion token 已写入 `.env`，但当前网络到 `api.cesium.com` 超时，所以页面默认只用 ArcGIS 影像，避免一直等地形。

需要试 Cesium Ion 时：

```text
http://127.0.0.1:8090/?ion=1
```

需要试本地代理的 Cesium quantized-mesh 地形时：

```text
http://127.0.0.1:8090/?terrain=maptiler
```

## 其他命令

```bash
npm run dev        # Vite 开发服务器
npm run type-check # tsc --noEmit
npm run verify     # Playwright 截图验收（需要时可重新启用）
```

## 说明

- 本地 8 km DEM、天地图 `swdx`、本地 z16 图集、地形校准工具均已从代码和 `public/` 中删除。
- 默认只请求 ArcGIS World Imagery，避开 Cesium Ion 超时和地形 LOD 卡住的问题。
- `server.mjs` 中保留的天地图/MapTiler 代理仅作为历史兼容，当前默认页面不使用。
