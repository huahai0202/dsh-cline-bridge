/**
 * 上游观测自检（不需要真实 key）
 *
 *   node tools/cline-upstream-check.mjs
 *
 * 本插件**不再做上游锁定**——实测 Cline 免费档那条路由会接受 `providerOptions.gateway`
 * 却完全忽略它（`only:["deepseek"]` / `["togetherai"]` / 连 `["zzz-not-real"]` 都与不锁
 * 的结果一模一样：final=deepseek、fb=15、只试 1 家）。所以注入锁定的代码已删除，
 * 只保留「这次实际走哪家」的观测，让漂移看得见。
 *
 * 这个自检钉住两件事：
 *   · 观测只**读**响应，绝不改写请求体（把「发出去的 body」与原文逐字节比对）；
 *   · 面板拿到的上游数据形状正确，且「看不到」时不给数据（绝不显示成某一家）。
 */

import { createServer } from 'node:http'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { createUpstreamLog, readUpstream, upstreamSummary } from '../lib/host/upstream.js'
import { MONITORED_UPSTREAM_MODELS, PREFERRED_UPSTREAM } from '../lib/host/defaults.js'

const TEST_STATE_DIR = join(tmpdir(), `ofb-upstream-state-${process.pid}`)
mkdirSync(TEST_STATE_DIR, { recursive: true })
let stateSeq = 0

const MONITORED = MONITORED_UPSTREAM_MODELS[0]
const OTHER = 'z-ai/glm-5.3-flash'

/** 造一份带网关路由元数据的回包（形状取自实测真实响应）。 */
const replyWith = (routing) =>
  JSON.stringify({
    data: {
      model: 'deepseek/deepseek-v4.1-flash',
      choices: [{ message: { provider_metadata: routing ? { gateway: { routing } } : undefined } }],
    },
  })

// ── mock Cline 服务端 ────────────────────────────────────────────────
const seen = []
let nextReply = replyWith({ finalProvider: 'deepseek', fallbacksAvailable: ['alibaba', 'novita'] })
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {}
    seen.push({ key, body, parsed })
    // k1 撞每日额度：用来验证「换 key 重发后仍然观测到上游」
    if (key.startsWith('k1')) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 'INFERENCE_CAP_ERROR', message: 'Error 429: Daily free limit reached. Try again in 22h 47m' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(nextReply)
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const match = `127.0.0.1:${server.address().port}`
const ENDPOINT = `http://${match}/api/v1/chat/completions`

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

let dispose = () => {}
let lastCtx
function mount(config = {}) {
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: () => {} },
    get: () => undefined,
    inject: () => undefined,
  }
  const merged = { ...config }
  if (merged.quotaStatePath === undefined) merged.quotaStatePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  if (merged.credentialsFile === undefined) merged.credentialsFile = join(TEST_STATE_DIR, 'no-such-credentials.yaml')
  apply(ctx, merged)
  lastCtx = ctx
  return ctx
}

const mark = () => seen.length
const since = (n) => seen.slice(n)
const upstreamRowOf = (model) => (lastCtx.__dshClineBridge.status().models || []).find((m) => m.id === model)

const call = async (key, model, body) => {
  const res = await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: body ?? JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
  })
  await res.text()
  return res
}

// ── A. readUpstream：只认实测过的形状，读不到就返回 null ─────────────
//
// A2–A4 是最要紧的：生产走的是**流式**（DSH 用 stream:true），而流式响应有两处和非流式
// 不一样——① chunk **没有 `data` 包裹**（choices 直接在顶层）；② 路由挂在 **`delta`** 上
// 而不是 `message` 上。早期实现只认「非流式那一种」，导致功能对真实流量**静默失效**；
// 而所有用 stream:false 写的探针全绿，极难发现。这几条就是那次事故的回归锁。
{
  const routing = { finalProvider: 'deepseek', fallbacksAvailable: ['alibaba', 'novita'] }
  const chunk = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
  // 真实流式 chunk 的形状：无 data 包裹 + 路由挂 delta
  const streamChunk = (r) => chunk({
    id: 'gen_x',
    object: 'chat.completion.chunk',
    model: 'deepseek/deepseek-v4.1-flash',
    choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: r } } } }],
  })

  check('A1 非流式回包（data.choices[0].message）能读出上游',
    (() => {
      const u = readUpstream(replyWith({ finalProvider: 'deepseek', fallbacksAvailable: ['a', 'b', 'c'] }))
      return u?.provider === 'deepseek' && u.fallbacks === 3
    })())

  check('A2 真实流式 chunk（无 data 包裹 + 路由挂 delta）能读出上游',
    (() => {
      const u = readUpstream(streamChunk(routing) + 'data: [DONE]\n\n')
      return u?.provider === 'deepseek' && u.fallbacks === 2 && u.servedModel === 'deepseek/deepseek-v4.1-flash'
    })(), JSON.stringify(readUpstream(streamChunk(routing))))

  check('A3 流式路由在中间 chunk 时也能找到（不只扫首尾）',
    (() => {
      const text = chunk({ choices: [{ delta: { content: 'Hi' } }] })
        + streamChunk(routing)
        + chunk({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] })
        + 'data: [DONE]\n\n'
      return readUpstream(text)?.provider === 'deepseek'
    })())

  check('A4 坏 chunk 不阻断后续 chunk 的解析',
    readUpstream('data: not-json\n\n' + streamChunk(routing))?.provider === 'deepseek')

  check('A5 只有 [DONE] 的流返回 null（不猜）', readUpstream('data: [DONE]\n\n') === null)
  check('A6 流式 chunk 里没有路由信息时返回 null',
    readUpstream(chunk({ choices: [{ delta: { content: 'hi' } }] }) + 'data: [DONE]\n\n') === null)
  check('A7 流式里 finalProvider 为空串时返回 null',
    readUpstream(streamChunk({ finalProvider: '', fallbacksAvailable: ['a'] })) === null)

  check('A8 没有 provider_metadata 时返回 null（看不到 ≠ 某一家）',
    readUpstream(JSON.stringify({ data: { choices: [{ message: {} }] } })) === null)
  check('A9 非 JSON 返回 null 且不抛错', readUpstream('not json') === null)
  check('A10 空/非字符串输入返回 null',
    readUpstream('') === null && readUpstream(undefined) === null && readUpstream(123) === null)
  check('A11 没有 fallbacksAvailable 时家数为 0（不谎报有兜底）',
    readUpstream(replyWith({ finalProvider: 'deepseek' }))?.fallbacks === 0)
  check('A12 provider 名两端空白被清掉',
    readUpstream(replyWith({ finalProvider: '  deepseek  ' }))?.provider === 'deepseek')
}

// ── B. 观测台账与展示数据 ────────────────────────────────────────────
{
  const log = createUpstreamLog()
  check('B1 未观测过时 get 为 undefined', log.get(MONITORED) === undefined)

  log.note(MONITORED, { provider: 'deepseek', fallbacks: 15 })
  check('B2 记下后能取回且带时间戳',
    log.get(MONITORED)?.provider === 'deepseek' && log.get(MONITORED).at > 0)

  log.note('*', { provider: 'x' })
  check('B3 模型名为 *（读不出模型）时不记录', log.get('*') === undefined)
  log.note('', { provider: 'x' })
  check('B4 空模型名不记录', log.get('') === undefined)
  log.note('m', null)
  check('B5 没有 provider 的观测不记录', log.get('m') === undefined)

  const good = log.get(MONITORED)
  check('B6 upstreamSummary：预期上游 → other=false',
    upstreamSummary(good, 'deepseek', 0)?.other === false)
  check('B7 upstreamSummary：不是预期上游 → other=true（用户真正关心的信号）',
    upstreamSummary({ provider: 'alibaba', fallbacks: 15, at: Date.now() }, 'deepseek', 0)?.other === true)
  check('B8 upstreamSummary：没有观测 → undefined（面板不显示徽标）',
    upstreamSummary(undefined, 'deepseek', 0) === undefined)

  // stale：观测时刻早于该模型最近一次使用 → 说明本次还没有新数据
  const t0 = Date.now() - 10_000
  check('B9 观测早于最近使用 → 标记 stale（不把旧结论当成当前状态）',
    upstreamSummary({ provider: 'deepseek', fallbacks: 1, at: t0 }, 'deepseek', t0 + 5000)?.stale === true)
  check('B10 观测晚于最近使用 → 不是 stale',
    upstreamSummary({ provider: 'deepseek', fallbacks: 1, at: t0 + 5000 }, 'deepseek', t0)?.stale === false)

  check('B11 观测名单只含用户指定的那一个模型',
    MONITORED_UPSTREAM_MODELS.length === 1 && MONITORED === 'cline-free/deepseek-v4.1-flash',
    MONITORED_UPSTREAM_MODELS.join(','))
  check('B12 预期上游表与观测名单一致', PREFERRED_UPSTREAM[MONITORED] === 'deepseek')
}

// ── C. 端到端：只读观测，请求体一个字节都不改 ────────────────────────
{
  mount({ clineKeys: ['s1'], clineMatch: match })
  // 特意带一个**会被旧版锁定代码改写的模型名**：锁定代码在时，这里发出去的 body
  // 会多出 providerOptions，逐字节比对就会失败——这条断言正是「不再改写请求」的锁。
  const payload = JSON.stringify({ model: MONITORED, messages: [{ role: 'user', content: 'keep-me' }] })
  let n = mark()
  await call('s1', MONITORED, payload)
  let rows = since(n)

  // 这是本节最重要的一条：插件不得改写请求体（锁定代码已移除）
  check('C1 发往上游的请求体与原始请求逐字节一致（插件不改写请求）',
    rows[0]?.body === payload,
    `sent=${rows[0]?.body?.slice(0, 90)}`)
  check('C2 请求体里没有 providerOptions（锁定字段已不再注入）',
    rows[0]?.parsed?.providerOptions === undefined,
    JSON.stringify(rows[0]?.parsed?.providerOptions))

  const row = upstreamRowOf(MONITORED)
  check('C3 面板拿到实际上游（deepseek）',
    row?.upstream?.provider === 'deepseek' && row.upstream.other === false,
    JSON.stringify(row?.upstream))

  // 上游漂到别家：面板必须能看出来
  nextReply = replyWith({ finalProvider: 'alibaba', fallbacksAvailable: ['novita'] })
  n = mark()
  await call('s1', MONITORED)
  const drifted = upstreamRowOf(MONITORED)
  check('C4 上游漂到 alibaba 时面板如实显示，并标记 other=true',
    drifted?.upstream?.provider === 'alibaba' && drifted.upstream.other === true,
    JSON.stringify(drifted?.upstream))

  // 读不到元数据：不显示任何上游（绝不用上一次的结论冒充本次）
  nextReply = JSON.stringify({ data: { choices: [{ message: {} }] } })
  n = mark()
  await call('s1', MONITORED)
  const noMeta = upstreamRowOf(MONITORED)
  check('C5 回包没有路由元数据时保留上一次观测（并因最近使用更新而标记 stale）',
    noMeta?.upstream?.provider === 'alibaba' && noMeta.upstream.stale === true,
    JSON.stringify(noMeta?.upstream))

  // 不在观测名单里的模型：即使回包有元数据也不记
  nextReply = replyWith({ finalProvider: 'bedrock', fallbacksAvailable: [] })
  n = mark()
  await call('s1', OTHER)
  const otherRow = upstreamRowOf(OTHER)
  check('C6 不在观测名单里的模型不产生上游数据（只盯指定模型，不外扩）',
    otherRow !== undefined && otherRow.upstream === undefined,
    JSON.stringify(otherRow))

  // 换 key 重发（429 轮换）后仍然观测到上游
  nextReply = replyWith({ finalProvider: 'deepseek', fallbacksAvailable: ['alibaba'] })
  mount({ clineKeys: ['k1', 's2'], clineMatch: match })
  n = mark()
  await call('k1', MONITORED)
  rows = since(n)
  const afterRotate = upstreamRowOf(MONITORED)
  check('C7 撞 429 换 key 重发后依然观测到上游（跑通的是第二次）',
    rows.length === 2 && rows[1].key === 's2' && afterRotate?.upstream?.provider === 'deepseek',
    `attempts=${rows.map((r) => r.key).join('→')} upstream=${JSON.stringify(afterRotate?.upstream)}`)
}

dispose()
rmSync(TEST_STATE_DIR, { recursive: true, force: true })
// 收尾顺序：先关干净连接，再让 undici 静下来。否则偶发
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 会让退出码变 1——
// 测试全绿却被判失败，是最难查的一类假阴性。
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))
await new Promise((resolve) => setTimeout(resolve, 50))

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.length} 项`)
process.exitCode = failed === 0 ? 0 : 1
