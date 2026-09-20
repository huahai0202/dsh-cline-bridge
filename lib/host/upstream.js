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
 * 两种响应形态都要认（都在真实流量里出现过）：
 *   · OpenAI 兼容：`{ data: { choices: [...] } }` —— 正常回包
 *   · Anthropic 形态：`{ content: [...] }`       —— 经 Axonhub 之类中转的场景
 */

/** 一次响应里能拿到的上游信息。拿不到就返回 null（「看不到」≠「用的是某个上游」）。 */
export function readUpstream(bodyText) {
  if (typeof bodyText !== 'string' || !bodyText) return null
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return null
  }
  const routing = parsed?.data?.choices?.[0]?.message?.provider_metadata?.gateway?.routing
  if (!routing || typeof routing !== 'object') return null
  const provider = typeof routing.finalProvider === 'string' ? routing.finalProvider.trim() : ''
  if (!provider) return null
  const fallbacks = Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable : []
  // 模型名有时在回包里（网关会回 canonical slug），拿得到就带上，拿不到不影响显示
  const servedModel = typeof parsed?.data?.model === 'string' ? parsed.data.model : ''
  return { provider, fallbacks: fallbacks.length, servedModel }
}

/**
 * 观测台账：model → { provider, fallbacks, at }。
 *
 * 为什么只放内存、不落状态文件：这是「刚才那次请求观察到的现象」，不是额度/用量那种
 * 必须跨重启保留的事实。上游随时会换，把过期结论写进盘再读出来只会误导——重启后
 * 显示「还没观察到」是诚实的，显示一个几小时前的旧上游才是错的。
 */
export function createUpstreamLog() {
  const byModel = new Map()
  return {
    /** 记一次观测。模型名不可信（来自请求体），所以这里挑最脏的也得挡住。 */
    note(model, upstream) {
      if (!model || model === '*' || !upstream?.provider) return
      byModel.set(model, { ...upstream, at: Date.now() })
    },
    get(model) {
      return model ? byModel.get(model) : undefined
    },
  }
}

/**
 * 面板徽标要的那一小份数据。
 *
 * 两个刻意的设计：
 *   · **只报实际上游，不报「期望值」**。上游名就是全部信息量，不需要翻译成
 *     「已锁定/未锁定」——那会暗示插件有能力影响路由，而它没有。
 *   · `preferred` 只用来给「不是首选」加一层视觉提示（用户关心的就是别漂走），
 *     它不改变显示的上游名本身，也不表示插件做过任何干预。
 *
 * `observedAt` 早于 `lastUsedAt` 时标记 `stale`：面板据此说明「这是上一次观察到的，
 * 本次还没有新数据」，避免把旧结论当成当前状态。
 */
export function upstreamSummary(upstream, preferred, lastUsedAt) {
  if (!upstream?.provider) return undefined
  const at = Number(upstream.at) || 0
  const used = Number(lastUsedAt) || 0
  return {
    provider: upstream.provider,
    fallbacks: Number(upstream.fallbacks) || 0,
    at,
    stale: used > at,
    other: Boolean(preferred) && upstream.provider !== preferred,
  }
}
