/**
 * 水面程序化纹理：可平铺的法线贴图与泡沫噪声。
 *
 * 全部在 CPU 一次性生成 256² 的 RGBA8 `DataTexture`，不依赖任何图片资源。
 * 值噪声的格点按整数周期回卷，因此每个八度都可无缝平铺；法线由高度场
 * 中心差分得到，编码为标准 tangent-space 法线（R=x, G=y, B=z, A=255）。
 *
 * 采样约定：u 沿东、v 沿北（与模拟纹理 uv 一致），因此贴图在着色器里
 * 直接按「纹理 u/v 轴 = 局部东/北方向」使用即可。
 */

import * as THREE from 'three'

/** 值噪声格点哈希，返回 [0, 1)。 */
function latticeHash(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1013904223)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

function smoothCurve(t: number): number {
  return t * t * (3 - 2 * t)
}

/**
 * 可平铺值噪声。
 *
 * `x`/`y` 以格点为单位，`period` 为整数格点周期（格点索引对 period 回卷）。
 */
function tileableValueNoise(x: number, y: number, period: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = smoothCurve(x - x0)
  const fy = smoothCurve(y - y0)
  const wrap = (value: number): number => ((value % period) + period) % period
  const xa = wrap(x0)
  const xb = wrap(x0 + 1)
  const ya = wrap(y0)
  const yb = wrap(y0 + 1)
  const v00 = latticeHash(xa, ya, seed)
  const v10 = latticeHash(xb, ya, seed)
  const v01 = latticeHash(xa, yb, seed)
  const v11 = latticeHash(xb, yb, seed)
  const bottom = v00 + (v10 - v00) * fx
  const top = v01 + (v11 - v01) * fx
  return bottom + (top - bottom) * fy
}

/**
 * 可平铺的 fbm（分形值噪声）。
 *
 * `u`/`v` 为 [0, 1) 域内坐标；`baseFrequency` 为整数格点数，逐八度翻倍以保持平铺。
 */
function tileableFbm(
  u: number,
  v: number,
  baseFrequency: number,
  octaves: number,
  seed: number,
  gain = 0.5
): number {
  let sum = 0
  let normalization = 0
  let amplitude = 1
  let frequency = baseFrequency
  let octaveSeed = seed
  for (let octave = 0; octave < octaves; octave += 1) {
    sum +=
      amplitude *
      tileableValueNoise(u * frequency, v * frequency, frequency, octaveSeed)
    normalization += amplitude
    amplitude *= gain
    frequency *= 2
    octaveSeed = (Math.imul(octaveSeed, 1664525) + 1013904223) >>> 0
  }
  return normalization > 0 ? sum / normalization : 0
}

function createRepeatingTexture(
  data: Uint8Array,
  size: number,
  name: string
): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
  texture.name = name
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 8
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

export interface WaterNormalTextureOptions {
  /** 纹理边长，默认 256。 */
  size?: number
  /** 基础值噪声格点数（整数），越大细节越密。 */
  frequency?: number
  /** fbm 八度数。 */
  octaves?: number
  /** 噪声随机种子。 */
  seed?: number
  /** 法线强度（高度场差分放大系数）。 */
  strength?: number
}

/**
 * 生成一张可平铺的波纹法线贴图。
 *
 * 高度场由多八度值噪声叠加，法线取中心差分；纹理可 RepeatWrapping + mipmap，
 * anisotropy 会在上传时被渲染器裁剪到硬件上限。
 */
export function createWaterNormalTexture(
  options: WaterNormalTextureOptions = {}
): THREE.DataTexture {
  const size = Math.max(64, Math.floor(options.size ?? 256))
  const frequency = Math.max(2, Math.floor(options.frequency ?? 8))
  const octaves = Math.max(1, Math.floor(options.octaves ?? 4))
  const seed = Math.floor(options.seed ?? 1)
  const strength = options.strength ?? 4

  const heights = new Float32Array(size * size)
  for (let y = 0; y < size; y += 1) {
    const v = y / size
    for (let x = 0; x < size; x += 1) {
      const u = x / size
      // 轻微提升高频权重，让波纹有细碎的尖峰而不是整片圆丘。
      const base = tileableFbm(u, v, frequency, octaves, seed)
      const crisp = tileableFbm(u, v, frequency * 2, Math.max(1, octaves - 1), seed ^ 0x9e3779b9)
      heights[y * size + x] = base * 0.72 + crisp * 0.28
    }
  }

  const data = new Uint8Array(size * size * 4)
  const wrap = (value: number): number => ((value % size) + size) % size
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const left = heights[y * size + wrap(x - 1)]
      const right = heights[y * size + wrap(x + 1)]
      const south = heights[wrap(y - 1) * size + x]
      const north = heights[wrap(y + 1) * size + x]
      // 法线 = normalize(-dh/du, -dh/dv, 1)；u 沿东、v 沿北。
      let nx = -(right - left) * strength
      let ny = -(north - south) * strength
      let nz = 1
      const length = Math.hypot(nx, ny, nz) || 1
      nx /= length
      ny /= length
      nz /= length
      const offset = (y * size + x) * 4
      data[offset] = Math.round((nx * 0.5 + 0.5) * 255)
      data[offset + 1] = Math.round((ny * 0.5 + 0.5) * 255)
      data[offset + 2] = Math.round((nz * 0.5 + 0.5) * 255)
      data[offset + 3] = 255
    }
  }

  return createRepeatingTexture(data, size, 'TelluxWaterNormal')
}

/**
 * 生成可平铺的泡沫/白浪噪声贴图。
 *
 * R：低频团块（岸线泡沫），G：中频碎裂（急流白浪），B：高频细节。
 */
export function createWaterFoamTexture(size = 256): THREE.DataTexture {
  const resolution = Math.max(64, Math.floor(size))
  const data = new Uint8Array(resolution * resolution * 4)
  for (let y = 0; y < resolution; y += 1) {
    const v = y / resolution
    for (let x = 0; x < resolution; x += 1) {
      const u = x / resolution
      const broad = tileableFbm(u, v, 6, 4, 17)
      const breakUp = tileableFbm(u, v, 16, 3, 43)
      const detail = tileableFbm(u, v, 40, 2, 71)
      const offset = (y * resolution + x) * 4
      data[offset] = Math.round(broad * 255)
      data[offset + 1] = Math.round(breakUp * 255)
      data[offset + 2] = Math.round(detail * 255)
      data[offset + 3] = 255
    }
  }
  return createRepeatingTexture(data, resolution, 'TelluxWaterFoam')
}

export interface WaterDetailTextures {
  /** 大尺度波浪法线（低频、缓）。 */
  normalBroad: THREE.DataTexture
  /** 细碎波纹法线（高频、锐）。 */
  normalFine: THREE.DataTexture
  /** 泡沫/白浪噪声。 */
  foam: THREE.DataTexture
}

/** 一次性生成渲染层需要的全部程序化纹理。 */
export function createWaterDetailTextures(): WaterDetailTextures {
  return {
    normalBroad: createWaterNormalTexture({ frequency: 7, octaves: 4, seed: 11, strength: 3.2 }),
    normalFine: createWaterNormalTexture({ frequency: 24, octaves: 4, seed: 29, strength: 4.2 }),
    foam: createWaterFoamTexture(256)
  }
}

/** 释放程序化纹理（可重复调用）。 */
export function disposeWaterDetailTextures(textures: WaterDetailTextures): void {
  textures.normalBroad.dispose()
  textures.normalFine.dispose()
  textures.foam.dispose()
}
