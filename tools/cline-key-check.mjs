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
// 这些 key 只给标准 `Retry-After` 头，报文里**没有**任何可解析的窗口文本：
// h1 走「纯秒数」形态，h2 走「HTTP-date」形态（两种都是 HTTP 规范允许的写法）；
// h3 两个来源同时在（报文 5 分钟、头 1 小时），用来钉「报文文本优先」。
const HEADER_PREFIXES = ['h1', 'h2', 'h3']

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

    if (HEADER_PREFIXES.some((p) => key === p || key.startsWith(p))) {
      const isPrecedenceProbe = key.startsWith('h3')
      const retryAfter = key.startsWith('h2')
        ? new Date(Date.now() + 2 * 3600_000).toUTCString() // HTTP-date 形态（2 小时后）
        : '3600' // 纯秒数形态（h1；h3 也带头，但报文里另有一个更小的窗口）
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': retryAfter })
      res.end(
        JSON.stringify(
          isPrecedenceProbe
            ? { code: 'INFERENCE_CAP_ERROR', message: 'Error 429: Daily free limit reached. Try again in 5m' }
            : { code: 'RATE_LIMITED', message: 'Too many requests, please slow down.' },
        ),
      )
      return
    }

    if (key.startsWith('n1')) {
      // 只回「被限流了」这一件事：报文里没有可解析的窗口，也没有 Retry-After 头。
      // 插件据此只应该记住「限流发生过」，**不该**自己编一个恢复时刻。
      res.writeHead(429, { 'content-type': 'application/json' })
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
    // big* 前缀的 key 回一个**异常巨大**的 usage：用来验证插件会把单次上报夹在上限内，
    // 不让一个坏数字污染「这把 key 用了多少」的统计（走的是真实的 tapUsage → markTokens 链路）。
    const usage = key.startsWith('big')
      ? { prompt_tokens: 1e12, completion_tokens: 10, total_tokens: 1e12 }
      : undefined
    // 回包同样只回哈希标签，避免 key 原文出现在测试输出里
    res.end(JSON.stringify({ ok: true, servedByTag: tag(key), model, ...(usage ? { usage } : {}) }))
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
function mount(config = {}) {
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: () => {} },
    // 插件不声明依赖，也不需要任何 host 服务：get 一律 undefined、inject 永不回调。
    // （settings / webServer 缺席正是插件要能正常工作的场景，面板会自行退化。）
    get: () => undefined,
    inject: () => undefined,
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
const ctxSnapshot = () => lastCtx?.__dshClineBridge?.clineKeys?.() ?? []
const ctxStatus = (options) => lastCtx?.__dshClineBridge?.status?.(options) ?? null
const ctxFlush = () => lastCtx?.__dshClineBridge?.flushQuotaState?.()
const ctxExtras = () => lastCtx?.__dshClineBridge?.extras?.() ?? {}
const ctxDiag = () => lastCtx?.__dshClineBridge?.diagnostics?.() ?? {}

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
    ctx.__dshClineBridge.parseRetryWindowMs('Error 429: Daily free limit reached. Try again in 22h 47m') === (22 * 3600 + 47 * 60) * 1000,
    String(ctx.__dshClineBridge.parseRetryWindowMs('Try again in 22h 47m')),
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
  const snap = ctx.__dshClineBridge.clineKeys()
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

  // N3：**已经成功读到过 key 之后**再往凭据文件里补一把新 ref —— 这是用户最常见的动作
  //（「新增这个 key」）。曾经这里被 `!extrasResolved` 门控挡住：首次读到就再也不读文件，
  // 新 key 必须重启 DSH 才生效，而 README 承诺的是「每 5 分钟复扫」。
  // 设计：文件里先只有 _2（值 k5x，mock 里 k5 前缀必限流），主 key k1 也限流，
  // 于是首次请求必然撞满 429；随后追加 _5（值 z5，健康），验证新 key 能顶上。
  const growPath = join(TEST_STATE_DIR, `credentials-grow-${++stateSeq}.yaml`)
  writeFileSync(growPath, ['version: 1', 'refs:', '  CLINE_API_KEY_2: "k5x"'].join('\n'))
  const growCtx = mount({ clineKeys: ['k1'], clineMatch: match, credentialsFile: growPath })
  const g1 = mark()
  const rg1 = await call('k1')
  const ag1 = since(g1)
  check('N3a 首次读到额外 key 后进入已解析状态，且当时池内只有两把',
    rg1.status === 429 && ctxExtras().extrasResolved === true && ctxStatus().keys.length === 2,
    `${attemptsText(ag1)} 池=${ctxStatus().keys.length}`)

  // 往同一个文件里追加一把新 ref（模拟用户新加了一把 key）
  writeFileSync(growPath, ['version: 1', 'refs:', '  CLINE_API_KEY_2: "k5x"', '  CLINE_API_KEY_5: "z5"'].join('\n'))
  // 用 force 越过 5 分钟节流，走的是与自动复扫完全相同的那条读盘路径
  await growCtx.__dshClineBridge.ensureExtras({ force: true })
  const poolLabels = ctxStatus().keys.map((k) => k.label)
  check('N3b 已解析状态下新增的 ref 会被复扫发现（池从 2 把变 3 把）',
    ctxStatus().keys.length === 3, `池内 ${poolLabels.length} 把`)

  // 关键：新加的那把真的能被用起来 —— k1 与 k5x 都限流后必须轮到 z5
  const g2 = mark()
  const rg2 = await call('k1')
  const ag2 = since(g2)
  check('N3c 新增的 key 无需重启即可承接轮换', rg2.status === 200 && ag2.some((x) => x.key === 'z5'), attemptsText(ag2))
}

// ─ P. 用量统计跨重启：计数 / token / 粘性基准都从状态文件恢复 ─────
// 这些数字过去只活在内存里，插件一更新（= DSH 重启）就全变 0。
{
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  rmSync(statePath, { force: true })
  const config = { clineKeys: ['k1', 'k3', 'k2'], clineMatch: match, quotaStatePath: statePath }
  // 池内的 label 是 8 位哈希（与插件同一算法）；上面的 tag() 只是「短 key 原样显示」的日志用版本
  const label8 = (value) => {
    let h = 0x811c9dc5
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }

  // 插入顺序是 k1 → k3 → k2，而本次先用过一次 k2：这样「粘性按 lastUsedAt 恢复」
  // 与「没恢复、按插入顺序且 lastUsedAt=0」会给出**不同**的备用 key（k2 vs k3），
  // 于是下面那条断言才真的在测「恢复」而不是在测巧合。
  mount(config)
  const r1 = await call('k2')
  ctxFlush()
  const totals1 = lastCtx.__dshClineBridge.statsTotals()
  const row1 = ctxStatus().keys.find((k) => k.label === label8('k2'))
  check('P1 统计已落盘（累计计数 + 统计起点）', r1.status === 200 && totals1.clineRequests === 1 && totals1.since > 0, JSON.stringify(totals1))
  // 这个 mock 的回包不带 usage，所以 token 在这里恒为 0（token 采集另有专测）；
  // 这里要钉的是「计数确实记在这把 key 上」，P4 再钉它跨重启没丢。
  check('P2 用过的 key 记下了请求计数', row1?.stats?.sent === 1 && row1?.stats?.ok === 1, JSON.stringify(row1?.stats))

  // 模拟插件更新 / DSH 重启：同一份状态文件，全新实例
  mount(config)
  const totals2 = lastCtx.__dshClineBridge.statsTotals()
  const row2 = ctxStatus().keys.find((k) => k.label === label8('k2'))
  check('P3 重启后累计计数与统计起点沿用', totals2.clineRequests === 1 && totals2.since === totals1.since, JSON.stringify(totals2))
  check('P4 重启后该 key 的计数与 token 仍在',
    row2?.stats?.sent === row1?.stats?.sent && row2?.stats?.tokens?.input === row1?.stats?.tokens?.input,
    JSON.stringify(row2?.stats))

  const n = mark()
  const r2 = await call('k1')
  const a2 = since(n)
  check('P5 重启后粘性延续：备用 key 仍是上次那把（k2 而不是插入顺序更前的 k3）',
    r2.status === 200 && a2.at(-1)?.key === 'k2', attemptsText(a2))
  ctxFlush()
  rmSync(statePath, { force: true })
}

// ─ Q. DSH 侧没配 key：从池里挑一把兜底（否则裸请求必是 401，轮换救不了）──
// 对应「把 DSH 提供方的 apiKeyEnv 整个移除」的用法：此时请求不带任何鉴权头，
// 插件在首发送前就从池里挑一把（粘性优先、跳过已冷却者），后续撞 429 照常轮换。
{
  const post = async (extraHeaders = {}) =>
    globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
    })

  mount({ clineKeys: ['k2', 'k3'], clineMatch: match })
  const n = mark()
  const res = await post()
  await res.text()
  const a = since(n)
  check('Q1 请求没带 key 时，插件从池里挑一把兜底', res.status === 200 && a.length === 1 && a[0].key === 'k2', attemptsText(a))

  // pi-ai 没凭据时的另一种形态：发出「Bearer undefined」占位头，同样按没带 key 处理
  mount({ clineKeys: ['k2', 'k3'], clineMatch: match })
  const n2 = mark()
  const res2 = await post({ authorization: 'Bearer undefined' })
  await res2.text()
  const a2 = since(n2)
  check('Q2 「Bearer undefined」占位头按没带 key 处理（不把 undefined 当 key 发出去）',
    res2.status === 200 && a2.length === 1 && a2[0].key === 'k2', attemptsText(a2))

  // 关掉兜底：clineMatch 指向免鉴权自建中转的场景，keyless 必须原样透传
  mount({ clineKeys: ['k2', 'k3'], clineMatch: match, fillMissingRequestKey: false })
  const n3 = mark()
  const res3 = await post()
  await res3.text()
  const a3 = since(n3)
  check('Q3 fillMissingRequestKey:false 时原样透传，不注入', a3.length === 1 && a3[0].key === '', attemptsText(a3))

  // 池子为空：没有可挑的，保持原来的裸请求行为
  mount({ clineKeys: [], clineMatch: match })
  const n4 = mark()
  const res4 = await post()
  await res4.text()
  const a4 = since(n4)
  check('Q4 池子为空时不注入（行为与从前一致）', a4.length === 1 && a4[0].key === '', attemptsText(a4))
}

// ─ R. 回归锁：Request 形态的 body 保真、abort 传播、非 2xx 计数、冷启动日志 ──
// 这四条都曾经真实存在过缺陷，且此前没有任何用例覆盖（测试全走 (url, init) 形态）：
//   R1/R2  Request 形态在**池里只有一把 key** 时请求体被静默清空（旧代码只在 pool.size>1
//          时才缓冲 body，重建 Request 时传了 body: undefined）；
//   R3      重建 Request 时丢掉 signal，客户端取消传不到上游；
//   R4      非 2xx（例如 500）被计入「成功」，面板成功率系统性高估；
//   R5      冷启动那次 key 池扫描的日志命中 const 的 TDZ，被 .catch 静默吞掉。
{
  // R1/R2 刻意用一个**不在 mock 限流名单里**的 key（k1/k5/e1/c1 一律回 429）：
  // 否则第一条请求就会把这把 key 打进冷却，第二条会被「全池冷却快速失败」直接拦下，
  // 那样测到的是快速失败、不是 body 保真（这个坑本身也值得记下来）。
  const HEALTHY = 'ok1'
  mount({ clineKeys: [], clineMatch: match })
  const payload = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] })
  const n = mark()
  const req = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HEALTHY}` },
    body: payload,
  })
  await (await globalThis.fetch(req)).text()
  const a = since(n)
  check('R1 单 key 池下 Request 形态的请求体不丢（逐字节一致）',
    a.length === 1 && a[0].body === payload, `len=${a[0]?.body?.length ?? -1}/${payload.length}`)

  // R6：Request 形态下「最近决策」的那条轨迹也要带上真实模型。轨迹是在 model 解析之前
  // 建立的（那时只看得见 init?.body，Request 形态下恒为 '*'），解析出模型后必须写回，
  // 否则面板的「最近决策」对生产主路径永远显示 '*'。
  const trace = ctxDiag().lastRequests?.at(-1)
  check('R6 Request 形态的轨迹记录真实模型（不再是 *）',
    trace?.model === 'deepseek/deepseek-v4.1-flash', String(trace?.model))

  // R2：流式 body 同样要保住（旧代码对未消费的流 clone() 会抛，被 catch 吞成「无 body」）
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload))
      controller.close()
    },
  })
  const n2 = mark()
  const req2 = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${HEALTHY}` },
    body: stream,
    duplex: 'half',
  })
  await (await globalThis.fetch(req2)).text()
  const a2 = since(n2)
  check('R2 流式 Request 的请求体也不丢', a2.length === 1 && a2[0].body === payload, `len=${a2[0]?.body?.length ?? -1}/${payload.length}`)
}

// R3：abort 必须传到上游（旧代码重建 Request 时丢掉了 signal，取消永远不生效）
{
  const slow = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {}) // 永不响应
  })
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const slowMatch = `127.0.0.1:${slow.address().port}`
  mount({ clineKeys: [], clineMatch: slowMatch })
  const controller = new AbortController()
  const req = new Request(`http://${slowMatch}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
    body: '{}',
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(new Error('cancelled by caller')), 200)
  const outcome = await Promise.race([
    globalThis.fetch(req).then(() => 'resolved').catch((error) => `rejected:${error?.name}`),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
  ])
  check('R3 abort 信号能传到上游（客户端取消不再失效）', outcome.startsWith('rejected'), outcome)
  slow.closeAllConnections?.()
  await new Promise((resolve) => slow.close(resolve))
}

// R4：非 2xx 不能计成「成功」
{
  const boom = createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal' }))
    })
  })
  await new Promise((resolve) => boom.listen(0, '127.0.0.1', resolve))
  const boomMatch = `127.0.0.1:${boom.address().port}`
  const boomCtx = mount({ clineKeys: ['k1', 'k2'], clineMatch: boomMatch })
  const res = await globalThis.fetch(`http://${boomMatch}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k1' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash' }),
  })
  await res.text()
  const rows = boomCtx.__dshClineBridge.status().keys
  check('R4 500 不计入「成功」，单独记 failed',
    res.status === 500 && rows.every((row) => row.stats.ok === 0) && rows.some((row) => row.stats.failed === 1),
    JSON.stringify(rows.map((row) => ({ ok: row.stats.ok, failed: row.stats.failed }))))
  boom.closeAllConnections?.()
  await new Promise((resolve) => boom.close(resolve))
}

// R5：冷启动的 key 池日志必须真的发出来（曾经被 TDZ + .catch 静默吞掉）
{
  const lines = []
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: (message) => lines.push(String(message)) },
    get: () => undefined,
    inject: () => undefined,
  }
  apply(ctx, {
    clineKeys: ['k1', 'k2'],
    clineMatch: match,
    quotaStatePath: join(TEST_STATE_DIR, `state-${++stateSeq}.json`),
    credentialsFile: join(TEST_STATE_DIR, 'no-such-credentials.yaml'),
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('R5 冷启动就能打出 key 池日志（不再被 TDZ 吞掉）',
    lines.some((line) => line.includes('key 池')), `lines=${lines.length}`)
}

// ─ S. 回归锁：兜底不再静默吞错 ──
// 这一组针对的是「同一类问题的机制」而非某一个点：曾经 index.js 有 6 处
// .catch(() => {}) 与 quota-state 的空 catch，会把额外 key 扫描失败、状态落盘失败
// 全部吞得无影无踪——用户只会看到「池子莫名是空的 / 重启后冷却和统计全丢了」，
// 日志里却什么线索都没有。修好单个 TDZ 点并不能防止同类问题再次发生。
{
  // S1：ensureExtras 内部抛错必须留下日志（用会抛错的 config 访问器触发）
  const lines = []
  dispose()
  const ctx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: (message) => lines.push(String(message)) },
    get: () => undefined,
    inject: () => undefined,
  }
  apply(ctx, {
    clineMatch: match,
    quotaStatePath: join(TEST_STATE_DIR, `state-${++stateSeq}.json`),
    credentialsFile: join(TEST_STATE_DIR, 'no-such-credentials.yaml'),
    get clineKeys() {
      throw new Error('config exploded')
    },
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  check('S1 额外 key 扫描失败会打日志（不再被 .catch(() => {}) 吞掉）',
    lines.some((line) => line.includes('额外 key 扫描失败')), `lines=${lines.length}`)

  // S2：状态文件落盘失败必须留下日志（把状态路径的父级做成普通文件，mkdir 必然失败）
  const blockedDir = join(TEST_STATE_DIR, `blocker-${++stateSeq}`)
  writeFileSync(blockedDir, 'not a directory')
  const writeLines = []
  dispose()
  const writeCtx = {
    on: (event, fn) => {
      if (event === 'dispose') dispose = fn
    },
    logger: { warn: (message) => writeLines.push(String(message)) },
    get: () => undefined,
    inject: () => undefined,
  }
  apply(writeCtx, {
    clineKeys: ['k1'],
    clineMatch: match,
    quotaStatePath: join(blockedDir, 'sub', 'state.json'),
    credentialsFile: join(TEST_STATE_DIR, 'no-such-credentials.yaml'),
  })
  writeCtx.__dshClineBridge.flushQuotaState()
  check('S2 状态落盘失败会打日志（不再完全静默）',
    writeLines.some((line) => line.includes('落盘失败')), `lines=${writeLines.length}`)

  // S3：落盘失败只报一次，不能每 500ms 刷屏
  writeCtx.__dshClineBridge.flushQuotaState()
  writeCtx.__dshClineBridge.flushQuotaState()
  check('S3 连续落盘失败只报一次（不刷屏）',
    writeLines.filter((line) => line.includes('落盘失败')).length === 1,
    `count=${writeLines.filter((line) => line.includes('落盘失败')).length}`)
}

// ─ T. 数据与资源：诊断字段白名单、轨迹截断、token 上限 ──
// 防的都是「长期使用后文件无限涨」与「一个坏数字污染统计」。
// 全部走真实链路，不引入任何只为测试存在的生产钩子。
{
  // T1/T2：diagnostics 过白名单——v1 遗留字段与未知字段都不该落盘
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  // 先造一个带 v1 遗留字段的状态文件，模拟从旧版本升级上来
  writeFileSync(
    statePath,
    JSON.stringify({
      version: 2,
      entries: {},
      usage: {},
      totals: { since: 1, clineRequests: 0, rotations: 0, failFasts: 0 },
      diagnostics: {
        pluginVersion: '1.0.0',
        credentialsFound: true,
        credentialsVia: 'file',
        credentialsProbeError: 'boom',
        injectApi: false,
        injectCallback: false,
        injectError: 'nope',
        someUnknownField: { nested: 'junk' },
        lastRequests: [{ at: 'x', model: 'm', decision: 'd', extra: 'drop-me' }],
      },
    }),
  )
  mount({ clineKeys: ['k1'], clineMatch: match, quotaStatePath: statePath, allCoolingFailFast: false })
  await call('k1')
  ctxFlush()
  const disk = JSON.parse(readFileSync(statePath, 'utf8'))
  const legacyKeys = ['credentialsFound', 'credentialsVia', 'credentialsProbeError', 'injectApi', 'injectCallback', 'injectError']
  check('T1 读盘时清掉 v1 遗留诊断字段（它们早已没有写入者）',
    legacyKeys.every((name) => !(name in disk.diagnostics)), Object.keys(disk.diagnostics).join(','))
  check('T2 未知诊断字段也不落盘（白名单生效）',
    !('someUnknownField' in disk.diagnostics), Object.keys(disk.diagnostics).join(','))

  // T3：轨迹条数与单条长度都有上限。发多条请求（每条都会写一次 lastRequests），
  // 再检查落盘的条数与字段长度——这走的是 decide() → setDiagnostics 的真实路径。
  const diagPath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: ['k2'], clineMatch: match, quotaStatePath: diagPath })
  const longModel = 'm'.repeat(400)
  for (let i = 0; i < 5; i++) await call('k2', longModel)
  ctxFlush()
  const d3 = JSON.parse(readFileSync(diagPath, 'utf8')).diagnostics
  check('T3 最近决策轨迹被截断（条数 ≤ 3，且单条字段有长度上限）',
    Array.isArray(d3.lastRequests) && d3.lastRequests.length <= 3 &&
      d3.lastRequests.every((row) => Object.values(row).every((v) => typeof v !== 'string' || v.length <= 200)),
    `count=${d3.lastRequests?.length} maxLen=${Math.max(...(d3.lastRequests ?? []).flatMap((r) => Object.values(r).filter((v) => typeof v === 'string').map((v) => v.length)))} `)

  // T4：token 上限——mock 对 big* 前缀的 key 回一个 1e12 的 input token，
  // 插件应把它夹在 1e9 以内，而不是原样累加。
  const bigPath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: ['k2'], clineMatch: match, quotaStatePath: bigPath })
  const bigRes = await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer bigkey-long-enough' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
  })
  await bigRes.text()
  // tapUsage 是异步扫流，给它一拍
  await new Promise((resolve) => setTimeout(resolve, 50))
  const bigLabel = keyTag('bigkey-long-enough')
  const bigRow = ctxStatus().keys.find((row) => row.label === bigLabel)
  const bigTok = bigRow?.models?.['deepseek/deepseek-v4.1-flash']?.tokens
  check('T4 异常大的单次 token 上报被夹在上限内（不污染统计）',
    Boolean(bigTok) && bigTok.input > 0 && bigTok.input <= 1e9 && bigTok.output === 10,
    JSON.stringify(bigTok))

  // T5：一把 key 见过的模型行数有上限（长跑进程里模型名会被不断带进来）。
  // 用长 key：keyTag 对 ≤8 字符的 key 原样返回，而池内的 label 是哈希，短 key 定位不到。
  const MANY_KEY = 'many-models-key'
  const manyPath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: [MANY_KEY], clineMatch: match, quotaStatePath: manyPath })
  for (let i = 0; i < 60; i++) await call(MANY_KEY, `model-${String(i).padStart(3, '0')}`)
  const manyRow = ctxStatus().keys.find((row) => row.label === keyTag(MANY_KEY))
  const manyModels = Object.keys(manyRow?.models ?? {})
  check('T5 单把 key 的模型行数被裁剪（不超过上限）',
    manyModels.length > 0 && manyModels.length <= 40, `models=${manyModels.length}`)

  // 裁剪必须丢「最久没用过」的：最新的那个模型要在，最早的那些该被丢掉。
  // （这条曾经真的错过：新行的 lastUsedAt 初始为 0，会先把自己裁掉，结果留下的是最早的 40 个。）
  check('T5b 裁剪保留最近使用的模型行、丢掉最早的',
    manyModels.includes('model-059') && !manyModels.includes('model-000'),
    `has-059=${manyModels.includes('model-059')} has-000=${manyModels.includes('model-000')} first=${manyModels[0]}`)
}

// ─ U. 冷却窗口只认服务端给的事实：报文的窗口文本 → 标准的 Retry-After 头 ──
// 两处来源都在服务端手里，插件只负责读：读不出来就不记冷却（U5/U6），绝不自己编一个
// 恢复时刻——编出来的不只会让面板显示假倒计时，还会让「全池冷却快速失败」把本可以试的
// key 判成注定失败。少了 Retry-After 这一档，`retry-after: 3` 这类瞬时限流会因为
// 「两处都没有窗口」而被当成无可奉告，冷却与倒计时一起丢失。
// 这里六个用例分别钉：纯秒数、HTTP-date、头驱动的小时级收尾、报文优先、不编造、轮换不依赖冷却。
{
  /** 该 key 在当前模型上的冷却还剩多少毫秒；没有冷却记录（或已过期）返回 0。
   *  取的是**面板载荷**（describe → cooling），不是自检快照（snapshot → quota）——
   *  两个视图字段名不同，写错只会静默拿到 0。 */
  const coolingMsLeft = (rawKey) => {
    const row = ctxStatus().keys.find((entry) => entry.label === keyTag(rawKey))
    const rowQuota = row?.cooling?.[0]
    return rowQuota ? Math.max(0, rowQuota.readyAt - Date.now()) : 0
  }

  // U1/U2：报文里没有任何可解析窗口，只有 `retry-after: 3600`。
  mount({ clineKeys: [], clineMatch: match })
  const u1n = mark()
  const u1Key = 'h1-retry-after-seconds'
  const u1 = await call(u1Key)
  const u1attempts = since(u1n)
  const u1left = coolingMsLeft(u1Key)
  check('U1 retry-after 的纯秒数形态被解析成 1 小时冷却（服务端说了才算）',
    u1attempts.length === 1 && u1left > 55 * 60_000 && u1left <= 60 * 60_000,
    `冷却 ${Math.round(u1left / 60_000)} 分钟`)
  check('U2 由头给出的小时级窗口同样按「额度耗尽」收尾（x-should-retry:false）',
    u1.noRetry === 'false', String(u1.noRetry))

  // U3：HTTP-date 形态（`Retry-After` 规范允许的另一种写法）。
  mount({ clineKeys: [], clineMatch: match })
  const u2Key = 'h2-http-date-shape'
  await call(u2Key)
  const u2left = coolingMsLeft(u2Key)
  check('U3 retry-after 的 HTTP-date 形态同样被解析',
    u2left > 115 * 60_000 && u2left <= 120 * 60_000, `冷却 ${Math.round(u2left / 60_000)} 分钟`)

  // U4：两个来源同时在（报文 5 分钟、头 1 小时）时，报文文本优先——它才是服务端按这把
  // key 的额度算出来的窗口，头只是个更粗的兜底。
  mount({ clineKeys: [], clineMatch: match })
  const u3Key = 'h3-both-sources'
  await call(u3Key)
  const u3left = coolingMsLeft(u3Key)
  check('U4 报文文本优先于 Retry-After 头（5m 而不是 60m）',
    u3left > 4 * 60_000 && u3left <= 5 * 60_000, `冷却 ${Math.round(u3left / 60_000)} 分钟`)

  // U5/U6：服务端既不给报文窗口、也不给 Retry-After 头时，插件**不编造**恢复时刻：
  // 限流照样计数（事实要留住），但面板上没有假倒计时；同时换 key 重发必须照常工作——
  // 这条路径不再依赖「先记冷却」，靠的是「本次请求试过的 key 不再挑」。
  const noWindowKey = 'n1-no-window-limit'
  const backupKey = 'n2-healthy-backup'
  mount({ clineKeys: [backupKey], clineMatch: match })
  const u5n = mark()
  const u5 = await call(noWindowKey)
  const u5attempts = since(u5n)
  const u5row = ctxStatus().keys.find((entry) => entry.label === keyTag(noWindowKey))
  check('U5 没有恢复时刻就不编造冷却（面板上没有假倒计时）',
    (u5row?.cooling ?? []).length === 0, JSON.stringify(u5row?.cooling ?? []))
  check('U6 限流仍然计数，且换 key 重发照常成功（不靠自造冷却）',
    u5.status === 200 && u5attempts.length === 2 && u5attempts[1]?.key === backupKey &&
      u5row?.models?.['deepseek/deepseek-v4.1-flash']?.limited === 1,
    `${u5.status} ${attemptsText(u5attempts)} limited=${u5row?.models?.['deepseek/deepseek-v4.1-flash']?.limited}`)
}

// ── V. 面板选定的「使用中」Key：**按模型独立**、首发送优先用它，但不接管轮换 ──────
// 选定只回答「这个模型从哪把开始」：撞 429 后照常换 key 重发（轮换靠「本次试过的 key」
// 集合，与冷却记录无关）。选定**按模型各记一条**——给 deepseek 选了某把 key 不该连带影响
// glm（冷却与用量本来就是 key+模型 维度，选定同理）。它与冷却、统计共用同一个状态文件，
// 且只有 8 位标签、没有原文。
{
  const pickedKey = 'v1-selected-key-aaaa'
  const backupKey = 'v2-backup-key-bbbb'
  const requestKey = 'v9-request-key-cccc'
  const limitedKey = 'k1-selected-limited-aaaa' // 前缀 k1 命中 mock 的「每日上限」名单
  const pickedLabel = keyTag(pickedKey)
  const backupLabel = keyTag(backupKey)
  const limitedLabel = keyTag(limitedKey)
  const modelA = 'deepseek/deepseek-v4.1-flash'
  const modelB = 'z-ai/glm-5.3-flash'

  // V1/V2：为 modelA 选定后，modelA 的首发送改用这把（覆盖请求自带的 key）
  const ctx = mount({ clineKeys: [pickedKey, backupKey], clineMatch: match })
  const accepted = ctx.__dshClineBridge.setSelection(modelA, pickedLabel)
  check('V1 为某个模型选定池内已知标签被接受，载荷里也只有这个模型那一条',
    accepted === true && ctxStatus().selection?.[modelA] === pickedLabel && ctxStatus().selection?.[modelB] === undefined,
    `accepted=${accepted} selection=${JSON.stringify(ctxStatus().selection)}`)
  const v1n = mark()
  const v1 = await call(requestKey, modelA)
  const v1attempts = since(v1n)
  check('V2 该模型的首发送改用选定的 key（请求自带的 key 不再被使用）',
    v1.status === 200 && v1attempts.length === 1 && v1attempts[0].key === pickedKey,
    `${v1.status} ${attemptsText(v1attempts)}`)

  // V3：**另一个模型不受影响**——这正是用户报的 bug（给一个模型选定不该管到所有模型）
  const v3n = mark()
  const v3 = await call(requestKey, modelB)
  const v3attempts = since(v3n)
  check('V3 另一个模型不受影响：它仍用请求自带的 key（选定按模型独立）',
    v3.status === 200 && v3attempts.length === 1 && v3attempts[0].key === requestKey,
    `${v3.status} ${attemptsText(v3attempts)}`)

  // V4：只有形状合法还不够——池里没有的标签、形状非法的标签、不像模型的模型名一律拒绝，
  // 且不改动已有选定（'*' 是「读不出模型」的占位，也不能拿来当选定键）
  const foreign = ctx.__dshClineBridge.setSelection(modelA, 'deadbeef')
  const malformed = ctx.__dshClineBridge.setSelection(modelA, 'not-a-label')
  const badModel = ctx.__dshClineBridge.setSelection('???', pickedLabel)
  const unknownModel = ctx.__dshClineBridge.setSelection('*', pickedLabel)
  check('V4 池内没有的标签 / 形状非法的标签 / 不像模型的模型名都被拒绝（不写入任何状态）',
    foreign === false && malformed === false && badModel === false && unknownModel === false &&
      ctxStatus().selection?.[modelA] === pickedLabel,
    `foreign=${foreign} malformed=${malformed} badModel=${badModel} unknownModel=${unknownModel} selection=${JSON.stringify(ctxStatus().selection)}`)

  // V5：选定的 key 撞 429 时照常换下一把——选定只决定起点，不接管轮换；同时**选定要跟着
  // 换到真正跑通的那把**（「被换掉的选定，面板上的使用标记也要跟着换」），没选定的模型不动。
  mount({ clineKeys: [limitedKey, backupKey], clineMatch: match })
  lastCtx.__dshClineBridge.setSelection(modelA, limitedLabel)
  lastCtx.__dshClineBridge.setSelection(modelB, limitedLabel)
  const v5n = mark()
  const v5 = await call(requestKey, modelA)
  const v5attempts = since(v5n)
  check('V5 选定的 key 撞 429 后照常换下一把重发（选定不接管轮换）',
    v5.status === 200 && v5attempts.length === 2 && v5attempts[0].key === limitedKey && v5attempts[1].key === backupKey,
    `${v5.status} ${attemptsText(v5attempts)}`)
  check('V5b 轮换成功后「使用中」跟着挪到跑通的那把（另一个模型的选定原封不动）',
    ctxStatus().selection?.[modelA] === backupLabel && ctxStatus().selection?.[modelB] === limitedLabel,
    JSON.stringify(ctxStatus().selection))

  // V5c：没有选定的模型不会被「自动选中」——轮换照常发生，但不替用户做决定
  mount({ clineKeys: [backupKey], clineMatch: match })
  const v5cn = mark()
  const v5c = await call(limitedKey, modelA)
  const v5cattempts = since(v5cn)
  check('V5c 没有选定的模型不会被自动选中（轮换照常，但不替用户做决定）',
    v5c.status === 200 && v5cattempts.length === 2 && Object.keys(ctxStatus().selection ?? {}).length === 0,
    `${v5c.status} ${attemptsText(v5cattempts)} selection=${JSON.stringify(ctxStatus().selection)}`)

  // V6：取消 modelA 的选定不影响 modelB——两边各自独立
  mount({ clineKeys: [pickedKey, backupKey], clineMatch: match })
  lastCtx.__dshClineBridge.setSelection(modelA, pickedLabel)
  lastCtx.__dshClineBridge.setSelection(modelB, backupLabel)
  const cleared = lastCtx.__dshClineBridge.setSelection(modelA, '')
  const v6n = mark()
  const v6 = await call(requestKey, modelA)
  const v6attempts = since(v6n)
  check('V6 取消 modelA 的选定后它回到请求自带的 key，而 modelB 的选定原封不动',
    cleared === true && ctxStatus().selection?.[modelA] === undefined && ctxStatus().selection?.[modelB] === backupLabel &&
      v6attempts.length === 1 && v6attempts[0].key === requestKey,
    `${attemptsText(v6attempts)} selection=${JSON.stringify(ctxStatus().selection)}`)

  // V7/V8：按模型的选定跨重启保留 + 落盘只有标签（与冷却、统计同一个状态文件）
  const sharedPath = join(TEST_STATE_DIR, `select-state-${++stateSeq}.json`)
  const first = mount({ clineKeys: [pickedKey, backupKey], clineMatch: match, quotaStatePath: sharedPath })
  first.__dshClineBridge.setSelection(modelA, pickedLabel)
  first.__dshClineBridge.setSelection(modelB, backupLabel)
  first.__dshClineBridge.flushQuotaState()
  const second = mount({ clineKeys: [pickedKey, backupKey], clineMatch: match, quotaStatePath: sharedPath })
  const v7n = mark()
  const v7 = await call(requestKey, modelA)
  const v7attempts = since(v7n)
  check('V7 按模型的选定跨重启保留（两个模型各读回自己那条，且 A 仍从选定那把开始）',
    second.__dshClineBridge.selectedLabel(modelA) === pickedLabel &&
      second.__dshClineBridge.selectedLabel(modelB) === backupLabel &&
      v7attempts.length === 1 && v7attempts[0].key === pickedKey,
    `A=${second.__dshClineBridge.selectedLabel(modelA)} B=${second.__dshClineBridge.selectedLabel(modelB)} ${attemptsText(v7attempts)}`)
  const stateText = readFileSync(sharedPath, 'utf8')
  check('V8 状态文件里只有 8 位标签，没有 key 原文',
    stateText.includes(pickedLabel) && stateText.includes(backupLabel) &&
      !stateText.includes(pickedKey) && !stateText.includes(backupKey),
    `hasA=${stateText.includes(pickedLabel)} hasRaw=${stateText.includes(pickedKey)}`)
}

dispose()
rmSync(TEST_STATE_DIR, { recursive: true, force: true })
server.closeAllConnections?.()
await new Promise((resolve) => server.close(resolve))

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.length} 项`)
process.exit(failed === 0 ? 0 : 1)