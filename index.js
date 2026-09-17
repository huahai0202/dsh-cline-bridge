export const name = 'opencode-free-bridge'

const PLUGIN_VERSION = '1.8.2'

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LOWER_HEX = '0123456789abcdef'

// 严格对齐官方源码 packages/opencode/src/session/llm/request.ts 的 `USER_AGENT`：
//   const USER_AGENT = `opencode/${InstallationVersion}`
// 官方只发 `opencode/<版本号>`，并无 ai-sdk/runtime 之类的后缀（那些是 SDK 或网关侧另行附加的）。
// 实测 Zen 仅校验 UA 中存在 `opencode/` 前缀，故裸写版本号既忠于官方又稳定。
const OPENCODE_UA = 'opencode/1.18.31'

// 官方对 opencode* 提供方只发这 5 个头（详见 request.ts 的 headers 构造）：
//   x-opencode-project   ← InstanceState.context.project.id，缺省时整头省略
//   x-opencode-session   ← input.sessionID
//   x-opencode-request   ← input.user.id
//   x-opencode-client    ← input.flags.client（默认 'cli'）
//   User-Agent           ← USER_AGENT
// 注意 x-session-affinity / X-Session-Id 只出现在「非 opencode 提供方」分支，
// 发往 Zen 时不应携带，故本插件会主动剥离（DSH 底层 pi-ai 恰好会下发这两个头）。

// opencode 官方合法会话 ID 形状：ses_ + 12 位小写十六进制 + 14 位 base62（总长 30）
const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function randomChars(alphabet, length) {
  const out = []
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(length)
    c.getRandomValues(bytes)
    for (let i = 0; i < length; i++) out.push(alphabet[bytes[i] % alphabet.length])
  } else {
    for (let i = 0; i < length; i++) out.push(alphabet[Math.floor(Math.random() * alphabet.length)])
  }
  return out.join('')
}

// FNV-1a：把 DSH 的会话标识映射为稳定种子，保证同一会话每轮派生出同一个 ID
function seedOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function seededChars(seed, alphabet, length) {
  let s = (seed || 0x9e3779b9) >>> 0
  const out = []
  for (let i = 0; i < length; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    out.push(alphabet[s % alphabet.length])
  }
  return out.join('')
}

// 复刻 opencode 官方 ID 规范，两代实现同形：
//   v1 packages/opencode/src/id/id.ts      → prefix + "_" + 12 位小写十六进制(时间戳) + 14 位 base62
//   v2 packages/schema/src/identifier.ts   → 同上（descending 仅对时间戳取反，仍是 12 位小写 hex）
// Zen 免费通道严格校验该形状：任意字符串、req_/msg_ 前缀、首位大写十六进制、64 位 hex
// 均返回 403 FreeTierError（后者见于 core runner 的 promptCacheKey 分支）。
// 时间戳本身不参与校验（可用派生值代替），故同一会话可稳定复用同一 ID 以获得路由固定与提示缓存。
function opencodeId(prefix, seedText) {
  if (seedText) {
    const seed = seedOf(seedText)
    return `${prefix}_${seededChars(seed, LOWER_HEX, 12)}${seededChars(seed ^ 0x5bf03635, BASE62, 14)}`
  }
  return `${prefix}_${randomChars(LOWER_HEX, 12)}${randomChars(BASE62, 14)}`
}

function canonicalSession(hint, fallback) {
  const value = hint && String(hint).trim()
  if (!value) return fallback()
  if (CANONICAL_SESSION.test(value)) return value
  // DSH 原生渠道（pi-ai）下发的 x-session-affinity / x-session-id 不是 opencode 形状，
  // 直接透传会被免费通道拒绝，此处改为「同一来源稳定映射」到合法 ID。
  return opencodeId('ses', value)
}

// ───────────────────────── Cline 多 Key 轮换 ─────────────────────────
// Cline 免费额度是「按 key + 按模型」的每日上限，撞限流时服务端返回：
//   429 {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached
//        on model deepseek/deepseek-v4.1-flash. Try again in 22h 47m"}
// 重试窗口以小时计，退避等待毫无意义，只能换 key。本插件位于 openai SDK 之下、
// pi-ai 的 retryProviderRequest 之上，是唯一能「换 key 重发」的层次：只要换 key 后拿到
// 成功响应就直接返回，pi-ai 根本看不到那次 429。
const DEFAULT_CLINE_MATCH = 'cline.bot'
const DEFAULT_CLINE_COOLDOWN_MS = 15 * 60 * 1000
const DEFAULT_FAIL_FAST_MIN_MS = 5 * 60 * 1000
const MAX_ROTATE_ATTEMPTS = 6
// 默认从凭据仓库 / 启动环境探测的额外 key 名（主 key 由 DSH 的 CLINE_API_KEY 提供）
const DEFAULT_CLINE_KEY_REFS = Array.from({ length: 9 }, (_, i) => `CLINE_API_KEY_${i + 2}`)
// 额外 key 的解析节流：服务未就绪时 2 秒后重试；就绪后每 5 分钟复扫一次以发现新增 ref
const EXTRAS_RETRY_MS = 2000
const EXTRAS_TTL_MS = 5 * 60 * 1000
const CLINE_ROTATE_STATUSES = [429]

/** 429 是否属于「额度已耗尽」这类终局错误：这类错误退避重试毫无意义。 */
const TERMINAL_CAP_RE = /INFERENCE_CAP_ERROR|daily\s+free\s+limit|free\s+limit\s+reached|usage\s+limit|quota\s+exceeded|insufficient/i
const TERMINAL_WINDOW_MS = 10 * 60 * 1000

/** 只用于日志的短标签，绝不记录 key 原文。 */
function keyLabel(key) {
  return seedOf(key).toString(16).padStart(8, '0')
}

// ── 掩码预览 ─────────────────────────────────────────────────────────
// 设置面板里为了让人认出「这是哪把 key」，会显示首尾各几位（形如 abcd…wxyz）。
// 这条通道有严格的边界，改动时务必保持：
//   · 只在内存里现算，只在同一个 HTTP 响应里回给本机设置面板；
//   · 绝不进日志，绝不进 <DSH_HOME>/.opencode-free-bridge-cline-quota.json
//     （落盘仍然只写 8 位哈希标签，见 quotaStore）；
//   · 可用 maskKeyPreview: false 整体关闭，关闭后连首尾几位也不下发。
// 注意：首尾各 4 位仍属于部分密钥材料，因此它只经由同源校验的只读路由暴露。
const MASK_HEAD = 4
const MASK_TAIL = 4

/** 形如 `sk-a…9f2c`；太短的 key 不猜结构，直接少露。 */
function maskKey(key) {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value) return ''
  if (value.length <= MASK_HEAD + MASK_TAIL) {
    // 短到首尾会重叠时只露尾巴，避免拼出完整 key
    return value.length <= 4 ? '…' : `…${value.slice(-4)}`
  }
  return `${value.slice(0, MASK_HEAD)}…${value.slice(-MASK_TAIL)}`
}

// ── 额度状态持久化 ───────────────────────────────────────────────────
// 报错报文里的「Try again in 22h 47m」是一个绝对可用的恢复时刻。把它连同 key 的
// 哈希标签一起落盘，DSH 重启后就能立刻知道哪个 key 在哪个模型上被限到几点，
// 既不必再白撞一次 429，也能在全池耗尽时直接回放服务端原始报错。
const QUOTA_STATE_VERSION = 1
const QUOTA_STATE_MAX_KEYS = 200

function resolveQuotaStatePath(config) {
  if (typeof config?.quotaStatePath === 'string' && config.quotaStatePath) return config.quotaStatePath
  return join(resolveDshHome(config), '.opencode-free-bridge-cline-quota.json')
}

function resolveDshHome(config) {
  if (typeof config?.dshHome === 'string' && config.dshHome) return config.dshHome
  return globalThis.process?.env?.DSH_HOME || join(homedir(), '.dsh')
}

function resolveCredentialsFilePath(config) {
  if (typeof config?.credentialsFile === 'string' && config.credentialsFile) return config.credentialsFile
  return join(resolveDshHome(config), '.credentials.yaml')
}

/** 磁盘上的额度状态：{ entries: { <keyLabel>: { <model>: { readyAt, body } } } } —— 不含 key 原文。 */
function createQuotaStore(path) {
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
function parseRetryWindowMs(text) {
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

/** 请求体是否可原样重发（轮换的前提）。 */
function replayableBody(body) {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  )
}

function readModelOf(body) {
  if (typeof body !== 'string') return '*'
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === 'string' ? parsed.model : '*'
  } catch {
    return '*'
  }
}

/** 鉴权头形态：openai 兼容渠道用 Authorization: Bearer，部分网关用 x-api-key。 */
function readAuthTarget(headers) {
  const auth = headers.get('authorization')
  if (auth) {
    const m = /^(\S+)\s+(.+)$/.exec(auth.trim())
    return { header: 'authorization', scheme: m ? m[1] : 'Bearer' }
  }
  if (headers.get('x-api-key')) return { header: 'x-api-key', scheme: '' }
  return { header: 'authorization', scheme: 'Bearer' }
}

function readKeyOf(headers, target) {
  if (target.header === 'x-api-key') return (headers.get('x-api-key') || '').trim()
  const auth = (headers.get('authorization') || '').trim()
  const m = /^\S+\s+(.+)$/.exec(auth)
  return (m ? m[1] : auth).trim()
}

function writeKeyTo(headers, key, target) {
  if (target.header === 'x-api-key') headers.set('x-api-key', key)
  else headers.set('authorization', `${target.scheme || 'Bearer'} ${key}`)
}

// 关于「为什么不用 DSH 凭据服务」（已实测确认，勿再尝试）：
//   Cordis 只在插件**声明依赖**时才把服务名映射进它的 isolate；未声明时
//   `ctx.get('credentials')` 会静默返回 undefined（不抛错），插件永远拿不到服务实例。
//   而插件 ctx 上并不存在 `ctx.inject(deps, cb)` 这个 API（实测 typeof 为 undefined）。
//   唯一的替代是 `export const inject = ['credentials']`，但那会让**整个插件**被该服务门控——
//   服务一旦缺席，连 Zen 头注入一起失效。收益（少读一个文件）远小于风险，故舍弃。
//   额外 key 由三条来源提供：插件 config、启动环境变量、.credentials.yaml 直读。

/** 兜底路径：直接解析 .credentials.yaml 的 refs 段（凭据服务尚未就绪或不可用时）。
 *  只取显式需要的 ref，文件的其余内容一概不碰。 */
function readCredentialRefsFromFile(path, wantedRefs) {
  const wanted = new Set(wantedRefs)
  const out = new Map()
  let inRefs = false
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(rawLine)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(rawLine)) break // 回到顶层：refs 段结束
    const matched = /^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(rawLine)
    if (!matched || !wanted.has(matched[1])) continue
    let value = matched[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) out.set(matched[1], value)
  }
  return out
}

/** key 池：按模型维度记录冷却时间，选 key 时**粘性优先**——先把一把用到限流再换下一把。
 *  冷却状态会经由 quotaStore 落到磁盘，DSH 重启后仍知道「哪个 key 在哪个模型上被限到几点」。
 *  每把 key 另带来源标签与本次运行的用量计数，供设置面板展示（这些只留在内存里）。 */
function createKeyPool(quotaStore, diag, log) {
  const entries = new Map() // label → { key, label, source, isRequestKey, cooling: Map<model, readyAt>, lastBody: Map<model, text>, lastUsedAt, stats }
  // 额外 key 未就绪时必须可重试：凭据服务可能在插件挂载之后才注册
  let extrasResolved = false
  let lastExtrasAttempt = 0

  /** 累加某把 key 在某个模型上的计数。
   *  用量必须按模型分开记：冷却本来就是「key + 模型」维度，把两个模型的数字混在
   *  一行里会让人误判（例如 deepseek 上被限、glm 上其实还在正常跑）。
   *  byModel 用 null 原型，避免模型名撞上 __proto__ 之类的键。 */
  const bumpModelStat = (entry, model, field) => {
    if (!model) return
    let row = entry.stats.byModel[model]
    if (!row) {
      row = { sent: 0, ok: 0, limited: 0, lastUsedAt: 0 }
      entry.stats.byModel[model] = row
    }
    row[field] += 1
    row.lastUsedAt = Date.now()
  }

  /** 来源标签只在首次登记时确定，之后的重复登记不覆盖（保证「它是从哪来的」稳定）。 */
  const register = (key, source) => {
    const value = typeof key === 'string' ? key.trim() : ''
    if (!value || /^(Bearer|undefined|null)$/i.test(value)) return undefined
    const label = keyLabel(value)
    let entry = entries.get(label)
    if (!entry) {
      entry = {
        key: value,
        label,
        source: typeof source === 'string' && source ? source : 'unknown',
        isRequestKey: false,
        cooling: new Map(),
        lastBody: new Map(),
        lastUsedAt: 0,
        stats: { sent: 0, ok: 0, limited: 0, lastModel: '', byModel: Object.create(null) },
      }
      entries.set(label, entry)
      // 恢复该 key 上次进程留下的额度状态（按 label 匹配，磁盘上没有 key 原文）
      for (const [model, record] of quotaStore?.forLabel?.(label) ?? []) {
        entry.cooling.set(model, record.readyAt)
        if (record.body) entry.lastBody.set(model, record.body)
      }
    }
    if (source === 'request') entry.isRequestKey = true
    return entry
  }

  return {
    get size() {
      return entries.size
    },
    register,
    /** 汇总额外 key：插件 config → 启动环境变量 → .credentials.yaml 直读。
     *  首次未读到不会永久上锁：按节流反复重试（文件可能稍后才出现），成功后按 TTL 定期复扫，
     *  运行期新增的 ref 也能被发现。 */
    async ensureExtras(ctx, config, options) {
      const now = Date.now()
      const throttle = options?.force ? 0 : extrasResolved ? EXTRAS_TTL_MS : EXTRAS_RETRY_MS
      if (now - lastExtrasAttempt < throttle) return
      lastExtrasAttempt = now

      // 列表里带上标号：多把 key 同在一处时，面板上靠它能对上你配置里的第几项
      const configKeys = config?.clineKeys ?? []
      for (let i = 0; i < configKeys.length; i++) register(configKeys[i], `config: clineKeys[${i + 1}]`)

      const env = globalThis.process?.env ?? {}
      for (const [name, chunk] of [['CLINE_API_KEYS', env.CLINE_API_KEYS], ['CLINE_FREE_API_KEYS', env.CLINE_FREE_API_KEYS]]) {
        if (!chunk) continue
        for (const key of String(chunk).split(/[\s,;]+/)) register(key, `env: ${name}`)
      }
      for (const ref of DEFAULT_CLINE_KEY_REFS) register(env[ref], `env: ${ref}`)

      const refs = config?.clineKeyRefs ?? DEFAULT_CLINE_KEY_REFS

      // 主来源：直读 .credentials.yaml 的 refs 段（只取需要的 ref）。
      // 注意这里**不能**加 `!extrasResolved` 门控：那样一旦首次读到 key 就再也不读文件，
      // 运行期新加的 ref（用户刚往凭据文件里补一把 key）必须重启 DSH 才生效，
      // 而 README 承诺的是「成功读到后每 5 分钟复扫」。省流是由上面的 throttle 保证的：
      // 已解析时 ensureExtras 本身每 5 分钟才走到这里一次，所以读盘频率仍是每 5 分钟一次。
      if (config?.readCredentialsFile !== false) {
        const path = resolveCredentialsFilePath(config)
        try {
          const fromFile = readCredentialRefsFromFile(path, refs)
          for (const [ref, value] of fromFile) register(value, `.credentials.yaml: ${ref}`)
          diag.credentialsFileRead = true
          // 读到过 key 就按「已解析」走 5 分钟节流；没读到则保持 2 秒重试（文件可能稍后才出现）
          if (fromFile.size > 0) extrasResolved = true
        } catch {
          diag.credentialsFileRead = false
        }
      }

      diag.extrasResolved = extrasResolved
      diag.poolSize = entries.size
      diag.lastExtrasAt = new Date(now).toISOString()
      quotaStore?.setDiagnostics?.(diag)
      log?.(`Cline key 池：${entries.size} 个 key（来源：config、启动环境变量、.credentials.yaml）`)
    },
    /** 挑一把备用 key：**粘性**优先，即「先把一把用到限流，再换下一把」。
     *
     *  取的是「最近还在用的那把」（MRU），而不是轮换摊派（LRU）。原因是 Cline 的免费
     *  额度按 `key + 模型` 每天重置：摊开用会让池子里所有 key 几乎同时逼近上限、
     *  一起失去后备；压着一把烧完再换，池子里才始终留着没动过的额度。
     *  冷却是硬条件——当前模型上已冷却的 key 一律跳过，所以「用到限流」时自然会换人。
     *
     *  lastUsedAt 的取值为 0 表示这把 key 本次运行还没碰过；MRU 会优先选已经用过
     *  （即已经烧掉一部分额度）的那把，而不是去开一把全新的，正是这个语义要的效果。 */
    pick(model) {
      const now = Date.now()
      let best
      for (const entry of entries.values()) {
        const until = entry.cooling.get(model)
        if (until !== undefined && until > now) continue
        if (!best || entry.lastUsedAt > best.lastUsedAt) best = entry
      }
      return best
    },
    isCooling(key, model) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return false
      const until = entry.cooling.get(model)
      return until !== undefined && until > Date.now()
    },
    /** 该模型上是否所有已知 key 都还在冷却。 */
    allCooling(model) {
      const now = Date.now()
      let seen = 0
      for (const entry of entries.values()) {
        seen++
        const until = entry.cooling.get(model)
        if (until === undefined || until <= now) return false
      }
      return seen > 0
    },
    /** 冷却中恢复最早的那个 key（含缓存报文，用于快速失败时回放真实报错）。 */
    soonestReady(model) {
      const now = Date.now()
      let best
      for (const entry of entries.values()) {
        const until = entry.cooling.get(model)
        if (until === undefined || until <= now) continue
        if (!best || until < best.readyAt) best = { key: entry.key, label: entry.label, readyAt: until, body: entry.lastBody.get(model) ?? '' }
      }
      return best
    },
    /** 记一次「真的发给了上游」（设置面板的用量计数用，只留在内存）。 */
    markSent(key, model) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      entry.stats.sent += 1
      entry.stats.lastModel = model
      entry.lastUsedAt = Date.now()
      bumpModelStat(entry, model, 'sent')
    },
    markCooling(key, model, ms, body) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      const readyAt = Date.now() + ms
      entry.cooling.set(model, readyAt)
      if (body) entry.lastBody.set(model, body)
      entry.lastUsedAt = Date.now()
      entry.stats.limited += 1
      entry.stats.lastModel = model
      bumpModelStat(entry, model, 'limited')
      quotaStore?.set?.(entry.label, model, readyAt, body)
    },
    markHealthy(key, model) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      entry.cooling.delete(model)
      entry.lastBody.delete(model)
      entry.lastUsedAt = Date.now()
      entry.stats.ok += 1
      entry.stats.lastModel = model
      bumpModelStat(entry, model, 'ok')
      quotaStore?.clear?.(entry.label, model)
    },
    /** 供自检工具观察状态，不暴露 key 原文。 */
    snapshot() {
      const now = Date.now()
      return [...entries.values()].map((entry) => ({
        label: entry.label,
        cooling: [...entry.cooling.entries()].filter(([, until]) => until > now).map(([model]) => model),
        quota: [...entry.cooling.entries()]
          .filter(([, until]) => until > now)
          .map(([model, until]) => ({ model, readyAt: until, readyInMin: Math.max(1, Math.round((until - now) / 60000)) })),
        lastUsedAt: entry.lastUsedAt,
      }))
    },
    /** 设置面板用的完整视图：带来源、掩码预览与本次运行用量。每个 key 原文都只经 maskKey 处理。 */
    describe(options) {
      const now = Date.now()
      const withPreview = options?.revealPreview !== false
      return [...entries.values()]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.label.localeCompare(b.label))
        .map((entry, index) => ({
          index: index + 1,
          label: entry.label,
          preview: withPreview ? maskKey(entry.key) : '',
          source: entry.source,
          isRequestKey: entry.isRequestKey,
          cooling: [...entry.cooling.entries()]
            .filter(([, until]) => until > now)
            .map(([model, until]) => ({
              model,
              readyAt: until,
              readyInMin: Math.max(1, Math.round((until - now) / 60000)),
            }))
            .sort((a, b) => a.readyAt - b.readyAt),
          stats: {
            sent: entry.stats.sent,
            ok: entry.stats.ok,
            limited: entry.stats.limited,
            lastModel: entry.stats.lastModel,
            lastUsedAt: entry.lastUsedAt,
          },
          // 按模型的用量明细（面板切到某个模型时看的就是这份）
          models: Object.fromEntries(
            Object.entries(entry.stats.byModel).map(([model, row]) => [
              model,
              { sent: row.sent, ok: row.ok, limited: row.limited, lastUsedAt: row.lastUsedAt },
            ]),
          ),
        }))
    },
  }
}

// ───────────────────── 设置面板的状态载荷 ─────────────────────
// 主机端 → 浏览器半边的唯一数据出口。它只读、只回这些字段：
//   · 每把 key 的 8 位标签、**掩码预览**（可关）、来源、冷却模型与恢复倒计时、
//     本次运行的用量计数；
//   · 全局计数、配置摘要（只挑标量字段）、最近几条决策轨迹。
// 绝不出现的内容：key 原文、config.clineKeys（那是 key 原文数组！）、请求体、
// 任何 Authorization 头。改动这里时请把这条约束当成硬性要求。

/** 只挑可安全外发的配置项：绝不整体展开 config（它在 clineKeys 里含 key 原文）。 */
function safeConfigSummary(config, extra) {
  return {
    clineMatch: extra.clineMatch,
    clineCooldownMs: extra.clineCooldownMs,
    failFastMinMs: extra.failFastMinMs,
    skipCoolingRequestKey: extra.skipCoolingRequestKey,
    allCoolingFailFast: extra.allCoolingFailFast,
    rotateStatuses: [...extra.rotateStatuses],
    maskKeyPreview: config?.maskKeyPreview !== false,
    readCredentialsFile: config?.readCredentialsFile !== false,
    credentialsFile: resolveCredentialsFilePath(config),
    clineKeyRefs: [...(config?.clineKeyRefs ?? DEFAULT_CLINE_KEY_REFS)],
  }
}

/** 设置面板一次刷新所需的全部内容。 */
function buildStatus(deps, options) {
  const { config, pool, diag, quotaStore } = deps
  const revealPreview = options?.revealPreview ?? config?.maskKeyPreview !== false
  const keys = pool.describe({ revealPreview })
  const coolingKeys = keys.filter((key) => key.cooling.length > 0).length
  const recent = (diag.lastRequests ?? []).map((row) => ({
    at: row.at,
    model: row.model,
    decision: row.decision,
    bodyLen: row.bodyLen,
    poolSize: row.poolSize,
  }))

  // 面板顶部那排「按模型查看」的筛选项：把所有出现过的模型按最近活跃排序。
  // 三个来源都要看——冷却记录（被限过的）、按模型用量（跑过的）、最近请求轨迹（包括 '*'）。
  const modelSeen = new Map() // model → lastUsedAt
  const touchModel = (model, at) => {
    if (!model || model === '*') return
    modelSeen.set(model, Math.max(modelSeen.get(model) ?? 0, Number(at) || 0))
  }
  for (const key of keys) {
    for (const row of key.cooling) touchModel(row.model, key.stats.lastUsedAt)
    for (const [model, row] of Object.entries(key.models ?? {})) touchModel(model, row.lastUsedAt)
    touchModel(key.stats.lastModel, key.stats.lastUsedAt)
  }
  for (const row of recent) touchModel(row.model, Date.parse(row.at) || 0)

  // 「当前正在用哪个模型」：最近一条带模型的请求轨迹就是答案（面板默认按它筛选）
  const latest = [...recent].reverse().find((row) => row.model && row.model !== '*')
  const currentModel = latest?.model ?? ''

  // 排序：当前模型固定排第一（本地请求常常落在同一毫秒里，只按时间排会退化成字母序，
  // 于是「当前模型」可能不在第一个，chips 的顺序就变得随机难看）。
  const models = [...modelSeen.entries()]
    .sort((a, b) => {
      if (a[0] === currentModel) return -1
      if (b[0] === currentModel) return 1
      return b[1] - a[1] || a[0].localeCompare(b[0])
    })
    .map(([id, lastUsedAt]) => ({ id, lastUsedAt }))

  return {
    plugin: 'opencode-free-bridge',
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
    settings: safeConfigSummary(config, deps),
    quotaStatePath: quotaStore.path,
    models,
    currentModel: currentModel || models[0]?.id || '',
    totals: {
      poolSize: keys.length,
      readyKeys: keys.length - coolingKeys,
      coolingKeys,
      clineRequests: diag.clineRequests ?? 0,
      rotations: diag.rotations ?? 0,
      failFasts: diag.failFasts ?? 0,
    },
    extras: {
      credentialsFileRead: Boolean(diag.credentialsFileRead),
      extrasResolved: Boolean(diag.extrasResolved),
      lastExtrasAt: diag.lastExtrasAt ?? '',
    },
    lastDecision: diag.lastDecision ?? '',
    keys,
    // 最近几次请求的决策轨迹（只有模型名与决策文本，无 key 材料）
    recent,
  }
}

/** 只回 JSON 的小工具：面板路由只走这一条响应路径。 */
function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"error":"serialization failed"}'
    status = 500
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 最低限度的本机浏览器信任校验：请求的 Referer 必须与 Host 同源。 */
function isTrustedRequest(req) {
  const host = req.headers?.host ?? ''
  const referer = req.headers?.referer ?? ''
  try {
    return referer !== '' && new URL(referer).host === host
  } catch {
    return false
  }
}

export function apply(ctx, config) {
  const originalFetch = globalThis.fetch
  let fallbackSession = ''
  const fallback = () => (fallbackSession ||= opencodeId('ses'))

  const clineMatch = typeof config?.clineMatch === 'string' && config.clineMatch ? config.clineMatch : DEFAULT_CLINE_MATCH
  const clineCooldownMs = Number.isFinite(config?.clineCooldownMs)
    ? Math.max(0, config.clineCooldownMs)
    : DEFAULT_CLINE_COOLDOWN_MS
  const rotateStatuses = Array.isArray(config?.rotateStatuses) ? config.rotateStatuses : CLINE_ROTATE_STATUSES
  // 默认 false：首发送始终用 DSH 配置的 key，冷却中的 key 也先试一次（更可预测）。
  // 置 true：本地已记录该 key 在当前模型上冷却时，首发送就改用健康 key，省掉一次白撞。
  const skipCoolingRequestKey = config?.skipCoolingRequestKey === true
  // 全池都在冷却、且最早恢复时刻还在 failFastMinMs 之外时：直接回放服务端原始 429，
  // 不再发一次注定失败的请求（报文里的恢复时刻就是依据）。默认开启，可配置关闭。
  const allCoolingFailFast = config?.allCoolingFailFast !== false
  const failFastMinMs = Number.isFinite(config?.failFastMinMs) ? Math.max(0, config.failFastMinMs) : DEFAULT_FAIL_FAST_MIN_MS
  const quotaStore = createQuotaStore(resolveQuotaStatePath(config))
  // 诊断信息随状态文件落盘：池规模、额外 key 来源、各类决策计数（便于线上排查“为什么没换 key”）
  const diag = {
    pluginVersion: PLUGIN_VERSION,
    credentialsFileRead: false,
    extrasResolved: false,
    poolSize: 0,
    lastExtrasAt: '',
    clineRequests: 0,
    rotations: 0,
    failFasts: 0,
    lastDecision: '',
  }
  const pool = createKeyPool(quotaStore, diag, (message) => log(message))
  // 额外 key 与请求无关，尽早加载；失败也不影响主链路
  void pool.ensureExtras(ctx, config).catch(() => {})

  const log = (message) => {
    try {
      ctx?.logger?.warn?.(`[opencode-free-bridge] ${message}`)
    } catch {
      // 日志失败绝不影响请求
    }
  }

  globalThis.fetch = async function (input, init) {
    let url = ''
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else if (input && typeof input.url === 'string') {
      url = input.url
    }

    // 1. 目标为 OpenCode Zen 的所有请求（包括 /v1/models 和 /v1/chat/completions 等）
    if (url && url.includes('opencode.ai/zen')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      const sessionHint =
        headers.get('x-opencode-session') ||
        headers.get('x-session-affinity') ||
        headers.get('x-session-id')
      const sessionId = canonicalSession(sessionHint, fallback)
      const requestId = opencodeId('msg')

      headers.set('user-agent', OPENCODE_UA)
      headers.set('x-opencode-client', 'cli')
      // 官方此处为 context.project.id；DSH 无 opencode 项目概念，等价取全局项目：
      // opencode 自身的全局项目 ID 即 ProjectV2.ID.global === 'global'（服务端不校验该值）
      headers.set('x-opencode-project', 'global')
      headers.set('x-opencode-session', sessionId)
      headers.set('x-opencode-request', requestId)
      // 对齐官方 opencode 分支：这两个头只用于非 opencode 提供方，故发往 Zen 时剥离
      // （DSH 底层 pi-ai 会下发它们，且取值并非 opencode 形状）
      headers.delete('x-session-affinity')
      headers.delete('x-session-id')

      // 若未设置 API 密钥、密钥为空，或误填成了 URL 地址，则自动切换为官方匿名通道
      const auth = headers.get('authorization')
      if (
        !auth ||
        auth.trim() === 'Bearer' ||
        auth.trim() === 'Bearer undefined' ||
        auth.trim() === 'Bearer null' ||
        auth.includes('http://') ||
        auth.includes('https://')
      ) {
        headers.set('authorization', 'Bearer public')
      }

      if (input instanceof Request) {
        const newRequest = new Request(input, { ...init, headers })
        return originalFetch.call(this, newRequest)
      }

      return originalFetch.call(this, input, { ...init, headers })
    }

    // 2. 目标为 Cline 官方中转 API 的所有请求（含多 key 轮换）
    if (url && url.includes(clineMatch)) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      // 仅注入 Cline 官方客户端协议特征头；鉴权默认完全遵循用户在 DSH 的设置
      headers.set('http-referer', 'https://cline.bot')
      headers.set('x-title', 'Cline')
      headers.set('user-agent', 'Cline/4.1.16')
      headers.set('x-conversion-version', '4.1.16')
      headers.set('x-platform-version', '1.106.0')
      headers.set('x-client-version', '4.1.16')
      headers.set('x-platform', 'vscode')
      headers.set('x-client-type', 'cline-vscode')

      const authTarget = readAuthTarget(headers)
      const requestKey = readKeyOf(headers, authTarget)
      const hasAuthorization = Boolean(headers.get('authorization'))
      const hasApiKey = Boolean(headers.get('x-api-key'))
      if (requestKey) pool.register(requestKey, 'request')
      // 额外 key 必须在首次判定前就位，否则「全池冷却」与「挑备用 key」都会失真
      await pool.ensureExtras(ctx, config).catch(() => {})
      diag.clineRequests += 1

      // 记录请求形状（只记头名与长度，绝不记 key 原文），便于线上定位「为什么没换 key」
      const trace = {
        at: new Date().toISOString(),
        url: url.slice(0, 120),
        method: (input instanceof Request ? input.method : init?.method) || 'GET',
        authHeader: hasAuthorization ? authTarget.header : hasApiKey ? 'x-api-key' : 'none',
        keyPresent: Boolean(requestKey),
        bodyKind: input instanceof Request ? 'Request' : typeof init?.body,
        bodyLen: typeof init?.body === 'string' ? init.body.length : -1,
        model: readModelOf(init?.body),
        poolSize: pool.size,
        decision: 'pending',
      }
      diag.lastRequests = [...(diag.lastRequests ?? []).slice(-2), trace]
      const decide = (reason) => {
        trace.decision = reason
        diag.poolSize = pool.size // 每轮决策时刷新，避免沿用 ensureExtras 里被 TTL 节流前的旧值
        diag.lastDecision = reason
        quotaStore.setDiagnostics({ ...diag, pool: pool.snapshot().map((e) => ({ label: e.label, cooling: e.cooling })) })
      }
      decide('inspecting')

      // Request 形态下 body 只能消费一次：若存在多个 key（可能轮换），先缓冲一份可重发副本
      let bufferedBody
      if (input instanceof Request && pool.size > 1 && rotateStatuses.length > 0) {
        try {
          bufferedBody = await input.clone().arrayBuffer()
        } catch {
          bufferedBody = undefined
        }
      }

      const model =
        input instanceof Request
          ? readModelOf(bufferedBody ? new TextDecoder().decode(bufferedBody) : undefined)
          : readModelOf(init?.body)

      // 全池冷却的快速失败：报文里的恢复时刻还在阈值之外时，不再发注定失败的请求，
      // 直接回放服务端原始 429（磁盘上有报文就用原始的，没有则合成一条诚实说明）。
      if (allCoolingFailFast && pool.allCooling(model)) {
        const soonest = pool.soonestReady(model)
        if (soonest && soonest.readyAt - Date.now() >= failFastMinMs) {
          const waitMin = Math.max(1, Math.round((soonest.readyAt - Date.now()) / 60000))
          diag.failFasts += 1
          decide(`fail-fast model=${model} pool=${pool.size} waitMin=${waitMin}`)
          log(`Cline 全部 key 在 ${model} 上均冷却（最早 ${waitMin} 分钟后恢复），直接返回缓存报错`)
          const body =
            soonest.body ||
            JSON.stringify({
              code: 'INFERENCE_CAP_ERROR',
              message: `Error 429: Daily free limit reached on model ${model}. Try again in ${waitMin}m (local cache)`,
            })
          return new Response(body, {
            status: 429,
            headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
          })
        }
      }

      // 首发送始终沿用请求自带的 key（即 DSH 里配置的那个），轮换只作为撞限流后的兜底。
      // 即使该 key 已被本地记为「冷却中」也仍然先试一次：本地冷却只是推测，
      // 服务端额度可能已重置，先试一次比直接换 key 更可预测。
      // 若确实希望省掉这次白撞（例如主 key 已被限 22 小时），把 skipCoolingRequestKey 打开。
      let currentKey = requestKey
      if (skipCoolingRequestKey && currentKey && pool.isCooling(currentKey, model)) {
        const healthy = pool.pick(model)
        if (healthy && healthy.key !== currentKey) {
          log(`Cline 主 key 在 ${model} 上仍在冷却，直接改用 ${healthy.label}`)
          currentKey = healthy.key
          writeKeyTo(headers, currentKey, authTarget)
        }
      }

      const sendWith = (sendHeaders, body) => {
        if (input instanceof Request) {
          const rebuilt = new Request(input.url, {
            method: input.method,
            headers: sendHeaders,
            body,
            // 流式 body 需要 half duplex；字符串 body 下该字段被忽略
            ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
          })
          return originalFetch.call(this, rebuilt)
        }
        return originalFetch.call(this, input, { ...init, headers: sendHeaders })
      }

      let response = await sendWith(headers, bufferedBody)
      if (currentKey) pool.markSent(currentKey, model)
      if (!rotateStatuses.includes(response.status)) {
        if (currentKey) pool.markHealthy(currentKey, model)
        decide(`pass-through status=${response.status}`)
        return response
      }

      // 重发要求 body 可原样重建（字符串 / 字节），流式 body 只能原样返回
      const replayable = input instanceof Request ? bufferedBody !== undefined : replayableBody(init?.body)
      if (!replayable || !currentKey) {
        decide(`cannot-rotate replayable=${replayable} keyPresent=${Boolean(currentKey)} status=${response.status}`)
        return response
      }

      let lastText = await response.clone().text()
      pool.markCooling(currentKey, model, parseRetryWindowMs(lastText) || clineCooldownMs, lastText)
      await pool.ensureExtras(ctx, config).catch(() => {})

      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
        const next = pool.pick(model)
        if (!next || next.key === currentKey) break
        const nextHeaders = new Headers(headers)
        writeKeyTo(nextHeaders, next.key, authTarget)

        let retried
        try {
          retried = await sendWith(nextHeaders, bufferedBody)
          pool.markSent(next.key, model)
        } catch (error) {
          log(`Cline 换 key 重发失败（key=${next.label}）：${error?.message ?? error}`)
          break
        }

        if (!rotateStatuses.includes(retried.status)) {
          pool.markHealthy(next.key, model)
          diag.rotations += 1
          decide(`rotated ${keyLabel(currentKey)}→${next.label} model=${model}`)
          log(`Cline 限流已换 key 恢复（${keyLabel(currentKey)} → ${next.label}, model=${model}）`)
          return retried
        }

        lastText = await retried.clone().text()
        pool.markCooling(next.key, model, parseRetryWindowMs(lastText) || clineCooldownMs, lastText)
        currentKey = next.key
        response = retried
      }

      // 备用 key 全部尝试完仍失败。区分两种情况：
      //   - 额度耗尽（每日上限之类，重试窗口以小时计）：显式标记 x-should-retry:false，
      //     pi-ai 的 provider-retry 会读取该头并立即放弃，省掉无意义的退避等待；
      //   - 瞬时限流：原样返回，交给 pi-ai 按 retry-after / 指数退避重试。
      const windowMs = parseRetryWindowMs(lastText)
      if (!TERMINAL_CAP_RE.test(lastText) && windowMs < TERMINAL_WINDOW_MS) {
        log(`Cline 备用 key 均未通过（model=${model}），保留 429 交由上层退避重试`)
        return response
      }

      const exhausted = new Headers(response.headers)
      exhausted.set('x-should-retry', 'false')
      const soonest = pool.soonestReady(model)
      const resetHint = soonest ? `，最早 ${new Date(soonest.readyAt).toLocaleTimeString('zh-CN', { hour12: false })} 恢复` : ''
      log(`Cline 额度已耗尽（model=${model}，重试窗口约 ${Math.max(1, Math.round(windowMs / 60000))} 分钟${resetHint}），放弃重试`)
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: exhausted,
      })
    }

    // 所有其他渠道（DeepSeek、OpenAI、Anthropic 等）100% 原样直通，完全无感
    return originalFetch.apply(this, arguments)
  }

  ctx.on('dispose', () => {
    globalThis.fetch = originalFetch
    quotaStore.flush()
  })

  // ───────────────────── 设置面板：只读状态路由 ─────────────────────
  // 面板本体是浏览器半边（lib/client.js，经 package.json 的 dsh.client 声明由
  // dsh-client-modules 打包投放）；它需要主机端把 key 池状态交出来，这里用一条
  // 同源只读路由提供。
  //
  // 关键：这条路由**不能**用模块级 `export const inject = ['webServer']` 来等依赖——
  // 那会把整个插件（包括 fetch 补丁）门控在 webServer 上，headless/acp/desktop
  // 这些没有 webServer 的 profile 里连 Zen/Cline 桥接都会一起失效。
  // 正确做法是 ctx.inject 开一个子 fiber（DSH 自身大量使用这个模式，例如
  // dsh-client-modules 就是这么挂 /plugins 路由的），只为路由等 webServer。
  const statusRoute = {
    path: '/opencode-free-bridge/cline-keys',
    build: (options) =>
      buildStatus(
        {
          config,
          pool,
          diag,
          quotaStore,
          clineMatch,
          clineCooldownMs,
          failFastMinMs,
          skipCoolingRequestKey,
          allCoolingFailFast,
          rotateStatuses,
        },
        options,
      ),
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: statusRoute.path,
            handler: (req, res) => {
              if (req.method !== 'GET' && req.method !== 'HEAD') {
                return sendJson(res, 405, { error: 'method not allowed' })
              }
              // 同源校验：拒绝一切非本机 GUI 发起的读取
              if (!isTrustedRequest(req)) return sendJson(res, 403, { error: 'untrusted request' })
              let payload
              try {
                payload = statusRoute.build()
              } catch (error) {
                return sendJson(res, 500, { error: String(error?.message ?? error) })
              }
              if (req.method === 'HEAD') {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                return res.end()
              }
              return sendJson(res, 200, payload)
            },
          }),
        'opencode-free-bridge: cline keys route',
      )
    })
  }

  // 自检工具用的观察入口（不含 key 原文）
  ctx.__opencodeFreeBridge = {
    clineKeys: () => pool.snapshot(),
    status: (options) => statusRoute.build(options),
    routePath: statusRoute.path,
    // 强制立刻重扫一次额外 key 来源（自检用；运行期新增 ref 的正式路径是 5 分钟自动复扫）
    ensureExtras: (options) => pool.ensureExtras(ctx, config, options),
    parseRetryWindowMs,
    quotaStatePath: quotaStore.path,
    flushQuotaState: () => quotaStore.flush(),
  }
}