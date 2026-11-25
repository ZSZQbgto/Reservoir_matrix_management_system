/**
 * UI 外壳：布局测量、模式滑块、面板折叠、水源抽屉与滑杆填充。
 *
 * 只操作布局与 DOM，不持有水体状态。
 */
import { pickElement, syncRangeFill } from '../shared/dom'
import { domId } from '../shared/domIds'

interface CollapseOptions {
  panel: HTMLElement
  toggle: HTMLElement
  body: HTMLElement
  /** 为 true 时初始折叠。 */
  collapseByDefault?: boolean
}

const SPRING_IN = 'cubic-bezier(0.34, 1.36, 0.5, 1)'
const EASE_OUT = 'cubic-bezier(0.32, 0.72, 0, 1)'

export function initUiShell(): void {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const duration = (ms: number): number => (reducedMotion.matches ? 1 : ms)

  /* ------------------------------------------------------------ 头部高度测量 */

  const header = pickElement<HTMLElement>('.hud-top')
  const footer = pickElement<HTMLElement>('.hud-bottom')

  const measure = (): void => {
    const root = document.documentElement
    if (header) {
      root.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().bottom)}px`)
    }
    if (footer) {
      const height = footer.getBoundingClientRect().height
      root.style.setProperty('--footer-h', `${Math.round(height)}px`)
    }
  }

  measure()
  if (header) new ResizeObserver(measure).observe(header)
  if (footer) new ResizeObserver(measure).observe(footer)
  window.addEventListener('resize', measure, { passive: true })
  window.addEventListener('load', measure, { once: true })
  void document.fonts?.ready.then(measure)

  /* ------------------------------------------------------------ 模式滑块 */

  const dock = pickElement<HTMLElement>(domId('mode-dock'))
  const glider = pickElement<HTMLElement>(domId('mode-glider'))

  if (dock && glider) {
    const place = (): void => {
      const active = pickElement<HTMLElement>('.mode-button.is-active', dock)
      if (!active) return
      const dockRect = dock.getBoundingClientRect()
      const activeRect = active.getBoundingClientRect()
      const offset = activeRect.left - dockRect.left - dock.clientLeft
      dock.style.setProperty('--glider-x', `${Math.round(offset)}px`)
      dock.style.setProperty('--glider-w', `${Math.round(activeRect.width)}px`)
    }

    requestAnimationFrame(() => {
      place()
      dock.classList.add('is-ready')
    })

    const observer = new MutationObserver(place)
    for (const button of dock.querySelectorAll('.mode-button')) {
      observer.observe(button, { attributes: true, attributeFilter: ['class'] })
    }
    new ResizeObserver(place).observe(dock)
    void document.fonts?.ready.then(place)
  }

  /* ------------------------------------------------------------ 面板折叠 */

  const setupCollapse = ({
    panel,
    toggle,
    body,
    collapseByDefault
  }: CollapseOptions): { collapse: () => void; expand: () => void } => {
    let animating = false
    let animation: Animation | null = null

    const setAria = (expanded: boolean): void => {
      toggle.setAttribute('aria-expanded', String(expanded))
      panel.dataset.collapsed = expanded ? 'false' : 'true'
    }

    setAria(!collapseByDefault)

    const collapse = (): void => {
      if (animating || panel.dataset.collapsed === 'true') return
      const from = panel.getBoundingClientRect().height
      const bodyHeight = body.getBoundingClientRect().height
      const to = Math.max(0, Math.round(from - bodyHeight))
      animating = true
      panel.classList.add('is-animating')
      toggle.setAttribute('aria-expanded', 'false')

      animation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: duration(280),
        easing: EASE_OUT
      })
      animation.onfinish = () => {
        panel.dataset.collapsed = 'true'
        panel.classList.remove('is-animating')
        panel.style.height = ''
        animating = false
        animation = null
      }
      animation.oncancel = () => {
        panel.dataset.collapsed = 'false'
        toggle.setAttribute('aria-expanded', 'true')
        panel.classList.remove('is-animating')
        panel.style.height = ''
        animating = false
        animation = null
      }
    }

    const expand = (): void => {
      if (animating || panel.dataset.collapsed !== 'true') return
      const from = panel.getBoundingClientRect().height
      toggle.setAttribute('aria-expanded', 'true')
      panel.dataset.collapsed = 'false'
      const to = Math.round(panel.getBoundingClientRect().height)
      animating = true
      panel.classList.add('is-animating')

      animation = panel.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: duration(360),
        easing: SPRING_IN
      })
      animation.onfinish = () => {
        panel.classList.remove('is-animating')
        panel.style.height = ''
        animating = false
        animation = null
      }
      animation.oncancel = () => {
        panel.classList.remove('is-animating')
        panel.style.height = ''
        animating = false
        animation = null
      }
    }

    toggle.addEventListener('click', () => {
      if (animation) return
      if (panel.dataset.collapsed === 'true') expand()
      else collapse()
    })

    // 视口变化时不要留下动画中的内联高度。
    window.addEventListener(
      'resize',
      () => {
        if (!animation) return
        animation.cancel()
      },
      { passive: true }
    )

    return { collapse, expand }
  }

  const consolePanel = pickElement<HTMLElement>(domId('console'))
  const consoleToggle = pickElement<HTMLElement>(domId('console-toggle'))
  const consoleBody = pickElement<HTMLElement>(domId('console-body'))
  const compact = window.matchMedia('(max-width: 720px)')

  if (consolePanel && consoleToggle && consoleBody) {
    setupCollapse({
      panel: consolePanel,
      toggle: consoleToggle,
      body: consoleBody,
      collapseByDefault: compact.matches
    })

    compact.addEventListener('change', (event) => {
      if (!event.matches) return
      if (consolePanel.dataset.collapsed === 'true') return
      consolePanel.dataset.collapsed = 'true'
      consoleToggle.setAttribute('aria-expanded', 'false')
    })
  }

  const waterRight = pickElement<HTMLElement>(domId('water-right'))
  const waterRightToggle = pickElement<HTMLElement>(domId('water-right-toggle'))
  const waterRightBody = pickElement<HTMLElement>(domId('water-right-body'))
  let waterRightControl: { collapse: () => void; expand: () => void } | null = null

  if (waterRight && waterRightToggle && waterRightBody) {
    waterRightControl = setupCollapse({
      panel: waterRight,
      toggle: waterRightToggle,
      body: waterRightBody
    })
  }

  /* ------------------------------------------------------------ 水源抽屉 */

  const body = document.body
  const handle = pickElement<HTMLButtonElement>(domId('source-drawer-toggle'))
  const drawer = pickElement<HTMLElement>(domId('water-left'))
  const sourceList = pickElement<HTMLElement>(domId('water-source-list'))
  const sourceCount = pickElement<HTMLElement>(domId('source-count'))

  const setDrawer = (open: boolean, moveFocus = false): void => {
    body.dataset.drawer = open ? 'open' : 'closed'
    handle?.setAttribute('aria-expanded', String(open))
    if (open) {
      // 打开抽屉时收起右侧面板，避免两块面板重叠。
      if (compact.matches) waterRightControl?.collapse()
      if (moveFocus) {
        const target = pickElement<HTMLElement>(domId('water-add-source'), drawer ?? document)
        target?.focus({ preventScroll: true })
      }
    }
  }

  if (handle && drawer) {
    handle.addEventListener('click', () => setDrawer(body.dataset.drawer !== 'open', true))

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || body.dataset.drawer !== 'open') return
      setDrawer(false)
      handle.focus({ preventScroll: true })
    })

    document.addEventListener(
      'pointerdown',
      (event) => {
        if (body.dataset.drawer !== 'open') return
        const target = event.target
        if (!(target instanceof Node)) return
        if (drawer.contains(target) || handle.contains(target)) return
        setDrawer(false)
      },
      { capture: true, passive: true }
    )

    drawer.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.water-source-item')) setDrawer(false)
    })

    new MutationObserver(() => {
      const mode = body.dataset.mode
      const placing = body.dataset.placing
      if (mode !== 'water' || placing === 'true') setDrawer(false)
    }).observe(body, { attributes: true, attributeFilter: ['data-mode', 'data-placing'] })

    window.addEventListener(
      'resize',
      () => {
        if (window.innerWidth > 1180 && body.dataset.drawer === 'open') setDrawer(false)
      },
      { passive: true }
    )

    waterRightToggle?.addEventListener('click', () => {
      if (compact.matches && body.dataset.drawer === 'open') setDrawer(false)
    })
  }

  if (sourceList && sourceCount) {
    const syncCount = (): void => {
      sourceCount.textContent = String(sourceList.querySelectorAll('.water-source-item').length)
    }
    syncCount()
    new MutationObserver(syncCount).observe(sourceList, { childList: true })
  }

  /* ------------------------------------------------------------ 滑杆值填充 */

  const syncAllRanges = (): void => {
    for (const input of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) {
      syncRangeFill(input)
    }
  }

  document.addEventListener(
    'input',
    (event) => {
      const target = event.target
      if (target instanceof HTMLInputElement && target.type === 'range') syncRangeFill(target)
    },
    true
  )

  new MutationObserver(syncAllRanges).observe(body, {
    attributes: true,
    attributeFilter: ['data-mode']
  })

  syncAllRanges()
  window.setTimeout(syncAllRanges, 600)
  window.setTimeout(syncAllRanges, 2200)
}
