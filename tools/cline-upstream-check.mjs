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
import { createUpstreamLog, readUpstream } from '../lib/host/upstream.js'
import { keyLabel } from '../lib/host/labels.js'
import { MONITORED_UPSTREAM_MODELS, PREFERRED_UPSTREAM } from '../lib/host/defaults.js'

const TEST_STATE_DIR = join(tmpdir(), `ofb-upstream-state-${process.pid}`)
mkdirSync(TEST_STATE_DIR, { recursive: true })
let stateSeq = 0

const MONITORED = MONITORED_UPSTREAM_MODELS[0]
// 第二个被观测的模型：glm 走的是**顶层 provider 字段**（无 provider_metadata），
// 与 deepseek 的 provider_metadata.routing 是两种形状，两条都要覆盖（见 A13–A16）。
const MONITORED_FLAT = 'z-ai/glm-5.3-flash'
// 「不在观测名单里」的模型：曾经用 glm 当这个角色，glm 加入名单后它就不能再代表「未观测」了。
const OTHER = 'some-vendor/unmonitored-model'

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
/** 该模型在载荷里的**模型维度**条目（只有 preferred，没有观测——观测是 per-key 的）。 */
const modelRowOf = (model) => (lastCtx.__dshClineBridge.status().models || []).find((m) => m.id === model)
/** 某把原始 key 在某个模型上的观测 —— 这才是面板 Key 表那一列真正读的数据。 */
const keyUpstreamOf = (rawKey, model) => {
  const label = keyLabel(rawKey)
  const key = (lastCtx.__dshClineBridge.status().keys || []).find((k) => k.label === label)
  return (key?.models || {})[model]?.upstream
}

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

  // A13–A16：**顶层 provider 字段**（形态三）。实测 `z-ai/glm-5.3-flash` 这条路由
  // 完全没有 provider_metadata，上游名放在 chunk 顶层的 `provider` 里。只认
  // provider_metadata 的实现对这些模型恒返回 null——面板「上游渠道」列永远是「—」。
  const flatChunk = (provider) => chunk({
    id: 'gen_x', object: 'chat.completion.chunk', model: 'z-ai/glm-5.3-flash',
    provider, choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
  })

  check('A13 流式 chunk 顶层 provider 字段能读出上游（glm 形态）',
    readUpstream(flatChunk('Parasail') + 'data: [DONE]\n\n')?.provider === 'Parasail',
    JSON.stringify(readUpstream(flatChunk('Parasail'))))
  check('A14 顶层 provider 名两端空白被清掉',
    readUpstream(flatChunk('  Parasail  '))?.provider === 'Parasail')
  check('A15 顶层 provider 为空串 / 缺失时返回 null（看不到 ≠ 某一家）',
    readUpstream(flatChunk('')) === null && readUpstream(flatChunk(undefined)) === null)
  check('A16 provider_metadata 优先于顶层 provider（两种形状同时出现时以 routing 为准）',
    (() => {
      const both = chunk({
        model: 'm', provider: 'Wafer',
        choices: [{ index: 0, delta: { provider_metadata: { gateway: { routing: { finalProvider: 'Parasail' } } } } }],
      })
      return readUpstream(both)?.provider === 'Parasail'
    })())
}

// ── B. 观测台账 ──────────────────────────────────────────────────────
// 台账有两份索引：model（芯片徽标曾用，现仅作记录）与 key+model（Key 表「上游渠道」列用）。
// 这里钉住「脏输入一律不记」与「按 key 取得到、且不串味」。
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

  // 按 key 的记录：这是 Key 表那一列的数据源
  log.note(MONITORED, { provider: 'alibaba', fallbacks: 3 }, 'aaaa1111')
  check('B6 按 key 取得到该 key 在该模型上的观测',
    log.getForKey('aaaa1111', MONITORED)?.provider === 'alibaba',
    JSON.stringify(log.getForKey('aaaa1111', MONITORED)))
  check('B7 没有标签时不写 key 维度的记录（不编造 key 的结论）',
    log.getForKey('', MONITORED) === undefined)
  check('B8 别的 key 取不到（逐 key 各记各的，不串味）',
    log.getForKey('bbbb2222', MONITORED) === undefined)
  check('B9 同一 key 在别的模型上取不到（key+模型 两维都要对上）',
    log.getForKey('aaaa1111', 'z-ai/glm-5.3-flash') === undefined)
  check('B10 没有 provider 的观测不写 key 维度',
    (() => { log.note(MONITORED, { provider: '' }, 'cccc3333'); return log.getForKey('cccc3333', MONITORED) === undefined })())

  check('B11 观测名单与预期上游表逐一对应（名单里的模型都有预期值）',
    MONITORED_UPSTREAM_MODELS.length === 3 &&
      MONITORED_UPSTREAM_MODELS.every((m) => typeof PREFERRED_UPSTREAM[m] === 'string' && PREFERRED_UPSTREAM[m]),
    MONITORED_UPSTREAM_MODELS.join(','))
  check('B12 预期上游表覆盖 deepseek、glm 与 kimi（glm 锁定在 Parasail，kimi 预期 Cline 自托管端点）',
    PREFERRED_UPSTREAM['cline-free/deepseek-v4.1-flash'] === 'deepseek' &&
      PREFERRED_UPSTREAM['z-ai/glm-5.3-flash'] === 'Parasail')
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

  // 面板读的是**逐 key** 的观测（Key 表的「上游渠道」列），不是模型维度的。
  const row = keyUpstreamOf('s1', MONITORED)
  check('C3 面板拿到这把 key 在該模型上的实际上游（deepseek）',
    row?.provider === 'deepseek', JSON.stringify(row))
  check('C3b 模型维度不再下发观测（芯片徽标已移除，只有 preferred）',
    modelRowOf(MONITORED)?.upstream === undefined && modelRowOf(MONITORED)?.preferred === 'deepseek',
    JSON.stringify(modelRowOf(MONITORED)))

  // 上游漂到别家：面板必须能看出来
  nextReply = replyWith({ finalProvider: 'alibaba', fallbacksAvailable: ['novita'] })
  n = mark()
  await call('s1', MONITORED)
  const drifted = keyUpstreamOf('s1', MONITORED)
  check('C4 上游漂到 alibaba 时面板如实显示',
    drifted?.provider === 'alibaba', JSON.stringify(drifted))

  // 读不到元数据：保留上一次观测（不用空值冒充本次）
  nextReply = JSON.stringify({ data: { choices: [{ message: {} }] } })
  n = mark()
  await call('s1', MONITORED)
  const noMeta = keyUpstreamOf('s1', MONITORED)
  check('C5 回包没有路由元数据时保留上一次观测（不清空成空值）',
    noMeta?.provider === 'alibaba', JSON.stringify(noMeta))

  // 不在观测名单里的模型：即使回包有元数据也不记
  nextReply = replyWith({ finalProvider: 'bedrock', fallbacksAvailable: [] })
  n = mark()
  await call('s1', OTHER)
  const otherRow = modelRowOf(OTHER)
  check('C6 不在观测名单里的模型不产生上游数据（只盯指定模型，不外扩）',
    otherRow !== undefined && otherRow.preferred === '' &&
      keyUpstreamOf('s1', OTHER) === undefined,
    JSON.stringify(otherRow))

  // 换 key 重发（429 轮换）后仍然观测到上游
  nextReply = replyWith({ finalProvider: 'deepseek', fallbacksAvailable: ['alibaba'] })
  mount({ clineKeys: ['k1', 's2'], clineMatch: match })
  n = mark()
  await call('k1', MONITORED)
  rows = since(n)
  const afterRotate = keyUpstreamOf('s2', MONITORED)
  check('C7 撞 429 换 key 重发后，观测记在**真正跑通的那把** key 上',
    rows.length === 2 && rows[1].key === 's2' && afterRotate?.provider === 'deepseek' &&
      keyUpstreamOf('k1', MONITORED) === undefined,
    `attempts=${rows.map((r) => r.key).join('→')} s2=${JSON.stringify(afterRotate)} k1=${JSON.stringify(keyUpstreamOf('k1', MONITORED))}`)
}

// ── D. 上游锁定：provider.only 注入 ─────────────────────────────────
//
// 2026-09 实测 `z-ai/glm-5.3-flash`：标准 OpenRouter 形态的 `provider.only` 是**真的
// 被强制执行**的（`only=["zzz-not-real"]` 会 6/6 报 stream_initialization_failed），
// 与早期被无视的 `providerOptions.gateway.only` 不同。D 组钉住注入的**边界**：
// 只在配置了锁定、且模型命中时才改；其余情况一个字节都不动。
{
  const GLM = MONITORED_FLAT
  const PIN = { pinUpstream: { [GLM]: 'Parasail' } }
  let rows = []

  // D1：没配置锁定时，请求体逐字节不变（既有契约）
  mount({ clineKeys: ['s1'], clineMatch: match })
  nextReply = replyWith({ finalProvider: 'deepseek' })
  let payload = JSON.stringify({ model: MONITORED, messages: [{ role: 'user', content: 'x' }] })
  let n = mark()
  await call('s1', MONITORED, payload)
  check('D1 没配置 pinUpstream 时请求体逐字节不变', since(n)[0]?.body === payload)

  // D2：配置了锁定，但请求的模型不在表里 → 不动
  mount({ clineKeys: ['s1'], clineMatch: match, ...PIN })
  n = mark()
  await call('s1', MONITORED, payload)
  check('D2 锁定表里没有该模型时请求体逐字节不变', since(n)[0]?.body === payload)

  // D3：命中锁定 → provider.only 真的发到线上
  payload = JSON.stringify({ model: GLM, messages: [{ role: 'user', content: 'x' }] })
  n = mark()
  await call('s1', GLM, payload)
  let sent = since(n)[0]
  check('D3 命中锁定时 provider.only 真的写进发出去的请求体',
    sent?.parsed?.provider?.only?.[0] === 'Parasail' && sent?.parsed?.provider?.allow_fallbacks === false,
    JSON.stringify(sent?.parsed?.provider))

  // D4：只加这一个字段，其余键原样保留
  check('D4 注入只加 provider 字段，原有键原样保留（model/messages 不变）',
    sent?.parsed?.model === GLM && sent?.parsed?.messages?.[0]?.content === 'x' &&
      Object.keys(sent?.parsed ?? {}).sort().join(',') === 'messages,model,provider',
    Object.keys(sent?.parsed ?? {}).join(','))

  // D5：allowFallbacks 配置能透传
  mount({ clineKeys: ['s1'], clineMatch: match, pinUpstream: { [GLM]: { provider: 'Parasail', allowFallbacks: true } } })
  n = mark()
  await call('s1', GLM, payload)
  check('D5 allowFallbacks:true 透传成 allow_fallbacks:true',
    since(n)[0]?.parsed?.provider?.allow_fallbacks === true)

  // D6：已有 provider.only（用户/别的中间件写的）不被覆盖
  mount({ clineKeys: ['s1'], clineMatch: match, ...PIN })
  const own = JSON.stringify({ model: GLM, messages: [], provider: { only: ['Wafer'] } })
  n = mark()
  await call('s1', GLM, own)
  check('D6 请求体已有 provider.only 时不覆盖（尊重现状）',
    since(n)[0]?.body === own, since(n)[0]?.body)

  // D7：非 JSON body 不炸、原样放行
  mount({ clineKeys: ['s1'], clineMatch: match, ...PIN })
  n = mark()
  await call('s1', GLM, 'not-json')
  check('D7 非 JSON 请求体原样放行（不抛错）', since(n)[0]?.body === 'not-json')

  // D8：撞 429 换 key 重发时，重发那份**同样带锁定**（否则会悄悄漂回随机路由）
  nextReply = replyWith({ finalProvider: 'Parasail' })
  mount({ clineKeys: ['k1', 's2'], clineMatch: match, ...PIN })
  n = mark()
  await call('k1', GLM, payload)
  rows = since(n)
  check('D8 换 key 重发的请求体同样带锁定（两条都注入）',
    rows.length === 2 && rows[0].parsed?.provider?.only?.[0] === 'Parasail' &&
      rows[1].parsed?.provider?.only?.[0] === 'Parasail',
    `attempts=${rows.length} pins=${rows.map((r) => r.parsed?.provider?.only?.[0]).join(',')}`)

  // D9：锁定生效次数进 diagnostics（排查入口）
  check('D9 锁定生效次数记进 diagnostics.pinApplied',
    lastCtx.__dshClineBridge.diagnostics().pinApplied > 0,
    String(lastCtx.__dshClineBridge.diagnostics().pinApplied))
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
