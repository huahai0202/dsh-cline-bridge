/**
 * 上游观测：从响应里读出**这次实际是哪个上游**服务的，供面板显示。
 *
 * 本模块**只读**，不改写请求的任何部分。这里没有「上游锁定」——实测结论是
 * Cline 免费档那条路由**会接受 `providerOptions.gateway` 却完全忽略它**，
 * 所以在客户端注入锁定字段是静默无效的，本插件不再这么做（详见 README）。
 * 留下来的价值是：**上游漂移能看见**。
 *
 * 读的是网关自己的汇报，位置取自实测：
 *   data.choices[0].message.provider_metadata.gateway.routing.finalProvider
 *
 * 响应可能是**整段 JSON**（非流式）或 **SSE 流**（`data: {...}` 逐块，生产走的是这条），
 * 两种都要认——只认前者的实现会对生产流量静默失效，见 readUpstream 的注释。
 */

/**
 * 从一段响应文本里抽出路由信息。差异比想象中多，全是实测踩出来的：
 *
 *   容器层：**非流式**包在 `{ data: { choices: [...] } }` 里；
 *            **流式（SSE）chunk 没有 `data` 包裹**，`choices` 直接在顶层。
 *   挂载点：**非流式**在 `choices[0].message.provider_metadata.gateway.routing`；
 *            **流式**在 `choices[0].delta.provider_metadata.gateway.routing`（挂在 delta 上）。
 *
 * 生产走的是流式（DSH 用 `stream: true` 发请求），所以只认「非流式那一种」的实现会
 * 对整个真实流量静默失效——而用 `stream: false` 写的探针全绿，极难发现。
 *
 * 两者都不匹配 → null。拿不到就说拿不到（「看不到」≠「用的是某一家」），绝不猜。
 */
function routingOf(parsed) {
  const choices = parsed?.data?.choices ?? parsed?.choices
  const choice = Array.isArray(choices) ? choices[0] : undefined
  const routing = choice?.message?.provider_metadata?.gateway?.routing
    ?? choice?.delta?.provider_metadata?.gateway?.routing
  // 形态三（实测）：部分路由（如 `z-ai/glm-5.3-flash`）**完全没有 provider_metadata**，
  // 而是把上游名放在 chunk **顶层的 `provider`** 字段里（`"provider":"Parasail"`）。
  // 只认 provider_metadata 的实现对这些模型恒返回 null——面板「上游渠道」列永远是「—」。
  const flat = parsed?.data?.provider ?? parsed?.provider
  const fromRouting = typeof routing?.finalProvider === 'string' ? routing.finalProvider.trim() : ''
  const provider = fromRouting || (typeof flat === 'string' ? flat.trim() : '')
  if (!provider) return null
  const fallbacks = Array.isArray(routing?.fallbacksAvailable) ? routing.fallbacksAvailable : []
  // 模型名有时在回包里（网关会回 canonical slug），拿得到就带上，拿不到不影响显示
  const servedModel = typeof (parsed?.data?.model ?? parsed?.model) === 'string'
    ? (parsed.data?.model ?? parsed.model)
    : ''
  return { provider, fallbacks: fallbacks.length, servedModel }
}

export function readUpstream(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return null

  // 形态一：整段就是一个 JSON
  try {
    const direct = routingOf(JSON.parse(bodyText))
    if (direct) return direct
  } catch {
    // 不是整体 JSON —— 多半是 SSE，往下走
  }

  // 形态二：SSE。逐行找 `data:` 载荷；`[DONE]` 与非 JSON 行一律跳过。
  // 路由信息可能出现在任意一个 chunk 里（实测在最后那个 chunk），所以扫完整段、
  // 取第一个能解析出 routing 的 chunk——不是只看最后一个，因为尾部可能是 [DONE]。
  if (bodyText.includes('data:')) {
    for (const rawLine of bodyText.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const found = routingOf(JSON.parse(payload))
        if (found) return found
      } catch {
        // 单个 chunk 解析失败不影响其他 chunk
      }
    }
  }

  return null
}

/**
 * 观测台账：model → { provider, fallbacks, at }，以及 key+model → 同形状。
 *
 * 为什么要按 key 再记一份：上游是**每次请求**由网关决定的，而请求是**某一把 key** 发出去的。
 * 面板要回答的问题是「我这把 key 实际在走哪家」，那就得按 key 记录——只用 model 维度的
 * 结论去填每一行，等于把最后一次观测复制给所有 key，看着像事实、其实是编的。
 * key 用 8 位标签（不是原文）：与面板、状态文件同一套标识，且不落盘、不进日志。
 *
 * 为什么只放内存、不落状态文件：这是「刚才那次请求观察到的现象」，不是额度/用量那种
 * 必须跨重启保留的事实。上游随时会换，把过期结论写进盘再读出来只会误导——重启后
 * 显示「还没观察到」是诚实的，显示一个几小时前的旧上游才是错的。
 */
export function createUpstreamLog() {
  const byModel = new Map()
  const byKey = new Map() // `${label}\u0000${model}` → 观测

  const clean = (value) => {
    if (!value || typeof value !== 'object') return undefined
    const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
    if (!provider) return undefined
    return {
      provider,
      fallbacks: Number(value.fallbacks) || 0,
      servedModel: typeof value.servedModel === 'string' ? value.servedModel : '',
      at: Number(value.at) || Date.now(),
    }
  }

  return {
    /**
     * 记一次观测。model / label 都来自请求侧，属于不可信输入，所以这里逐项挡：
     * 读不出模型（'*'）或没有 key 标签时只记 model 维度，不编造 key 维度的结论。
     */
    note(model, upstream, label) {
      if (!model || model === '*' || !upstream?.provider) return
      const entry = clean({ ...upstream, at: Date.now() })
      if (!entry) return
      byModel.set(model, entry)
      if (label) byKey.set(`${label}\u0000${model}`, entry)
    },
    get(model) {
      return model ? byModel.get(model) : undefined
    },
    getForKey(label, model) {
      return label && model ? byKey.get(`${label}\u0000${model}`) : undefined
    },
  }
}
