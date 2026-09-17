export const name = 'opencode-free-bridge'

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
const DEFAULT_CLINE_MATCH = 'api.cline.bot'
const DEFAULT_CLINE_COOLDOWN_MS = 15 * 60 * 1000
const MAX_ROTATE_ATTEMPTS = 6
// 默认从凭据仓库 / 启动环境探测的额外 key 名（主 key 由 DSH 的 CLINE_API_KEY 提供）
const DEFAULT_CLINE_KEY_REFS = Array.from({ length: 9 }, (_, i) => `CLINE_API_KEY_${i + 2}`)
const CLINE_ROTATE_STATUSES = [429]

/** 429 是否属于「额度已耗尽」这类终局错误：这类错误退避重试毫无意义。 */
const TERMINAL_CAP_RE = /INFERENCE_CAP_ERROR|daily\s+free\s+limit|free\s+limit\s+reached|usage\s+limit|quota\s+exceeded|insufficient/i
const TERMINAL_WINDOW_MS = 10 * 60 * 1000

/** 只用于日志的短标签，绝不记录 key 原文。 */
function keyLabel(key) {
  return seedOf(key).toString(16).padStart(8, '0')
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

/** key 池：按模型维度记录冷却时间，选 key 时用 LRU 避开刚用过的那个。 */
function createKeyPool() {
  const entries = new Map() // key → { key, label, cooling: Map<model, until>, lastUsedAt }
  let extrasLoaded = false

  const register = (key) => {
    const value = typeof key === 'string' ? key.trim() : ''
    if (!value || /^(Bearer|undefined|null)$/i.test(value)) return undefined
    let entry = entries.get(value)
    if (!entry) {
      entry = { key: value, label: keyLabel(value), cooling: new Map(), lastUsedAt: 0 }
      entries.set(value, entry)
    }
    return entry
  }

  return {
    get size() {
      return entries.size
    },
    register,
    /** 加载 config / 环境变量 / 凭据仓库里的额外 key（仅一次）。 */
    async ensureExtras(ctx, config) {
      if (extrasLoaded) return
      extrasLoaded = true

      for (const key of config?.clineKeys ?? []) register(key)

      const env = globalThis.process?.env ?? {}
      for (const chunk of [env.CLINE_API_KEYS, env.CLINE_FREE_API_KEYS]) {
        if (!chunk) continue
        for (const key of String(chunk).split(/[\s,;]+/)) register(key)
      }
      for (const ref of DEFAULT_CLINE_KEY_REFS) register(env[ref])

      const refs = config?.clineKeyRefs ?? DEFAULT_CLINE_KEY_REFS
      let credentials
      try {
        credentials = ctx?.get?.('credentials')
      } catch {
        credentials = undefined
      }
      if (credentials?.resolve) {
        for (const ref of refs) {
          try {
            const resolved = await credentials.resolve(ref)
            const value = typeof resolved === 'string' ? resolved : resolved?.value
            if (typeof value === 'string') register(value)
          } catch {
            // 凭据服务不可用或该 ref 未配置：忽略，不影响其余来源
          }
        }
      }
    },
    pick(model) {
      const now = Date.now()
      let best
      for (const entry of entries.values()) {
        const until = entry.cooling.get(model)
        if (until !== undefined && until > now) continue
        if (!best || entry.lastUsedAt < best.lastUsedAt) best = entry
      }
      return best
    },
    isCooling(key, model) {
      const entry = entries.get(key)
      if (!entry) return false
      const until = entry.cooling.get(model)
      return until !== undefined && until > Date.now()
    },
    markCooling(key, model, ms) {
      const entry = entries.get(key)
      if (!entry) return
      entry.cooling.set(model, Date.now() + ms)
      entry.lastUsedAt = Date.now()
    },
    markHealthy(key, model) {
      const entry = entries.get(key)
      if (!entry) return
      entry.cooling.delete(model)
      entry.lastUsedAt = Date.now()
    },
    /** 供自检工具观察状态，不暴露 key 原文。 */
    snapshot() {
      const now = Date.now()
      return [...entries.values()].map((entry) => ({
        label: entry.label,
        cooling: [...entry.cooling.entries()].filter(([, until]) => until > now).map(([model]) => model),
        lastUsedAt: entry.lastUsedAt,
      }))
    },
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
  const pool = createKeyPool()
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
      if (requestKey) pool.register(requestKey)

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
      if (!rotateStatuses.includes(response.status)) {
        if (currentKey) pool.markHealthy(currentKey, model)
        return response
      }

      // 重发要求 body 可原样重建（字符串 / 字节），流式 body 只能原样返回
      const replayable = input instanceof Request ? bufferedBody !== undefined : replayableBody(init?.body)
      if (!replayable || !currentKey) return response

      let lastText = await response.clone().text()
      pool.markCooling(currentKey, model, parseRetryWindowMs(lastText) || clineCooldownMs)
      await pool.ensureExtras(ctx, config).catch(() => {})

      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
        const next = pool.pick(model)
        if (!next || next.key === currentKey) break
        const nextHeaders = new Headers(headers)
        writeKeyTo(nextHeaders, next.key, authTarget)

        let retried
        try {
          retried = await sendWith(nextHeaders, bufferedBody)
        } catch (error) {
          log(`Cline 换 key 重发失败（key=${next.label}）：${error?.message ?? error}`)
          break
        }

        if (!rotateStatuses.includes(retried.status)) {
          pool.markHealthy(next.key, model)
          log(`Cline 限流已换 key 恢复（${keyLabel(currentKey)} → ${next.label}, model=${model}）`)
          return retried
        }

        lastText = await retried.clone().text()
        pool.markCooling(next.key, model, parseRetryWindowMs(lastText) || clineCooldownMs)
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
      log(`Cline 额度已耗尽（model=${model}，重试窗口约 ${Math.max(1, Math.round(windowMs / 60000))} 分钟），放弃重试`)
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
  })

  // 自检工具用的观察入口（不含 key 原文）
  ctx.__opencodeFreeBridge = {
    clineKeys: () => pool.snapshot(),
    parseRetryWindowMs,
  }
}