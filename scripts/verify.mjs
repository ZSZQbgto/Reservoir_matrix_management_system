#!/usr/bin/env node
/**
 * 端到端验证：启动 Vite 开发服务器 + 有头 Chrome，验证水体编辑器的
 * 模式切换、模拟域构建、水源放置/拖动、浅水模拟推进、参数面板、持久化恢复与场景模式。
 *
 * 为什么必须有头：本机 headless Chrome 的 WebGL2 上下文无法加载 Cesium 地形。
 *
 * 用法：
 *   npm run verify
 *   VERIFY_PORT=5299 CHROME_PATH="C:\\...\\chrome.exe" npm run verify
 *
 * 需要 .env 中的 CESIUM_ION_TOKEN；没有 token 时只跑不依赖地形的 UI 检查并打印 SKIP。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests', 'out')
mkdirSync(outDir, { recursive: true })

const port = Number(process.env.VERIFY_PORT || 5199)
const baseUrl = `http://127.0.0.1:${port}`

function readEnvValue(key) {
  if (process.env[key]) return process.env[key]
  const envPath = join(root, '.env')
  if (!existsSync(envPath)) return ''
  const line = readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trim().startsWith(`${key}=`))
  return line ? line.slice(line.indexOf('=') + 1).trim() : ''
}

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) || ''
}

const results = []
let failures = 0
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  \u2713 ${name}`)
  } catch (error) {
    failures += 1
    results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    console.error(`  \u2717 ${name}`)
    console.error(`    ${error instanceof Error ? error.message : String(error)}`)
  }
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

async function waitFor(fn, timeoutMs, label, intervalMs = 200) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`等待超时（${((Date.now() - started) / 1000).toFixed(0)}s）：${label}`)
}

async function startDevServer() {
  const viteBin = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
  const child = spawn(
    process.execPath,
    [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' }
    }
  )
  let output = ''
  child.stdout?.on('data', (chunk) => {
    output += chunk.toString()
  })
  child.stderr?.on('data', (chunk) => {
    output += chunk.toString()
  })
  try {
    await waitFor(
      async () => {
        try {
          const response = await fetch(`${baseUrl}/`)
          return response.ok
        } catch {
          if (child.exitCode !== null) throw new Error(`Vite 提前退出：\n${output}`)
          return false
        }
      },
      40000,
      'Vite 开发服务器启动'
    )
  } catch (error) {
    child.kill()
    throw error
  }
  return child
}

async function main() {
  // --ui：只跑不依赖地形瓦片的界面检查（离线、无 token 也能跑）。
  const uiOnly = process.argv.includes('--ui')
  const token = uiOnly ? '' : readEnvValue('CESIUM_ION_TOKEN')
  const chromePath = findChrome()
  if (!chromePath) {
    console.error('未找到 Chrome / Edge。请用 CHROME_PATH 环境变量指定浏览器可执行文件。')
    process.exit(1)
  }

  console.log(`[verify] browser: ${chromePath}`)
  console.log(`[verify] dev server: ${baseUrl}`)
  const server = await startDevServer()
  // 清掉上次运行留下的服务器端模拟域缓存，确保从“首次采样”开始验证。
  try {
    await fetch(`${baseUrl}/domain-cache/domain.json`, { method: 'DELETE' })
  } catch {
    // 没有该端点或服务端不支持 DELETE 时忽略，后续断言会给出明确失败信息。
  }
  let browser
  const consoleErrors = []

  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: false,
      args: ['--no-sandbox', '--disable-gpu-sandbox']
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const externalTileRequests = []
    page.on('request', (request) => {
      const requestUrl = request.url()
      if (/assets\.ion\.cesium\.com|api\.cesium\.com|arcgisonline\.com|maptiler/.test(requestUrl)) {
        externalTileRequests.push(requestUrl)
      }
    })
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))

    const url = `${baseUrl}/`
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    console.log('\n[verify] 启动与 UI')
    await check('页面创建 Tellux Viewer', async () => {
      await page.waitForFunction('window.viewer !== undefined', { timeout: 90000 })
      assert(await page.evaluate(() => Boolean(window.viewer)), 'window.viewer 不存在')
    })
    await check('加载器隐藏且无致命脚本错误', async () => {
      await page.waitForFunction(
        "document.querySelector('#loader')?.classList.contains('is-hidden') === true",
        { timeout: 60000 }
      )
      await page.waitForTimeout(1500)
      assert(consoleErrors.length === 0, `存在控制台错误：${consoleErrors[0]}`)
    })
    await check('地形 / 影像经由本地缓存端点加载', async () => {
      const terrain = await page.evaluate(() => window.viewer.terrain.current)
      assert(
        terrain && terrain.type === 'url',
        `地形源不是本地缓存 URL：${JSON.stringify(terrain)}`
      )
      assert(
        String(terrain.url).includes('/terrain-cache/'),
        `地形 URL 未指向本地缓存：${terrain.url}`
      )
      const stats = await page.evaluate(async () => (await fetch('/tile-cache/stats')).json())
      assert(stats && stats.cacheDir, '本地缓存统计不可用')
      assert(Array.isArray(externalTileRequests), '外部请求记录不可用')
      assert(
        externalTileRequests.length === 0,
        `浏览器直接请求了外部瓦片：${externalTileRequests[0]}`
      )
    })

    await check('场景模式默认显示场景控制台', async () => {
      assert(
        await page.evaluate(() => !document.querySelector('#console').hidden),
        '场景控制台不可见'
      )
      assert(
        await page.evaluate(() => document.querySelector('#water-left').hidden),
        '水体左栏不应显示'
      )
      assert(
        await page.evaluate(() => window.__waterEditor.getMode() === 'scene'),
        '当前模式不是 scene'
      )
    })

    await check('体积云 / 云层细节参数联动', async () => {
      await page.evaluate(() => {
        const setRange = (selector, value) => {
          const input = document.querySelector(selector)
          input.value = String(value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const setChecked = (selector, checked) => {
          const input = document.querySelector(selector)
          if (input.checked !== checked) input.click()
        }
        setRange('#quality', 0)
        setRange('#coverage', 55)
        setRange('#cloud-altitude', 9500)
        setRange('#cloud-height', 1200)
        setRange('#cloud-speed', 2)
        setRange('#cloud-shadow-quality', 2)
        setChecked('#cloud-detail', false)
        setChecked('#cloud-turbulence', false)
        setChecked('#cloud-haze', false)
        setChecked('#cloud-light-shafts', false)
        setChecked('#clouds-toggle', true)
      })
      await page.waitForTimeout(900)
      const clouds = await page.evaluate(() => {
        const value = window.viewer.scene.clouds
        return {
          show: value.show,
          coverage: value.coverage,
          altitude: value.layer.altitude,
          height: value.layer.height,
          speed: value.speed,
          quality: value.quality,
          lightShafts: value.lightShafts,
          detail: value.look.detail,
          turbulence: value.look.turbulence,
          haze: value.look.haze,
          shadow: value.shadow.quality
        }
      })
      assert(clouds.show === true, '云层开关未生效')
      assert(Math.abs(clouds.coverage - 0.55) < 1e-6, `云量未生效：${clouds.coverage}`)
      assert(Math.abs(clouds.altitude - 9500) < 1e-6, `云底高度未生效：${clouds.altitude}`)
      assert(Math.abs(clouds.height - 1200) < 1e-6, `云层厚度未生效：${clouds.height}`)
      assert(Math.abs(clouds.speed - 0.002) < 1e-9, `云层流速未生效：${clouds.speed}`)
      assert(clouds.quality === 'low', `渲染质量未生效：${clouds.quality}`)
      assert(clouds.lightShafts === false, '体积光柱未关闭')
      assert(clouds.detail === false, '云形细节未关闭')
      assert(clouds.turbulence === false, '湍流未关闭')
      assert(clouds.haze === false, '薄雾未关闭')
      assert(clouds.shadow === 'high', `云影质量未生效：${clouds.shadow}`)
      await page.screenshot({ path: join(outDir, 'clouds-detail.png') })

      // 保留一组可区分的持久化值并关闭云层，供刷新恢复测试使用。
      await page.evaluate(() => {
        const setRange = (selector, value) => {
          const input = document.querySelector(selector)
          input.value = String(value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        const setChecked = (selector, checked) => {
          const input = document.querySelector(selector)
          if (input.checked !== checked) input.click()
        }
        setRange('#quality', 2)
        setRange('#coverage', 62)
        setRange('#cloud-altitude', 9000)
        setRange('#cloud-height', 1500)
        setRange('#cloud-speed', 1.5)
        setRange('#cloud-shadow-quality', 1)
        setChecked('#cloud-detail', false)
        setChecked('#cloud-turbulence', true)
        setChecked('#cloud-haze', true)
        setChecked('#cloud-light-shafts', true)
        setChecked('#clouds-toggle', false)
      })
    })

    await check('体积云数值调参（含质量预设重放）', async () => {
      const hasEffect = await page.evaluate(() => Boolean(window.viewer.atmosphere?.cloudsEffect))
      assert(hasEffect, '取不到 CloudsEffect，Tellux 内部结构可能已变化')
      await page.evaluate(() => {
        const setRange = (selector, value) => {
          const input = document.querySelector(selector)
          input.value = String(value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setRange('#cloud-min-step', 80)
        setRange('#cloud-iterations', 260)
        setRange('#cloud-sun-iterations', 1)
        setRange('#cloud-scattering', 1.4)
        setRange('#cloud-absorption', 0.1)
        setRange('#cloud-turbulence-displacement', 500)
      })
      const tuned = await page.evaluate(() => {
        const effect = window.viewer.atmosphere.cloudsEffect
        return {
          minStep: effect.clouds.minStepSize,
          iterations: effect.clouds.maxIterationCount,
          sunIterations: effect.clouds.maxIterationCountToSun,
          scattering: effect.scatteringCoefficient,
          absorption: effect.absorptionCoefficient,
          turbulence: effect.turbulenceDisplacement
        }
      })
      assert(Math.abs(tuned.minStep - 80) < 1e-6, `最小步长未生效：${tuned.minStep}`)
      assert(tuned.iterations === 260, `主步进上限未生效：${tuned.iterations}`)
      assert(tuned.sunIterations === 1, `太阳步进上限未生效：${tuned.sunIterations}`)
      assert(Math.abs(tuned.scattering - 1.4) < 1e-6, `散射强度未生效：${tuned.scattering}`)
      assert(Math.abs(tuned.absorption - 0.1) < 1e-6, `吸收强度未生效：${tuned.absorption}`)
      assert(Math.abs(tuned.turbulence - 500) < 1e-6, `湍流位移未生效：${tuned.turbulence}`)

      // 改变云量会触发质量预设重套；自定义数值应被重放而不是被预设覆盖。
      await page.evaluate(() => {
        const input = document.querySelector('#coverage')
        input.value = '56'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const replayed = await page.evaluate(
        () => window.viewer.atmosphere.cloudsEffect.clouds.minStepSize
      )
      assert(Math.abs(replayed - 80) < 1e-6, `云量变化后自定义最小步长被质量预设覆盖：${replayed}`)
      // 还原调参，避免影响后续断言。
      await page.evaluate(() => {
        const setRange = (selector, value) => {
          const input = document.querySelector(selector)
          input.value = String(value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
        setRange('#cloud-min-step', 60)
        setRange('#cloud-iterations', 400)
        setRange('#cloud-sun-iterations', 2)
        setRange('#cloud-scattering', 1)
        setRange('#cloud-absorption', 0)
        setRange('#cloud-turbulence-displacement', 350)
        setRange('#coverage', 62)
      })
    })

    if (!token) {
      console.log('\n[verify] SKIP：未配置 CESIUM_ION_TOKEN，跳过水体模拟域与模拟验证')
    } else {
      console.log('\n[verify] 水体编辑模式')
      await check('切换到水体编辑模式', async () => {
        await page.click('#mode-water')
        await page.waitForFunction("document.body.dataset.mode === 'water'", { timeout: 15000 })
        assert(
          await page.evaluate(() => document.querySelector('#water-left').hidden === false),
          '水体左栏未显示'
        )
        assert(
          await page.evaluate(() => document.querySelector('#water-right').hidden === false),
          '水体右栏未显示'
        )
        assert(
          await page.evaluate(() => document.querySelector('#console').hidden === true),
          '场景控制台未隐藏'
        )
        assert(
          await page.evaluate(() => window.__waterEditor.getMode() === 'water'),
          '编辑器模式未切换'
        )
      })

      await check('模拟域构建完成（地形采样）', async () => {
        const ready = await page.evaluate(() => window.__waterEditor.waitReady(240000))
        assert(ready === true, '模拟域未就绪')
        const domain = await page.evaluate(() => window.__waterEditor.getDomain())
        const field = await page.evaluate(() => window.__waterEditor.getFieldInfo())
        assert(domain, 'domain 为空')
        assert(field, '地形场为空')
        assert(field.resolution === 97, `地形采样分辨率异常：${field.resolution}`)
        assert(domain.sizeMeters === 8000, `模拟域尺寸异常：${domain.sizeMeters}`)
        assert(
          Math.abs(domain.origin.longitude - 116.77) < 1e-6 &&
            Math.abs(domain.origin.latitude - 36.02) < 1e-6,
          `模拟域中心不是固定位置：${JSON.stringify(domain.origin)}`
        )
        assert(Number.isFinite(domain.baseElevation), '基准高程不是有限数')
        assert(field.maxHeight - field.minHeight > 1, '地形高度场没有起伏')
        const source = await page.evaluate(() => window.__waterEditor.getDomainSource())
        assert(source === 'sampled', `首次构建应现场采样地形：${source}`)
        const cacheInfo = await page.evaluate(() => window.__waterEditor.getDomainCacheInfo())
        assert(cacheInfo && cacheInfo.resolution === 97, '模拟域地形未写入本地存储')
        assert(cacheInfo.bytes > 20000, `本地存储地形数据过小：${cacheInfo.bytes}`)
        const serverCached = await page.evaluate(async () => {
          const response = await fetch('/domain-cache/domain.json')
          if (!response.ok) return null
          const data = await response.json()
          return {
            resolution: data.resolution,
            sizeMeters: data.sizeMeters,
            center: data.center,
            heightsLength: typeof data.heights === 'string' ? data.heights.length : 0
          }
        })
        assert(serverCached, '模拟域地形未写入服务器本地缓存')
        assert(
          serverCached.resolution === 97 && serverCached.sizeMeters === 8000,
          '服务器本地缓存参数异常'
        )
        assert(serverCached.heightsLength > 40000, '服务器本地缓存高度场过小')
      })

      await check('用鼠标在地形上放置水源', async () => {
        await page.click('#water-add-source')
        await page.waitForFunction("document.body.dataset.placing === 'true'", { timeout: 5000 })
        const point = await page.evaluate(() => {
          const domain = window.__waterEditor.getDomain()
          const vector = window.viewer.cartographicToVector3({
            longitude: domain.origin.longitude,
            latitude: domain.origin.latitude,
            height: domain.baseElevation + 40
          })
          vector.project(window.viewer.camera.raw)
          const rect = document.querySelector('#viewer canvas').getBoundingClientRect()
          return {
            x: rect.left + ((vector.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - vector.y) / 2) * rect.height
          }
        })
        await page.mouse.click(point.x, point.y)
        const sources = await waitFor(
          () => page.evaluate(() => window.__waterEditor.getState().sources),
          15000,
          '水源放置'
        )
        assert(sources.length === 1, `水源数量应为 1，实际 ${sources.length}`)
        assert(sources[0].name === '水源 1', `默认名称异常：${sources[0].name}`)
        assert(
          typeof sources[0].targetLevel === 'number' && typeof sources[0].groundLevel === 'number',
          '新水源缺少地面高程 / 目标水位'
        )
        assert(sources[0].targetLevel > sources[0].groundLevel, '目标水位应高于地面高程')
        await page.keyboard.press('Escape')
      })

      await check('浅水模拟注水并扩散（无 NaN）', async () => {
        const stats = await waitFor(
          async () => {
            const value = await page.evaluate(() => window.__waterEditor.getStats())
            return value && value.steps > 60 && value.wetCells > 0 && value.maxDepth > 0
              ? value
              : null
          },
          90000,
          '浅水模拟产生水面'
        )
        assert(Number.isFinite(stats.maxDepth), 'maxDepth 不是有限数')
        assert(stats.wetCells > 10, `湿格过少：${stats.wetCells}`)
        assert(stats.maxDepth > 0.2, `最大水深过小：${stats.maxDepth}`)
        await page.screenshot({ path: join(outDir, 'water-editor.png') })
      })

      await check('暂停 / 继续模拟', async () => {
        await page.click('#water-pause')
        await page.waitForTimeout(1300)
        const pausedA = await page.evaluate(() => window.__waterEditor.getStats())
        await page.waitForTimeout(1300)
        const pausedB = await page.evaluate(() => window.__waterEditor.getStats())
        assert(
          Math.abs(pausedB.steps - pausedA.steps) <= 2,
          `暂停后 steps 仍在增长：${pausedA.steps} -> ${pausedB.steps}`
        )
        assert(
          await page.evaluate(() => window.__waterEditor.getState().sim.paused === true),
          '暂停状态未写入'
        )
        await page.click('#water-pause')
        await page.waitForTimeout(1300)
        const resumed = await page.evaluate(() => window.__waterEditor.getStats())
        assert(
          resumed.steps > pausedB.steps + 10,
          `继续后 steps 未恢复增长：${pausedB.steps} -> ${resumed.steps}`
        )
      })

      await check('水面精细外观参数联动', async () => {
        await page.evaluate(() => {
          const setRange = (selector, value) => {
            const input = document.querySelector(selector)
            input.value = String(value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          setRange('#water-shimmer', 2.2)
          setRange('#water-glint', 1.8)
          setRange('#water-reflection', 0.4)
          setRange('#water-ripple', 1.4)
          setRange('#water-ripple-scale', 1.7)
          setRange('#water-flow-speed', 0.3)
          setRange('#water-foam', 1.6)
          setRange('#water-clarity', 0.4)
        })
        const visual = await page.evaluate(() => window.__waterEditor.getState().visual)
        assert(Math.abs(visual.shimmer - 2.2) < 0.001, `太阳高光未更新：${visual.shimmer}`)
        assert(Math.abs(visual.glint - 1.8) < 0.001, `高光锐度未更新：${visual.glint}`)
        assert(Math.abs(visual.reflection - 0.4) < 0.001, `天空反射未更新：${visual.reflection}`)
        assert(Math.abs(visual.ripple - 1.4) < 0.001, `波纹强度未更新：${visual.ripple}`)
        assert(Math.abs(visual.rippleScale - 1.7) < 0.001, `波纹尺度未更新：${visual.rippleScale}`)
        assert(Math.abs(visual.flowSpeed - 0.3) < 0.001, `波纹流速未更新：${visual.flowSpeed}`)
        assert(Math.abs(visual.foam - 1.6) < 0.001, `泡沫强度未更新：${visual.foam}`)
        assert(Math.abs(visual.clarity - 0.4) < 0.001, `清澈度未更新：${visual.clarity}`)
        await page.screenshot({ path: join(outDir, 'water-appearance-tuned.png') })
        await page.evaluate(() => {
          const input = document.querySelector('#water-opacity')
          input.value = '0.75'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const opacity = await page.evaluate(() => window.__waterEditor.getState().visual.opacity)
        assert(Math.abs(opacity - 0.75) < 0.001, `水面不透明度未更新：${opacity}`)
        await page.click('#water-appearance-reset')
        await page.waitForTimeout(300)
        const reset = await page.evaluate(() => window.__waterEditor.getState().visual)
        assert(Math.abs(reset.shimmer - 1) < 0.001, `恢复默认失败：shimmer=${reset.shimmer}`)
        assert(Math.abs(reset.glint - 1) < 0.001, `恢复默认失败：glint=${reset.glint}`)
        assert(
          Math.abs(reset.reflection - 1) < 0.001,
          `恢复默认失败：reflection=${reset.reflection}`
        )
        assert(Math.abs(reset.ripple - 1) < 0.001, `恢复默认失败：ripple=${reset.ripple}`)
        assert(
          Math.abs(reset.rippleScale - 1) < 0.001,
          `恢复默认失败：rippleScale=${reset.rippleScale}`
        )
        assert(Math.abs(reset.flowSpeed - 1) < 0.001, `恢复默认失败：flowSpeed=${reset.flowSpeed}`)
        assert(Math.abs(reset.foam - 1) < 0.001, `恢复默认失败：foam=${reset.foam}`)
        assert(Math.abs(reset.clarity - 0.62) < 0.001, `恢复默认失败：clarity=${reset.clarity}`)
        assert(reset.opacity === 0, `恢复默认失败：opacity=${reset.opacity}`)
      })

      await check('模拟速度上限 64×', async () => {
        await page.evaluate(() => {
          const input = document.querySelector('#water-speed')
          input.value = '64'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        const speed = await page.evaluate(() => window.__waterEditor.getState().sim.speed)
        assert(Math.abs(speed - 64) < 1e-6, `模拟速度未到 64×：${speed}`)
        await page.evaluate(() => {
          const input = document.querySelector('#water-speed')
          input.value = '1'
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
      })

      await check('水流数值调参', async () => {
        await page.evaluate(() => {
          const setRange = (selector, value) => {
            const input = document.querySelector(selector)
            input.value = String(value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          setRange('#water-max-flow-speed', 45)
          setRange('#water-damping', 0.95)
          setRange('#water-inject-interval', 3)
        })
        const sim = await page.evaluate(() => window.__waterEditor.getState().sim)
        assert(sim.maxFlowSpeed === 45, `最大流速未生效：${sim.maxFlowSpeed}`)
        assert(Math.abs(sim.damping - 0.95) < 1e-6, `流动阻尼未生效：${sim.damping}`)
        assert(sim.injectInterval === 3, `注水间隔未生效：${sim.injectInterval}`)
        await page.evaluate(() => {
          const setRange = (selector, value) => {
            const input = document.querySelector(selector)
            input.value = String(value)
            input.dispatchEvent(new Event('input', { bubbles: true }))
          }
          setRange('#water-max-flow-speed', 30)
          setRange('#water-damping', 0.995)
          setRange('#water-inject-interval', 2)
        })
      })

      await check('水体总开关', async () => {
        await page.evaluate(() => document.querySelector('#water-toggle').click())
        await page.waitForTimeout(400)
        assert(
          await page.evaluate(() => window.__waterEditor.getState().enabled === false),
          '关闭状态未写入'
        )
        const pill = await page.evaluate(
          () => document.querySelector('#water-status-pill span').textContent
        )
        assert(pill.includes('已关闭'), `状态胶囊未显示已关闭：${pill}`)
        await page.evaluate(() => document.querySelector('#water-toggle').click())
        await page.waitForTimeout(300)
        assert(
          await page.evaluate(() => window.__waterEditor.getState().enabled === true),
          '重新开启失败'
        )
      })

      await check('拖动水源更新位置', async () => {
        const id = await page.evaluate(() => window.__waterEditor.getState().sources[0].id)
        const before = await page.evaluate(() => {
          const source = window.__waterEditor.getState().sources[0]
          return { longitude: source.longitude, latitude: source.latitude }
        })
        const point = await page.evaluate(
          (sourceId) => window.__waterEditor.getSourceScreenPosition(sourceId),
          id
        )
        assert(point, '取不到水源屏幕位置')
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
        await page.mouse.move(point.x + 90, point.y + 50, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(500)
        const after = await page.evaluate(() => {
          const source = window.__waterEditor.getState().sources[0]
          return { longitude: source.longitude, latitude: source.latitude }
        })
        assert(
          Math.abs(after.longitude - before.longitude) > 1e-6 ||
            Math.abs(after.latitude - before.latitude) > 1e-6,
          '拖动后位置未变化'
        )
      })

      await check('重置模拟', async () => {
        const paused = await page.evaluate(() => window.__waterEditor.getState().sim.paused)
        if (!paused) await page.click('#water-pause')
        await page.waitForTimeout(400)
        await page.click('#water-reset')
        await page.waitForTimeout(400)
        const stats = await page.evaluate(() => window.__waterEditor.getStats())
        assert(stats.steps === 0, `重置后 steps 应为 0，实际 ${stats.steps}`)
        assert(stats.wetCells === 0, `重置后湿格应为 0，实际 ${stats.wetCells}`)
        if (!paused) await page.click('#water-pause')
      })

      await check('持久化与刷新恢复', async () => {
        await page.click('#water-add-source')
        await page.waitForFunction("document.body.dataset.placing === 'true'", { timeout: 5000 })
        const point = await page.evaluate(() => {
          const domain = window.__waterEditor.getDomain()
          const vector = window.viewer.cartographicToVector3({
            longitude: domain.origin.longitude + 0.002,
            latitude: domain.origin.latitude + 0.002,
            height: domain.baseElevation + 40
          })
          vector.project(window.viewer.camera.raw)
          const rect = document.querySelector('#viewer canvas').getBoundingClientRect()
          return {
            x: rect.left + ((vector.x + 1) / 2) * rect.width,
            y: rect.top + ((1 - vector.y) / 2) * rect.height
          }
        })
        await page.mouse.click(point.x, point.y)
        await waitFor(
          () => page.evaluate(() => window.__waterEditor.getState().sources.length >= 2),
          15000,
          '第二个水源放置'
        )
        await page.keyboard.press('Escape')
        await page.evaluate(() => window.__waterEditor.saveNow())
        const stored = await page.evaluate(() =>
          JSON.parse(localStorage.getItem('tellux-water-editor-v1') || 'null')
        )
        assert(stored, 'localStorage 中没有水体工程')
        assert(stored.sources.length >= 2, '工程中的水源数量不足')
        assert(stored.domain && stored.domain.sizeMeters === 8000, '工程没有保存固定模拟域')

        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForFunction('window.viewer !== undefined', { timeout: 90000 })
        await page.waitForFunction(
          "window.__waterEditor && window.__waterEditor.getMode() === 'water'",
          { timeout: 30000 }
        )
        const restored = await page.evaluate(() => window.__waterEditor.getState())
        assert(restored.sources.length >= 2, `刷新后水源未恢复：${restored.sources.length}`)
        const cloudRestored = await page.evaluate(() => ({
          coverage: document.querySelector('#coverage').value,
          height: document.querySelector('#cloud-height').value,
          speed: document.querySelector('#cloud-speed').value,
          detail: document.querySelector('#cloud-detail').checked
        }))
        assert(cloudRestored.coverage === '62', `体积云云量未恢复：${cloudRestored.coverage}`)
        assert(cloudRestored.height === '1500', `体积云厚度未恢复：${cloudRestored.height}`)
        assert(cloudRestored.speed === '1.5', `体积云流速未恢复：${cloudRestored.speed}`)
        assert(cloudRestored.detail === false, '体积云细节开关未恢复')
        const ready = await page.evaluate(() => window.__waterEditor.waitReady(240000))
        assert(ready === true, '刷新后模拟域未恢复')
        const restoredSource = await page.evaluate(() => window.__waterEditor.getDomainSource())
        assert(restoredSource === 'cache', `刷新后模拟域未从本地存储恢复：${restoredSource}`)
        const restoredProjection = await page.evaluate(() => window.__waterEditor.getProjection())
        assert(
          restoredProjection && restoredProjection.sizeMeters === 8000,
          '本地缓存恢复后缺少模拟域投影（会导致水源不注水、无法拖动）'
        )
        await page.waitForTimeout(3500)
        await check('刷新后水面继续模拟', async () => {
          const stats = await page.evaluate(() => window.__waterEditor.getStats())
          assert(stats.steps > 0, `刷新后模拟未推进：steps=${stats.steps}`)
          assert(stats.wetCells > 0, `刷新后水面消失：wetCells=${stats.wetCells}`)
        })
        await page.screenshot({ path: join(outDir, 'water-editor-restored.png') })
      })

      await check('本地缓存恢复后水源仍可拖动且继续注水', async () => {
        await page.waitForTimeout(1200)
        const id = await page.evaluate(() => window.__waterEditor.getState().sources[0]?.id)
        assert(id, '刷新后没有水源')
        const before = await page.evaluate(() => {
          const source = window.__waterEditor.getState().sources[0]
          return { longitude: source.longitude, latitude: source.latitude }
        })
        const point = await page.evaluate(
          (sourceId) => window.__waterEditor.getSourceScreenPosition(sourceId),
          id
        )
        assert(point, '取不到水源屏幕位置')
        await page.mouse.move(point.x, point.y)
        await page.mouse.down()
        await page.mouse.move(point.x + 100, point.y + 50, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(700)
        const after = await page.evaluate(() => {
          const source = window.__waterEditor.getState().sources[0]
          return { longitude: source.longitude, latitude: source.latitude }
        })
        assert(
          Math.abs(after.longitude - before.longitude) > 1e-6 ||
            Math.abs(after.latitude - before.latitude) > 1e-6,
          '本地缓存恢复后拖动水源无效'
        )
        await page.waitForTimeout(3500)
        const stats = await page.evaluate(() => window.__waterEditor.getStats())
        assert(stats.wetCells > 0, `本地缓存恢复后水面消失：wetCells=${stats.wetCells}`)
      })

      await check('清除浏览器缓存后从服务器本地存储恢复模拟域', async () => {
        await page.evaluate(() => localStorage.removeItem('tellux-water-domain-v1'))
        const ready = await page.evaluate(() => window.__waterEditor.restoreDomainFromStorage())
        assert(ready === true, '服务器本地存储恢复模拟域失败')
        const source = await page.evaluate(() => window.__waterEditor.getDomainSource())
        assert(source === 'cache', `模拟域未从服务器本地存储恢复：${source}`)
        const projection = await page.evaluate(() => window.__waterEditor.getProjection())
        assert(projection && projection.sizeMeters === 8000, '服务器本地存储恢复后缺少模拟域投影')
        const localRefilled = await page.evaluate(
          () => localStorage.getItem('tellux-water-domain-v1') !== null
        )
        assert(localRefilled, '从服务器恢复后未回填浏览器本地存储')
        const domain = await page.evaluate(() => window.__waterEditor.getDomain())
        assert(
          domain.sizeMeters === 8000 && Math.abs(domain.origin.longitude - 116.77) < 1e-6,
          '服务器恢复的模拟域不是固定区域'
        )
      })

      await check('重建模拟域重新采样并更新本地存储', async () => {
        const before = await page.evaluate(() => window.__waterEditor.getDomainCacheInfo())
        const serverBefore = await page.evaluate(async () => {
          const response = await fetch('/domain-cache/domain.json')
          return response.ok ? response.json() : null
        })
        await page.click('#water-rebuild-domain')
        const ready = await page.evaluate(() => window.__waterEditor.waitReady(240000))
        assert(ready === true, '重建模拟域未完成')
        const source = await page.evaluate(() => window.__waterEditor.getDomainSource())
        assert(source === 'sampled', `重建后应现场采样地形：${source}`)
        const after = await page.evaluate(() => window.__waterEditor.getDomainCacheInfo())
        assert(after && after.resolution === 97, '重建后本地存储信息异常')
        assert(!before || after.savedAt !== before.savedAt, '重建后本地存储未更新')
        const serverAfter = await page.evaluate(async () => {
          const response = await fetch('/domain-cache/domain.json')
          return response.ok ? response.json() : null
        })
        assert(serverAfter, '重建后服务器本地存储缺失')
        assert(
          serverBefore && serverAfter.savedAt !== serverBefore.savedAt,
          '重建后服务器本地存储未更新'
        )
        const domain = await page.evaluate(() => window.__waterEditor.getDomain())
        assert(
          domain.sizeMeters === 8000 && Math.abs(domain.origin.longitude - 116.77) < 1e-6,
          '重建后模拟域不是固定区域'
        )
      })

      await check('切回浏览模式后模拟继续推进', async () => {
        await page.click('#mode-scene')
        await page.waitForTimeout(800)
        assert(
          await page.evaluate(() => document.querySelector('#console').hidden === false),
          '场景控制台未恢复'
        )
        assert(
          await page.evaluate(() => document.querySelector('#water-left').hidden === true),
          '水体面板未隐藏'
        )
        const before = await page.evaluate(() => window.__waterEditor.getStats())
        await page.waitForTimeout(1600)
        const after = await page.evaluate(() => window.__waterEditor.getStats())
        assert(
          after.steps > before.steps,
          `浏览模式下模拟未继续：${before.steps} -> ${after.steps}`
        )
        await page.screenshot({ path: join(outDir, 'water-scene-mode.png') })
      })
    }

    await check('运行期间无控制台错误', async () => {
      assert(
        consoleErrors.length === 0,
        `存在 ${consoleErrors.length} 条控制台错误：${consoleErrors[0]}`
      )
    })
  } finally {
    if (browser) await browser.close()
    server.kill()
  }

  console.log(`\n[verify] ${results.length - failures}/${results.length} 项通过`)
  if (failures > 0) {
    console.error(`[verify] ${failures} 项失败`)
    process.exit(1)
  }
  console.log('[verify] 全部通过')
  process.exit(0)
}

main().catch((error) => {
  console.error('[verify] 验证脚本异常退出：', error)
  process.exit(1)
})
