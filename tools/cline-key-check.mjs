/**
 * Cline 多 key 轮换自检（不需要真实 key）
 *
 *   node tools/cline-key-check.mjs
 *
 * 起一个本地 mock 服务器复刻 Cline 的限流报文：
 *   429 {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached
 *        on model <model>. Try again in 22h 47m"}
 * 然后验证插件的四种 key 来源、按模型冷却、粘性选 key（先烧完一把再换），以及整池耗尽时的收尾行为。
 */

import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

// 额度状态默认落在 DSH home；自检必须隔离到临时目录，绝不碰用户真实状态文件
const TEST_STATE_DIR = join(tmpdir(), `ofb-cline-state-${process.pid}`)
mkdirSync(TEST_STATE_DIR, { recursive: true })
let stateSeq = 0

// ── mock Cline 服务端 ────────────────────────────────────────────────
const seen = [] // { key, model, headers }
const tag = (key) => {
  if (typeof key !== 'string' || key.length <= 8) return String(key)
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const LIMITED_PREFIXES = ['k1', 'k5', 'e1', 'c1'] // 这些 key 一律撞「每日免费额度」上限
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
    seen.push({ key, model, headers: req.headers, body })

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
    // 回包同样只回哈希标签，避免 key 原文出现在测试输出里
    res.end(JSON.stringify({ ok: true, servedByTag: tag(key), model }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const match = `127.0.0.1:${server.address().port}`
const ENDPOINT = `http://${match}/api/v1/chat/completions`

// ── 断言脚手架 ──────────────────────────────────────────────────────
const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

let dispose = () => {}
let lastCtx
function mount(config = {}, credentialsStub, injectService) {
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: () => {} },
    // credentialsStub 可为对象，或「返回对象/undefined 或抛错」的函数（模拟服务晚就绪或 isolate 不匹配）
    get: (name) =>
      name === 'credentials' ? (typeof credentialsStub === 'function' ? credentialsStub() : credentialsStub) : undefined,
    // 模拟 Cordis 的「等依赖就绪」子插件：deps 命中且提供了服务时才回调
    inject: (deps, callback) => {
      if (Array.isArray(deps) && deps.includes('credentials') && injectService) {
        callback({ credentials: injectService, get: (name) => (name === 'credentials' ? injectService : undefined) })
      }
    },
  }
  const merged = { ...config }
  if (merged.quotaStatePath === undefined) merged.quotaStatePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  // 隔离：绝不读用户真实的 .credentials.yaml（除非用例显式提供自己的凭据文件）
  if (merged.credentialsFile === undefined && merged.readCredentialsFile === undefined) {
    merged.credentialsFile = join(TEST_STATE_DIR, 'no-such-credentials.yaml')
  }
  apply(ctx, merged)
  lastCtx = ctx
  return ctx
}

/** 输出里永不出现 key 原文：长于 8 字符的一律换成 8 位哈希标签（与插件日志同一算法）。 */
const keyTag = (key) => {
  if (typeof key !== 'string') return String(key)
  if (key.length <= 8) return key
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const attemptsText = (attempts) => attempts.map((a) => keyTag(a.key)).join('→')
/** 复刻 Cordis 的真实行为：插件未声明依赖时，ctx.get(name) 会抛错而非返回 undefined。 */
const isolateMismatch = () => {
  throw new Error('cannot get property "credentials" without provide (isolate)')
}
const ctxSnapshot = () => lastCtx?.__opencodeFreeBridge?.clineKeys?.() ?? []
const ctxStatus = (options) => lastCtx?.__opencodeFreeBridge?.status?.(options) ?? null
const ctxFlush = () => lastCtx?.__opencodeFreeBridge?.flushQuotaState?.()

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

// ── G. 来源三：.credentials.yaml，且 ref 名可配置（未声明的 ref 必须被忽略）──
{
  const credPath = join(TEST_STATE_DIR, `credentials-refs-${++stateSeq}.yaml`)
  writeFileSync(
    credPath,
    ['version: 1', 'refs:', '  MY_CLINE_KEY: "g2"', '  CLINE_API_KEY_2: "must-be-ignored"'].join('\n'),
  )
  mount({ clineKeys: ['k1'], clineMatch: match, credentialsFile: credPath, clineKeyRefs: ['MY_CLINE_KEY'] })
  const n = mark()
  const r = await call('k1')
  const attempts = since(n)
  check('G1 自定义 ref 名被采纳并完成轮换', r.status === 200 && attempts.length === 2 && attempts[1].key === 'g2', attemptsText(attempts))
  check('G2 未列在 clineKeyRefs 中的 ref 被忽略', !attempts.some((a) => a.key === 'must-be-ignored'), attemptsText(attempts))
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

// ─ O. 粘性选 key：先把一把用到限流，再换下一把（不把压力摊到所有 key）─────
// 场景就是用户实际遇到的：主 key 已撞每日上限，池里还有几把健康 key。
// 期望行为是「一直用同一把备用 key，直到它也撞上限才换下一把」，
// 而不是每个请求轮换一把（那会让所有 key 几乎同时逼近上限、一起失去后备）。
{
  mount({ clineKeys: ['z1', 'z2', 'z3'], clineMatch: match, skipCoolingRequestKey: true })

  // 第 1 个请求：主 key k1 撞上限 → 换到池内第一把
  const n0 = mark()
  const r1 = await call('k1')
  const first = since(n0)
  check('O1 首次轮换落到一把备用 key 上并成功', r1.status === 200 && first.length === 2 && first[1].key === 'z1', first.map((a) => a.key).join('→'))

  // 之后连续 4 个请求：应当全部复用同一把（z1），不能轮换到 z2/z3
  const n1 = mark()
  for (let i = 0; i < 4; i++) await call('k1')
  const followUp = since(n1)
  const usedKeys = [...new Set(followUp.map((a) => a.key))]
  check('O2 后续请求全部复用同一把备用 key（粘性）', usedKeys.length === 1 && usedKeys[0] === 'z1', `4 个请求用到 ${usedKeys.length} 把：${usedKeys.join(',')}`)
  check('O3 粘性期间没有碰过池里其它 key', !followUp.some((a) => a.key === 'z2' || a.key === 'z3'), followUp.map((a) => a.key).join('→'))

  // 面板口径也应如此：z1 多次发送，z2/z3 一次都没发过。
  // 注意：短测试 key 的掩码预览会退化成同一个「…」，所以这里按 8 位标签取，而不是掩码。
  const labelOf = (key) => {
    let h = 0x811c9dc5
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  const keys = ctxStatus().keys
  const sentOf = (key) => keys.find((k) => k.label === labelOf(key))?.stats.sent ?? -1
  const coolingOf = (key) => keys.find((k) => k.label === labelOf(key))?.cooling ?? []
  check('O4 面板统计里被粘住的那把计数最多', sentOf('z1') === 5 && sentOf('z2') === 0 && sentOf('z3') === 0,
    `z1=${sentOf('z1')} z2=${sentOf('z2')} z3=${sentOf('z3')}`)
  check('O5 被粘住的 key 仍然健康（没有冷却）', Array.isArray(coolingOf('z1')) && coolingOf('z1').length === 0)
  check('O6 主 key 只在首个请求撞过一次，之后不再白撞', sentOf('k1') === 1, `k1=${sentOf('k1')}`)

  // 备用 key 自己也撞上限时才该换人：k1、k5 都限流，z2 健康
  mount({ clineKeys: ['k1', 'k5', 'z2'], clineMatch: match, skipCoolingRequestKey: true })
  const n2 = mark()
  await call('k1') // k1 限流 → 换到 k5（也限流）→ 换到 z2 成功
  const recovery = since(n2)
  check('O7 连续撞限流时会依次换到下一把，直到找到健康 key', recovery.length === 3 && recovery[2].key === 'z2', recovery.map((a) => a.key).join('→'))
  const n3 = mark()
  await call('k1')
  const sticky2 = since(n3)
  check('O8 换到健康 key 后同样粘住它（不再回到已限流的 k5）', sticky2.length === 1 && sticky2[0].key === 'z2', sticky2.map((a) => a.key).join('→'))
}

// ── K. 轮换重发是否影响会话内容：请求体必须逐字节相同 ────────────────
{
  mount({ clineKeys: ['k1', 'k2'], clineMatch: match })
  const payload = JSON.stringify({
    model: 'deepseek/deepseek-v4.1-flash',
    max_tokens: 256,
    messages: [
      { role: 'system', content: 'You are a helpful coding agent.' },
      { role: 'user', content: '第一轮问题：读一下 index.js' },
      { role: 'assistant', content: '第一轮回答：已读取' },
      { role: 'user', content: '第二轮追问：继续改' },
    ],
    tools: [
      { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ],
  })
  const n = mark()
  const res = await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
    body: payload,
  })
  await res.text()
  const attempts = since(n)

  check('K1 轮换后成功（同一次调用内完成）', res.status === 200 && attempts.length === 2, attempts.map((a) => a.key).join('→'))
  check(
    'K2 重发的请求体与原请求逐字节相同（对话历史不被改动）',
    attempts.length === 2 && attempts[0].body === payload && attempts[1].body === payload,
    `len=${attempts[1]?.body?.length ?? 0}/${payload.length}`,
  )
  check('K3 两次仅鉴权头不同，其余 Cline 指纹头一致', attempts[0].key === 'k1' && attempts[1].key === 'k2' && attempts[0].headers['x-client-type'] === attempts[1].headers['x-client-type'])
}

// ── L. 额度状态跨进程持久化（用报错里的恢复时刻）─────────────────────
{
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  rmSync(statePath, { force: true })

  // 第一个进程：k1 撞上限，记录恢复时刻并落盘
  mount({ clineKeys: ['k1', 'k2'], clineMatch: match, quotaStatePath: statePath, skipCoolingRequestKey: true, allCoolingFailFast: false })
  const n = mark()
  const r1 = await call('k1')
  const a1 = since(n)
  ctxFlush()
  dispose()

  const saved = JSON.parse(readFileSync(statePath, 'utf8'))
  const flat = Object.values(saved.entries ?? {}).flatMap((m) => Object.values(m))
  check('L1 首次轮换成功且状态已落盘', r1.status === 200 && a1.length === 2 && flat.length === 1, attemptsText(a1))
  check('L2 落盘的是恢复时刻而非 key 原文', flat[0]?.readyAt > Date.now() + 60 * 60 * 1000 && !readFileSync(statePath, 'utf8').includes('k1'), `readyInMin=${Math.round((flat[0]?.readyAt - Date.now()) / 60000)}`)
  check('L3 缓存了服务端原始报错供回放', /INFERENCE_CAP_ERROR/.test(flat[0]?.body ?? ''), (flat[0]?.body ?? '').slice(0, 60))

  // 模拟 DSH 重启：全新实例读同一份状态
  mount({ clineKeys: ['k1', 'k2'], clineMatch: match, quotaStatePath: statePath, skipCoolingRequestKey: true, allCoolingFailFast: false })
  const n2 = mark()
  const r2 = await call('k1')
  const a2 = since(n2)
  check(
    'L4 重启后直接跳过已限 key（不再白撞 429）',
    r2.status === 200 && a2.length === 1 && a2[0].key === 'k2',
    attemptsText(a2),
  )
  const snap = ctxSnapshot()
  check('L5 恢复后的冷却状态可读且带恢复时间', snap.some((e) => e.quota?.some((q) => q.readyInMin > 60)), JSON.stringify(snap.find((e) => e.quota?.length)?.quota ?? []))
  ctxFlush()
  rmSync(statePath, { force: true })
}

// ── M. 全池冷却：用恢复时刻直接快速失败，不发注定失败的请求 ──────────
{
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: ['k1', 'k5'], clineMatch: match, quotaStatePath: statePath })

  // k1 与 k5 在 mock 里都返回每日上限；第一次请求会把两个 key 都打上冷却
  const n = mark()
  const r1 = await call('k1')
  since(n)
  check('M1 两个 key 都撞上限后返回 429', r1.status === 429, String(r1.status))

  const n2 = mark()
  const r2 = await call('k1')
  const a2 = since(n2)
  check('M2 全池冷却时不再发请求（快速失败）', a2.length === 0, `server 收到 ${a2.length} 次`)
  check('M3 回放的是服务端原始报文', /INFERENCE_CAP_ERROR/.test(r2.text) && /Try again in/.test(r2.text), r2.text.slice(0, 90))
  check('M4 标记 x-should-retry:false', r2.noRetry === 'false', String(r2.noRetry))

  // 恢复时刻落在阈值之内时不应快速失败，仍要实际请求。
  // failFastMinMs 的语义：最早恢复时刻距离现在「至少这么远」才快速失败；设 0 表示只要全池冷却就快速失败。
  const statePath2 = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: ['k1'], clineMatch: match, quotaStatePath: statePath2, failFastMinMs: 365 * 24 * 3600 * 1000 })
  await call('k1')
  const n3 = mark()
  await call('k1')
  check('M5 阈值大于实际恢复间隔时不快速失败（照常请求）', since(n3).length === 1, `server 收到 ${since(n3).length} 次`)

  const statePath3 = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: ['k1'], clineMatch: match, quotaStatePath: statePath3, failFastMinMs: 0 })
  await call('k1')
  const n4 = mark()
  await call('k1')
  check('M6 failFastMinMs=0 表示只要全池冷却就快速失败', since(n4).length === 0, `server 收到 ${since(n4).length} 次`)

  ctxFlush()
  rmSync(statePath, { force: true })
}

// ── N. 额外 key 来源的健壮性（不再使用 DSH 凭据服务，见 index.js 顶部说明）──
{
  // N1：ctx.get 拿不到凭据服务时，直接读 .credentials.yaml
  const credPath = join(TEST_STATE_DIR, `credentials-${++stateSeq}.yaml`)
  writeFileSync(
    credPath,
    ['version: 1', 'refs:', '  CLINE_API_KEY: "p1"', '  CLINE_API_KEY_2: "n2"', 'records:', '  x:', '    kind: grant'].join('\n'),
  )
  mount({ clineKeys: [], clineMatch: match, credentialsFile: credPath })
  const n = mark()
  const r = await call('k1')
  const a = since(n)
  check('N1 从 .credentials.yaml 取到额外 key 并完成轮换', r.status === 200 && a.length === 2 && a[1].key === 'n2', attemptsText(a))

  // N2：文件稍后才出现（例如首次读取时 DSH 还没写盘）不能被永久上锁
  const latePath = join(TEST_STATE_DIR, `credentials-late-${++stateSeq}.yaml`)
  mount({ clineKeys: ['k1'], clineMatch: match, credentialsFile: latePath })
  const r0 = await call('k1')
  check('N2a 文件不存在时先按单 key 处理', r0.status === 429, String(r0.status))

  writeFileSync(latePath, ['version: 1', 'refs:', '  CLINE_API_KEY_9: "z9"'].join('\n'))
  await new Promise((r) => setTimeout(r, 2200)) // 越过 2s 重试节流
  const n2 = mark()
  const r2 = await call('k1')
  const a2 = since(n2)
  check('N2b 文件稍后出现后额外 key 自动补入池（无永久上锁）', r2.status === 200 && a2.some((x) => x.key === 'z9'), attemptsText(a2))
}

dispose()
rmSync(TEST_STATE_DIR, { recursive: true, force: true })
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.length} 项`)
process.exit(failed === 0 ? 0 : 1)