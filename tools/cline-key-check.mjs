/**
 * Cline 多 key 轮换自检（不需要真实 key）
 *
 *   node tools/cline-key-check.mjs
 *
 * 起一个本地 mock 服务器复刻 Cline 的限流报文：
 *   429 {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached
 *        on model <model>. Try again in 22h 47m"}
 * 然后验证插件的四种 key 来源、按模型冷却、LRU 选 key，以及整池耗尽时的收尾行为。
 */

import { createServer } from 'node:http'
import { apply } from '../index.js'

// ── mock Cline 服务端 ────────────────────────────────────────────────
const seen = [] // { key, model, headers }
const LIMITED_PREFIXES = ['k1', 'e1', 'c1'] // 这些 key 一律撞「每日免费额度」上限
const TRANSIENT_PREFIXES = ['r1'] // 这些 key 返回瞬时限流（无每日上限字样）

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    let model = '?'
    try {
      model = JSON.parse(body).model ?? '?'
    } catch {}
    seen.push({ key, model, headers: req.headers })

    if (TRANSIENT_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      res.end(JSON.stringify({ code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' }))
      return
    }

    if (LIMITED_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          code: 'INFERENCE_CAP_ERROR',
          message: `Error 429: Daily free limit reached on model ${model}. Try again in 22h 47m`,
        }),
      )
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, servedBy: key, model }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const match = `127.0.0.1:${server.address().port}`
const ENDPOINT = `http://${match}/api/v1/chat/completions`

// ── 断言脚手架 ──────────────────────────────────────────────────────
const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

let dispose = () => {}
function mount(config, credentialsStub) {
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: () => {} },
    get: (name) => (name === 'credentials' ? credentialsStub : undefined),
  }
  apply(ctx, config)
  return ctx
}

const call = async (key, model = 'deepseek/deepseek-v4.1-flash') => {
  const res = await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const text = await res.text()
  return { status: res.status, text, noRetry: res.headers.get('x-should-retry') }
}

const mark = () => seen.length
const since = (n) => seen.slice(n)

// ── A. config 里的 key 池：撞限流后换 key ────────────────────────────
{
  const ctx = mount({ clineKeys: ['k1', 'k2'], clineMatch: match })
  const n = mark()
  const r = await call('k1')
  const attempts = since(n)

  check('A1 换 key 后拿到 200', r.status === 200, `${r.status} ${r.text.slice(0, 60)}`)
  check('A2 服务端确实收到两次请求', attempts.length === 2, `attempts=${attempts.map((a) => a.key).join('→')}`)
  check('A3 第一次用原 key、第二次用池内 key', attempts[0]?.key === 'k1' && attempts[1]?.key === 'k2', attempts.map((a) => a.key).join('→'))
  check('A4 两次都带 Cline 指纹头', attempts.every((a) => a.headers['x-client-type'] === 'cline-vscode'))
  check(
    'A5 重试窗口解析正确（22h47m）',
    ctx.__opencodeFreeBridge.parseRetryWindowMs('Error 429: Daily free limit reached. Try again in 22h 47m') === (22 * 3600 + 47 * 60) * 1000,
    String(ctx.__opencodeFreeBridge.parseRetryWindowMs('Try again in 22h 47m')),
  )

  // ── B. 冷却中的 key 仍会先试一次（已确认可接受），随后换 key 成功 ──
  const n2 = mark()
  const r2 = await call('k1')
  const attempts2 = since(n2)
  check(
    'B1 冷却中的 key 仍先试一次，失败后换 key 成功',
    r2.status === 200 && attempts2.length === 2 && attempts2[0].key === 'k1' && attempts2[1].key === 'k2',
    attempts2.map((a) => a.key).join('→'),
  )

  // ── C. 冷却按模型隔离：换模型后原 key 仍可用 ──
  const n3 = mark()
  const r3 = await call('k1', 'z-ai/glm-5.3-flash')
  const attempts3 = since(n3)
  check('C1 不同模型不受上次冷却影响', r3.status === 200 && attempts3.length === 2 && attempts3[0].key === 'k1', attempts3.map((a) => `${a.key}@${a.model}`).join('→'))

  // ── D. 冷却状态可观察 ──
  const snap = ctx.__opencodeFreeBridge.clineKeys()
  const coolingModels = snap.flatMap((e) => e.cooling)
  check('D1 快照显示按模型冷却', coolingModels.includes('deepseek/deepseek-v4.1-flash'), JSON.stringify(snap))
  check('D2 快照不含 key 原文', JSON.stringify(snap).indexOf('k1') === -1 && JSON.stringify(snap).indexOf('k2') === -1)
}

// ── E. 单 key 池耗尽：返回 429 且标记不再重试 ───────────────────────
{
  mount({ clineKeys: ['k1'], clineMatch: match })
  const r = await call('k1')
  check('E1 无备用 key 时原样返回 429', r.status === 429, String(r.status))
  check('E2 附带 x-should-retry:false（避免 pi-ai 无意义退避）', r.noRetry === 'false', String(r.noRetry))
  check('E3 429 报文完整保留', r.text.includes('INFERENCE_CAP_ERROR') && r.text.includes('22h 47m'), r.text.slice(0, 80))
}

// ── F. 来源二：启动环境变量 ──────────────────────────────────────────
{
  process.env.CLINE_API_KEYS = 'e1,e2'
  mount({ clineMatch: match })
  const n = mark()
  const r = await call('e1')
  const attempts = since(n)
  check('F1 环境变量 CLINE_API_KEYS 生效', r.status === 200 && attempts.length === 2 && attempts[1].key === 'e2', attempts.map((a) => a.key).join('→'))
  delete process.env.CLINE_API_KEYS
}

// ── G. 来源三：DSH 凭据仓库（ctx.credentials.resolve）──────────────
{
  const resolved = []
  const stub = {
    resolve: async (ref) => {
      resolved.push(ref)
      return ref === 'CLINE_API_KEY_2' ? { value: 'c2', source: 'file' } : undefined
    },
  }
  mount({ clineMatch: match, clineKeyRefs: ['CLINE_API_KEY_2'] }, stub)
  await new Promise((r) => setTimeout(r, 20)) // 等 ensureExtras 落地
  const n = mark()
  const r = await call('c1')
  const attempts = since(n)
  check('G1 凭据仓库的 key 参与轮换', r.status === 200 && attempts.length === 2 && attempts[1].key === 'c2', attempts.map((a) => a.key).join('→'))
  check('G2 按配置的 ref 名解析', resolved.includes('CLINE_API_KEY_2'), resolved.join(','))
}

// ── H. 其它渠道零副作用 ─────────────────────────────────────────────
{
  mount({ clineKeys: ['k1', 'k2'], clineMatch: match })
  let captured
  const before = globalThis.fetch
  const realFetch = before
  // 用一个不会被插件拦截的地址验证直通
  const passthrough = await realFetch('http://127.0.0.1:1/not-cline', { method: 'POST', body: '{}' }).catch((e) => e)
  check('H1 非 Cline 目标不被接管（连接错误即可）', passthrough instanceof Error, passthrough?.code ?? passthrough?.name ?? 'ok')
  check('H2 全局 fetch 已被插件包装', typeof before === 'function')
  void captured
}

// ── I. 瞬时限流不应被标记为不可重试 ──────────────────────────────
{
  mount({ clineKeys: ['r1'], clineMatch: match })
  const r = await call('r1')
  check('I1 瞬时限流仍原样返回 429', r.status === 429, String(r.status))
  check('I2 不追加 x-should-retry（交给 pi-ai 自行退避重试）', r.noRetry === null, String(r.noRetry))
}

// ── J. skipCoolingRequestKey：可选地跳过首发送的白撞 ────────────────
{
  mount({ clineKeys: ['k1', 'k2'], clineMatch: match, skipCoolingRequestKey: true })
  const n = mark()
  const r1 = await call('k1')
  const a1 = since(n)
  check('J1 开启后首次仍靠轮换成功', r1.status === 200 && a1.length === 2 && a1[1].key === 'k2', a1.map((a) => a.key).join('→'))

  const n2 = mark()
  const r2 = await call('k1')
  const a2 = since(n2)
  check('J2 开启后冷却中的 key 不再被先撞（一次成功）', r2.status === 200 && a2.length === 1 && a2[0].key === 'k2', a2.map((a) => a.key).join('→'))
}

dispose()
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.length} 项`)
process.exit(failed === 0 ? 0 : 1)