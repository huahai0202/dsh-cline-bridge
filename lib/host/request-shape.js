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

// 关于「为什么不用 DSH 凭据服务」（已实测确认，勿再尝试）：
//   Cordis 只在插件**声明依赖**时才把服务名映射进它的 isolate；未声明时
//   `ctx.get('credentials')` 会静默返回 undefined（不抛错），插件永远拿不到服务实例。
//   而插件 ctx 上并不存在 `ctx.inject(deps, cb)` 这个 API（实测 typeof 为 undefined）。
//   唯一的替代是 `export const inject = ['credentials']`，但那会让**整个插件**被该服务门控——
//   服务一旦缺席，连 Zen 头注入一起失效。收益（少读一个文件）远小于风险，故舍弃。
//   额外 key 由三条来源提供：插件 config、启动环境变量、.credentials.yaml 直读。
