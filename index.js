export const name = 'opencode-free-bridge'

// 本文件只做两件事：把各模块装配起来，以及实现 fetch 层拦截。
// 具体实现按职责拆在 lib/host/ 下：defaults(常量与路径) / ids(ID 与标签) /
// quota-state(额度落盘) / request-shape(请求形状) / credentials(凭据文件读+兜底写) /
// key-import(面板导入) / usage(token 采集) / key-pool(key 池) / status(面板载荷) /
// http(路由小工具)。
import {
  CLINE_ROTATE_STATUSES,
  DEFAULT_CLINE_KEY_REFS,
  DEFAULT_CLINE_MATCH,
  DEFAULT_CLINE_COOLDOWN_MS,
  DEFAULT_FAIL_FAST_MIN_MS,
  MAX_ROTATE_ATTEMPTS,
  PLUGIN_VERSION,
  TERMINAL_CAP_RE,
  TERMINAL_WINDOW_MS,
  resolveCredentialsFilePath,
  resolveQuotaStatePath,
} from './lib/host/defaults.js'
import { OPENCODE_UA, canonicalSession, keyLabel, opencodeId } from './lib/host/ids.js'
import { createQuotaStore, parseRetryWindowMs } from './lib/host/quota-state.js'
import { readAuthTarget, readKeyOf, readModelOf, replayableBody, writeKeyTo } from './lib/host/request-shape.js'
import { normalizeUsage, tapUsage } from './lib/host/usage.js'
import { createKeyPool } from './lib/host/key-pool.js'
import { buildStatus } from './lib/host/status.js'
import { isTrustedRequest, readJsonBody, sendJson } from './lib/host/http.js'
import { readCredentialRefsFromFile, writeCredentialRefToFile } from './lib/host/credentials.js'
import { importClineKeys, MAX_IMPORT_KEYS } from './lib/host/key-import.js'

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
  // 设置面板的写入口（导入 Key / 重置统计两条 POST 路由）。默认开启；置 false 则写路由
  // 一律拒绝服务（只读面板照常），供不需要这条通道的部署关掉。
  const keyImportEnabled = config?.keyImport !== false
  // DSH 侧没配 key（apiKeyEnv 被移除，或解析出来是空值）时，首发送直接从池里挑一把兜底。
  // 不兜底的话这个请求会裸着发给上游：Cline 回 401，而轮换只认 429，池子根本没有上场机会。
  // 关掉场景：clineMatch 指向不需要鉴权的自建中转，此时不该把池里的 key 注入进去。
  const fillMissingRequestKey = config?.fillMissingRequestKey !== false
  // 允许导入写入的 ref 名单：与 key-pool 读盘用的是同一份（未列出的 ref 一律不碰）
  const wantedKeyRefs = Array.isArray(config?.clineKeyRefs) ? config.clineKeyRefs : DEFAULT_CLINE_KEY_REFS
  // 导入正文字节上限：面板是手工粘贴几十把 Key 的量级，64KB 绰绰有余
  const MAX_IMPORT_BODY = 64 * 1024
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
  // 跨重启恢复：累计计数与「最近决策」是上次进程留下的，插件更新 / DSH 重启不该把它们清零。
  // 池内每把 key 的用量由 key-pool 在登记时按 8 位标签自行恢复（同一个文件）。
  const restoredTotals = quotaStore.totals()
  const restoredDiag = quotaStore.diagnostics()
  // 「统计自 … 起」：首次运行取当下，之后一直沿用上次的起点，重置时才改写
  let statsSince = restoredTotals.since || Date.now()
  diag.statsSince = statsSince
  diag.clineRequests = restoredTotals.clineRequests
  diag.rotations = restoredTotals.rotations
  diag.failFasts = restoredTotals.failFasts
  diag.lastRequests = Array.isArray(restoredDiag.lastRequests) ? restoredDiag.lastRequests.slice(-3) : []
  const pool = createKeyPool(quotaStore, diag, (message) => log(message))
  // 额外 key 与请求无关，尽早加载；失败也不影响主链路
  void pool.ensureExtras(ctx, config).catch(() => {})

  // DSH 设置服务的只读引用：面板靠它列出「Cline 名下配置了哪些模型」，
  // 这样刚重启、一次 Cline 请求都还没发生时也能显示 glm 等模型。
  // 用**非门控**的 ctx.inject：settings 缺席时插件照常工作，面板退化成只列观察到的模型。
  let settingsService
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      settingsService = settingsCtx.get('settings') ?? settingsCtx.settings
    })
  }

  const log = (message) => {
    try {
      ctx?.logger?.warn?.(`[opencode-free-bridge] ${message}`)
    } catch {
      // 日志失败绝不影响请求
    }
  }

  // 凭据服务（可选）：导入 Key 的**写**优先走它——带文件锁的原子写 + 变更通知，
  // 与 DSH 设置页写凭据是同一条路径。仍然用非门控的 ctx.inject：服务缺席时插件照常工作，
  // 导入退化为直写凭据文件（读侧本来就有这条兜底）。
  let credentialsService
  if (typeof ctx.inject === 'function') {
    ctx.inject(['credentials'], (credentialsCtx) => {
      credentialsService = credentialsCtx.get('credentials') ?? credentialsCtx.credentials
      // 凭据一变（面板导入、DSH 设置里改 ref、乃至手工编辑文件被服务观察到）立刻重扫 key 池，
      // 不必等 EXTRAS_TTL_MS 那 5 分钟节流——「刚加进去的 key 为什么不在池子里」就是这么来的。
      credentialsCtx.on?.('credentials/reference-updated', () => {
        void pool.ensureExtras(ctx, config, { force: true }).catch(() => {})
      })
    })
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
      const rawRequestKey = readKeyOf(headers, authTarget)
      // pi-ai 在没有凭据时可能发出「Bearer undefined / Bearer null」这类占位头：一律按「没带 key」处理
      const requestKey = /^(undefined|null)$/i.test(rawRequestKey) ? '' : rawRequestKey
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
        // 计数与「最近决策」一并落到 totals / diagnostics：三个决策点（正常发、换 key、快速失败）
        // 都会经过这里，所以不需要在每处 += 1 之后各自补一次写盘
        diag.statsSince = statsSince
        quotaStore.setTotals({
          since: statsSince,
          clineRequests: diag.clineRequests,
          rotations: diag.rotations,
          failFasts: diag.failFasts,
        })
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

      // 请求完全没带 key（DSH 的 apiKeyEnv 被移除 / 凭据为空）：从池里挑一把兜底。
      // 挑选规则与轮换一致（粘性优先、跳过该模型上已冷却者），后续撞 429 也照常轮换。
      if (!currentKey && fillMissingRequestKey) {
        const picked = pool.pick(model)
        if (picked) {
          currentKey = picked.key
          writeKeyTo(headers, currentKey, authTarget)
          log(`Cline 请求未带 key，已从池里挑 ${picked.label} 兜底（model=${model}，池=${pool.size}）`)
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
        // 顺手把这轮响应的 token 用量记到「key + 模型」上（失败静默，不影响请求）
        return currentKey ? tapUsage(response, (usage) => pool.markTokens(currentKey, model, normalizeUsage(usage))) : response
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
          return tapUsage(retried, (usage) => pool.markTokens(next.key, model, normalizeUsage(usage)))
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

  // ───────────────────── 设置面板：导入 Key（写路由） ─────────────────────
  // 面板上「插件版本」右边的按钮就是这条通道：把粘贴进来的 Key 写进凭据仓库
  // （优先凭据服务），写完立刻重扫进池，当轮即可参与轮换。
  //
  // 这是一条**写**路由，因此比只读状态路由多三道闸：
  //   · 只接受 POST + application/json（挡住表单/文本这类无需预检的跨站简单请求）；
  //   · 同源校验与只读路由完全一致（Referer 必须与 Host 同源）；
  //   · 正文带上限（MAX_IMPORT_BODY），超限立刻断开。
  // 除此之外它只写 refs 段里名单内的 ref，且回包只带 ref / 哈希标签 / 掩码——没有 Key 原文。
  const importPath = '/opencode-free-bridge/cline-keys/import'
  const resetPath = '/opencode-free-bridge/cline-keys/stats/reset'

  /** ref → 当前值：凭据服务优先（反映 DSH 眼里的真实值），服务缺席或未就绪时直读文件。 */
  const readClineKeyRefs = async () => {
    const values = new Map(wantedKeyRefs.map((ref) => [ref, undefined]))
    const service = credentialsService
    if (service && typeof service.resolve === 'function') {
      await Promise.all(
        wantedKeyRefs.map(async (ref) => {
          try {
            const found = await service.resolve(ref)
            if (found && typeof found.value === 'string' && found.value) values.set(ref, found.value)
          } catch {
            // 单个 ref 解析失败只影响它自己：按「未占用」处理，导入时再用写路径的报错说话
          }
        }),
      )
      return { values, source: 'credentials' }
    }
    try {
      for (const [ref, value] of readCredentialRefsFromFile(resolveCredentialsFilePath(config), wantedKeyRefs)) {
        values.set(ref, value)
      }
    } catch {
      // 文件不存在/不可读：当作全都空着，写的时候再报错
    }
    return { values, source: 'file' }
  }

  /** 凭据服务缺席时的兜底写：直写凭据文件的 refs 段。 */
  const writeCredentialKeyToFile = (ref, value) => writeCredentialRefToFile(resolveCredentialsFilePath(config), ref, value)

  /** 写一个 ref：凭据服务优先（带文件锁的原子写 + 变更通知），缺席时直写凭据文件。 */
  const writeClineKeyRef = async (ref, value) => {
    const service = credentialsService
    if (service && typeof service.set === 'function') return service.set(ref, value)
    writeCredentialKeyToFile(ref, value)
  }

  /** 写路由共用的三道闸：总开关、只收 POST、同源。返回 false 表示已经回过包。
   *  只读路由不经过这里（它另有 GET/HEAD 的白名单）。 */
  const passWriteGuard = (req, res) => {
    if (!keyImportEnabled) {
      sendJson(res, 403, { error: 'panel write routes are disabled (config.keyImport = false)' })
      return false
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' })
      return false
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { error: 'untrusted request' })
      return false
    }
    return true
  }

  /** 写路由还必须带 application/json：内容类型不简单的请求会被浏览器先发预检，
   *  跨站表单/文本这类「简单请求」因此根本进不来——这是没有 CSRF token 时的关键一道闸。 */
  const isJsonRequest = (req) => /^application\/json\b/i.test(String(req.headers?.['content-type'] ?? ''))

  /** 重置统计：计数、token、最近决策全部归零（冷却与额度不动——那是服务端的事实）。 */
  const handleStatsReset = async (req, res) => {
    if (!passWriteGuard(req, res)) return
    if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    try {
      // 空正文也要读完，否则连接会一直半开着
      await readJsonBody(req, 1024)
    } catch (error) {
      if (error?.code === 'PAYLOAD_TOO_LARGE') return sendJson(res, 413, { error: String(error.message) })
      // 正文不是 JSON 也无所谓：重置不需要任何入参
    }
    pool.resetStats()
    diag.clineRequests = 0
    diag.rotations = 0
    diag.failFasts = 0
    diag.lastRequests = []
    diag.lastDecision = 'stats-reset'
    statsSince = Date.now()
    diag.statsSince = statsSince
    quotaStore.setTotals({ since: statsSince, clineRequests: 0, rotations: 0, failFasts: 0 })
    quotaStore.setDiagnostics({ ...diag, pool: pool.snapshot().map((e) => ({ label: e.label, cooling: e.cooling })) })
    quotaStore.flush()
    log('统计已重置（计数、token、最近决策归零；冷却与额度未动）')
    return sendJson(res, 200, { ok: true, since: statsSince, totals: quotaStore.totals(), poolSize: pool.size })
  }

  const handleKeyImport = async (req, res) => {
    if (!passWriteGuard(req, res)) return
    if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })

    let payload
    try {
      payload = await readJsonBody(req, MAX_IMPORT_BODY)
    } catch (error) {
      const tooLarge = error?.code === 'PAYLOAD_TOO_LARGE'
      return sendJson(res, tooLarge ? 413 : 400, { error: String(error?.message ?? error) })
    }
    const text =
      typeof payload?.keys === 'string' ? payload.keys : Array.isArray(payload?.keys) ? payload.keys.join('\n') : ''
    if (!text.trim()) return sendJson(res, 400, { error: 'no keys in request body' })

    const current = await readClineKeyRefs()
    const report = await importClineKeys({
      text,
      refs: wantedKeyRefs,
      existing: current.values,
      writeRef: writeClineKeyRef,
      // 池内已知标签：粘一把已经在用的 Key 会被判为重复，而不是又写一份
      poolLabels: new Set(pool.snapshot().map((entry) => entry.label)),
    })

    // 只有真写进去了才重扫：把新 ref 立刻收进池子（顺带刷新来源标签与池大小）
    if (report.imported.length > 0) {
      await pool.ensureExtras(ctx, config, { force: true }).catch(() => {})
    }
    // 日志只有计数，没有 Key 材料
    log(
      '导入 Key：新增 ' + report.imported.length + '，重复 ' + report.duplicates.length +
        '，拒绝 ' + report.rejected.length + '，失败 ' + report.failed.length + '（来源：' + current.source + '）',
    )
    return sendJson(res, 200, {
      ok: true,
      writeMode: current.source,
      imported: report.imported,
      duplicates: report.duplicates,
      rejected: report.rejected,
      failed: report.failed,
      refsFree: report.refsFree,
      poolSize: pool.size,
      maxKeys: MAX_IMPORT_KEYS,
    })
  }

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
          // getter：settings 可能比插件晚就绪，取的时候再读，别在构建期固化
          get settings() {
            return settingsService
          },
          clineMatch,
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
      // 导入路由与只读路由同一个 webServer 门（headless/acp 下两条一起缺席，主链路不受影响）
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: importPath,
            handler: (req, res) => {
              handleKeyImport(req, res).catch((error) => {
                if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
              })
            },
          }),
        'opencode-free-bridge: cline key import route',
      )
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: resetPath,
            handler: (req, res) => {
              handleStatsReset(req, res).catch((error) => {
                if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
              })
            },
          }),
        'opencode-free-bridge: cline stats reset route',
      )
    })
  }

  // 自检工具用的观察入口（不含 key 原文）
  ctx.__opencodeFreeBridge = {
    clineKeys: () => pool.snapshot(),
    /** 累计计数与统计起点（自检用来断言「跨重启没丢」）。 */
    statsTotals: () => quotaStore.totals(),
    resetStats: () => pool.resetStats(),
    status: (options) => statusRoute.build(options),
    routePath: statusRoute.path,
    // 强制立刻重扫一次额外 key 来源（自检用；运行期新增 ref 的正式路径是 5 分钟自动复扫）
    ensureExtras: (options) => pool.ensureExtras(ctx, config, options),
    parseRetryWindowMs,
    quotaStatePath: quotaStore.path,
    flushQuotaState: () => quotaStore.flush(),
  }
}
