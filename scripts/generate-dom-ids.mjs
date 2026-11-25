/**
 * 从 index.html 生成 DOM id 清单（src/shared/domIds.ts）。
 *
 * id 以字面量类型导出，`domId('#id')` 的拼写错误在编译期报错，而不是运行期。
 *
 * 用法：npm run gen:dom
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { format, resolveConfig } from 'prettier'

const HTML_PATH = 'index.html'
const OUT_PATH = 'src/shared/domIds.ts'

const HEADER = `/**
 * 由 scripts/generate-dom-ids.mjs 从 index.html 生成，请勿手改。
 *
 * id 变化后运行 \`npm run gen:dom\`；\`npm run check:conventions\` 校验同步。
 */
`

/** 生成 domIds.ts 的完整内容（已按 Prettier 格式化，保证重生成后格式稳定）。 */
export async function buildDomIdsSource(html) {
  const ids = []
  const seen = new Set()
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  const entries = ids.map((id) => `  '${id}': '${id}'`).join(',\n')
  const raw = `${HEADER}export const DOM_IDS = {
${entries}
} as const

export type DomId = keyof typeof DOM_IDS

/** 把 id 转成 CSS 选择器；参数受 \`DomId\` 约束，写错 id 会编译失败。 */
export const domId = (id: DomId): string => \`#\${DOM_IDS[id]}\`
`

  const config = (await resolveConfig(OUT_PATH)) ?? {}
  return format(raw, { ...config, parser: 'typescript' })
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`

if (isMain) {
  const html = readFileSync(HTML_PATH, 'utf8')
  const source = await buildDomIdsSource(html)
  writeFileSync(OUT_PATH, source, 'utf8')
  console.log(`wrote ${OUT_PATH}`)
}
