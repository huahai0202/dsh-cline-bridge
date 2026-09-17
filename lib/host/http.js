/**
 * 面板路由的 HTTP 小工具：JSON 响应、同源校验，以及写路由用的带上限 JSON 正文读取。
 *
 * 前半（sendJson / isTrustedRequest）从原本单文件的 index.js 按语义边界原样拆出。
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

/**
 * 读取并解析 JSON 请求体（导入路由用；读取路由不需要正文）。
 *
 * 写路由只认 application/json：它同时挡住「表单 / 文本」这类不需要预检的跨站简单请求，
 * 也挡住把多种编码混进来的可能（调用方负责校验 Content-Type，这里只管字节）。
 *
 * 超过 limit 字节立刻拒绝并停止读取，避免一个坏请求把内存吃满。抛出的错误带 code：
 * PAYLOAD_TOO_LARGE / BAD_JSON，由调用方映射成 413 / 400。
 */
export function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (code, message) => {
      if (done) return
      done = true
      const error = new Error(message)
      error.code = code
      reject(error)
    }
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) {
        fail('PAYLOAD_TOO_LARGE', 'request body exceeds ' + limit + ' bytes')
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => {
      if (done) return
      done = true
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        const error = new Error('request body is not valid JSON')
        error.code = 'BAD_JSON'
        reject(error)
      }
    })
    req.on('error', (error) => {
      if (done) return
      done = true
      reject(error)
    })
  })
}
