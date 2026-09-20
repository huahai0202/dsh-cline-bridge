/**
 * 设置面板的状态载荷：把 key 池、计数、模型清单整理成浏览器半边要的 JSON。
 *
 * 这里是主机端唯一的对外数据出口，字段白名单是硬约束：只有哈希标签、掩码预览、
 * 冷却时刻与计数，绝不出现 key 原文，也不整体展开 config（它含 key 原文数组）。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { PLUGIN_VERSION, PREFERRED_UPSTREAM } from './defaults.js'
import { isPlausibleModelId } from './model-id.js'

// ──────────────────── 设置面板的状态载荷 ─────────────────────
// 主机端 → 浏览器半边的唯一数据出口。它只读、只回这些字段：
//   · 每把 key 的 8 位标签、**掩码预览**（可关）、来源、冷却模型与恢复倒计时、
//     累计用量计数（含 token，跨重启保留）；
//   · 全局计数、模型清单与「当前模型」、面板选定的「使用中」Key（只有 8 位标签）、最近几条决策轨迹。
// 绝不出现的内容：key 原文、config.clineKeys（那是 key 原文数组！）、请求体、
// 任何 Authorization 头。改动这里时请把这条约束当成硬性要求。

/** 从 DSH 设置里挑出「走 Cline 通道」的提供方所配置的模型 id。
 *
 *  判据与 fetch 拦截完全一致（提供方 baseURL 命中 clineMatch），所以列出来的模型
 *  一定就是本插件会介入的那些。这一步的意义：面板不该只在「已经发生过流量」之后
 *  才认识某个模型——用户刚切到 glm、一次请求都还没发时，芯片条里就该有 glm。
 *  读的是 settings 的只读快照（深冻结），只取模型 id，绝不碰 apiKeyEnv 等字段。 */
function clineModelsFromSettings(table, clineMatch) {
  const providers = table?.providers
  if (!providers || typeof providers !== 'object') return []
  const out = []
  for (const entry of Object.values(providers)) {
    const base = typeof entry?.baseURL === 'string' ? entry.baseURL : ''
    if (!base || !base.includes(clineMatch)) continue
    for (const model of entry?.models ?? []) {
      const id = typeof model?.id === 'string' ? model.id : ''
      if (id && !out.includes(id)) out.push(id)
    }
  }
  return out
}

/** Cline 提供方（baseURL 命中 clineMatch）的 apiKeyEnv ref：DSH 发给上游的主 Key 就是从它解析的。
 *  可能有多个提供方命中，取第一个配了 apiKeyEnv 的；没有就返回空串。 */
export function clineApiKeyEnvOf(table, clineMatch) {
  const providers = table?.providers
  if (!providers || typeof providers !== 'object') return ''
  for (const entry of Object.values(providers)) {
    const base = typeof entry?.baseURL === 'string' ? entry.baseURL : ''
    if (!base || !base.includes(clineMatch)) continue
    const ref = typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv : ''
    if (ref) return ref
  }
  return ''
}

/** `agent-default-model` 指向 Cline 通道时给出它选中的模型，用作面板的默认筛选项。 */
function agentDefaultForCline(defaultValue, table, clineMatch) {
  const provider = typeof defaultValue?.provider === 'string' ? defaultValue.provider : ''
  const model = typeof defaultValue?.model === 'string' ? defaultValue.model : ''
  if (!provider || !model) return ''
  const base = table?.providers?.[provider]?.baseURL
  return typeof base === 'string' && base.includes(clineMatch) ? model : ''
}

/** 设置面板一次刷新所需的全部内容。 */
export function buildStatus(deps, options) {
  const { config, pool, diag, clineMatch } = deps
  const revealPreview = options?.revealPreview ?? config?.maskKeyPreview !== false
  // upstreamLog 一并传进去：每把 key 的按模型明细要带上「这把在这个模型上实际走哪家」
  const keys = pool.describe({ revealPreview, upstreamLog: deps.upstreamLog })
  // 面板的「最近决策」只用 at / model / decision 三项；bodyLen 与 poolSize 曾经也在这里
  // 下发，但客户端半边一次都没读过（已核对），纯属白占载荷，故移除。
  const recent = (diag.lastRequests ?? []).map((row) => ({
    at: row.at,
    model: row.model,
    decision: row.decision,
  }))

  // 每次构建都重读设置（面板每 5 秒拉一次，所以用户改了 cline 提供方的模型表会自动跟上，
  // 不需要 watch 接线）；读不到就退化成「只列观察到的模型」。
  // 设置服务缺席或命名空间未注册时返回 undefined，绝不抛错。原先这里另有一份与
  // index.js 的 safeSettingsTable 完全同构的包装函数，两份合并成这一处。
  const readSettings = (namespace) => {
    try {
      return deps.settings?.get?.(namespace)
    } catch {
      return undefined
    }
  }
  const settingsTable = readSettings('llm-pi-ai')
  const configuredModels = clineModelsFromSettings(settingsTable, clineMatch)
  const agentDefaultModel = agentDefaultForCline(readSettings('agent-default-model'), settingsTable, clineMatch)

  // 面板顶部的「按模型查看」筛选项 = 配置里 Cline 名下的模型 ∪ 实际观察到活动的模型。
  // 前者保证「一次请求都还没发」时也列得全（刚切到 glm 就能看到），
  // 后者兜住配置改了/记录还在的情况。
  const modelSeen = new Map() // model → lastUsedAt
  const touchModel = (model, at) => {
    if (!isPlausibleModelId(model)) return
    modelSeen.set(model, Math.max(modelSeen.get(model) ?? 0, Number(at) || 0))
  }
  for (const model of configuredModels) touchModel(model, 0)
  for (const key of keys) {
    for (const row of key.cooling) touchModel(row.model, key.stats.lastUsedAt)
    for (const [model, row] of Object.entries(key.models ?? {})) touchModel(model, row.lastUsedAt)
    touchModel(key.stats.lastModel, key.stats.lastUsedAt)
  }
  for (const row of recent) touchModel(row.model, Date.parse(row.at) || 0)

  // 「当前正在用哪个模型」：最近一条带模型的请求轨迹就是答案（面板默认按它筛选）
  const latest = [...recent].reverse().find((row) => isPlausibleModelId(row.model))
  // 默认选中哪个模型：最近一次真实流量的模型 > DSH 的默认模型（若它也在 Cline 名下）>
  // 配置里的第一个 Cline 模型。这样「刚重启、还没发过 Cline 请求」时也能落在正确的模型上。
  const currentModel = latest?.model || agentDefaultModel || configuredModels[0] || ''

  // 排序：当前模型固定排第一（本地请求常常落在同一毫秒里，只按时间排会退化成字母序，
  // 于是「当前模型」可能不在第一个，chips 的顺序就变得随机难看）；
  // 其余按最近活跃，最后按配置顺序（配置里有、还没跑过的模型靠后但始终可见）。
  const configuredRank = new Map(configuredModels.map((id, index) => [id, index]))
  const models = [...modelSeen.entries()]
    .sort((a, b) => {
      if (a[0] === currentModel) return -1
      if (b[0] === currentModel) return 1
      return b[1] - a[1] || (configuredRank.get(a[0]) ?? 99) - (configuredRank.get(b[0]) ?? 99) || a[0].localeCompare(b[0])
    })
    // 每个模型只下发**预期**上游（来自配置，与观测无关）：面板据此给 Key 表的
    // 「上游渠道」列上警示色。
    //
    // 这里**不下发模型维度的观测**（曾经的 `upstream`）：芯片徽标移除后，客户端半边
    // 一次都不读它（表格每行用的是各自 key+模型的观测，见 key-pool.describe）——留着
    // 就是只写不读的字段，正是 H41/H42 那组断言要挡掉的东西。
    // 另外它曾经被当作 `preferred` 的来源，而观测是内存态：重启后为空 → 警示色永不出现。
    // 预期值是配置里的事实，不该被「还没观测到」牵连，所以单独下发。
    .map(([id, lastUsedAt]) => ({
      id,
      lastUsedAt,
      preferred: PREFERRED_UPSTREAM[id] || '',
    }))

  return {
    plugin: 'dsh-cline-bridge',
    version: PLUGIN_VERSION,
    // 这里曾有 updatedAt: Date.now()：客户端从未读过它（面板用的是本地的 state.at），
    // 而它每次请求都不同，会让条件请求（ETag）永远无法命中，故移除。
    // 注意：这里不再回「配置摘要 / 额度状态文件路径 / 最近一次决策」——
    // 面板从不需要它们（曾经有过一张「运行参数」卡，已删），而其中的诊断价值由
    // 额度状态文件里的 diagnostics 字段承担（README 把它当作排查入口）。
    models,
    currentModel: currentModel || models[0]?.id || '',
    totals: {
      poolSize: keys.length,
      // 不再回 readyKeys / coolingKeys：面板恒定按某个模型看，这两个「跨模型汇总」
      // 没有任何消费方（可用/冷却把数由浏览器半边按当前模型自己算）
      clineRequests: diag.clineRequests ?? 0,
      rotations: diag.rotations ?? 0,
      failFasts: diag.failFasts ?? 0,
      // 统计起点（毫秒时间戳）：面板据此说明「这些数字是从什么时候开始累计的」。
      // 累计值跨重启保留在状态文件里，所以这个时间可能在很久以前。
      since: Number(diag.statsSince) || 0,
    },
    // 这里曾下发 extras { credentialsFileRead, extrasResolved, lastExtrasAt }：
    // 客户端半边从未读取（只有自检在读），真正的排查入口是状态文件里的 diagnostics，
    // 所以从面板载荷里移除，改由 ctx.__dshClineBridge（自检入口）直接暴露。
    keys,
    // 面板选定的「使用中」Key（首发送优先用它），**按模型**各记一条：model → 8 位标签。
    // 面板正处在某个模型的筛选下，取的就是自己那一条；选定的 key 已不在池中时也照样下发
    // （面板据此提示「已不在池中」），那时首发送退回请求自带的 key。
    selection: pool.selections(),
    // 最近几次请求的决策轨迹（只有模型名与决策文本，无 key 材料）
    recent,
  }
}
