/**
 * 静态校验 index.html 与 src/shared/domIds.ts 的 DOM id 一致性。
 *
 * 检查项：
 * 1. index.html 中 id 唯一（重复 id 会让 querySelector 命中第一个）；
 * 2. `src/shared/domIds.ts` 与 index.html 同步（由 `npm run gen:dom` 生成）；
 * 3. 代码里 `domId('x')` / `requireElement('#x')` 引用的 id 存在；
 * 4. `aria-controls` / `for` / `aria-labelledby` 指向的 id 存在。
 *
 * 只做静态扫描，不依赖浏览器；有问题时退出码为 1。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { buildDomIdsSource } from './generate-dom-ids.mjs'

const ROOT = process.cwd()
const problems = []

const html = await readFile(join(ROOT, 'index.html'), 'utf8')

/* ------------------------------------------------------------------ id 收集 */

const idPattern = /\sid="([^"]+)"/g
const ids = new Set()
const duplicated = new Set()
const orderedIds = []
for (const match of html.matchAll(idPattern)) {
  const id = match[1]
  if (ids.has(id)) duplicated.add(id)
  if (!ids.has(id)) orderedIds.push(id)
  ids.add(id)
}
for (const id of duplicated) {
  problems.push(`index.html: id 重复 → #${id}（querySelector 会静默命中第一个）`)
}

/* --------------------------------------------------- 生成文件与 HTML 是否同步 */

const generated = await readFile(join(ROOT, 'src/shared/domIds.ts'), 'utf8').catch(() => null)
if (generated === null) {
  problems.push('缺少 src/shared/domIds.ts：运行 `npm run gen:dom`')
} else if (generated !== (await buildDomIdsSource(html))) {
  problems.push('src/shared/domIds.ts 与 index.html 不同步：运行 `npm run gen:dom`')
}

/* ------------------------------------------------------- 代码引用的 id 存在性 */

const sourceFiles = await collectSources(join(ROOT, 'src'))
const domIdPattern = /\bdomId\(\s*'([^']+)'/g
const selectorPattern =
  /(?:\$|requireElement|pickElement)\s*(?:<[^>]*>)?\s*\(\s*'#([A-Za-z0-9_-]+)/g

for (const file of sourceFiles) {
  const text = await readFile(file, 'utf8')
  for (const pattern of [domIdPattern, selectorPattern]) {
    for (const match of text.matchAll(pattern)) {
      const id = match[1]
      if (!ids.has(id)) {
        const line = text.slice(0, match.index).split('\n').length
        problems.push(`${relative(ROOT, file)}:${line}: 引用了 index.html 中不存在的 id → #${id}`)
      }
    }
  }
}

/* ------------------------------------------------ aria 关系与 label 指向的 id */

const ariaPattern = /\s(aria-controls|aria-labelledby|for)="([^"]+)"/g
for (const match of html.matchAll(ariaPattern)) {
  const attr = match[1]
  const value = match[2]
  for (const id of value.split(/\s+/).filter(Boolean)) {
    if (!ids.has(id)) {
      const line = html.slice(0, match.index).split('\n').length
      problems.push(`index.html:${line}: ${attr}="${id}" 指向不存在的 id`)
    }
  }
}

/* ---------------------------------------------------------------------- 输出 */

if (problems.length > 0) {
  console.error(`[conventions] 发现 ${problems.length} 处问题：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exitCode = 1
} else {
  console.log(
    `[conventions] 通过：${orderedIds.length} 个 id、${sourceFiles.length} 个源文件，生成清单同步、无悬空引用`
  )
}

/** 递归收集 src 下的 .ts 文件（跳过 .d.ts 与生成的 domIds.ts）。 */
async function collectSources(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await collectSources(path)))
    else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      entry.name !== 'domIds.ts'
    ) {
      files.push(path)
    }
  }
  return files
}
