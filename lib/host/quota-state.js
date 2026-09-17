/**
 * 状态落盘：额度（哪个 key 在哪个模型上被限到几点）+ 用量统计（计数、token、最近使用）。
 *
 * 两者落在同一个文件里，因为它们回答的是同一类问题「这把 key 现在什么状态」，
 * 而且共用同一个去抖写入器；拆成两个文件只会多一份原子写与两次读盘。
 *
 * 落盘内容只有 8 位哈希标签、模型名、恢复时刻、服务端原始报文与计数，
 * 绝不含 key 原文（掩码也不写：掩码只在内存里现算，发给本机面板时才出现）。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；用量统计后来加进来（v2，向后兼容）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveDshHome } from './defaults.js'

// 报错报文里的「Try again in 22h 47m」是一个绝对可用的恢复时刻。把它连同 key 的
// 哈希标签一起落盘，DSH 重启后就能立刻知道哪个 key 在哪个模型上被限到几点，
// 既不必再白撞一次 429，也能在全池耗尽时直接回放服务端原始报错。
//
// v2 追加 usage / totals 两段：v1 文件照读（缺这两段就是「还没有统计」），
// 旧版插件读 v2 文件也只是忽略多出来的字段。
const STATE_VERSION = 2
const STATE_MAX_KEYS = 200
const TOKEN_FIELDS = ['input', 'output', 'total', 'cached']

/** 非负整数，其余一律归零：磁盘上的数字只信自己写过的形状。 */
function count(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function tokens(raw) {
  const out = {}
  for (const field of TOKEN_FIELDS) out[field] = count(raw?.[field])
  return out
}

/** 一把 key 的统计行：形状固定，未知字段一律丢弃。 */
function sanitizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const models = {}
  for (const [model, row] of Object.entries(raw.models ?? {})) {
    if (!model || !row || typeof row !== 'object') continue
    models[model] = {
      sent: count(row.sent),
      ok: count(row.ok),
      limited: count(row.limited),
      lastUsedAt: count(row.lastUsedAt),
      tokens: tokens(row.tokens),
    }
  }
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {}
  return {
    firstSeenAt: count(raw.firstSeenAt),
    lastUsedAt: count(raw.lastUsedAt),
    stats: {
      sent: count(stats.sent),
      ok: count(stats.ok),
      limited: count(stats.limited),
      lastModel: typeof stats.lastModel === 'string' ? stats.lastModel : '',
      lastUsedAt: count(stats.lastUsedAt),
      tokens: tokens(stats.tokens),
    },
    models,
  }
}

/** 磁盘上的状态：{ entries, usage, totals, diagnostics } —— 不含 key 原文，也不含掩码。 */
export function createQuotaStore(path) {
  let records = new Map() // label → Map<model, { readyAt, body }>
  let usage = new Map() // label → 统计行（见 sanitizeUsage）
  let totals = { since: 0, clineRequests: 0, rotations: 0, failFasts: 0 }
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
    for (const [label, row] of Object.entries(parsed?.usage ?? {})) {
      const clean = sanitizeUsage(row)
      if (clean) usage.set(label, clean)
    }
    for (const field of ['since', 'clineRequests', 'rotations', 'failFasts']) {
      totals[field] = count(parsed?.totals?.[field])
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
      const tmp = path + '.tmp'
      writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, updatedAt: Date.now(), entries, usage: Object.fromEntries(usage), totals, diagnostics }))
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

  /** 统计行按最近使用裁剪：只留最近用过的若干把，避免长期运行后文件无限长。 */
  const trimUsage = () => {
    if (usage.size <= STATE_MAX_KEYS) return
    const kept = [...usage.entries()].sort((a, b) => (b[1].lastUsedAt || 0) - (a[1].lastUsedAt || 0))
    usage = new Map(kept.slice(0, STATE_MAX_KEYS))
  }

  return {
    path,
    /** 记录诊断信息（池规模、凭据服务是否可达、各类决策计数），随状态文件一起落盘便于排查。 */
    setDiagnostics(next) {
      diagnostics = { ...diagnostics, ...next }
      schedule()
    },
    /** 上次运行留下的诊断快照（用来自恢复「最近决策」这类跨重启仍有意义的东西）。 */
    diagnostics() {
      return diagnostics
    },
    /** 某把 key（8 位哈希标签）的累计统计，磁盘上没有就返回 undefined。 */
    usageFor(label) {
      return usage.get(label)
    },
    /** 覆盖写入一把 key 的统计行（调用方给的是纯 JSON 快照）。 */
    setUsage(label, snapshot) {
      if (!label) return
      const clean = sanitizeUsage(snapshot)
      if (!clean) return
      usage.set(label, clean)
      trimUsage()
      schedule()
    },
    /** 全局累计计数（跨重启保留）。 */
    totals() {
      return { ...totals }
    },
    /** 覆盖写入全局计数：只认这四个字段，未给的保持原值。 */
    setTotals(next) {
      for (const field of ['since', 'clineRequests', 'rotations', 'failFasts']) {
        if (next?.[field] !== undefined) totals[field] = count(next[field])
      }
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
      if (records.size > STATE_MAX_KEYS) {
        const trimmed = [...records.entries()].sort((a, b) => {
          const latest = (entry) => Math.max(...[...entry[1].values()].map((r) => r.readyAt), 0)
          return latest(b) - latest(a)
        })
        records = new Map(trimmed.slice(0, STATE_MAX_KEYS))
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
