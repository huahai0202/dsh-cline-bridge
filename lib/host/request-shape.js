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

export function readModelOf(body) {
  if (typeof body !== 'string') return '*'
  try {
    const parsed = JSON.parse(body)
    return typeof parsed?.model === 'string' ? parsed.model : '*'
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
