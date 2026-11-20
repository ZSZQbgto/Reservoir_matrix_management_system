/**
 * UI 布局截图工具（人工核对响应式布局用）。
 *
 *   node scripts/capture-ui.mjs --out .impeccable/review/ui/before
 *   node scripts/capture-ui.mjs --out .impeccable/review/ui/after --base http://127.0.0.1:5173
 *
 * 需要本机 Chrome / Edge（WebGL 地球需要真实 GPU，headless 下地形无法加载）。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const base = arg('base', 'http://127.0.0.1:5173')
const outDir = arg('out', '.impeccable/review/ui')
const only = arg('only', '')
const chromePath =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const VIEWPORTS = [
  { name: 'wide-1600x900', width: 1600, height: 900 },
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'compact-1280x800', width: 1280, height: 800 },
  { name: 'small-1180x760', width: 1180, height: 760 },
  { name: 'tablet-1024x768', width: 1024, height: 768 },
  { name: 'window-900x700', width: 900, height: 700 },
  { name: 'narrow-760x820', width: 760, height: 820 },
  { name: 'sheet-700x800', width: 700, height: 800 },
  { name: 'phone-600x780', width: 600, height: 780 },
  { name: 'short-1440x620', width: 1440, height: 620 },
  { name: 'short-1024x560', width: 1024, height: 560 }
]

mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: false,
  args: ['--no-sandbox', '--disable-gpu-sandbox']
})

const metrics = (page) =>
  page.evaluate(() => {
    const pick = (selector) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right),
        hidden: style.display === 'none' || node.hidden,
        scrolls: node.scrollHeight > node.clientHeight + 1
      }
    }
    return {
      inner: { w: innerWidth, h: innerHeight },
      header: pick('.hud-top'),
      footer: pick('.hud-bottom'),
      dock: pick('.mode-dock'),
      console: pick('.console'),
      left: pick('.water-panel-left'),
      right: pick('.water-panel-right'),
      drawer: pick('.drawer-handle'),
      bodyScroll: { w: document.body.scrollWidth, h: document.body.scrollHeight }
    }
  })

for (const viewport of VIEWPORTS.filter((item) => !only || item.name.includes(only))) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => document.querySelector('#loader')?.classList.contains('is-hidden'),
    null,
    { timeout: 60000 }
  )
  await page.waitForTimeout(5200)
  await page.screenshot({ path: join(outDir, `${viewport.name}--scene.png`) })
  const scene = await metrics(page)

  await page.click('#mode-water')
  await page.waitForTimeout(4000)
  await page.screenshot({ path: join(outDir, `${viewport.name}--water.png`) })
  const water = await metrics(page)

  let drawer = null
  if (await page.isVisible('#source-drawer-toggle')) {
    await page.click('#source-drawer-toggle')
    await page.waitForTimeout(700)
    await page.screenshot({ path: join(outDir, `${viewport.name}--drawer.png`) })
    drawer = await metrics(page)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  let collapsed = null
  if (await page.isVisible('#water-right-toggle')) {
    await page.click('#water-right-toggle')
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(outDir, `${viewport.name}--collapsed.png`) })
    collapsed = await metrics(page)
  }

  console.log(
    JSON.stringify({
      viewport: viewport.name,
      scene: { console: scene.console, dock: scene.dock, header: scene.header },
      water: { left: water.left, right: water.right, drawer: water.drawer },
      drawer: drawer?.left,
      collapsed: collapsed?.right,
      errors: [...new Set(errors)].slice(0, 4)
    })
  )

  await context.close()
}

await browser.close()
