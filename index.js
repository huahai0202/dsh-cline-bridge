export const name = 'dsh-cline-bridge'

// 本文件只做两件事：把各模块装配起来，以及实现 fetch 层拦截（Cline 渠道：客户端特征头
// 注入 + 撞限流后换 key 重发）。
// 具体实现按职责拆在 lib/host/ 下：defaults(常量与路径) / labels(标签与掩码) /
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
  MONITORED_UPSTREAM_MODELS,
  PLUGIN_VERSION,
  TERMINAL_CAP_RE,
  TERMINAL_WINDOW_MS,
  resolveCredentialsFilePath,
  resolveQuotaStatePath,
  migrateLegacyQuotaState,
} from './lib/host/defaults.js'
import { keyLabel } from './lib/host/labels.js'
import { isPlausibleModelId } from './lib/host/model-id.js'
import { cooldownMsFromResponse, createQuotaStore, parseRetryWindowMs } from './lib/host/quota-state.js'
import { matchesClineTarget, readAuthTarget, readKeyOf, readModelOf, replayableBody, writeKeyTo } from './lib/host/request-shape.js'
import { createUpstreamLog, readUpstream } from './lib/host/upstream.js'
import { injectPinnedProvider, parsePinUpstream } from './lib/host/pin.js'
import { normalizeUsage, tapUsage } from './lib/host/usage.js'
import { createKeyPool } from './lib/host/key-pool.js'
import { buildStatus, clineApiKeyEnvOf } from './lib/host/status.js'
import { isTrustedRequest, readJsonBody, sendJson, sendJsonConditional } from './lib/host/http.js'
import { readCredentialRefsFromFile, writeCredentialRefToFile } from './lib/host/credentials.js'
import { importClineKeys, MAX_IMPORT_KEYS } from './lib/host/key-import.js'

export function apply(ctx, config) {
  const originalFetch = globalThis.fetch

  // 日志工具必须最先定义：下面的 pool.ensureExtras(...) 会在 apply() 同步返回前就调它，
  // 而它内部用到的 log 若声明在更后面，那次调用会命中 const 的 TDZ 抛 ReferenceError，
  // 再被调用点的 .catch(() => {}) 静默吞掉——表现为「冷启动少一条 key 池日志，毫无迹象」。
  // 日志失败本身绝不影响请求，所以这里仍然整体包一层。
  const log = (message) => {
    try {
      ctx?.logger?.warn?.(`[dsh-cline-bridge] ${message}`)
    } catch {
      // 日志失败绝不影响请求
    }
  }

  const clineMatch = typeof config?.clineMatch === 'string' && config.clineMatch ? config.clineMatch : DEFAULT_CLINE_MATCH
  // 兜底冷却：默认 0 = 不补。冷却窗口只认服务端给的两处（报文的 Try again in … →
  // Retry-After 头，见 cooldownMsFromResponse）；两者都拿不到就**不编造**恢复时刻——
  // 限流是「这把 key 在这个模型上」的事实，什么时候恢复只有服务端知道。显式配置 > 0
  // 才会在此兜底（那是用户自己的策略，不是插件的默认策略）。
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
  // 上游锁定（可选）：model → { provider, allowFallbacks }。配置了才会改写请求体，
  // 没配置时插件对请求体一个字节都不动（与既有契约一致）。实现见 lib/host/pin.js。
  const pinnedUpstream = parsePinUpstream(config?.pinUpstream)
  // 锁定摘要进 diagnostics：一眼看出「锁了哪些模型、生效了几次」，与既有排查入口一致。
  // 没配置锁定时是空串（不占位），配置了则是 `model→provider` 的紧凑列表。
  const pinSummary = [...pinnedUpstream.entries()].map(([m, p]) => `${m}→${p.provider}`).join(', ')
  // 「这次实际是哪个上游服务的」——只读观测，供面板显示，**不干预路由**。
  //
  // 只放内存、不落状态文件：这是「刚才那次请求观察到的现象」，不是额度/用量那种必须
  // 跨重启保留的事实。上游随时会漂，把过期结论写进盘再读出来只会误导。
  //
  // 为什么只盯一个模型：观测数据要挂在面板的模型芯片上，给每个跑过的模型都挂会变成噪声；
  // 名单见 defaults.MONITORED_UPSTREAM_MODELS。
  const upstreamLog = createUpstreamLog()
  const monitoredUpstream = (model) => MONITORED_UPSTREAM_MODELS.includes(model)

  /**
   * 从一次响应的文本里记下实际上游。失败一律静默——观测绝不能影响请求本身。
   * `bodyText` 由调用方传入（它已经 clone 过一份给用量采集，这里直接用那份文本）。
   * `label` 是这次实际发出去的那把 key 的 8 位标签：面板要按 key 显示「这把在走哪家」。
   */
  const noteUpstream = (model, bodyText, label) => {
    if (!monitoredUpstream(model)) return
    const upstream = readUpstream(bodyText)
    if (upstream) upstreamLog.note(model, upstream, label)
  }

  /**
   * 读一次响应并把上游记下来。这是唯一的调用入口，避免各处自己 clone/parse。
   * 429 报文里没有路由信息，所以只在真正拿到 2xx 的出路调用。
   */
  const observeUpstream = async (model, response, label) => {
    if (!monitoredUpstream(model)) return
    try {
      noteUpstream(model, await response.clone().text(), label)
    } catch {
      // 观测失败不影响请求
    }
  }

  // 导入正文字节上限：面板是手工粘贴几十把 Key 的量级，64KB 绰绰有余
  const MAX_IMPORT_BODY = 64 * 1024
  // 插件更名（opencode-free-bridge → dsh-cline-bridge）后第一次启动：把旧名状态文件搬过来，
  // 冷却与累计统计才不丢。只搬一次，之后这里什么也不做。
  const legacyQuotaState = migrateLegacyQuotaState(config)
  // 读盘 / 落盘失败不再静默：把 store 的错误交回日志（它自己不认识日志实现，见 quota-state.js）。
  // 「冷却与统计明明在丢、却没有任何迹象」就是这么来的。
  const quotaStore = createQuotaStore(resolveQuotaStatePath(config), {
    onError: (kind, error) => {
      const detail = error?.message ?? error
      log(kind === 'load' ? `额度状态文件读取失败，已按空状态启动（${detail}）` : `额度状态落盘失败（${detail}）`)
    },
  })
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
    // 上游锁定（只进状态文件的 diagnostics，面板不读）：配置摘要 + 实际生效次数
    pinnedUpstream: pinSummary,
    pinApplied: 0,
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
  // pinApplied 是累计计数，跨重启保留；摘要始终以当前 config 为准（改配置立刻反映）
  diag.pinApplied = Number(restoredDiag.pinApplied) || 0
  diag.lastRequests = Array.isArray(restoredDiag.lastRequests) ? restoredDiag.lastRequests.slice(-3) : []
  const pool = createKeyPool(quotaStore, diag, (message) => log(message))
  // 额外 key 扫描失败不拖垮主链路，但**不再静默**：曾经这里 (以及下面几处) 是
  // .catch(() => {})，把 ensureExtras 内任何异常（config 访问器抛错、注册过程出错……）
  // 都吞得无影无踪——表现为「池子莫名其妙是空的，日志里什么也没有」。
  const ensureExtrasQuiet = (options) =>
    pool.ensureExtras(ctx, config, options).catch((error) => {
      log(`Cline 额外 key 扫描失败：${error?.message ?? error}`)
    })
  // 额外 key 与请求无关，尽早加载
  void ensureExtrasQuiet()

  // DSH 设置服务的只读引用：面板靠它列出「Cline 名下配置了哪些模型」，
  // 这样刚重启、一次 Cline 请求都还没发生时也能显示 glm 等模型。
  // 注意用**非门控**的 ctx.inject（而不是模块级 export const inject = ['settings']）：
  // 后者会把整个插件门控在 settings 上，headless/acp 等没有该服务的 profile 里连 fetch 补丁
  // 都会一起失效。ctx.inject 本身是 cordis Context 的原型方法，恒存在，无需 typeof 守卫。
  let settingsService
  ctx.inject(['settings'], (settingsCtx) => {
    settingsService = settingsCtx.get('settings') ?? settingsCtx.settings
    scheduleMainKeyRegistration()
  })

  // 迁移只发生在「旧文件在、新文件不在」的那一次；此后的启动这里都是空串、不发日志。
  if (legacyQuotaState) log(`已把旧插件名的状态文件迁移到新名字：${legacyQuotaState} → ${quotaStore.path}`)

  // 凭据服务（可选）：导入 Key 的**写**优先走它——带文件锁的原子写 + 变更通知，
  // 与 DSH 设置页写凭据是同一条路径。仍然用非门控的 ctx.inject：服务缺席时插件照常工作，
  // 导入退化为直写凭据文件（读侧本来就有这条兜底）。
  let credentialsService
  ctx.inject(['credentials'], (credentialsCtx) => {
    credentialsService = credentialsCtx.get('credentials') ?? credentialsCtx.credentials
    // 凭据一变（面板导入、DSH 设置里改 ref、乃至手工编辑文件被服务观察到）立刻重扫 key 池，
    // 不必等 EXTRAS_TTL_MS 那 5 分钟节流——「刚加进去的 key 为什么不在池子里」就是这么来的。
    credentialsCtx.on?.('credentials/reference-updated', () => {
      void ensureExtrasQuiet({ force: true })
      scheduleMainKeyRegistration()
    })
    scheduleMainKeyRegistration()
  })

  // 主 Key（提供方 apiKeyEnv 指向的那把）挂载即入池：不然 DSH 重启后面板只有备用 key，
  // 要等第一条请求把它带上来才补齐，看着像少了一把。它本来就是 DSH 会随请求头携带的
  // 那把，所以来源仍标 request（面板不显示来源，载荷里与「请求头带来」同义）。
  // settings 与凭据服务谁后到都行：两边就绪时才解析；解析不到（比如确实没配）就静默跳过。
  async function registerMainKey() {
    const ref = clineApiKeyEnvOf(safeSettingsTable(), clineMatch)
    if (!ref) return
    let value
    const service = credentialsService
    if (service && typeof service.resolve === 'function') {
      try {
        value = (await service.resolve(ref))?.value
      } catch {
        // 刻意静默：凭据服务解析失败等价于「这把主 Key 暂时解析不到」，
        // 既不影响请求（DSH 自己会带 key），也不影响池子（备用 key 照常工作），
        // 而且凭据一变就会再触发一次。这里记日志只会刷屏。
        value = undefined
      }
    }
    if (!value && config?.readCredentialsFile !== false) {
      try {
        value = readCredentialRefsFromFile(resolveCredentialsFilePath(config), [ref]).get(ref)
      } catch {
        // 同上：凭据文件不存在/不可读时按「主 Key 未配置」处理，由 ensureExtras 那条
        // 日志承担可观测性（它读的是同一份文件，失败会打日志），这里不重复报。
        value = undefined
      }
    }
    if (!value) return
    pool.register(value, 'request')
  }

  /** 挂到微任务上执行：inject 回调可能在 apply() 半路同步触发，那时下面的 let 还没初始化。 */
  function scheduleMainKeyRegistration() {
    queueMicrotask(() => {
      registerMainKey().catch((error) => {
        log(`主 Key 解析失败：${error?.message ?? error}`)
      })
    })
  }

  /** settings 快照只读一次；服务缺席或命名空间未注册时返回 undefined，绝不抛错。 */
  function safeSettingsTable() {
    try {
      return settingsService?.get?.('llm-pi-ai')
    } catch {
      return undefined
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

    // 目标为 Cline 官方中转 API 的所有请求（含多 key 轮换）。
    // 按主机名匹配而不是整条 URL 的子串：子串会把仿冒主机（api.cline.bot.attacker.example）
    // 和只在路径/查询串里提到 cline.bot 的 URL 都算命中，池里的 Key 会随之发向错误的对象。
    if (url && matchesClineTarget(url, clineMatch)) {
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
      // pi-ai 在没有凭据时可能发出「Bearer undefined / Bearer null」乃至裸「Bearer」这类
      // 占位头：一律按「没带 key」处理（与 key-pool.register 的拒收口径保持一致）
      const requestKey = /^(undefined|null|bearer)$/i.test(rawRequestKey) ? '' : rawRequestKey
      const hasAuthorization = Boolean(headers.get('authorization'))
      const hasApiKey = Boolean(headers.get('x-api-key'))
      if (requestKey) pool.register(requestKey, 'request')
      // 额外 key 必须在首次判定前就位，否则「全池冷却」与「挑备用 key」都会失真
      await ensureExtrasQuiet()
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
        quotaStore.setDiagnostics({ ...diag })
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

      // Request 形态下 body 只能消费一次：sendWith 重建 Request 时需要一份可重发副本。
      // 这里**不能**再用 `pool.size > 1` 当条件——池里只有一把 key 时同样会走 sendWith
      // 重建这条路，旧条件会让 bufferedBody 保持 undefined，请求体随之被清空。
      // 缓冲失败也**不能**静默当成「没有 body」：宁可显式放弃轮换，也不能改变请求内容。
      let bufferedBody
      let bodyBufferFailed = false
      if (input instanceof Request) {
        try {
          bufferedBody = await input.clone().arrayBuffer()
        } catch {
          bodyBufferFailed = true
        }
      }

      // `(url, init)` 形态下要发出去的请求体：默认就是 init.body 原样。
      // 唯一会改写它的是**上游锁定**（config.pinUpstream，见 lib/host/pin.js）——
      // 没配置锁定时这里逐字节等于原请求，与既有契约一致。
      const requestBody = init?.body

      const model =
        input instanceof Request
          ? readModelOf(bufferedBody ? new TextDecoder().decode(bufferedBody) : undefined)
          : readModelOf(init?.body)

      // 上面那条轨迹是在 model 解析**之前**建的（那时只看得见 init?.body，Request 形态
      // 下恒为 '*'）。把真实解析出的模型写回，面板的「最近决策」才不会对 Request 形态
      // 流量一直显示 '*'；bodyLen 同理，从占位的 -1 改成真实字节数（只进 diagnostics，
      // 不进面板载荷）。
      trace.model = model
      if (input instanceof Request) trace.bodyLen = bufferedBody?.byteLength ?? -1

      // ── 上游锁定（可选）────────────────────────────────────────────────
      // 配置了 pinUpstream[model] 时，把 `provider: { only:[provider], allow_fallbacks }`
      // 注入请求体，让网关只走指定上游。这是本插件唯一会改写请求体的地方：
      // 没配置锁定 → outgoingBody 与收到的字节完全相同（回归锁 C1 继续守着这条）。
      // 注入在**所有**发送路径上生效（首发送 + 换 key 重发都用同一份 outgoingBody），
      // 否则换 key 重发会悄悄漂回随机路由。
      const pin = pinnedUpstream.get(model)
      const outgoingBody = (() => {
        if (!pin) return input instanceof Request ? bufferedBody : requestBody
        if (input instanceof Request) {
          if (bodyBufferFailed || bufferedBody === undefined) return bufferedBody
          const original = new TextDecoder().decode(bufferedBody)
          const patched = injectPinnedProvider(original, pin.provider, pin.allowFallbacks)
          if (patched === original) return bufferedBody
          diag.pinApplied += 1
          return new TextEncoder().encode(patched)
        }
        if (typeof requestBody !== 'string') return requestBody
        const patched = injectPinnedProvider(requestBody, pin.provider, pin.allowFallbacks)
        if (patched !== requestBody) diag.pinApplied += 1
        return patched
      })()

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

      // 首发送默认沿用请求自带的 key（即 DSH 里配置的那个），轮换只作为撞限流后的兜底。
      // 面板为**当前模型**选定了「使用中」的 key 时它优先：首发送改用选定那把（请求没带 key
      // 时也由它补上）。选定只决定「从哪把开始」——撞限流后的轮换、快速失败等一概不变；
      // 该模型没有选定、或选定的 key 已不在池中时 selected() 返回 undefined，静默退回原行为。
      let currentKey = requestKey
      const selected = pool.selected(model)
      if (selected) {
        currentKey = selected.key
        writeKeyTo(headers, currentKey, authTarget)
      }
      // 即使该 key 已被本地记为「冷却中」也仍然先试一次：本地冷却只是推测，
      // 服务端额度可能已重置，先试一次比直接换 key 更可预测。
      // 若确实希望省掉这次白撞（例如主 key 已被限 22 小时），把 skipCoolingRequestKey 打开。
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
          // 用 `new Request(input, …)` 而不是 `new Request(input.url, …)`：前者继承原请求的
          // signal / credentials / redirect / mode 等字段，后者会把这些全部丢掉——实测 abort
          // 信号因此失效，客户端取消再也传不到上游。
          // body 只在拿到可重发副本时才覆盖；拿不到就**省略**，让构造器继承 input 自己的 body。
          // 绝不能传 `body: undefined`——那等于把请求体清空（实测服务端收到 0 字节）。
          const rebuilt = new Request(input, {
            method: input.method,
            headers: sendHeaders,
            ...(body !== undefined ? { body } : input.body ? { duplex: 'half' } : {}),
          })
          return originalFetch.call(this, rebuilt)
        }
        // `(url, init)` 形态：body 只在**真的带了值**时才覆盖 init.body。绝不能传
        // `body: undefined`——那会把原有的请求体抹掉（与 Request 分支同一个坑）。
        // 这里原先无条件 `{ ...init, headers }`，等于丢掉传进来的 body：上游锁定改写出来的
        // 请求体因此发不出去（轮换重发本来也该用这份副本）。
        return originalFetch.call(this, input, {
          ...init,
          headers: sendHeaders,
          ...(body !== undefined ? { body } : {}),
        })
      }

      let response
      try {
        response = await sendWith(headers, outgoingBody)
      } catch (error) {
        // 传输层异常（abort / DNS / TLS）：与其余路径一样留下决策与日志，不让轨迹停在 inspecting
        decide(`transport-error ${String(error?.message ?? error).slice(0, 80)}`)
        log(`Cline 首发送失败（model=${model}）：${error?.message ?? error}`)
        throw error
      }
      if (currentKey) pool.markSent(currentKey, model)
      if (!rotateStatuses.includes(response.status)) {
        // 只有 2xx 才算「这把 key 成功了」：markHealthy 会清掉冷却记录并把 ok 计数 +1。
        // 5xx / 4xx 走到这里时上游其实拒绝了这次请求，若也按成功记，面板的「成功」列会系统性
        // 高估（实测 500 被记成 ok=1），而它正是用户判断「这把 key 还能不能用」的依据。
        if (currentKey && response.ok) {
          pool.markHealthy(currentKey, model)
          // 这个模型有选定、但实际跑通的是另一把（典型：选定的那把已冷却、被
          // skipCoolingRequestKey 直接跳过），让「使用中」跟着挪到真正在用的这把——
          // 否则面板会指着一把没在用的 Key（用户报的「标记没跟着换」就是这条）。
          if (pool.followRotation(model, currentKey)) log(`已把 ${model} 的「使用中」改为 ${keyLabel(currentKey)}（实际在用）`)
        } else if (currentKey) pool.markFailed(currentKey, model)
        // 记下这次实际上是哪个上游服务的（只读观测，面板据此显示）。
        // 只在这一条出路做：429/5xx 的报文里没有路由信息，拿了也是白拿。
        if (response.ok) await observeUpstream(model, response, currentKey ? keyLabel(currentKey) : '')
        decide(`pass-through status=${response.status}`)
        // 顺手把这轮响应的 token 用量记到「key + 模型」上（失败静默，不影响请求）
        return currentKey ? tapUsage(response, (usage, ms) => pool.markTokens(currentKey, model, normalizeUsage(usage), ms)) : response
      }

      // 重发要求 body 可原样重建（字符串 / 字节），流式 body 只能原样返回。
      // `requestBody` 就是实际发出去的那份（`(url, init)` 形态下它可能被改写，虽然本插件
      // 现在不再改写请求体，但按「实际发出去的」判断永远是对的）。
      const replayable = input instanceof Request
        ? !bodyBufferFailed && (bufferedBody !== undefined || !input.body)
        : replayableBody(requestBody)
      if (!replayable || !currentKey) {
        decide(`cannot-rotate replayable=${replayable} keyPresent=${Boolean(currentKey)} status=${response.status}`)
        return response
      }

      let lastText = await response.clone().text()
      // 冷却窗口只认服务端给的：报文窗口 → Retry-After 头；两者都没有时用 clineCooldownMs
      // 兜底，而它默认是 0 = 不补（见 defaults.js：不自己编恢复时刻）。
      pool.markCooling(currentKey, model, cooldownMsFromResponse(response, lastText) || clineCooldownMs, lastText)
      await ensureExtrasQuiet()

      // 本次请求已经试过的 key：换 key 重发时绝不挑回同一把。服务端没给恢复时刻时
      // 冷却记录为空、冷却跳过不生效，只有这个显式排除能拦住 MRU 把失败那把又挑回来。
      const tried = new Set([keyLabel(currentKey)])
      for (let attempt = 0; attempt < MAX_ROTATE_ATTEMPTS; attempt++) {
        const next = pool.pick(model, tried)
        if (!next) break
        tried.add(next.label)
        const nextHeaders = new Headers(headers)
        writeKeyTo(nextHeaders, next.key, authTarget)

        let retried
        try {
          retried = await sendWith(nextHeaders, outgoingBody)
          pool.markSent(next.key, model)
        } catch (error) {
          log(`Cline 换 key 重发失败（key=${next.label}）：${error?.message ?? error}`)
          break
        }

        if (!rotateStatuses.includes(retried.status)) {
          if (retried.ok) {
            pool.markHealthy(next.key, model)
            diag.rotations += 1
            decide(`rotated ${keyLabel(currentKey)}→${next.label} model=${model}`)
            log(`Cline 限流已换 key 恢复（${keyLabel(currentKey)} → ${next.label}, model=${model}）`)
            // 这个模型在面板上若有「使用中」的选定，让它跟着挪到真正跑通的这把：否则面板会
            // 一直标着一把已经限流的 key，而实际在用的是另一把。没选定的模型不受影响。
            if (pool.followRotation(model, next.key)) log(`已把 ${model} 的「使用中」改为 ${next.label}（原选定已限流）`)
            // 重发成功这条也要记上游（首发送撞 429，真正跑通的是这一次）
            await observeUpstream(model, retried, keyLabel(next.key))
          } else {
            // 换 key 后拿到的是 4xx/5xx：这次轮换并没有「恢复」，别把它计成成功，
            // 也别把冷却清掉——留着继续试池里下一把。
            pool.markFailed(next.key, model)
            decide(`rotate-failed ${keyLabel(currentKey)}→${next.label} status=${retried.status} model=${model}`)
          }
          return tapUsage(retried, (usage, ms) => pool.markTokens(next.key, model, normalizeUsage(usage), ms))
        }

        lastText = await retried.clone().text()
        pool.markCooling(next.key, model, cooldownMsFromResponse(retried, lastText) || clineCooldownMs, lastText)
        currentKey = next.key
        response = retried
      }

      // 备用 key 全部尝试完仍失败。区分两种情况：
      //   - 额度耗尽（每日上限之类，重试窗口以小时计）：显式标记 x-should-retry:false，
      //     pi-ai 的 provider-retry 会读取该头并立即放弃，省掉无意义的退避等待；
      //   - 瞬时限流：原样返回，交给 pi-ai 按 retry-after / 指数退避重试。
      // 窗口同样取「报文文本 → Retry-After 头」两个来源：只认报文的话，一个带
      // `retry-after: 3600` 却没有可解析文本的 429 会被当成瞬时限流放行给 pi-ai 空等。
      const windowMs = cooldownMsFromResponse(response, lastText)
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
  const importPath = '/dsh-cline-bridge/keys/import'
  const resetPath = '/dsh-cline-bridge/keys/stats/reset'
  const selectPath = '/dsh-cline-bridge/keys/select'

  /** ref → 当前值：凭据服务优先（反映 DSH 眼里的真实值），服务缺席或未就绪时直读文件。
   *  关键约束：**解析失败 ≠ 空闲**。服务 resolve 抛错（钥匙串锁住、文件正被占用……）时
   *  那把 ref 的状态是「不明」，不是「没人用」——若当成空闲，导入就会用 set() 把用户
   *  正在用的 Key 静默覆盖掉（回包还显示「导入成功」）。不明的槽位先退文件直读兜底
   *  确认一次，仍不明就记入 unknown，本次导入一个都不用。 */
  const readClineKeyRefs = async () => {
    const values = new Map(wantedKeyRefs.map((ref) => [ref, undefined]))
    const unknown = new Set()
    const service = credentialsService
    if (service && typeof service.resolve === 'function') {
      await Promise.all(
        wantedKeyRefs.map(async (ref) => {
          try {
            const found = await service.resolve(ref)
            if (found && typeof found.value === 'string' && found.value) values.set(ref, found.value)
          } catch {
            unknown.add(ref)
          }
        }),
      )
      // 服务说不清的槽位，退回文件直读确认一次（读侧本来就有这条兜底）
      if (unknown.size > 0 && config?.readCredentialsFile !== false) {
        try {
          for (const [ref, value] of readCredentialRefsFromFile(resolveCredentialsFilePath(config), [...unknown])) {
            values.set(ref, value)
          }
          // 文件读到了：在里面的按占用、不在里面的真空闲；文件不存在也按全部空闲。
          // 只有「读到了但解析/权限失败」才保持状态不明（importClineKeys 会跳过这些槽位）。
          unknown.clear()
        } catch (error) {
          if (error?.code === 'ENOENT') unknown.clear()
        }
      }
      return { values, unknown, source: 'credentials' }
    }
    try {
      for (const [ref, value] of readCredentialRefsFromFile(resolveCredentialsFilePath(config), wantedKeyRefs)) {
        values.set(ref, value)
      }
    } catch (error) {
      // 文件不存在 = 全部真空闲；读到了但解析/权限失败 = 全部状态不明（宁可这次导不进去）
      if (error?.code !== 'ENOENT') wantedKeyRefs.forEach((ref) => unknown.add(ref))
    }
    return { values, unknown, source: 'file' }
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
    let scope = ''
    try {
      // 空正文也要读完，否则连接会一直半开着
      const body = await readJsonBody(req, 1024)
      if (body && typeof body === 'object' && body.scope === 'speed') scope = 'speed'
    } catch (error) {
      if (error?.code === 'PAYLOAD_TOO_LARGE') return sendJson(res, 413, { error: String(error.message) })
      // 正文不是 JSON 也无所谓：重置不需要任何入参
    }
    if (scope === 'speed') {
      pool.resetSpeed()
      diag.lastDecision = 'speed-reset'
      quotaStore.setDiagnostics({ ...diag })
      quotaStore.flush()
      log('速度数据已重置（仅 tokens.ms 归零；计数、token、冷却与额度未动）')
      return sendJson(res, 200, { ok: true, scope: 'speed', totals: quotaStore.totals(), poolSize: pool.size })
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
    quotaStore.setDiagnostics({ ...diag })
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
      // 状态不明的槽位（服务解析失败、文件也确认不了）：绝不往里写
      unknownRefs: current.unknown,
      writeRef: writeClineKeyRef,
      // 池内已知标签：粘一把已经在用的 Key 会被判为重复，而不是又写一份
      poolLabels: new Set(pool.snapshot().map((entry) => entry.label)),
    })

    // 只有真写进去了才重扫：把新 ref 立刻收进池子（顺带刷新来源标签与池大小）
    if (report.imported.length > 0) {
      await ensureExtrasQuiet({ force: true })
    }
    // 日志只有计数，没有 Key 材料
    log(
      '导入 Key：新增 ' + report.imported.length + '，重复 ' + report.duplicates.length +
        '，拒绝 ' + report.rejected.length + '，失败 ' + report.failed.length +
        (report.refsUnknown.length > 0 ? '，槽位状态不明 ' + report.refsUnknown.length + ' 个（已跳过）' : '') +
        '（来源：' + current.source + '）',
    )
    return sendJson(res, 200, {
      ok: true,
      writeMode: current.source,
      imported: report.imported,
      duplicates: report.duplicates,
      rejected: report.rejected,
      failed: report.failed,
      refsFree: report.refsFree,
      refsUnknown: report.refsUnknown,
      poolSize: pool.size,
      maxKeys: MAX_IMPORT_KEYS,
    })
  }

  /** 为**某个模型**选定 / 取消「使用中」的 Key：只认池内已知的 8 位标签，空值＝取消（幂等）。
   *  模型与标签两维都必填——选定是「这个模型上用这把」，缺模型就没法对号入座。
   *  它不改凭据——只决定插件发请求时从哪把开始（撞限流后照常轮换），所以闸门与
   *  另两条写路由完全一致，回包也只有模型名与标签，没有任何 Key 材料。 */
  const handleKeySelect = async (req, res) => {
    if (!passWriteGuard(req, res)) return
    if (!isJsonRequest(req)) return sendJson(res, 415, { error: 'content-type must be application/json' })
    let payload
    try {
      payload = await readJsonBody(req, 1024)
    } catch (error) {
      const tooLarge = error?.code === 'PAYLOAD_TOO_LARGE'
      return sendJson(res, tooLarge ? 413 : 400, { error: String(error?.message ?? error) })
    }
    const rawModel = payload?.model
    const raw = payload?.label
    // 类型不对时明确报错，而不是静默当成「取消」——面板永远发字符串，这里是防手改请求
    if ((rawModel !== undefined && typeof rawModel !== 'string') || (raw !== undefined && raw !== null && typeof raw !== 'string')) {
      return sendJson(res, 400, { error: 'model and label must be strings' })
    }
    const model = typeof rawModel === 'string' ? rawModel.trim() : ''
    const label = typeof raw === 'string' ? raw.trim() : ''
    if (!isPlausibleModelId(model)) return sendJson(res, 400, { error: 'model is required' })
    if (!pool.setSelection(model, label)) return sendJson(res, 400, { error: 'unknown key label' })
    const applied = pool.selected(model)
    log(applied ? `已为 ${model} 选定使用 key ${applied.label}` : `已取消 ${model} 上的选定`)
    return sendJson(res, 200, {
      ok: true,
      model,
      selection: applied ? { label: applied.label } : null,
    })
  }

  // ───────────────────── 设置面板：只读状态路由 ─────────────────────
  // 面板本体是浏览器半边（lib/client.js，经 package.json 的 dsh.client 声明由
  // dsh-client-modules 打包投放）；它需要主机端把 key 池状态交出来，这里用一条
  // 同源只读路由提供。
  //
  // 关键：这条路由**不能**用模块级 `export const inject = ['webServer']` 来等依赖——
  // 那会把整个插件（包括 fetch 补丁）门控在 webServer 上，headless/acp/desktop
  // 这些没有 webServer 的 profile 里连 Cline 渠道桥接都会一起失效。
  // 正确做法是 ctx.inject 开一个子 fiber（DSH 自身大量使用这个模式，例如
  // dsh-client-modules 就是这么挂 /plugins 路由的），只为路由等 webServer。
  const statusRoute = {
    path: '/dsh-cline-bridge/keys',
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
          // 上游观测台账（只读）：面板据此显示「实际走哪家」
          upstreamLog,
        },
        options,
      ),
  }

  {
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
              // 条件请求：载荷没变就回 304（面板每 5 秒轮询一次，绝大多数轮次内容相同）
              return sendJsonConditional(req, res, payload)
            },
          }),
        'dsh-cline-bridge: cline keys route',
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
        'dsh-cline-bridge: cline key import route',
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
        'dsh-cline-bridge: cline stats reset route',
      )
      // 选定「使用中」的 Key：与另两条写路由同一个 webServer 门（headless/acp 下三条一起缺席）
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: selectPath,
            handler: (req, res) => {
              handleKeySelect(req, res).catch((error) => {
                if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
              })
            },
          }),
        'dsh-cline-bridge: cline key select route',
      )
    })
  }

  // 自检工具用的观察入口（不含 key 原文）
  ctx.__dshClineBridge = {
    clineKeys: () => pool.snapshot(),
    /** 累计计数与统计起点（自检用来断言「跨重启没丢」）。 */
    statsTotals: () => quotaStore.totals(),
    resetStats: () => pool.resetStats(),
    /** 只清速度数据（自检用；与面板「重置速度」按钮同一条路径）。 */
    resetSpeed: () => pool.resetSpeed(),
    /** 某个模型上选定的「使用中」Key（自检用；只有 8 位标签，不含 key 原文）。 */
    selectedLabel: (model) => pool.selected(model)?.label ?? '',
    setSelection: (model, label) => pool.setSelection(model, label),
    status: (options) => statusRoute.build(options),
    routePath: statusRoute.path,
    // 强制立刻重扫一次额外 key 来源（自检用；运行期新增 ref 的正式路径是 5 分钟自动复扫）
    ensureExtras: (options) => pool.ensureExtras(ctx, config, options),
    parseRetryWindowMs,
    quotaStatePath: quotaStore.path,
    flushQuotaState: () => quotaStore.flush(),
    /** 额外 key 来源的解析状态（原本随面板载荷下发，现已从载荷移除，仅自检使用）。 */
    extras: () => ({
      credentialsFileRead: Boolean(diag.credentialsFileRead),
      extrasResolved: Boolean(diag.extrasResolved),
      lastExtrasAt: diag.lastExtrasAt ?? '',
    }),
    /** 诊断快照（跨重启保留的那份）。 */
    diagnostics: () => quotaStore.diagnostics(),
  }
}
