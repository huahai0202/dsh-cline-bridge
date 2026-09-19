/**
 * 读取/改写上游请求的形状：请求体可否原样重发、模型名、鉴权头形态与 key 读写。
 *
 * 轮换重发完全依赖这几个函数，所以它们只做最小解析，不做任何「聪明」的推断。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
/** 请求体是否可原样重发（轮换的前提）。 */
export function replayableBody(body) {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  )
}

/**
 * 目标 URL 是否属于 Cline 通道：按**主机名**匹配，而不是整条 URL 的子串。
 *
 * 这是凭据边界：命中就意味着插件会把池里的 Key 写进 Authorization 发出去。
 * 子串匹配会把 `api.cline.bot.attacker.example`（仿冒主机）乃至只在路径/查询串里
 * 提到 cline.bot 的 URL（如 `https://proxy/?upstream=https://api.cline.bot`）都算命中，
 * Key 随之发向错误的对象。
 *
 * 配置形态两种：
 *   · 完整 URL（含 ://）：protocol + host（含端口）全等，路径不作要求；
 *   · 主机名或 host:port：host 全等，或 hostname 以「.配置值」结尾
 *     （默认 `cline.bot` 命中 `api.cline.bot`，但不命中 `api.cline.bot.attacker.example`）。
 * URL 解析不出一律按不命中处理（宁漏勿错）。
 */
export function matchesClineTarget(url, clineMatch) {
  const match = typeof clineMatch === 'string' ? clineMatch.trim() : ''
  if (!url || !match) return false
  let parsed
  try {
    parsed = new URL(typeof url === 'string' ? url : String(url))
  } catch {
    return false
  }
  if (match.includes('://')) {
    let wanted
    try {
      wanted = new URL(match)
    } catch {
      return false
    }
    return parsed.protocol === wanted.protocol && parsed.host === wanted.host
  }
  if (parsed.host === match || parsed.hostname === match) return true
  return parsed.hostname.endsWith('.' + match)
}

export function readModelOf(body) {
  if (typeof body !== 'string') return '*'
  try {
    const parsed = JSON.parse(body)
    // 模型名是 cooling / 用量 / 选定三维的索引键，必须归一化：请求体里带首尾空格的
    // 「 glm 」若原样当键，选定路由（会 trim）写下的选定就永远对不上它。
    const model = typeof parsed?.model === 'string' ? parsed.model.trim() : ''
    return model || '*'
  } catch {
    return '*'
  }
}

/** 鉴权头形态：openai 兼容渠道用 Authorization: Bearer，部分网关用 x-api-key。 */
export function readAuthTarget(headers) {
  const auth = headers.get('authorization')
  if (auth) {
    const m = /^(\S+)\s+(.+)$/.exec(auth.trim())
    return { header: 'authorization', scheme: m ? m[1] : 'Bearer' }
  }
  if (headers.get('x-api-key')) return { header: 'x-api-key', scheme: '' }
  return { header: 'authorization', scheme: 'Bearer' }
}

export function readKeyOf(headers, target) {
  if (target.header === 'x-api-key') return (headers.get('x-api-key') || '').trim()
  const auth = (headers.get('authorization') || '').trim()
  const m = /^\S+\s+(.+)$/.exec(auth)
  return (m ? m[1] : auth).trim()
}

export function writeKeyTo(headers, key, target) {
  if (target.header === 'x-api-key') headers.set('x-api-key', key)
  else headers.set('authorization', `${target.scheme || 'Bearer'} ${key}`)
}

// 关于凭据服务的读写（2026-09 实测更新，旧结论已作废）：
//   旧版结论「插件 ctx 上不存在 ctx.inject(deps, cb)、ctx.get('credentials') 静默 undefined」
//   在当前 DSH 上不成立——ctx.inject 可用，且已在面板导入/主 Key 入池上实测生效
//   （导入路由回包 writeMode: 'credentials' 即为凭据服务在用的证据）。
//   但**读侧仍然直读 .credentials.yaml**，原因有二：
//   · 读不能等：key 池要在第一条请求前就位，而凭据服务可能比插件晚挂载；
//   · 读不能挂：headless/acp 等没有凭据服务的 profile 里，轮换必须照常工作。
//   所以服务只作为**可选加速与写入通道**（导入、主 Key 解析），文件直读永远是兜底。
//   额外 key 由四条来源提供：面板导入、插件 config、启动环境变量、.credentials.yaml 直读。
