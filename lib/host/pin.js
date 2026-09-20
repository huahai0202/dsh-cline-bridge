/**
 * 上游锁定：把 `provider: { only: [...], allow_fallbacks }` 写进 Cline 请求体。
 *
 * 这是本插件**唯一**会改写请求体的地方，所以它被单独放在一个模块里，边界写清楚。
 *
 * 为什么字段是 `provider.only` 而不是 `providerOptions.gateway.only`：
 * 后者是早期实测用过的形态，结论是「网关接受却完全忽略」（见 README 与 defaults.js）。
 * 2026-09 重新实测 `z-ai/glm-5.3-flash`，发现标准 OpenRouter 形态的
 * `provider.only` 是**真的被强制执行**的：
 *   only=["Wafer"]        → 6/6 全是 Wafer
 *   only=["Together"]     → 6/6 全是 Together
 *   only=["zzz-not-real"] → 6/6 stream_initialization_failed（不存在的上游直接报错）
 *   不带 provider 字段     → 随机漂（Near AI / Z.AI / Wafer / SiliconFlow / …）
 * 所以「锁不住」这个前提对这条路由不成立，锁定能力恢复。
 *
 * 设计约束（照抄 request-shape.js 的口径）：
 *   · **只改这一个字段**：其余键（含已有的 provider / providerOptions）原样保留；
 *   · 解析不出来 / 不是对象 / 已有 provider.only 时不猜、不强改——宁可不动；
 *   · 只在请求体是 JSON 字符串时改写（流式 body 无从改写，直接放行）。
 */

/**
 * 把 `provider.only` 注入一份 JSON 请求体文本。
 *
 * @param {string} bodyText 原始请求体文本
 * @param {string} provider 要锁定的上游名（如 'Parasail'）
 * @param {boolean} allowFallbacks 是否允许网关在该上游不可用时回退到别家
 * @returns {string} 改写后的文本；任何无法安全改写的情形都原样返回入参
 */
export function injectPinnedProvider(bodyText, provider, allowFallbacks) {
  if (typeof bodyText !== 'string' || !bodyText) return bodyText
  const wanted = typeof provider === 'string' ? provider.trim() : ''
  if (!wanted) return bodyText

  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    // 不是 JSON（流式 body / 非 JSON 报文）：无从注入，原样放行
    return bodyText
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bodyText

  // 已经有 provider 且不是普通对象：用户自己写了奇怪的东西，不碰
  if (parsed.provider !== undefined && (typeof parsed.provider !== 'object' || parsed.provider === null || Array.isArray(parsed.provider))) {
    return bodyText
  }
  const existing = parsed.provider ?? {}
  // 已经锁了别的上游（用户手写 / 别的中间件）：尊重现状，不覆盖
  if (Array.isArray(existing.only) && existing.only.length > 0) return bodyText

  const next = { ...parsed, provider: { ...existing, only: [wanted], allow_fallbacks: allowFallbacks === true } }
  return JSON.stringify(next)
}

/**
 * 从插件 config 解析「模型 → 上游」的锁定表。
 *
 * 配置形态（`cordis.patch.yml` 的 `config.pinUpstream`）：
 *   pinUpstream:
 *     'z-ai/glm-5.3-flash': Parasail
 *   或带 allowFallbacks 的完整形态：
 *     'z-ai/glm-5.3-flash': { provider: Parasail, allowFallbacks: false }
 *
 * 返回值是 Map<model, { provider, allowFallbacks }>；非法项一律跳过（不抛错）。
 */
export function parsePinUpstream(raw) {
  const table = new Map()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return table
  for (const [model, value] of Object.entries(raw)) {
    const key = typeof model === 'string' ? model.trim() : ''
    if (!key || key === '*') continue
    let provider = ''
    let allowFallbacks = false
    if (typeof value === 'string') {
      provider = value.trim()
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      provider = typeof value.provider === 'string' ? value.provider.trim() : ''
      allowFallbacks = value.allowFallbacks === true
    }
    if (!provider) continue
    table.set(key, { provider, allowFallbacks })
  }
  return table
}
