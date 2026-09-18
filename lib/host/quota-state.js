/**
 * 状态落盘：额度（哪个 key 在哪个模型上被限到几点）+ 用量统计（计数、token、最近使用）
 * + 面板选定的「使用中」Key（首发送优先用它）。
 *
 * 三者落在同一个文件里，因为它们回答的是同一类问题「这把 key 现在什么状态」，
 * 而且共用同一个去抖写入器；拆开只会多一份原子写与两次读盘。
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
// v2.1 在每行统计里追加 failed（上游明确拒绝的次数）：旧文件缺该字段时按 0 读，
// 所以升级不会让「成功」列失真，降级也只会忽略多出来的字段。
const STATE_VERSION = 2
const STATE_MAX_KEYS = 200
const TOKEN_FIELDS = ['input', 'output', 'total', 'cached']
/** 面板选定「使用中」Key 的标签形状：与 keyLabel 的输出一致（8 位小写十六进制）。
 *  形状之外的一律丢弃/拒绝——磁盘上的字段只信自己写过的形状。 */
const SELECTION_LABEL_RE = /^[0-9a-f]{8}$/

// diagnostics 是排查入口，不是垃圾桶：它曾经没有上限，且被 v1 遗留字段长期占位
// （credentialsFound / credentialsVia / credentialsProbeError / injectApi / injectCallback /
// injectError —— 代码里早已没有任何写入者，但因为 setDiagnostics 用 { ...旧, ...新 } 合并，
// 它们会永远留在文件里）。这里用白名单 + 长度上限把它钉死。
const DIAG_STRING_FIELDS = ['pluginVersion', 'lastDecision', 'lastExtrasAt']
const DIAG_BOOLEAN_FIELDS = ['credentialsFileRead', 'extrasResolved']
const DIAG_NUMBER_FIELDS = ['poolSize', 'clineRequests', 'rotations', 'failFasts', 'statsSince']
/** 最近决策轨迹最多留几条（面板只显示最近几条，留多了纯属占地方）。 */
const DIAG_MAX_TRACES = 3
/** 单条轨迹里字符串字段的长度上限（url / model / decision 都可能很长）。 */
const DIAG_TRACE_MAX_LEN = 200

/** 只保留白名单字段，并给每条轨迹做长度与条数截断。未知字段一律丢弃。 */
function sanitizeDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const field of DIAG_STRING_FIELDS) {
    if (raw[field] === undefined) continue
    out[field] = typeof raw[field] === 'string' ? raw[field].slice(0, DIAG_TRACE_MAX_LEN) : String(raw[field]).slice(0, DIAG_TRACE_MAX_LEN)
  }
  for (const field of DIAG_BOOLEAN_FIELDS) {
    if (raw[field] !== undefined) out[field] = Boolean(raw[field])
  }
  for (const field of DIAG_NUMBER_FIELDS) {
    if (raw[field] !== undefined) out[field] = count(raw[field])
  }
  if (Array.isArray(raw.lastRequests)) {
    out.lastRequests = raw.lastRequests.slice(-DIAG_MAX_TRACES).map((row) => {
      const trace = {}
      for (const [key, value] of Object.entries(row ?? {})) {
        if (typeof value === 'string') trace[key] = value.slice(0, DIAG_TRACE_MAX_LEN)
        else if (typeof value === 'number' && Number.isFinite(value)) trace[key] = value
        else if (typeof value === 'boolean') trace[key] = value
      }
      return trace
    })
  }
  return out
}

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
      // failed 是 v2.1 追加的：旧文件里没有这个字段，count() 会把它读成 0，
      // 于是升级后「成功」列不会因为缺字段而失真。
      failed: count(row.failed),
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
      failed: count(stats.failed),
      limited: count(stats.limited),
      lastModel: typeof stats.lastModel === 'string' ? stats.lastModel : '',
      lastUsedAt: count(stats.lastUsedAt),
      tokens: tokens(stats.tokens),
    },
    models,
  }
}

/**
 * 磁盘上的状态：{ entries, usage, selection, totals, diagnostics } —— 不含 key 原文，也不含掩码。
 *
 * @param path - 状态文件路径。
 * @param options.onError - 可选。读盘 / 落盘失败时的上报通道（kind: 'load' | 'write'）。
 *   这里刻意**不**直接依赖日志实现：store 只负责把「出错了」这件事交出去，
 *   由调用方决定怎么记，这样它仍然能脱离 DSH 单测。传了 onError 就意味着
 *   失败不再静默——这正是「冷却与统计悄悄不再落盘、却没有任何迹象」的修复点。
 */
export function createQuotaStore(path, options) {
  const onError = typeof options?.onError === 'function' ? options.onError : undefined
  let records = new Map() // label → Map<model, { readyAt, body }>
  let usage = new Map() // label → 统计行（见 sanitizeUsage）
  let totals = { since: 0, clineRequests: 0, rotations: 0, failFasts: 0 }
  // 面板选定的「使用中」Key（首发送优先用它）：只存 8 位哈希标签与选定时刻，无选定为 undefined
  let selection
  let diagnostics = {}
  let dirty = false
  let timer
  // 落盘失败只报一次：写盘是 500ms 去抖的，磁盘满/只读时会每 500ms 失败一次，
  // 每次都记会刷爆日志。恢复成功后再失败，会重新报一次。
  let writeFailureReported = false

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const now = Date.now()
    // 过白名单：既拦掉未知字段，也顺手清掉 v1 遗留的那几个（它们没有写入者，只会一直占地方）
    diagnostics = sanitizeDiagnostics(parsed?.diagnostics)
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
    // 面板选定的「使用中」Key：标签形状必须是 keyLabel 的输出，其余一律丢弃
    if (SELECTION_LABEL_RE.test(String(parsed?.selection?.label ?? ''))) {
      selection = { label: parsed.selection.label, at: count(parsed.selection.at) }
    }
  } catch (error) {
    // 首次运行、文件损坏或不可读：按空状态处理（插件照常工作）。
    // 但「文件明明在、却读不动」和「文件不存在」是两回事：前者意味着
    // 冷却与统计已经悄悄丢了，必须留下痕迹，否则用户只会看到面板上的数字凭空清零。
    if (error?.code !== 'ENOENT') onError?.('load', error)
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
      writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, updatedAt: Date.now(), entries, usage: Object.fromEntries(usage), selection, totals, diagnostics }))
      renameSync(tmp, path)
      // 写成功了：把「已报过失败」复位，下次再坏时会重新报一次
      writeFailureReported = false
    } catch (error) {
      // 落盘失败仍然绝不影响请求（冷却与统计都只是优化，不是主链路），
      // 但**不再完全静默**：否则磁盘满 / 权限错 / 路径不可写时，
      // 用户只会观察到「重启后冷却和统计全丢了」，却找不到任何原因。
      if (!writeFailureReported) {
        writeFailureReported = true
        onError?.('write', error)
      }
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
      // 合并后整体过白名单：未知字段不会落盘，长字符串与轨迹条数也会被截断。
      diagnostics = sanitizeDiagnostics({ ...diagnostics, ...next })
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
    /** 面板选定的「使用中」Key（首发送优先用它）；没有选定返回 undefined。 */
    selection() {
      return selection ? { ...selection } : undefined
    },
    /** 覆盖写入选定：空值＝取消（幂等）；标签形状不对时返回 false 且不改动任何状态。 */
    setSelection(label) {
      const value = typeof label === 'string' ? label.trim() : ''
      if (!value) {
        selection = undefined
        schedule()
        return true
      }
      if (!SELECTION_LABEL_RE.test(value)) return false
      selection = { label: value, at: Date.now() }
      schedule()
      return true
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

/** `Retry-After` 头解析：标准允许两种形态（纯秒数 / HTTP-date），两种都认。
 *  解析不出（空、乱写、已过期）一律回 0——这里绝不猜。 */
export function parseRetryAfterMs(raw) {
  const value = String(raw ?? '').trim()
  if (!value) return 0
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const at = Date.parse(value)
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
}

/**
 * 冷却窗口从哪里来：报错报文文本（最准）→ `Retry-After` 头 → 0。
 *
 * 报文首选：形如「Try again in 22h 47m」的窗口是服务端按这把 key 的额度算出来的，语义最完整。
 * `Retry-After` 是标准头，覆盖「报文里没有可解析窗口、但头给了秒数或 HTTP-date」的上游：
 * 少了这一档，`retry-after: 3` 这类瞬时限流会因为「两处都没有窗口」而被当成无可奉告。
 *
 * 返回 0 表示**服务端没给恢复时刻**：限流是「这把 key 在这个模型上」的事实，但什么时候
 * 恢复只有服务端知道，插件不自己编一个（调用方要不要用 clineCooldownMs 兜底由用户显式配置）。
 */
export function cooldownMsFromResponse(response, text) {
  const fromText = parseRetryWindowMs(text)
  if (fromText > 0) return fromText
  return parseRetryAfterMs(response?.headers?.get?.('retry-after'))
}
