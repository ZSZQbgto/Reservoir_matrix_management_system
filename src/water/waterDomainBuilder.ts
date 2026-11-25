/**
 * 模拟域构建：把「缓存恢复 / 现场采样」两套流程从编辑器里剥离。
 *
 * 只依赖 `viewer`、地形采样工具与缓存模块，不碰 DOM、不碰编辑器状态：
 * 进度与提示通过 hooks 回调，调用方决定怎么显示。
 */
import type { Viewer } from 'tellux'
import { delay, nextFrame } from './async'
import {
  fetchServerDomainField,
  loadCachedDomainField,
  saveCachedDomainField,
  saveDomainFieldToServer
} from './domainCache'
import { createLocalProjection, sampleTerrainField, type LocalProjection } from './terrainField'
import {
  flyOverDomain,
  sampleGroundHeight,
  waitForTerrainAvailable,
  waitForTerrainStable
} from './terrainSampling'
import { TERRAIN_GRID_SIZE, WATER_DOMAIN, type TerrainField } from './types'

/** 地形高度场的来源，调用方据此生成提示文案。 */
export type DomainFieldOrigin = 'browser-cache' | 'server-cache' | 'sampled'

export interface DomainBuildResult {
  field: TerrainField
  origin: DomainFieldOrigin
  /** 与 field 同一中心 / 边长的切平面投影，编辑器直接复用，避免重复创建。 */
  projection: LocalProjection
}

export interface DomainBuildHooks {
  /** 进度 0–100 与阶段文案。 */
  onProgress(percent: number, label: string): void
  onToast(message: string, duration?: number): void
}

/** 采样期间地形可能继续细化：重试次数、漂移阈值与等待时长。 */
const SAMPLE_ATTEMPTS = 3
const DRIFT_TOLERANCE_METERS = 0.6
const DRIFT_SETTLE_MS = 900

export class WaterDomainBuilder {
  constructor(
    private readonly viewer: Viewer,
    private readonly hooks: DomainBuildHooks
  ) {}

  /** 浏览器缓存 → 服务器缓存（.cache/tiles/domain）。都取不到返回 null。 */
  async loadCached(): Promise<DomainBuildResult | null> {
    const center = { longitude: WATER_DOMAIN.longitude, latitude: WATER_DOMAIN.latitude }
    const projection = createLocalProjection(center, WATER_DOMAIN.sizeMeters)

    const cached = loadCachedDomainField()
    if (cached) return { field: cached, origin: 'browser-cache', projection }

    const serverField = await fetchServerDomainField()
    if (!serverField) return null
    saveCachedDomainField(serverField)
    return { field: serverField, origin: 'server-cache', projection }
  }

  /**
   * 现场采样：飞到域上方 → 等地形可用 → 等瓦片细化稳定 → 逐格采样 → 写缓存。
   *
   * `isStale` 为 true 时立即放弃（已被新的构建取代），返回 null。
   */
  async sample(
    center: { longitude: number; latitude: number },
    sizeMeters: number,
    control: { isStale(): boolean; cancel: { cancelled: boolean } }
  ): Promise<DomainBuildResult | null> {
    const { isStale } = control
    this.hooks.onProgress(4, '正在定位模拟域…')
    await flyOverDomain(this.viewer, center, sizeMeters)
    if (isStale()) return null

    this.hooks.onProgress(8, '正在等待地形加载…')
    const terrainAvailable = await waitForTerrainAvailable(this.viewer, center, 20000)
    if (isStale()) return null
    if (!terrainAvailable) {
      this.hooks.onToast('地形尚未加载完成，无法采样模拟域，请稍后重试', 4200)
      return null
    }

    this.hooks.onProgress(10, '正在等待地形细化…')
    await waitForTerrainStable(this.viewer, center)
    if (isStale()) return null

    const projection = createLocalProjection(center, sizeMeters)
    const field = await this.sampleWithRetry(center, projection, control)
    if (!field || isStale()) return null

    const savedToBrowser = saveCachedDomainField(field)
    const savedToServer = await saveDomainFieldToServer(field)
    if (isStale()) return null
    if (!savedToBrowser && !savedToServer) {
      this.hooks.onToast('模拟域已就绪，但本地缓存写入失败', 3000)
    }

    this.hooks.onProgress(100, '模拟域已就绪')
    await nextFrame()
    return { field, origin: 'sampled', projection }
  }

  /** 逐格采样；瓦片继续细化导致中心高程漂移时重采，最多 3 次。 */
  private async sampleWithRetry(
    center: { longitude: number; latitude: number },
    projection: LocalProjection,
    control: { isStale(): boolean; cancel: { cancelled: boolean } }
  ): Promise<TerrainField | null> {
    const { isStale, cancel } = control
    this.hooks.onProgress(10, '正在采样地形高度…')

    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS; attempt += 1) {
      const field = await sampleTerrainField({
        projection,
        sampleHeight: (points) => this.viewer.sampleHeight(points),
        gridSize: TERRAIN_GRID_SIZE,
        chunkRows: 4,
        cancel,
        onProgress: (completed, total) => {
          if (isStale()) return
          this.hooks.onProgress(
            10 + (completed / total) * 80,
            `正在采样地形高度… ${Math.round((completed / total) * 100)}%`
          )
        }
      })
      if (isStale()) return null
      if (!field) return null

      // 采样期间地形可能继续细化：等一拍再比对域中心高程，漂移明显就重采。
      await delay(DRIFT_SETTLE_MS)
      if (isStale()) return null
      const freshCenter = sampleGroundHeight(this.viewer, center.longitude, center.latitude)
      if (typeof freshCenter !== 'number') return field
      if (Math.abs(freshCenter - field.baseElevation) <= DRIFT_TOLERANCE_METERS) return field
      this.hooks.onProgress(10, '地形仍在细化，重新采样…')
    }
    return null
  }
}
