import assert from 'node:assert/strict'
import {
  MAX_WATER_SOURCES,
  SIM_RESOLUTION_OPTIONS,
  WATER_DOMAIN,
  WATER_STATE_VERSION,
  cloneState,
  createDefaultState,
  createSourceId,
  normalizeWaterState,
  nearestOption
} from '../src/water/types.ts'

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

console.log('water-state')

test('默认状态合法', () => {
  const state = createDefaultState()
  assert.equal(state.version, WATER_STATE_VERSION)
  assert.equal(state.enabled, true)
  assert.equal(state.domain, null)
  assert.equal(state.sources.length, 0)
  assert.equal(state.sim.speed, 1)
  assert.equal(state.sim.waterAmount, 15)
  assert.equal(state.sim.resolution, 256)
  assert.equal(state.sim.paused, false)
  assert.equal(state.visual.shimmer, 1)
  assert.equal(state.visual.glint, 1)
  assert.equal(state.visual.reflection, 1)
  assert.equal(state.visual.ripple, 1)
  assert.equal(state.visual.rippleScale, 1)
  assert.equal(state.visual.flowSpeed, 1)
  assert.equal(state.visual.foam, 1)
  assert.equal(state.visual.clarity, 0.62)
})

test('非法输入回落到默认值', () => {
  for (const raw of [null, undefined, 42, 'nope', [], { sources: 'x' }]) {
    const state = normalizeWaterState(raw)
    assert.equal(state.version, WATER_STATE_VERSION)
    assert.equal(state.enabled, true)
    assert.equal(state.sources.length, 0)
  }
})

test('数值字段夹到合法范围', () => {
  const state = normalizeWaterState({
    sim: { speed: 99, waterAmount: -5, resolution: 300, paused: true },
    visual: {
      shimmer: 9,
      glint: 99,
      reflection: 9,
      ripple: -1,
      rippleScale: 0.1,
      flowSpeed: 9,
      foam: -1,
      clarity: 3
    }
  })
  assert.equal(state.sim.speed, 32)
  assert.equal(state.sim.waterAmount, 1)
  assert.equal(state.sim.paused, true)
  // 300 最接近 256 档
  assert.equal(state.sim.resolution, 256)
  assert.equal(state.visual.shimmer, 3)
  assert.equal(state.visual.glint, 2.5)
  assert.equal(state.visual.reflection, 1.5)
  assert.equal(state.visual.ripple, 0)
  assert.equal(state.visual.rippleScale, 0.4)
  assert.equal(state.visual.flowSpeed, 2)
  assert.equal(state.visual.foam, 0)
  assert.equal(state.visual.clarity, 1)
})

test('旧工程缺失的外观字段补默认值', () => {
  const state = normalizeWaterState({
    visual: { shimmer: 0.5, ripple: 1.5, clarity: 0.3 }
  })
  assert.equal(state.visual.shimmer, 0.5)
  assert.equal(state.visual.ripple, 1.5)
  assert.equal(state.visual.clarity, 0.3)
  assert.equal(state.visual.glint, 1)
  assert.equal(state.visual.reflection, 1)
  assert.equal(state.visual.rippleScale, 1)
  assert.equal(state.visual.flowSpeed, 1)
  assert.equal(state.visual.foam, 1)
})

test('无效坐标的水源被丢弃', () => {
  const state = normalizeWaterState({
    sources: [
      { longitude: 116.77, latitude: 36.01 },
      { longitude: '116.7', latitude: 36.01 },
      { longitude: 200, latitude: 36.01 },
      { latitude: 36.01 }
    ]
  })
  assert.equal(state.sources.length, 1)
  assert.equal(state.sources[0].longitude, 116.77)
})

test('水源字段归一化与数量上限', () => {
  const raw = { sources: [] }
  for (let i = 0; i < MAX_WATER_SOURCES + 4; i++) {
    raw.sources.push({
      name: i === 0 ? '  河道入口  ' : `水源 ${i + 1}`,
      longitude: 116.7 + i * 0.001,
      latitude: 36.0,
      radius: i === 0 ? 5 : 4000,
      targetLevel: i === 1 ? Number.NaN : 120,
      amount: i === 2 ? 500 : null,
      enabled: i !== 3
    })
  }
  const state = normalizeWaterState(raw)
  assert.equal(state.sources.length, MAX_WATER_SOURCES)
  const first = state.sources[0]
  assert.equal(first.name, '河道入口')
  assert.equal(first.radius, 20)
  assert.equal(first.id.startsWith('wsrc_'), true)
  assert.equal(first.amount, null)
  assert.equal(state.sources[1].targetLevel, null)
  assert.equal(state.sources[2].amount, null)
  assert.equal(state.sources[3].enabled, false)
  assert.equal(state.sources[4].radius, 3000)
})

test('模拟域固定为 116.77, 36.02 的 8 km × 8 km', () => {
  const migrated = normalizeWaterState({
    domain: { longitude: 10, latitude: 10, sizeMeters: 1234 }
  })
  assert.deepEqual(migrated.domain, { ...WATER_DOMAIN })
  const imported = normalizeWaterState({
    domain: { longitude: 116.9, latitude: 36.1, sizeMeters: 4000 }
  })
  assert.deepEqual(imported.domain, { ...WATER_DOMAIN })
  assert.equal(normalizeWaterState({ domain: null }).domain, null)
  assert.equal(createDefaultState().domain, null)
  assert.equal(WATER_DOMAIN.sizeMeters, 8000)
})

test('模拟速度上限为 32×', () => {
  assert.equal(normalizeWaterState({ sim: { speed: 99 } }).sim.speed, 32)
  assert.equal(normalizeWaterState({ sim: { speed: 24.5 } }).sim.speed, 24.5)
  assert.equal(normalizeWaterState({ sim: { speed: 0.01 } }).sim.speed, 0.1)
  assert.equal(normalizeWaterState({ sim: { speed: 4 } }).sim.speed, 4)
})

test('分辨率档位归一', () => {
  assert.equal(nearestOption(SIM_RESOLUTION_OPTIONS, 390, 256), 384)
  assert.equal(nearestOption(SIM_RESOLUTION_OPTIONS, 250, 256), 256)
})

test('cloneState 深拷贝', () => {
  const state = createDefaultState()
  state.sources.push({
    id: createSourceId(),
    name: '水源 1',
    longitude: 116.77,
    latitude: 36.01,
    radius: 150,
    targetLevel: 100,
    amount: null,
    enabled: true,
    groundLevel: 90
  })
  const copy = cloneState(state)
  copy.sources[0].name = '改过'
  copy.sim.speed = 3
  assert.equal(state.sources[0].name, '水源 1')
  assert.equal(state.sim.speed, 1)
})

console.log(`\n${passed} 项全部通过`)
