/**
 * 面板路由的 HTTP 小工具：JSON 响应、同源校验，以及写路由用的带上限 JSON 正文读取。
 *
 * 前半（sendJson / isTrustedRequest）从原本单文件的 index.js 按语义边界原样拆出。
 */
import { createHash } from 'node:crypto'

/** 只回 JSON 的小工具：面板路由只走这一条响应路径。 */
export function sendJson(res, status, payload) {
  // 不做 stringify 的 try/catch：这里的载荷全部来自 pool.describe() / buildStatus()，
  // 是纯 number/string/array/plain-object，既无循环引用也无 BigInt，stringify 不会抛。
  // 真正可能抛的是 writeHead（连接已断），那由各路由外层的兜底 500 处理。
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/**
 * 与 sendJson 相同，但支持条件请求：载荷未变时回 304，省掉整份 JSON 的传输与解析。
 *
 * 面板每 5 秒轮询一次，而载荷里绝大部分内容（池状态、计数、用量）在两次请求之间根本
 * 没变——真正会变的只有冷却倒计时（readyInMin 按分钟取整）。所以按内容算一个 ETag：
 * 内容一致就回 304，客户端继续用手里那份数据，只是把「更新于」的时间往前推。
 *
 * 注意：ETag 必须只由**内容**决定。载荷里曾经有个 updatedAt: Date.now() 字段，那东西
 * 每次都不同，会让 ETag 永远不匹配（它本身也从没被客户端读过，已随这次改动移除）。
 */
export function sendJsonConditional(req, res, payload) {
  const body = JSON.stringify(payload)
  // 用 sha1 而不是简单长度/计数：内容变化必须被察觉，碰撞会直接导致面板停在旧数据上。
  const etag = '"' + createHash('sha1').update(body).digest('hex') + '"'
  const ifNoneMatch = String(req?.headers?.['if-none-match'] ?? '').trim()
  if (ifNoneMatch && ifNoneMatch === etag) {
    // 304 不能带正文；etag 仍需回传，方便客户端确认手里那份就是最新的。
    res.writeHead(304, { etag, 'cache-control': 'no-store' })
    return res.end()
  }
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    etag,
  })
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
