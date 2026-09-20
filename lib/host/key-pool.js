/**
 * Cline 多 key 池：来源登记、按 key+模型 冷却、粘性选 key、面板选定的「使用中」key、按模型用量计数。
 *
 * 冷却状态、用量统计与「使用中」的选定都经 quotaStore 落盘（按 8 位哈希标签恢复，插件更新不清零）；
 * 留在内存里的只有来源标签。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { DEFAULT_CLINE_KEY_REFS, EXTRAS_RETRY_MS, EXTRAS_TTL_MS, MAX_POOL_KEYS, MAX_STORED_ERROR_BODY, resolveCredentialsFilePath } from './defaults.js'
import { keyLabel, maskKey } from './labels.js'
import { readCredentialRefsFromFile } from './credentials.js'

/** key 池：按模型维度记录冷却时间，选 key 时**粘性优先**——先把一把用到限流再换下一把。
 *  冷却状态会经由 quotaStore 落到磁盘，DSH 重启后仍知道「哪个 key 在哪个模型上被限到几点」。
 *  每把 key 另带来源标签与累计用量计数，供设置面板展示；计数按标签落盘并跨重启恢复。 */
export function createKeyPool(quotaStore, diag, log) {
  // 契约：三个参数都由调用方当场构造（全仓只有 index.js 一个调用点），永不为空，
  // 所以下面直接调用、不再写 quotaStore?.xxx?.() / log?.() 这类不可达的可选链。
  const entries = new Map() // label → { key, label, source, cooling: Map<model, readyAt>, lastBody: Map<model, text>, lastUsedAt, firstSeenAt, stats }
  /** 把一把 key 的统计写成纯 JSON 快照交给状态文件（去抖与原子写在 store 里）。
   *  每次计数变化后调用，所以插件更新/DSH 重启都不会把已累计的数字丢掉。 */
  const persistStats = (entry) => {
    quotaStore.setUsage(entry.label, {
      firstSeenAt: entry.firstSeenAt,
      lastUsedAt: entry.lastUsedAt,
      stats: {
        sent: entry.stats.sent,
        ok: entry.stats.ok,
        failed: entry.stats.failed,
        limited: entry.stats.limited,
        lastModel: entry.stats.lastModel,
        lastUsedAt: entry.lastUsedAt,
        tokens: { ...entry.stats.tokens },
      },
      models: Object.fromEntries(
        Object.entries(entry.stats.byModel).map(([model, row]) => [
          model,
          { sent: row.sent, ok: row.ok, failed: row.failed, limited: row.limited, lastUsedAt: row.lastUsedAt, tokens: { ...row.tokens } },
        ]),
      ),
    })
  }
  // 额外 key 未就绪时必须可重试：凭据服务可能在插件挂载之后才注册
  let extrasResolved = false
  let lastExtrasAttempt = 0

  /** 每把 key 最多保留多少个模型行。磁盘侧 STATE_MAX_KEYS 管的是「多少把 key」，
   *  这里管的是「一把 key 见过多少个模型」——长跑进程里模型名可能被不断带进来
   *  （换模型、写错模型的请求、上游回显），不裁剪就会一直涨。 */
  const MAX_MODELS_PER_KEY = 40
  /** 单次 token 累加的上限：超过它一定是上游给了异常值（或字段被写坏），
   *  按上限夹住而不是原样累加，避免一个坏数字污染「这把 key 用了多少」的统计。 */
  const MAX_TOKEN_PER_REPORT = 1e9

  /** 模型行超过上限时，按 lastUsedAt 丢掉最久没用过的那些。
   *  正在用的模型（刚被 touch，lastUsedAt 最大）永远不会被丢。
   *  定义放在 modelRowOf 之前：后者会调它，避免「引用在前、声明在后」这类
   *  只在特定调用时机才暴露的 TDZ 问题（本仓库已经栽过一次，见 index.js 的 log）。 */
  const trimModels = (entry) => {
    const keys = Object.keys(entry.stats.byModel)
    if (keys.length <= MAX_MODELS_PER_KEY) return
    keys
      .sort((a, b) => (entry.stats.byModel[a].lastUsedAt || 0) - (entry.stats.byModel[b].lastUsedAt || 0))
      .slice(0, keys.length - MAX_MODELS_PER_KEY)
      .forEach((model) => { delete entry.stats.byModel[model] })
  }

  /** 取（必要时创建）某把 key 在某模型上的计数行。
   *  byModel 用 null 原型，避免模型名撞上 __proto__ 之类的键。 */
  const modelRowOf = (entry, model) => {
    if (!model) return undefined
    let row = entry.stats.byModel[model]
    if (!row) {
      // lastUsedAt 必须当场给成「现在」而不是 0：trimModels 按 lastUsedAt 升序丢最旧的，
      // 新行若是 0 就会**先把自己丢掉**（实测：连发 60 个模型后，留下的是最早的 40 个、
      // 最新的反而不见了）。bumpModelStat 稍后也会设这个值，但不能指望它——trim 就在前面。
      row = { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: Date.now(), tokens: { input: 0, output: 0, total: 0, cached: 0, ms: 0 } }
      entry.stats.byModel[model] = row
      trimModels(entry)
    }
    return row
  }

  /** 累加某把 key 在某个模型上的请求计数。
   *  用量必须按模型分开记：冷却本来就是「key + 模型」维度，把两个模型的数字混在
   *  一行里会让人误判（例如 deepseek 上被限、glm 上其实还在正常跑）。 */
  const bumpModelStat = (entry, model, field) => {
    const row = modelRowOf(entry, model)
    if (!row) return
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
        cooling: new Map(),
        lastBody: new Map(),
        lastUsedAt: 0,
        firstSeenAt: Date.now(),
        stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastModel: '', byModel: Object.create(null), tokens: { input: 0, output: 0, total: 0, cached: 0, ms: 0 } },
      }
      entries.set(label, entry)
      // 请求头带来的 key 是不可信输入（共享部署 / 代理场景下什么 Authorization 都可能出现），
      // 内存池必须像磁盘侧（STATE_MAX_KEYS）一样有上限，否则 entries 只增不减、
      // 每次面板轮询的 describe() 全量排序也跟着无限涨。按 MRU 丢最久没用的；
      // 被丢的 key 若再出现会重新 register 并从磁盘恢复冷却与统计，不丢事实。
      if (entries.size > MAX_POOL_KEYS) {
        const victims = [...entries.values()]
          .filter((candidate) => candidate !== entry)
          .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.firstSeenAt - b.firstSeenAt)
        for (const victim of victims.slice(0, entries.size - MAX_POOL_KEYS)) entries.delete(victim.label)
      }
      // 恢复该 key 上次进程留下的额度状态（按 label 匹配，磁盘上没有 key 原文）
      for (const [model, record] of quotaStore.forLabel(label)) {
        entry.cooling.set(model, record.readyAt)
        if (record.body) entry.lastBody.set(model, record.body)
      }
      // 用量统计同样按 label 恢复：插件更新 / DSH 重启不该把「这把用了多少」清零。
      // lastUsedAt 也一起回来，于是「粘性选 Key」跨重启仍然是接着烧同一把。
      const saved = quotaStore.usageFor(label)
      if (saved) {
        entry.firstSeenAt = saved.firstSeenAt || entry.firstSeenAt
        entry.lastUsedAt = saved.lastUsedAt || 0
        entry.stats.sent = saved.stats.sent
        entry.stats.ok = saved.stats.ok
        entry.stats.failed = saved.stats.failed
        entry.stats.limited = saved.stats.limited
        entry.stats.lastModel = saved.stats.lastModel
        entry.stats.tokens = { ...saved.stats.tokens }
        for (const [model, row] of Object.entries(saved.models)) {
          entry.stats.byModel[model] = { ...row, tokens: { ...row.tokens } }
        }
        // 磁盘上的旧文件可能已经超过上限（更早的版本没有裁剪），恢复后补一刀
        trimModels(entry)
      }
    }
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

      const refs = config?.clineKeyRefs ?? DEFAULT_CLINE_KEY_REFS

      const env = globalThis.process?.env ?? {}
      for (const [name, chunk] of [['CLINE_API_KEYS', env.CLINE_API_KEYS], ['CLINE_FREE_API_KEYS', env.CLINE_FREE_API_KEYS]]) {
        if (!chunk) continue
        for (const key of String(chunk).split(/[\s,;]+/)) register(key, `env: ${name}`)
      }
      // env 扫描与文件直读用同一份 ref 名单（自定义 clineKeyRefs 不该只对文件生效）
      for (const ref of refs) register(env[ref], `env: ${ref}`)

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
      quotaStore.setDiagnostics(diag)
      log(`Cline key 池：${entries.size} 个 key（来源：config、启动环境变量、.credentials.yaml）`)
    },
    /** 挑一把备用 key：**粘性**优先，即「先把一把用到限流，再换下一把」。
     *
     *  取的是「最近还在用的那把」（MRU），而不是轮换摊派（LRU）。原因是 Cline 的免费
     *  额度按 `key + 模型` 每天重置：摊开用会让池子里所有 key 几乎同时逼近上限、
     *  一起失去后备；压着一把烧完再换，池子里才始终留着没动过的额度。
     *  冷却是硬条件——当前模型上已冷却的 key 一律跳过，所以「用到限流」时自然会换人。
     *
     *  lastUsedAt 的取值为 0 表示这把 key 本次运行还没碰过；MRU 会优先选已经用过
     *  （即已经烧掉一部分额度）的那把，而不是去开一把全新的，正是这个语义要的效果。
     *
     *  `exclude`（可选，8 位标签集合）是**本次请求已经试过的 key**：换 key 重发时用，
     *  保证不会挑回刚撞限流的那把。服务端没给恢复时刻时冷却记录为空、冷却跳过不生效，
     *  这时只能靠这个显式排除——否则 MRU 会把刚失败的那把又挑回来。 */
    pick(model, exclude) {
      const now = Date.now()
      let best
      for (const entry of entries.values()) {
        if (exclude?.has(entry.label)) continue
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
    /** 某个模型上选定的「使用中」Key（首发送优先用它）：按标签在池里找回这把 key 原文。
     *  该模型没有选定、或选定的 key 已不在池中（凭据被删 / ref 改过）时返回 undefined——
     *  调用方据此静默退回「首发送用请求自带的 key」。选定**按模型各记一条**：冷却与用量
     *  本来就是 key+模型 维度，给 deepseek 选了某把 key 不该连带影响 glm。 */
    selected(model) {
      const label = quotaStore.selectionFor(model)?.label
      if (!label) return undefined
      const entry = entries.get(label)
      return entry ? { key: entry.key, label: entry.label } : undefined
    },
    /** 全部选定（model → 8 位标签），供面板载荷使用。 */
    selections() {
      return quotaStore.selections()
    },
    /** 面板为某个模型设定「使用中」的 Key：只接受池内已知的标签（否则返回 false 且不写入
     *  任何状态），空值＝取消该模型的选定（幂等）。落盘与跨重启恢复由 quotaStore 负责
     *  （只有 8 位标签，无 key 原文）。 */
    setSelection(model, label) {
      const value = typeof label === 'string' ? label.trim() : ''
      if (!value) return quotaStore.setSelection(model, '')
      if (!entries.has(value)) return false
      return quotaStore.setSelection(model, value)
    },
    /** 轮换成功后的**跟随**：只在该模型已有选定时，把「使用中」挪到真正跑通的那把——
     *  否则面板会一直标着一把已经限流的 key，而实际在用的是另一把。没有选定的模型不动：
     *  那是「首发送用请求自带 key」的默认形态，插件不擅自替用户选。 */
    followRotation(model, key) {
      const current = quotaStore.selectionFor(model)
      if (!current) return false
      // 选定指向的 key 已不在池中（凭据被删 / 这次没读到）：面板正显示「已不在池中」，
      // 这时首发送退回的是请求自带的 key，**不**算「换了一把在用」——若也跟随，
      // 用户「别烧主 Key」的选定就会被一次成功请求悄悄改写到主 Key 上。
      if (!entries.has(current.label)) return false
      const entry = entries.get(keyLabel(key))
      if (!entry || entry.label === current.label) return false
      return quotaStore.setSelection(model, entry.label)
    },
    /** 记一次「真的发给了上游」（设置面板的用量计数用；就地落盘，跨重启保留）。 */
    markSent(key, model) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      entry.stats.sent += 1
      entry.stats.lastModel = model
      entry.lastUsedAt = Date.now()
      bumpModelStat(entry, model, 'sent')
      persistStats(entry)
    },
    /** 记一次限流（429）。冷却窗口只认服务端给的：ms > 0 时记下恢复时刻并落盘；
     *  ms <= 0 表示「服务端说了限流、但没给恢复时刻」——照样计数、照样留档，
     *  但**不编造**一个冷却时间（编出来的不只会让面板显示假倒计时，还会让
     *  「全池冷却快速失败」在不该触发的时候触发）。 */
    markCooling(key, model, ms, body) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      // 落盘/回放只需要错误码与「Try again in …」那几行：上游回一个几十 MB 的报错页
      // 不能原样进内存、进状态文件（每 500ms 去抖写一次）、再原样回放给客户端。
      const storedBody = typeof body === 'string' && body.length > MAX_STORED_ERROR_BODY ? body.slice(0, MAX_STORED_ERROR_BODY) : body
      entry.lastUsedAt = Date.now()
      entry.stats.limited += 1
      entry.stats.lastModel = model
      if (storedBody) entry.lastBody.set(model, storedBody)
      bumpModelStat(entry, model, 'limited')
      if (Number.isFinite(ms) && ms > 0) {
        const readyAt = Date.now() + ms
        entry.cooling.set(model, readyAt)
        quotaStore.set(entry.label, model, readyAt, storedBody)
      }
      persistStats(entry)
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
      quotaStore.clear(entry.label, model)
      persistStats(entry)
    },
    /** 记一次「上游明确拒绝了这次请求」的响应（非 2xx 且不在轮换状态码里，例如 500 / 400）。
     *  与 markHealthy 的区别只有一个：**不动冷却记录**——失败不代表这把 key 的额度恢复了。
     *  单独计数而不是并进 ok，是为了让面板的「成功」列保持可信。 */
    markFailed(key, model) {
      const entry = entries.get(keyLabel(key))
      if (!entry) return
      entry.stats.failed += 1
      entry.stats.lastModel = model
      entry.lastUsedAt = Date.now()
      bumpModelStat(entry, model, 'failed')
      persistStats(entry)
    },
    /** 记一次响应里的 token 用量（key + 模型两个维度同时累加）。不碰 lastUsedAt：
     *  用量是发送之后才回来的，时间戳该由发送那一刻决定。
     *  ms = 这次流式响应的耗时（毫秒，0 表示未知，如非流式）——面板拿 output/ms 算输出速度。 */
    markTokens(key, model, usage, ms = 0) {
      const entry = entries.get(keyLabel(key))
      if (!entry || !usage) return
      const row = modelRowOf(entry, model)
      if (!row) return
      for (const field of ['input', 'output', 'total', 'cached']) {
        const value = Number(usage[field]) || 0
        if (!value || value < 0) continue
        // 单次上报超过上限一定是异常值：夹住而不是原样累加（见 MAX_TOKEN_PER_REPORT）
        const safe = Math.min(value, MAX_TOKEN_PER_REPORT)
        row.tokens[field] += safe
        entry.stats.tokens[field] += safe
      }
      // 流式耗时同样夹住异常值（单次上限 10 分钟——比任何正常生成都长，只挡明显坏数据）
      const msSafe = Math.min(Math.max(Number(ms) || 0, 0), 10 * 60 * 1000)
      if (msSafe > 0) {
        row.tokens.ms += msSafe
        entry.stats.tokens.ms += msSafe
      }
      persistStats(entry)
    },
    /** 清零统计（内存 + 磁盘）：计数、token、「最近使用」与粘性基准全部归零。
     *  冷却与额度一概不动——那是服务端的事实，不是我们的计数。 */
    resetStats() {
      const now = Date.now()
      for (const entry of entries.values()) {
        const byModel = Object.create(null)
        // 保留按模型的行、只把数字归零：「按模型用量」卡与模型芯片条仍知道这些模型存在过
        for (const model of Object.keys(entry.stats.byModel)) {
          byModel[model] = { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: { input: 0, output: 0, total: 0, cached: 0, ms: 0 } }
        }
        entry.stats = { sent: 0, ok: 0, failed: 0, limited: 0, lastModel: '', byModel, tokens: { input: 0, output: 0, total: 0, cached: 0, ms: 0 } }
        entry.lastUsedAt = 0
        entry.firstSeenAt = now
        persistStats(entry)
      }
    },
    /** 只清零流式耗时累计（tokens.ms），其余统计一概不动（用户要求：速度数据可以
     *  单独丢弃——修复过计时缺陷后旧 ms 是脏数据，但计数与 token 还想留着）。
     *  清零后速度列显示「—」，直到下一批新请求带 ms 回来。 */
    resetSpeed() {
      for (const entry of entries.values()) {
        let touched = false
        if (entry.stats.tokens.ms > 0) { entry.stats.tokens.ms = 0; touched = true }
        for (const row of Object.values(entry.stats.byModel)) {
          if (row.tokens.ms > 0) { row.tokens.ms = 0; touched = true }
        }
        if (touched) persistStats(entry)
      }
    },
    /** 供自检工具观察状态，不暴露 key 原文。 */
    snapshot() {
      const now = Date.now()
      return [...entries.values()].map((entry) => ({
        label: entry.label,
        sent: entry.stats.sent,
        ok: entry.stats.ok,
        failed: entry.stats.failed,
        limited: entry.stats.limited,
        cooling: [...entry.cooling.entries()].filter(([, until]) => until > now).map(([model]) => model),
        quota: [...entry.cooling.entries()]
          .filter(([, until]) => until > now)
          .map(([model, until]) => ({ model, readyAt: until, readyInMin: Math.max(1, Math.round((until - now) / 60000)) })),
        lastUsedAt: entry.lastUsedAt,
      }))
    },
    /** 设置面板用的完整视图：带来源、掩码预览与累计用量。每个 key 原文都只经 maskKey 处理。 */
    describe(options) {
      const now = Date.now()
      const withPreview = options?.revealPreview !== false
      return [...entries.values()]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.label.localeCompare(b.label))
        .map((entry, index) => ({
          index: index + 1,
          label: entry.label,
          preview: withPreview ? maskKey(entry.key) : '',
          // 只保留「来源」这一项出处信息；不再单独标「哪把是 DSH 主 key」——
          // 开启 skipCoolingRequestKey 后池内 key 一律同级（该冷却就跳过，不搞特殊）。
          source: entry.source,
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
            failed: entry.stats.failed,
            limited: entry.stats.limited,
            lastModel: entry.stats.lastModel,
            lastUsedAt: entry.lastUsedAt,
            tokens: { ...entry.stats.tokens },
          },
          // 按模型的用量明细（面板切到某个模型时看的就是这份）。
          // `upstream` 是「这把 key 在这个模型上最近一次实际走的上游」——按 key+模型记，
          // 不能拿模型维度的结论复制给每一行：那看着像事实，其实是编的（上游是每次请求
          // 由网关决定的）。没观测到就是 undefined，面板显示「—」而不是猜一个。
          // 缓存命中率**不在这里下发**：它由 tokens.cached / tokens.input 直接算得，
          // 面板手里已经有这两个原始数——再下发一个派生值等于同一事实两份、还可能不一致。
          models: Object.fromEntries(
            Object.entries(entry.stats.byModel).map(([model, row]) => [
              model,
              {
                sent: row.sent,
                ok: row.ok,
                failed: row.failed,
                limited: row.limited,
                lastUsedAt: row.lastUsedAt,
                tokens: { ...row.tokens },
                upstream: options?.upstreamLog?.getForKey?.(entry.label, model),
              },
            ]),
          ),
        }))
    },
  }
}
