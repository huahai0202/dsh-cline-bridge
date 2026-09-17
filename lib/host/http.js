/**
 * 只读状态路由的两个 HTTP 小工具：JSON 响应与同源校验。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
/** 只回 JSON 的小工具：面板路由只走这一条响应路径。 */
export function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch {
    body = '{"error":"serialization failed"}'
    status = 500
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** 最低限度的本机浏览器信任校验：请求的 Referer 必须与 Host 同源。 */
export function isTrustedRequest(req) {
  const host = req.headers?.host ?? ''
  const referer = req.headers?.referer ?? ''
  try {
    return referer !== '' && new URL(referer).host === host
  } catch {
    return false
  }
}
