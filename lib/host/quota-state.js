/**
 * 额度状态持久化：把「哪个 key 在哪个模型上被限到几点」落盘，跨 DSH 重启复用。
 *
 * 落盘内容只有 8 位哈希标签、模型名、恢复时刻与服务端原始报文，绝不含 key 原文。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveDshHome } from './defaults.js'

// 报错报文里的「Try again in 22h 47m」是一个绝对可用的恢复时刻。把它连同 key 的
// 哈希标签一起落盘，DSH 重启后就能立刻知道哪个 key 在哪个模型上被限到几点，
// 既不必再白撞一次 429，也能在全池耗尽时直接回放服务端原始报错。
const QUOTA_STATE_VERSION = 1
const QUOTA_STATE_MAX_KEYS = 200


/** 磁盘上的额度状态：{ entries: { <keyLabel>: { <model>: { readyAt, body } } } } —— 不含 key 原文。 */
export function createQuotaStore(path) {
  let records = new Map() // label → Map<model, { readyAt, body }>
  let diagnostics = {}
  let dirty = false
  let timer

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const now = Date.now()
    diagnostics = typeof parsed?.diagnostics === 'object' && parsed.diagnostics ? parsed.diagnostics : {}
    for (const [label, models] of Object.entries(parsed?.entries ?? {})) {
      const kept = new Map()
      for (const [model, record] of Object.entries(models ?? {})) {
        if (typeof record?.readyAt === 'number' && record.readyAt > now) {
          kept.set(model, { readyAt: record.readyAt, body: typeof record.body === 'string' ? record.body : '' })
        }
      }
      if (kept.size) records.set(label, kept)
    }
  } catch {
    // 首次运行、文件损坏或不可读：按空状态处理
  }

  const write = () => {
    try {
      const entries = {}
      for (const [label, models] of records) {
        entries[label] = {}
        for (const [model, record] of models) entries[label][model] = { readyAt: record.readyAt, body: record.body }
      }
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: QUOTA_STATE_VERSION, updatedAt: Date.now(), entries, diagnostics }))
      renameSync(tmp, path)
    } catch {
      // 落盘失败绝不影响请求
    }
  }

  const schedule = () => {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      if (dirty) {
        dirty = false
        write()
      }
    }, 500)
    timer.unref?.()
  }

  return {
    path,
    /** 记录诊断信息（池规模、凭据服务是否可达、各类决策计数），随状态文件一起落盘便于排查。 */
    setDiagnostics(next) {
      diagnostics = { ...diagnostics, ...next }
      schedule()
    },
    forLabel(label) {
      const now = Date.now()
      return [...(records.get(label) ?? new Map()).entries()].filter(([, record]) => record.readyAt > now)
    },
    get(label, model) {
      const record = records.get(label)?.get(model)
      return record && record.readyAt > Date.now() ? record : undefined
    },
    set(label, model, readyAt, body) {
      if (!records.has(label)) records.set(label, new Map())
      records.get(label).set(model, { readyAt, body: body ?? '' })
      if (records.size > QUOTA_STATE_MAX_KEYS) {
        const trimmed = [...records.entries()].sort((a, b) => {
          const latest = (entry) => Math.max(...[...entry[1].values()].map((r) => r.readyAt), 0)
          return latest(b) - latest(a)
        })
        records = new Map(trimmed.slice(0, QUOTA_STATE_MAX_KEYS))
      }
      schedule()
    },
    clear(label, model) {
      const models = records.get(label)
      if (!models?.delete(model)) return
      if (!models.size) records.delete(label)
      schedule()
    },
    flush() {
      if (!timer && !dirty) return
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      dirty = false
      write()
    },
  }
}


/** 从报文中解析 "Try again in 22h 47m" 这类重试窗口；解析不出则返回 0。 */
export function parseRetryWindowMs(text) {
  if (!text) return 0
  const scoped = /try again in\s*([^."\n]+)/i.exec(text)
  const segment = scoped ? scoped[1] : text
  const re = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi
  let ms = 0
  let hit
  while ((hit = re.exec(segment))) {
    const n = Number(hit[1])
    const unit = hit[2].toLowerCase()[0]
    ms += unit === 'h' ? n * 3600_000 : unit === 'm' ? n * 60_000 : n * 1000
  }
  return ms
}
