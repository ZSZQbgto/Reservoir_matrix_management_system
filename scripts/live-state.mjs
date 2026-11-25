import fs from 'node:fs'
import path from 'node:path'

const EMPTY_SCENE = {
  mode: 'scene',
  enabled: false,
  paused: false,
  sources: [],
  selectedSourceId: null,
  modelCount: 0,
  maxDepth: 0,
  wetCells: 0,
  building: false,
  progress: 0,
  updatedAt: 0
}

/**
 * 跨端口共享的轻量状态：两个 Vite dev server 与生产 server 都读同一个 JSON 文件。
 * 只用于业务矩阵与场景摘要联动，不是数据库。
 */
export function createLiveStateStore(root) {
  const dir = path.join(root, '.cache')
  const file = path.join(dir, 'live-state.json')

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const matrix =
        parsed.matrix && Array.isArray(parsed.matrix.rows)
          ? parsed.matrix
          : { rows: [], selectedId: null }
      const scene = parsed.scene && typeof parsed.scene === 'object' ? parsed.scene : EMPTY_SCENE
      return {
        revision: Number.isFinite(parsed.revision) ? parsed.revision : 0,
        updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        matrix,
        scene
      }
    } catch {
      return {
        revision: 0,
        updatedAt: 0,
        matrix: { rows: [], selectedId: null },
        scene: { ...EMPTY_SCENE }
      }
    }
  }

  function merge(patch) {
    const current = read()
    const next = {
      revision: current.revision + 1,
      updatedAt: Date.now(),
      matrix:
        patch && patch.matrix && Array.isArray(patch.matrix.rows)
          ? {
              rows: patch.matrix.rows,
              selectedId:
                typeof patch.matrix.selectedId === 'string' ? patch.matrix.selectedId : null
            }
          : current.matrix,
      scene:
        patch && patch.scene && typeof patch.scene === 'object'
          ? { ...current.scene, ...patch.scene, updatedAt: Date.now() }
          : current.scene
    }
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next), 'utf8')
    fs.renameSync(tmp, file)
    return next
  }

  return { read, merge, file }
}

export function readJsonBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload_too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

export function sendLiveJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}
