/**
 * 设置面板的状态载荷：把 key 池、计数、模型清单整理成浏览器半边要的 JSON。
 *
 * 这里是主机端唯一的对外数据出口，字段白名单是硬约束：只有哈希标签、掩码预览、
 * 冷却时刻与计数，绝不出现 key 原文，也不整体展开 config（它含 key 原文数组）。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { PLUGIN_VERSION } from './defaults.js'

// ──────────────────── 设置面板的状态载荷 ─────────────────────
// 主机端 → 浏览器半边的唯一数据出口。它只读、只回这些字段：
//   · 每把 key 的 8 位标签、**掩码预览**（可关）、来源、冷却模型与恢复倒计时、
//     本次运行的用量计数（含 token）；
//   · 全局计数、模型清单与「当前模型」、最近几条决策轨迹。
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

/** `agent-default-model` 指向 Cline 通道时给出它选中的模型，用作面板的默认筛选项。 */
function agentDefaultForCline(defaultValue, table, clineMatch) {
  const provider = typeof defaultValue?.provider === 'string' ? defaultValue.provider : ''
  const model = typeof defaultValue?.model === 'string' ? defaultValue.model : ''
  if (!provider || !model) return ''
  const base = table?.providers?.[provider]?.baseURL
  return typeof base === 'string' && base.includes(clineMatch) ? model : ''
}

/** 设置服务缺席或命名空间未注册时返回 undefined，绝不抛错。 */
function safeSettingsGet(service, namespace) {
  try {
    return service?.get?.(namespace)
  } catch {
    return undefined
  }
}

/** 设置面板一次刷新所需的全部内容。 */
export function buildStatus(deps, options) {
  const { config, pool, diag, clineMatch } = deps
  const revealPreview = options?.revealPreview ?? config?.maskKeyPreview !== false
  const keys = pool.describe({ revealPreview })
  const recent = (diag.lastRequests ?? []).map((row) => ({
    at: row.at,
    model: row.model,
    decision: row.decision,
    bodyLen: row.bodyLen,
    poolSize: row.poolSize,
  }))

  // 每次构建都重读设置（面板每 5 秒拉一次，所以用户改了 cline 提供方的模型表会自动跟上，
  // 不需要 watch 接线）；读不到就退化成「只列观察到的模型」。
  const settingsTable = safeSettingsGet(deps.settings, 'llm-pi-ai')
  const configuredModels = clineModelsFromSettings(settingsTable, clineMatch)
  const agentDefaultModel = agentDefaultForCline(safeSettingsGet(deps.settings, 'agent-default-model'), settingsTable, clineMatch)

  // 面板顶部的「按模型查看」筛选项 = 配置里 Cline 名下的模型 ∪ 实际观察到活动的模型。
  // 前者保证「一次请求都还没发」时也列得全（刚切到 glm 就能看到），
  // 后者兜住配置改了/记录还在的情况。
  const modelSeen = new Map() // model → lastUsedAt
  const touchModel = (model, at) => {
    if (!model || model === '*') return
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
  const latest = [...recent].reverse().find((row) => row.model && row.model !== '*')
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
    .map(([id, lastUsedAt]) => ({ id, lastUsedAt }))

  return {
    plugin: 'opencode-free-bridge',
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
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
    },
    extras: {
      credentialsFileRead: Boolean(diag.credentialsFileRead),
      extrasResolved: Boolean(diag.extrasResolved),
      lastExtrasAt: diag.lastExtrasAt ?? '',
    },
    keys,
    // 最近几次请求的决策轨迹（只有模型名与决策文本，无 key 材料）
    recent,
  }
}
