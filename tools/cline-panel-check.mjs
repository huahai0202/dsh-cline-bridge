/**
 * Cline Key 设置面板自检（不需要真实 key，也不需要跑起 DSH）
 *
 *   node tools/cline-panel-check.mjs
 *
 * 两半都测：
 *   1) 主机半边：用 mock ctx 挂载插件，等 ctx.inject(['webServer']) 回调里注册出路由，
 *      然后按真实 HTTP 形状调用它——校验同源校验、方法限制、载荷内容，以及
 *      **载荷里除了首尾掩码之外不含任何 key 材料**、磁盘状态文件里连掩码都没有。
 *   2) 浏览器半边：把 lib/client.js 放进 vm 沙箱执行（伪造 window.__ModuleLoader__、
 *      document、fetch），用迷你 React 运行时真正渲染一遍面板，校验它在
 *      「有数据 / 空池 / 请求失败」三条路径上都不炸，并断言渲染树里不出现 key 原文。
 */

import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { apply } from '../index.js'
import { PLUGIN_VERSION as HOST_VERSION } from '../lib/host/defaults.js'
import { readCredentialRefsFromFile, writeCredentialRefToFile } from '../lib/host/credentials.js'
import { parseKeyInput } from '../lib/host/key-import.js'

const TEST_STATE_DIR = join(tmpdir(), `ofb-panel-state-${process.pid}`)
mkdirSync(TEST_STATE_DIR, { recursive: true })
let stateSeq = 0

// 版本号只从 package.json 读，避免每发一次版就要来改一次断言
const MANIFEST = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const PLUGIN_VERSION = MANIFEST.version

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

// key 原文只出现在这两个常量里；任何输出都不得包含它们
const SECRET_A = 'sk-live-AAAA1111BBBB2222CCCC3333DDDD4444'
const SECRET_B = 'sk-test-EEEE5555FFFF6666GGGG7777HHHH8888'
const MASK_A = `${SECRET_A.slice(0, 4)}…${SECRET_A.slice(-4)}`
const MASK_B = `${SECRET_B.slice(0, 4)}…${SECRET_B.slice(-4)}`
// 导入用：两把全新的 Key（也用于断言回包里没有原文、只有 ref/标签/掩码）
const SECRET_C = 'sk-import-CCCC1111DDDD2222EEEE3333FFFF4444'
const SECRET_D = 'sk-import-DDDD5555EEEE6666FFFF7777AAAA8888'
const MASK_C = `${SECRET_C.slice(0, 4)}…${SECRET_C.slice(-4)}`
const MASK_D = `${SECRET_D.slice(0, 4)}…${SECRET_D.slice(-4)}`

/** SECRET_A 只在这个模型上撞每日上限；换到别的模型它仍然可用。 */
const CAP_ONLY_MODEL = 'cline-free/deepseek-v4.1-flash'

// ───────────────────────── mock Cline 上游 ─────────────────────────
const seen = []

/** 每个 (key, model) 组合回一组固定的 token 用量，方便断言累加结果。 */
const usageFor = (key, model) => ({
  prompt_tokens: key === SECRET_B ? 2000 : 100,
  completion_tokens: key === SECRET_B ? 300 : 20,
  total_tokens: (key === SECRET_B ? 2000 : 100) + (key === SECRET_B ? 300 : 20),
  prompt_tokens_details: { cached_tokens: key === SECRET_B ? 500 : 0 },
  model,
})

const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    let parsed = {}
    try { parsed = JSON.parse(body) } catch {}
    const model = parsed.model ?? '?'
    seen.push({ key, model })

    /** 成功响应：流式回 SSE（带 usage 的最后一个 chunk），非流式回 JSON。 */
    const succeed = () => {
      const usage = usageFor(key, model)
      if (parsed.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: 'hi' } }] })}\n\n`)
        // 中间再插一个「不带 usage」的 chunk，确认扫描只认带 usage 的那些
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: '!' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ id: 'x', choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, usage }))
    }

    if (key === SECRET_B) return succeed()
    // SECRET_A 只在 deepseek 上撞每日上限，在别的模型上照常成功——这正是真实场景
    // （每日额度是「key + 模型」维度），也是「按模型分别查看」要防住的那种误判。
    if (key === SECRET_A && model !== CAP_ONLY_MODEL) return succeed()
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      code: 'INFERENCE_CAP_ERROR',
      message: `Error 429: Daily free limit reached on model ${model}. Try again in 21h 40m`,
    }))
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const match = `127.0.0.1:${server.address().port}`
const ENDPOINT = `http://${match}/api/v1/chat/completions`

// ───────────────────────── 主机半边脚手架 ─────────────────────────
let dispose = () => {}
let lastCtx
const routes = []
// 插件通过 ctx.inject(['credentials']) 订阅的监听器（凭据变更 → 立刻重扫 Key 池）
const credentialListeners = []
let credsSeq = 0

/** 凭据服务的替身：读写都落到一个真实临时文件上（用插件自己的读写函数），
 *  这样「导入 → 池子里真的多了一把」是端到端可见的，而不是只在内存里自说自话。 */
function makeCredentialsService(file) {
  return {
    async resolve(ref) {
      const value = readCredentialRefsFromFile(file, [ref]).get(ref)
      return value ? { value, source: 'file' } : undefined
    },
    async set(ref, value) {
      writeCredentialRefToFile(file, ref, value)
    },
  }
}

/** DSH 设置服务里 llm-pi-ai 的值：一个 Cline 提供方 + 一个非 Cline 提供方。
 *  用来验证面板能从配置里列出 Cline 名下的模型（而不是只从发生过的流量里学）。 */
const SETTINGS_TABLE = {
  providers: {
    cline: {
      displayName: 'Cline',
      apiKeyEnv: 'CLINE_API_KEY',
      baseURL: 'https://api.cline.bot/api/v1',
      models: [{ id: 'cline-free/deepseek-v4.1-flash' }, { id: 'z-ai/glm-5.3-flash' }],
    },
    hyper: {
      displayName: 'Charm Hyper',
      apiKeyEnv: 'HYPER_API_KEY',
      baseURL: 'https://hyper.charm.land/v1',
      models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }],
    },
    opencode: {
      apiKeyEnv: 'OPENCODE_API_KEY',
      baseURL: 'https://opencode.ai/zen/v1',
      models: [{ id: 'mimo-v2.5-free' }],
    },
  },
}
const AGENT_DEFAULT = { provider: 'cline', model: 'z-ai/glm-5.3-flash' }

/** 挂载插件，并把 ctx.inject(['webServer'], ...) 里的路由捕获下来。 */
function mount(config = {}) {
  dispose()
  routes.length = 0
  credentialListeners.length = 0
  const settingsValues = { 'llm-pi-ai': SETTINGS_TABLE, 'agent-default-model': AGENT_DEFAULT, ...(config.__settingsValues ?? {}) }
  // 每次挂载一个全新的凭据文件：导入测试之间不互相污染（config 里显式给了就用它的）
  const credentialsFile = config.credentialsFile ?? join(TEST_STATE_DIR, `creds-${++credsSeq}.yaml`)
  // __credentials 允许测试注入「会出故障」的凭据服务（比如 resolve 全部抛错），
  // 用来验证导入在「槽位状态不明」时宁可不导，也不往可能已被占用的 ref 上盖。
  const credentials = config.__credentials ?? makeCredentialsService(credentialsFile)
  const ctx = {
    on: (event, fn) => { if (event === 'dispose') dispose = fn },
    logger: { warn: () => {} },
    get: () => undefined,
    // DSH 真实 ctx 上的子 fiber 等待模式
    inject: (deps, callback) => {
      if (!Array.isArray(deps)) return undefined
      if (deps.includes('settings')) {
        if (config.__noSettings) return undefined // 模拟 settings 服务缺席
        return callback({
          effect: (factory) => factory(),
          get: (name) => (name === 'settings' ? { get: (ns) => settingsValues[ns] } : undefined),
          settings: { get: (ns) => settingsValues[ns] },
        })
      }
      if (deps.includes('credentials')) {
        if (config.__noCredentials) return undefined // 模拟凭据服务缺席（导入应退化为直写文件）
        return callback({
          effect: (factory) => factory(),
          get: (name) => (name === 'credentials' ? credentials : undefined),
          credentials,
          on: (event, fn) => { if (event === 'credentials/reference-updated') credentialListeners.push(fn) },
        })
      }
      if (!deps.includes('webServer')) return undefined
      const webCtx = {
        effect: (factory) => factory(),
        webServer: {
          register: (route) => {
            routes.push(route)
            return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) }
          },
        },
      }
      return callback(webCtx)
    },
  }
  const merged = {
    clineMatch: match,
    clineKeys: [SECRET_A],
    credentialsFile,
    quotaStatePath: join(TEST_STATE_DIR, `state-${++stateSeq}.json`),
    ...config,
  }
  apply(ctx, merged)
  lastCtx = ctx
  return ctx
}

const READ_PATH = '/dsh-cline-bridge/keys'
const IMPORT_PATH = '/dsh-cline-bridge/keys/import'
const RESET_PATH = '/dsh-cline-bridge/keys/stats/reset'
const SELECT_PATH = '/dsh-cline-bridge/keys/select'

/** 假请求：带正文的那几条会按真实流式形状分两片投递 data、再 end，
 *  这样「带上限的正文读取」真的走到累加与上限分支。 */
const fakeReq = ({ method = 'GET', referer = 'http://127.0.0.1:3080/settings', host = '127.0.0.1:3080', contentType, body, headers } = {}) => {
  const handlers = new Map()
  const req = {
    method,
    headers: { host, referer, ...(contentType === undefined ? {} : { 'content-type': contentType }), ...(headers ?? {}) },
    on(event, fn) {
      const list = handlers.get(event) ?? []
      list.push(fn)
      handlers.set(event, list)
      return req
    },
    destroy() {},
  }
  setTimeout(() => {
    const list = (event) => handlers.get(event) ?? []
    if (body !== undefined) {
      const buffer = Buffer.from(String(body), 'utf8')
      const half = Math.ceil(buffer.length / 2)
      for (const chunk of [buffer.subarray(0, half), buffer.subarray(half)]) {
        if (chunk.length) for (const fn of list('data')) fn(chunk)
      }
    }
    for (const fn of list('end')) fn()
  }, 0)
  return req
}

/** 与插件同一套 FNV-1a 标签：测试里按标签定位某把 key 的统计行。 */
const label8 = (value) => {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
const fakeRes = () => {
  let settle
  const done = new Promise((resolve) => { settle = resolve })
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    headersSent: false,
    done,
    writeHead(status, headers) { res.statusCode = status; res.headers = headers || {} },
    end(body) {
      if (body !== undefined) res.body += String(body)
      res.headersSent = true
      settle()
    },
  }
  return res
}

/** 调一条路由（默认只读状态路由）：等 handler 返回，也等响应真的收尾。
 *  带 2 秒兜底，避免将来某条 handler 忘了 end 时整个自检挂死。 */
const callRoute = async (options) => {
  const route = routes.find((row) => row.path === (options?.path ?? READ_PATH))
  if (!route) throw new Error('route not registered: ' + (options?.path ?? READ_PATH))
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  await Promise.race([res.done, new Promise((resolve) => setTimeout(resolve, 2000))])
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { route, status: res.statusCode, headers: res.headers, body: res.body, json }
}

/** 走导入路由的一发 POST（默认带合法的同源 Referer 与 JSON Content-Type）。 */
const importPost = (options = {}) =>
  callRoute({ path: IMPORT_PATH, method: 'POST', contentType: 'application/json', ...options })

/** 最近一次 mount 出来的插件实例的观察入口（不含 key 原文）。 */
const ctxStatusOf = (options) => lastCtx?.__dshClineBridge?.status?.(options)

// ───────────────────────── 1. 路由注册与契约 ─────────────────────────
{
  mount({ skipCoolingRequestKey: true })
  check('H1 只在 ctx.inject([\'webServer\']) 里注册路由（不门控整个插件）', routes.length === 4, `routes=${routes.length}`)
  const readRoute = routes.find((row) => row.path === READ_PATH)
  const importRoute = routes.find((row) => row.path === IMPORT_PATH)
  const resetRoute = routes.find((row) => row.path === RESET_PATH)
  const selectRoute = routes.find((row) => row.path === SELECT_PATH)
  check('H2 只读 / 导入 / 重置统计 / 选定四条路由都是 exact 匹配且路径固定',
    Boolean(readRoute && importRoute && resetRoute && selectRoute) &&
      [readRoute, importRoute, resetRoute, selectRoute].every((row) => row.kind === 'exact'),
    routes.map((row) => `${row.kind} ${row.path}`).join(' + '))

  const ok = await callRoute()
  check('H3 同源 GET 返回 200 JSON', ok.status === 200 && ok.json?.plugin === 'dsh-cline-bridge', `status=${ok.status}`)
  check('H4 载荷带缓存禁止头', /no-store/.test(ok.headers['cache-control'] ?? ''), String(ok.headers['cache-control']))
  check('H5 响应头是 JSON', /application\/json/.test(ok.headers['content-type'] ?? ''), String(ok.headers['content-type']))

  const untrusted = await callRoute({ referer: 'http://evil.example/x' })
  check('H6 非同源 Referer 被拒（403）', untrusted.status === 403, `status=${untrusted.status}`)
  const noReferer = await callRoute({ referer: '' })
  check('H7 缺失 Referer 也被拒（403）', noReferer.status === 403, `status=${noReferer.status}`)
  const wrongMethod = await callRoute({ method: 'POST' })
  check('H8 非 GET/HEAD 被拒（405）', wrongMethod.status === 405, `status=${wrongMethod.status}`)
  const head = await callRoute({ method: 'HEAD' })
  check('H9 HEAD 返回 200 空体', head.status === 200 && head.body === '', `status=${head.status} len=${head.body.length}`)
}

// ───────────────────────── 2. 载荷只含掩码，不含 key 材料 ─────────────────────────
{
  const ctx = mount({ clineKeys: [SECRET_A, SECRET_B], skipCoolingRequestKey: true })
  const r = await callRoute()
  const raw = r.body
  check('H10 载荷不含任何 key 原文', !raw.includes(SECRET_A) && !raw.includes(SECRET_B))
  check('H11 载荷带首尾掩码预览', raw.includes(MASK_A) && raw.includes(MASK_B), MASK_A)

  const keys = r.json.keys ?? []
  check('H12 池内两把 key 都在列表里', keys.length === 2, `keys=${keys.length}`)
  check('H13 每把 key 都有 8 位哈希标签', keys.every((k) => /^[0-9a-f]{8}$/.test(k.label)))
  const previews = keys.map((k) => k.preview)
  check('H14 掩码形状是「前4…后4」', previews.every((p) => /^.{4}….{4}$/.test(p)), JSON.stringify(previews))
  check('H15 config.clineKeys 原文没有被回显', !raw.includes('clineKeys') || !raw.includes('live-AAAA'), '')

  // 掩码可以整体关闭：关掉后连首尾片段都不下发
  mount({ clineKeys: [SECRET_A], maskKeyPreview: false })
  const off = await callRoute()
  check('H16 maskKeyPreview:false 时不下发任何 key 片段', !off.body.includes(SECRET_A) && off.json.keys.every((k) => k.preview === ''), JSON.stringify(off.json.keys.map((k) => k.preview)))

  // 状态入口（自检工具）与路由同源
  check('H17 ctx.__dshClineBridge.status() 与路由载荷一致', ctx.__dshClineBridge.status().plugin === 'dsh-cline-bridge')
}

// ───────────────────────── 3. 用量统计与来源标签 ─────────────────────────
{
  mount({ clineKeys: [SECRET_A, SECRET_B], skipCoolingRequestKey: true })
  const res = await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_A}` },
    body: JSON.stringify({ model: 'cline-free/deepseek-v4.1-flash', messages: [] }),
  })
  await res.text()

  const r = await callRoute()
  const keys = r.json.keys ?? []
  const byPreview = Object.fromEntries(keys.map((k) => [k.preview, k]))

  check('H18 轮换后的请求确实走了第二把 key', res.status === 200 && seen.some((s) => s.key === SECRET_B), `status=${res.status}`)
  const coolingKey = keys.find((k) => k.cooling.length > 0)
  check('H19 被限流的那把 key 标记为冷却并带恢复倒计时', Boolean(coolingKey) && coolingKey.cooling[0].model === 'cline-free/deepseek-v4.1-flash' && coolingKey.cooling[0].readyInMin > 1000, JSON.stringify(coolingKey?.cooling ?? []))
  check('H20 冷却 key 的限流计数与发送计数都记到了 1', coolingKey?.stats.sent === 1 && coolingKey?.stats.limited === 1 && coolingKey?.stats.ok === 0, JSON.stringify(coolingKey?.stats))
  const healthyKey = keys.find((k) => k.cooling.length === 0)
  check('H21 成功那把 key 记了 ok', healthyKey?.stats.ok === 1 && healthyKey?.stats.sent === 1, JSON.stringify(healthyKey?.stats))
  check('H22 来源标签区分 DSH 主 key 与 config', Boolean(byPreview[MASK_A] || byPreview[MASK_B]) && keys.some((k) => k.source.startsWith('config:')), JSON.stringify(keys.map((k) => k.source)))
  check('H23 每把 key 都带来源标签，且载荷已无 isRequestKey 字段（池内 key 同级）',
    keys.every((k) => typeof k.source === 'string' && k.source.length > 0) && keys.every((k) => !('isRequestKey' in k)),
    JSON.stringify(keys.map((k) => k.source)))
  check('H24 全局计数里有一次换 key 恢复', r.json.totals.rotations === 1 && r.json.totals.clineRequests === 1, JSON.stringify(r.json.totals))
}

// ───────────────────────── 4. 落盘文件不含任何 key 片段 ─────────────────────────
{
  const statePath = join(TEST_STATE_DIR, `state-disk-${++stateSeq}.json`)
  const ctx = mount({ clineKeys: [SECRET_A, SECRET_B], skipCoolingRequestKey: true, quotaStatePath: statePath })
  await (await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_A}` },
    body: JSON.stringify({ model: 'cline-free/deepseek-v4.1-flash', messages: [] }),
  })).text()
  ctx.__dshClineBridge.flushQuotaState()
  const disk = readFileSync(statePath, 'utf8')
  check('H25 磁盘状态文件不含 key 原文', !disk.includes(SECRET_A) && !disk.includes(SECRET_B))
  check('H26 磁盘状态文件连掩码片段也不含', !disk.includes(SECRET_A.slice(0, 4) + '…') && !disk.includes(MASK_A), disk.slice(0, 60))
  check('H27 磁盘状态文件里只有哈希标签', /"entries":\{"[0-9a-f]{8}"/.test(disk))
}

// ───────────────────────── 4b. 主机端的按模型维度 ─────────────────────────
// 冷却本来就是「key + 模型」维度，用量也必须分开记：否则面板切到 glm 时会拿
// deepseek 的数字充数，正是用户报的那个误导。
{
  const modelA = CAP_ONLY_MODEL
  const modelB = 'z-ai/glm-5.3-flash'
  const post = async (key, model) =>
    (await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [] }),
    })).text()

  mount({ clineKeys: [SECRET_A, SECRET_B], skipCoolingRequestKey: true })
  // modelA：SECRET_A 撞上限 → 换 SECRET_B 成功
  // modelB：SECRET_A 并未在 modelB 上冷却，所以照旧先用它，而且它能成功
  await post(SECRET_A, modelA)
  await post(SECRET_A, modelB)
  await post(SECRET_A, modelB)

  const r = await callRoute()
  const keys = r.json.keys ?? []
  const byLabel = (label) => keys.find((k) => k.label === label)
  const labelOf = (key) => {
    let h = 0x811c9dc5
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  const a = byLabel(labelOf(SECRET_A))
  const b = byLabel(labelOf(SECRET_B))

  check('H28 载荷带按模型用量明细', Boolean(a?.models) && Object.keys(a.models).length === 2, JSON.stringify(Object.keys(a?.models ?? {})))
  check('H29 撞限流那把在 modelA 上是 1 次发送 1 次限流 0 次成功',
    a?.models?.[modelA]?.sent === 1 && a?.models?.[modelA]?.limited === 1 && a?.models?.[modelA]?.ok === 0,
    JSON.stringify(a?.models?.[modelA]))
  check('H30 同一把 key 在 modelB 上照常成功（额度是 key+模型 维度）',
    a?.models?.[modelB]?.sent === 2 && a?.models?.[modelB]?.ok === 2 && a?.models?.[modelB]?.limited === 0,
    JSON.stringify(a?.models?.[modelB]))
  check('H31 modelA 上承压的那把只在 modelA 有记录',
    b?.models?.[modelA]?.sent === 1 && b?.models?.[modelA]?.ok === 1 && !b?.models?.[modelB],
    JSON.stringify(b?.models))
  check('H32 全局总计等于各模型之和',
    a?.stats?.sent === 3 && a?.stats?.ok === 2 && a?.stats?.limited === 1 && b?.stats?.sent === 1,
    `${JSON.stringify(a?.stats)} / ${JSON.stringify(b?.stats)}`)
  check('H33 载荷带模型清单与「当前模型」', Array.isArray(r.json.models) && r.json.models.some((m) => m.id === modelB) && r.json.models.some((m) => m.id === modelA) && r.json.currentModel === modelB,
    `${JSON.stringify(r.json.models)} current=${r.json.currentModel}`)
  check('H34 模型清单按最近活跃排序（当前模型在最前）', r.json.models[0]?.id === modelB, r.json.models.map((m) => m.id).join(' > '))
}

// ───────────────────────── 4b-2. 条件请求（ETag / 304） ─────────────────────────
// 面板每 5 秒轮询一次，而绝大多数轮次载荷完全没变。这里验证：同一份载荷第二次带
// If-None-Match 来取时会回 304（省掉整份 JSON），内容一变就回 200 并给出新的 ETag。
{
  mount({ skipCoolingRequestKey: true })
  const first = await callRoute()
  check('H35 只读路由回带 ETag', first.status === 200 && typeof first.headers?.etag === 'string' && first.headers.etag.length > 2,
    String(first.headers?.etag))
  const etag = first.headers.etag

  // 立刻用同一个 ETag 再取一次：载荷里的 readyInMin 按分钟取整，同一分钟内必然一致
  const second = await callRoute({ headers: { 'if-none-match': etag } })
  check('H36 载荷未变时回 304（不重传整份 JSON）', second.status === 304 && second.body === '',
    `status=${second.status} bodyLen=${second.body.length}`)

  // ETag 必须由内容决定：换一个不同的 ETag 就该拿到 200
  const third = await callRoute({ headers: { 'if-none-match': '"stale-etag"' } })
  check('H37 ETag 不匹配时照常回 200 全量', third.status === 200 && third.body.length > 0,
    `status=${third.status}`)

  // 内容真的变了之后，同一个 ETag 必须失效——否则面板会永远停在旧数据上。
  // 这里制造一次真实的载荷变化：发一条请求，让 clineRequests 计数 +1。
  await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k2' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
  }).then((res) => res.text()).catch(() => {})
  const fourth = await callRoute({ headers: { 'if-none-match': etag } })
  check('H38 载荷内容变化后旧 ETag 失效（不会让面板停在旧数据上）',
    fourth.status === 200 && fourth.headers.etag !== etag,
    `status=${fourth.status} etag=${fourth.headers.etag}`)
}

// ───────────────────────── 4b-3. 脏模型名不该变成筛选芯片 ─────────────────────────
// 观察到的模型来自「请求体里的 model 字段」与冷却记录，可能是手改配置、探针或错误回显
// 带来的垃圾值。它一旦进了模型清单就会变成一个芯片，还会经 bumpModelStat 落进状态文件。
{
  const DIRTY = ['???', '   ', '*', '---', 'x'.repeat(200), 'ok\nbad']
  // 让 DSH 设置里 Cline 名下只有这一个正经模型，其余全是脏值——
  // 脏值要么来自配置（这里），要么来自实际流量（下面再补一条真实请求）
  const ctx = mount({
    skipCoolingRequestKey: true,
    __settingsValues: {
      'llm-pi-ai': {
        providers: {
          cline: { baseURL: `http://${match}/api/v1`, models: [{ id: 'deepseek/deepseek-v4.1-flash' }, ...DIRTY.map((id) => ({ id }))] },
        },
      },
    },
  })
  // 再发一条 model 为脏值的真实请求：它会进 lastRequests，也会进 byModel
  await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k2' },
    body: JSON.stringify({ model: '???', messages: [] }),
  }).then((res) => res.text()).catch(() => {})

  const probe = ctx.__dshClineBridge.status()
  const ids = probe.models.map((m) => m.id)
  check('H39 脏模型名不会变成筛选芯片（配置里塞脏值 + 真实脏流量都不行）',
    ids.includes('deepseek/deepseek-v4.1-flash') && DIRTY.every((id) => !ids.includes(id)) && !ids.includes('*'),
    JSON.stringify(ids))
  check('H40 载荷里不出现 readModelOf 的占位符 * 作为当前模型',
    probe.currentModel !== '*', String(probe.currentModel))
}

// ───────────────────────── 4b-4. 载荷里不再有只写不读的字段 ─────────────────────────
// 这些字段客户端半边一次都没读过（已逐字段核对过 client.js），下发它们纯属白占带宽。
{
  mount({ skipCoolingRequestKey: true })
  await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer k2' },
    body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }),
  }).then((res) => res.text()).catch(() => {})
  const probe = lastCtx.__dshClineBridge.status()
  check('H41 面板载荷不再下发 bodyLen / poolSize（客户端从未读取）',
    (probe.recent ?? []).length > 0 && probe.recent.every((row) => !('bodyLen' in row) && !('poolSize' in row)),
    JSON.stringify(probe.recent?.[0] ?? {}))
  check('H42 面板载荷不再下发 extras / updatedAt（客户端从未读取）',
    !('extras' in probe) && !('updatedAt' in probe),
    Object.keys(probe).join(','))

  // H43：「最近决策」里的模型名必须是真的。轨迹是在 model 解析之前建立的（那时只看得见
  // init?.body，Request 形态下恒为 '*'），解析出模型后要写回——否则面板上就是一行 '*'
  // ——R 组在自检入口钉了同一件事，这里钉的是**载荷**（面板真正读的那份）。
  const requestForm = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_B}` },
    body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [] }),
  })
  await globalThis.fetch(requestForm).then((res) => res.text()).catch(() => {})
  const probeForm = lastCtx.__dshClineBridge.status()
  const lastTrace = (probeForm.recent ?? []).at(-1)
  check('H43 Request 形态的「最近决策」带真实模型（不是 *）',
    lastTrace?.model === 'z-ai/glm-5.3-flash', String(lastTrace?.model))
}

// ───────────────────────── 4c. 模型清单来自配置，而不是只靠流量 ─────────────────────────
// 用户的现象：deepseek 撞上限、切到 glm 之后面板里只有 deepseek 一个模型芯片。
// 原因是模型清单只从「已发生的流量 + 落盘的冷却记录」里学——重启后若还没发过 glm
// 请求，glm 就完全不存在。正确做法是直接读 DSH 设置里 Cline 提供方的模型表。
{
  // 全新挂载、一次 Cline 请求都不发。注意设置表里的 Cline baseURL 必须命中本用例的
  // clineMatch（与真实判据同构：提供方 baseURL 命中 clineMatch 才算 Cline 通道），
  // 所以这里用 mock 服务器地址当 baseURL。
  const table = {
    providers: {
      cline: {
        displayName: 'Cline',
        apiKeyEnv: 'CLINE_API_KEY',
        baseURL: `http://${match}/api/v1`,
        models: [{ id: 'cline-free/deepseek-v4.1-flash' }, { id: 'z-ai/glm-5.3-flash' }],
      },
      hyper: { displayName: 'Charm Hyper', baseURL: 'https://hyper.charm.land/v1', models: [{ id: 'glm-5.3' }, { id: 'kimi-k3' }] },
      opencode: { baseURL: 'https://opencode.ai/zen/v1', models: [{ id: 'mimo-v2.5-free' }] },
    },
  }
  mount({ __settingsValues: { 'llm-pi-ai': table } })
  const r = await callRoute()
  const ids = (r.json.models ?? []).map((m) => m.id)
  check('G1 零流量时也能列出 Cline 名下配置的全部模型（含 glm）',
    ids.includes('z-ai/glm-5.3-flash') && ids.includes('cline-free/deepseek-v4.1-flash'), ids.join(' | '))
  check('G2 默认筛选项取 DSH 的默认模型（cline/z-ai/glm-5.3-flash）',
    r.json.currentModel === 'z-ai/glm-5.3-flash', String(r.json.currentModel))
  check('G3 非 Cline 提供方的模型不会混进来（hyper / opencode 隔离）',
    !ids.includes('glm-5.3') && !ids.includes('kimi-k3') && !ids.includes('mimo-v2.5-free'), ids.join(' | '))
  check('G4 配置里的 Cline 模型按配置顺序紧随当前模型排列',
    ids[0] === 'z-ai/glm-5.3-flash' && ids[1] === 'cline-free/deepseek-v4.1-flash', ids.join(' | '))

  // 发一个「配置里没有」的模型：它也必须进清单（配置 ∪ 观察到的流量）
  await (await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_B}` },
    body: JSON.stringify({ model: 'cline-free/observed-only', messages: [] }),
  })).text()
  const after = (await callRoute()).json
  const idsAfter = (after.models ?? []).map((m) => m.id)
  check('G5 配置 ∪ 观察：跑过的非配置模型也会进清单',
    idsAfter.includes('cline-free/observed-only') && idsAfter.includes('z-ai/glm-5.3-flash'), idsAfter.join(' | '))
  check('G6 有真实流量后默认筛选项改跟流量走（不再是配置默认）',
    after.currentModel === 'cline-free/observed-only', String(after.currentModel))

  // 设置客户端缺席时必须退化，而不是崩
  const noSettings = await (async () => { mount({ __noSettings: true }); return callRoute() })()
  check('G7 settings 服务缺席时退化为「只列观察到的模型」且不报错',
    noSettings.status === 200 && Array.isArray(noSettings.json.models), `status=${noSettings.status} models=${(noSettings.json.models ?? []).length}`)

  // 配置里没有 Cline 提供方时同样不崩，且不把别的提供方的模型算进来
  const noCline = await (async () => {
    mount({ __settingsValues: { 'llm-pi-ai': { providers: { hyper: table.providers.hyper } } } })
    return callRoute()
  })()
  check('G8 配置里没有 Cline 提供方时不列任何配置模型，也不崩',
    noCline.status === 200 && (noCline.json.models ?? []).length === 0, JSON.stringify((noCline.json.models ?? []).map((m) => m.id)))
}

// ───────────────────────── 4d. Token 用量采集 ─────────────────────────
// 用户要的是 token 用量，不是请求次数。插件在 SDK 之下，只能从原始响应体里捞：
// 流式取 SSE 里最后一个带 usage 的 chunk，非流式取 JSON 的 usage；
// 记录维度是「key + 模型」，并同时累加到 key 级总计。
{
  const model = CAP_ONLY_MODEL
  const ctx = mount({ clineKeys: [SECRET_B], skipCoolingRequestKey: true })
  const post = async (stream) =>
    (await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_B}` },
      body: JSON.stringify({ model, messages: [], ...(stream ? { stream: true } : {}) }),
    })).text()

  // 非流式一次：input 2000 / output 300 / cached 500
  const plainText = await post(false)
  check('J1 非流式响应的 body 仍然原样交给上层（含 usage）', plainText.includes('"usage"') && plainText.includes('2000'), plainText.slice(0, 60))

  // 流式两次：应逐次累加
  const sse1 = await post(true)
  const sse2 = await post(true)
  check('J2 流式响应仍完整交给上层（SSE 未被吞掉）', sse1.includes('[DONE]') && sse1.includes('"content"') && sse2.includes('[DONE]'), sse1.slice(0, 40))
  check('J3 流式带 usage 的 chunk 仍在（没被改写）', sse1.includes('"prompt_tokens":2000'), sse1.slice(-80).replace(/\n/g, ' '))

  // 采集是异步的（顺带读一遍流），给它一拍
  await new Promise((r) => setTimeout(r, 50))
  const keys = ctx.__dshClineBridge.status().keys
  const row = keys.find((k) => k.label === label8(SECRET_B))
  check('J4 token 用量按 key+模型 累加（非流式 + 两次流式）',
    row?.models?.[model]?.tokens?.input === 6000 && row?.models?.[model]?.tokens?.output === 900,
    JSON.stringify(row?.models?.[model]?.tokens))
  check('J5 同时累加到 key 级总计', row?.stats?.tokens?.input === 6000 && row?.stats?.tokens?.total === 6900, JSON.stringify(row?.stats?.tokens))
  check('J6 缓存命中 token 也记下来了', row?.models?.[model]?.tokens?.cached === 1500, String(row?.models?.[model]?.tokens?.cached))
  check('J7 token 采集不改变请求计数', row?.models?.[model]?.sent === 3 && row?.stats?.sent === 3, `${row?.models?.[model]?.sent}/${row?.stats?.sent}`)

  // 429 响应没有 usage，不应给「被限流的那把 key」记 token。
  // 注意：这次请求会轮换到 SECRET_B 并成功，所以 B 的 token 增长是正常的——
  // 要断言的是撞限流的 A 没有任何 token 记录。
  await (await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_A}` },
    body: JSON.stringify({ model, messages: [] }),
  })).text()
  await new Promise((r) => setTimeout(r, 30))
  const afterKeys = ctx.__dshClineBridge.status().keys
  const limited = afterKeys.find((k) => k.label === label8(SECRET_A))
  const healthy = afterKeys.find((k) => k.label === label8(SECRET_B))
  check('J8 撞限流的响应不给被限的那把 key 记 token（轮换成功的那把照常记）',
    limited?.models?.[model]?.tokens?.total === 0 && limited?.models?.[model]?.limited === 1 && healthy?.models?.[model]?.tokens?.input === 8000,
    `A=${JSON.stringify(limited?.models?.[model]?.tokens)} (limited=${limited?.models?.[model]?.limited}) B=${JSON.stringify(healthy?.models?.[model]?.tokens)}`)
}

// ── 4e. 只从请求头出现的那把 key，来源应记为 request ──
// （与 isRequestKey 不同：来源记的是「首次见到它的地方」，所以配置里也列了的 key
//  会显示 config，只有纯粹从请求头来的才显示 request。）
{
  mount({ clineKeys: [], skipCoolingRequestKey: true })
  await (await globalThis.fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_B}` },
    body: JSON.stringify({ model: CAP_ONLY_MODEL, messages: [] }),
  })).text()
  const onlyRequest = ctxStatusOf().keys
  check('K1 仅从请求头出现的 key，来源记为 request',
    onlyRequest.length === 1 && onlyRequest[0].source === 'request',
    JSON.stringify(onlyRequest.map((k) => k.source)))
}

// ──────────────────────── 4f. 面板导入 Key（写路由） ─────────────────────────
// 这是插件唯一的写入口，闸门与写入结果都要逐条钉住：同源、POST + JSON、体积上限，
// 以及「真的写进凭据文件、池子立刻可见、回包不含 Key 原文」。
{
  const credsFile = join(TEST_STATE_DIR, `import-creds-${++credsSeq}.yaml`)
  mount({ clineKeys: [SECRET_A], credentialsFile: credsFile, skipCoolingRequestKey: true })

  const getOnImport = await callRoute({ path: IMPORT_PATH })
  check('L1 导入路由拒绝非 POST（405）', getOnImport.status === 405, `status=${getOnImport.status}`)
  const untrusted = await importPost({ referer: 'http://evil.example/x', body: JSON.stringify({ keys: SECRET_C }) })
  check('L2 导入路由同样要求同源 Referer（403）', untrusted.status === 403, `status=${untrusted.status}`)
  const wrongType = await importPost({ contentType: 'text/plain', body: JSON.stringify({ keys: SECRET_C }) })
  check('L3 非 application/json 被拒（415，挡住跨站简单请求）', wrongType.status === 415, `status=${wrongType.status}`)
  const badJson = await importPost({ body: '{oops' })
  check('L4 非法 JSON 被拒（400）', badJson.status === 400, `status=${badJson.status}`)
  const emptyBody = await importPost({ body: JSON.stringify({ keys: '   \n  ' }) })
  check('L5 空正文被拒（400）', emptyBody.status === 400, `status=${emptyBody.status}`)
  const tooBig = await importPost({ body: JSON.stringify({ keys: 'x'.repeat(70 * 1024) }) })
  check('L6 超过体积上限被拒（413）', tooBig.status === 413, `status=${tooBig.status}`)

  const ok = await importPost({ body: JSON.stringify({ keys: SECRET_C + '\n' + SECRET_D }) })
  check('L7 导入两把返回 200 与分组结果', ok.status === 200 && ok.json?.ok === true && ok.json?.imported?.length === 2, `status=${ok.status} imported=${ok.json?.imported?.length}`)
  check('L8 回包不含任何 Key 原文', !ok.body.includes(SECRET_C) && !ok.body.includes(SECRET_D))
  check('L9 回包只有 ref / 哈希标签 / 掩码',
    (ok.json?.imported ?? []).every((row) => /^CLINE_API_KEY_\d+$/.test(row.ref) && /^[0-9a-f]{8}$/.test(row.label) && /^.{4}….{4}$/.test(row.preview)),
    JSON.stringify(ok.json?.imported))
  check('L10 落到最小的空闲槽位 _2 / _3', (ok.json?.imported ?? []).map((row) => row.ref).join(',') === 'CLINE_API_KEY_2,CLINE_API_KEY_3', (ok.json?.imported ?? []).map((row) => row.ref).join(','))
  check('L11 有凭据服务时走服务这条写入路径', ok.json?.writeMode === 'credentials', String(ok.json?.writeMode))

  const onDisk = readCredentialRefsFromFile(credsFile, ['CLINE_API_KEY_2', 'CLINE_API_KEY_3'])
  check('L12 凭据文件里真的写进了这两个 ref 且值正确', onDisk.get('CLINE_API_KEY_2') === SECRET_C && onDisk.get('CLINE_API_KEY_3') === SECRET_D, `${onDisk.size} refs`)

  const afterImport = await callRoute()
  const afterKeys = afterImport.json?.keys ?? []
  check('L13 导入后池子立刻包含新 Key（不等 5 分钟复扫）',
    afterKeys.some((k) => k.label === label8(SECRET_C)) && afterKeys.some((k) => k.label === label8(SECRET_D)),
    afterKeys.map((k) => k.label).join(','))
  check('L14 新 Key 的来源标成它落到的凭证 ref',
    afterKeys.find((k) => k.label === label8(SECRET_C))?.source === '.credentials.yaml: CLINE_API_KEY_2',
    String(afterKeys.find((k) => k.label === label8(SECRET_C))?.source))
  check('L15 只读载荷里依然没有 Key 原文', !afterImport.body.includes(SECRET_C) && !afterImport.body.includes(SECRET_D))

  const again = await importPost({ body: JSON.stringify({ keys: SECRET_C }) })
  check('L16 重复导入被判为 duplicate，不再写一遍', again.json?.duplicates?.length === 1 && again.json?.imported?.length === 0, JSON.stringify(again.json?.duplicates))
  check('L17 重复导入没有多占槽位', readCredentialRefsFromFile(credsFile, ['CLINE_API_KEY_2', 'CLINE_API_KEY_3', 'CLINE_API_KEY_4']).size === 2)

  const dirty = await importPost({ body: JSON.stringify({ keys: 'short\n' + 'x'.repeat(300) + '\n' + SECRET_C + '\n' + SECRET_C + '\nok-enough-key-value' }) })
  check('L18 太短 / 太长被拒，同批重复与被池内重复都只算一次',
    dirty.json?.rejected?.length === 2 && dirty.json?.duplicates?.length === 1 && dirty.json?.imported?.length === 1,
    `rej=${dirty.json?.rejected?.length} dup=${dirty.json?.duplicates?.length} imp=${dirty.json?.imported?.length}`)
  check('L19 被拒条目只给掩码与原因码（不回显原文）',
    (dirty.json?.rejected ?? []).every((row) => ['too-short', 'too-long'].includes(row.reason) && row.preview.length < 20 && !dirty.body.includes('x'.repeat(50))),
    JSON.stringify(dirty.json?.rejected))
}

// 槽位用尽：明确拒绝并说明原因，而不是静默丢掉
{
  const credsFile = join(TEST_STATE_DIR, `import-full-${++credsSeq}.yaml`)
  for (let i = 2; i <= 10; i++) writeCredentialRefToFile(credsFile, `CLINE_API_KEY_${i}`, `sk-filler-${i}-`.padEnd(40, 'z'))
  mount({ clineKeys: [], credentialsFile: credsFile })
  const full = await importPost({ body: JSON.stringify({ keys: SECRET_C }) })
  check('L20 空闲槽位用尽时明确拒绝（no-free-ref）',
    full.json?.imported?.length === 0 && full.json?.rejected?.[0]?.reason === 'no-free-ref' && full.json?.refsFree === 0,
    JSON.stringify(full.json?.rejected))
}

// 凭据服务缺席：导入退化为直写文件，且不碰文件的其余内容
{
  const credsFile = join(TEST_STATE_DIR, `import-keep-${++credsSeq}.yaml`)
  writeFileSync(credsFile, 'version: 1\nrefs:\n  CLINE_API_KEY_2: "sk-old-value-000000"\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      secret: keep-me\n', 'utf8')
  mount({ clineKeys: [], credentialsFile: credsFile, __noCredentials: true })
  const fallback = await importPost({ body: JSON.stringify({ keys: SECRET_D }) })
  const text = readFileSync(credsFile, 'utf8')
  check('L21 凭据服务缺席时直写文件仍然成功', fallback.status === 200 && fallback.json?.imported?.length === 1 && fallback.json?.writeMode === 'file', JSON.stringify(fallback.json ?? {}).slice(0, 120))
  check('L22 兜底写入保留文件其余内容（records 段原样）', text.includes('client-connection/browser-session') && text.includes('keep-me'), text.slice(0, 40))
  check('L23 兜底写入接着已有条目放进 refs 段', readCredentialRefsFromFile(credsFile, ['CLINE_API_KEY_2', 'CLINE_API_KEY_3']).get('CLINE_API_KEY_3') === SECRET_D)
}

// 凭据变更事件 → 立刻重扫（DSH 设置页改 ref、手工编辑文件都走这条）
{
  const credsFile = join(TEST_STATE_DIR, `import-event-${++credsSeq}.yaml`)
  mount({ clineKeys: [], credentialsFile: credsFile })
  check('L24 插件订阅了凭据变更事件', credentialListeners.length === 1, `listeners=${credentialListeners.length}`)
  writeCredentialRefToFile(credsFile, 'CLINE_API_KEY_2', SECRET_C)
  for (const fn of credentialListeners) fn('CLINE_API_KEY_2')
  await new Promise((r) => setTimeout(r, 30))
  const keys = ctxStatusOf().keys
  check('L25 凭据变更后立刻重扫池子（不必等 TTL 节流）', keys.some((k) => k.label === label8(SECRET_C)), keys.map((k) => k.label).join(','))
}

// 解析器的边角：引号包裹、Bearer 前缀、逗号/分号分隔
{
  const parsed = parseKeyInput('"sk-quoted1111"\nBearer sk-bearer2222\nsk-aaaa1111,sk-bbbb2222;sk-cccc3333')
  check('L26 解析容忍引号 / Bearer 前缀 / 逗号分号分隔',
    parsed.values.length === 5 && parsed.values[0] === 'sk-quoted1111' && parsed.values[1] === 'sk-bearer2222' && parsed.rejected.length === 0,
    parsed.values.join('|'))
}

// 凭据服务「读不出」槽位时：宁可一个不导，也绝不往可能已被占用的 ref 上盖。
// 这正是 N1 的回归测试——一次服务抖动不该把用户正在用的 Key 覆盖掉。
{
  const credsFile = join(TEST_STATE_DIR, `import-unknown-${++credsSeq}.yaml`)
  let setCalls = 0
  const broken = {
    async resolve() { throw new Error('vault locked') },
    async set() { setCalls += 1 },
  }
  mount({ clineKeys: [], credentialsFile: credsFile, readCredentialsFile: false, __credentials: broken })
  const blind = await importPost({ body: JSON.stringify({ keys: SECRET_C }) })
  check('L27 全部槽位状态不明时一把都不导入',
    blind.status === 200 && blind.json?.imported?.length === 0 && blind.json?.rejected?.[0]?.reason === 'no-free-ref',
    JSON.stringify(blind.json ?? {}).slice(0, 120))
  check('L28 回包如实列出状态不明的槽位（9 个）',
    blind.json?.refsUnknown?.length === 9 && blind.json.refsUnknown.every((ref) => /^CLINE_API_KEY_\d+$/.test(ref)),
    JSON.stringify(blind.json?.refsUnknown))
  check('L29 一个槽位都没写（文件根本没被创建）', setCalls === 0 && !existsSync(credsFile), `setCalls=${setCalls}`)
  check('L30 回包依然不含 Key 原文', !blind.body.includes(SECRET_C))
}

// 服务读不出、但文件兜底读得到：以文件为准——占用归占用、空闲归空闲，导入照常落最小的空闲槽位。
{
  const credsFile = join(TEST_STATE_DIR, `import-fileback-${++credsSeq}.yaml`)
  writeCredentialRefToFile(credsFile, 'CLINE_API_KEY_2', 'sk-occupied-00000000')
  const broken = {
    async resolve() { throw new Error('vault locked') },
    async set(ref, value) { writeCredentialRefToFile(credsFile, ref, value) },
  }
  mount({ clineKeys: [], credentialsFile: credsFile, __credentials: broken })
  const viaFile = await importPost({ body: JSON.stringify({ keys: SECRET_C }) })
  check('L31 文件兜底确认占用后，导入落在下一个空闲槽位 _3',
    viaFile.json?.imported?.[0]?.ref === 'CLINE_API_KEY_3' && viaFile.json?.refsUnknown?.length === 0,
    JSON.stringify(viaFile.json?.imported))
  check('L32 已被占用的 _2 原值原样保留',
    readCredentialRefsFromFile(credsFile, ['CLINE_API_KEY_2']).get('CLINE_API_KEY_2') === 'sk-occupied-00000000')
  check('L33 新 Key 真的写进了 _3',
    readCredentialRefsFromFile(credsFile, ['CLINE_API_KEY_3']).get('CLINE_API_KEY_3') === SECRET_C)
}

// ───────────────── 4f-2. 选定「使用中」的 Key（第三条写路由，按模型独立）─────────────────
// 语义：选定只决定「**这个模型**的首发送从哪把开始」——不改凭据、不写 key 原文、撞限流
// 照常轮换，而且给一个模型选定不影响其它模型。这一组钉：写路由的三道闸、模型与标签两维的
// 校验、取消是幂等清空、载荷同步、落盘、跨重启与模型间互不影响。
{
  const statePath = join(TEST_STATE_DIR, `select-${++stateSeq}.json`)
  rmSync(statePath, { force: true })
  const MODEL_CLINE = 'cline-free/deepseek-v4.1-flash'
  const MODEL_GLM = 'z-ai/glm-5.3-flash'
  mount({ clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath })
  const selectPost = (options = {}) => callRoute({ path: SELECT_PATH, method: 'POST', contentType: 'application/json', ...options })
  const labelA = label8(SECRET_A)
  const labelB = label8(SECRET_B)
  const selectionOf = () => ctxStatusOf().selection ?? {}

  const notPost = await callRoute({ path: SELECT_PATH, method: 'GET' })
  check('W1 选定路由只收 POST（GET → 405）', notPost.status === 405, String(notPost.status))
  const crossSite = await callRoute({ path: SELECT_PATH, method: 'POST', contentType: 'application/json', referer: 'http://evil.example/x' })
  check('W2 非同源 → 403', crossSite.status === 403, String(crossSite.status))
  const wrongType = await selectPost({ contentType: 'text/plain', body: '{}' })
  check('W3 非 application/json → 415', wrongType.status === 415, String(wrongType.status))
  const badJson = await selectPost({ body: '{oops' })
  check('W4 坏 JSON → 400', badJson.status === 400, String(badJson.status))
  const noModel = await selectPost({ body: JSON.stringify({ label: 'deadbeef' }) })
  check('W5 缺模型 → 400（选定必须落在某个模型上，否则无从对号入座）', noModel.status === 400, String(noModel.status))
  const junkModel = await selectPost({ body: JSON.stringify({ model: '???', label: labelA }) })
  const starModel = await selectPost({ body: JSON.stringify({ model: '*', label: labelA }) })
  check('W5b 不像模型的模型名（??? / *）→ 400', junkModel.status === 400 && starModel.status === 400, `${junkModel.status} ${starModel.status}`)
  const notString = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: 42 }) })
  check('W5c label 不是字符串 → 400（不静默当成取消）', notString.status === 400, String(notString.status))
  const unknown = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: 'deadbeef' }) })
  check('W6 池内没有的标签 → 400，且选定保持为空',
    unknown.status === 400 && Object.keys(selectionOf()).length === 0, `${unknown.status} ${JSON.stringify(selectionOf())}`)
  const chosen = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: labelA }) })
  check('W7 为某个模型选定池内已知标签 → 200，只读载荷按模型同步可见（另一个模型仍为空）',
    chosen.status === 200 && chosen.json?.model === MODEL_CLINE && chosen.json?.selection?.label === labelA &&
      selectionOf()[MODEL_CLINE] === labelA && selectionOf()[MODEL_GLM] === undefined,
    `${chosen.status} ${JSON.stringify(chosen.json ?? null)}`)
  lastCtx.__dshClineBridge.flushQuotaState()
  const fileText = readFileSync(statePath, 'utf8')
  check('W8 选定落盘只有 8 位标签，没有 key 原文',
    fileText.includes(labelA) && !fileText.includes(SECRET_A) && !fileText.includes(SECRET_B),
    `hasLabel=${fileText.includes(labelA)} hasRaw=${fileText.includes(SECRET_A)}`)
  // W9：两个模型各选一把，取消其中一个不动另一个——选定是「模型 + 标签」两维的
  const forGlm = await selectPost({ body: JSON.stringify({ model: MODEL_GLM, label: labelB }) })
  const cleared = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: '' }) })
  check('W9 取消某个模型的选定是幂等清空，另一个模型的选定原封不动',
    forGlm.status === 200 && cleared.status === 200 && cleared.json?.selection === null &&
      selectionOf()[MODEL_CLINE] === undefined && selectionOf()[MODEL_GLM] === labelB,
    `${cleared.status} selection=${JSON.stringify(selectionOf())}`)
  const clearedAgain = await selectPost({ body: JSON.stringify({ model: MODEL_GLM, label: '' }) })
  check('W9b 再清一次同样 200（幂等），选定回到空表',
    clearedAgain.status === 200 && Object.keys(selectionOf()).length === 0, JSON.stringify(selectionOf()))
  mount({ clineKeys: [SECRET_A], keyImport: false })
  const disabled = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: 'deadbeef' }) })
  check('W10 keyImport:false 时选定路由一并 403（与另两条写路由同一开关）', disabled.status === 403, String(disabled.status))
  // 跨重启：两个模型各选一把 → 落盘 → 换全新实例读同一份文件
  mount({ clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath })
  const restoredA = await selectPost({ body: JSON.stringify({ model: MODEL_CLINE, label: labelA }) })
  await selectPost({ body: JSON.stringify({ model: MODEL_GLM, label: labelB }) })
  lastCtx.__dshClineBridge.flushQuotaState()
  mount({ clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath })
  check('W11 按模型的选定跨重启保留（两个模型各读回自己那条）',
    restoredA.status === 200 && selectionOf()[MODEL_CLINE] === labelA && selectionOf()[MODEL_GLM] === labelB,
    JSON.stringify(selectionOf()))
}

// ───────────────── 4g. 统计跨重启持久化 + 重置统计 ─────────────────
// 以前这些数字只活在内存里：插件一更新（= DSH 重启）就全变 0，看着像「白用了」。
// 现在统计与冷却共用同一个状态文件，按 8 位哈希标签恢复——这一组就是钉住这件事。
{
  const statePath = join(TEST_STATE_DIR, `stats-${++stateSeq}.json`)
  rmSync(statePath, { force: true })
  const baseConfig = { clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath, skipCoolingRequestKey: true }
  const send = async () =>
    (await globalThis.fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET_A}` },
      body: JSON.stringify({ model: CAP_ONLY_MODEL, messages: [] }),
    })).text()

  mount(baseConfig)
  await send()
  await new Promise((r) => setTimeout(r, 60)) // token 采集在响应体被读完之后才回来
  const before = await callRoute()
  const beforeA = (before.json.keys ?? []).find((k) => k.label === label8(SECRET_A))
  const beforeB = (before.json.keys ?? []).find((k) => k.label === label8(SECRET_B))
  lastCtx?.__dshClineBridge?.flushQuotaState?.()

  const rawDisk = readFileSync(statePath, 'utf8')
  const disk = JSON.parse(rawDisk)
  check('P1 统计随状态文件落盘（usage + totals 两段）',
    Object.keys(disk.usage ?? {}).length >= 2 && disk.totals?.clineRequests === 1 && disk.totals?.rotations === 1,
    `usage=${Object.keys(disk.usage ?? {}).length} totals=${JSON.stringify(disk.totals)}`)
  check('P2 落盘文件里既没有 key 原文，也没有掩码', !rawDisk.includes(SECRET_A) && !rawDisk.includes(MASK_A) && !rawDisk.includes(SECRET_B))
  check('P3 落盘统计按 8 位哈希标签索引', Object.keys(disk.usage ?? {}).every((label) => /^[0-9a-f]{8}$/.test(label)), Object.keys(disk.usage ?? {}).join(','))
  check('P4 落盘里有按模型的 token 明细', Number(disk.usage?.[label8(SECRET_B)]?.models?.[CAP_ONLY_MODEL]?.tokens?.input) > 0, JSON.stringify(disk.usage?.[label8(SECRET_B)]?.models ?? {}))
  check('P5 载荷带统计起点 totals.since', before.json.totals.since > 0, String(before.json.totals.since))

  // 模拟插件更新 / DSH 重启：同一份状态文件，全新实例
  mount(baseConfig)
  const after = await callRoute()
  const afterA = (after.json.keys ?? []).find((k) => k.label === label8(SECRET_A))
  const afterB = (after.json.keys ?? []).find((k) => k.label === label8(SECRET_B))
  check('P6 重启后全局计数还在', after.json.totals.clineRequests === 1 && after.json.totals.rotations === 1, JSON.stringify(after.json.totals))
  check('P7 重启后每把 key 的发送 / 成功 / 限流计数还在',
    afterA?.stats.sent === 1 && afterA?.stats.limited === 1 && afterB?.stats.ok === 1 && afterB?.stats.sent === 1,
    `A=${JSON.stringify(afterA?.stats)} B=${JSON.stringify(afterB?.stats)}`)
  check('P8 重启后 token 用量还在（key 级 + 按模型）',
    afterB?.stats.tokens.input === beforeB?.stats.tokens.input && afterB?.models?.[CAP_ONLY_MODEL]?.tokens?.input === beforeB?.models?.[CAP_ONLY_MODEL]?.tokens?.input && afterB?.stats.tokens.input > 0,
    `${JSON.stringify(afterB?.stats.tokens)} vs ${JSON.stringify(beforeB?.stats.tokens)}`)
  check('P9 重启后统计起点沿用上次（不是重启时刻）', after.json.totals.since === before.json.totals.since, `${after.json.totals.since} vs ${before.json.totals.since}`)
  check('P10 重启后「最近决策」也还在', (after.json.recent ?? []).length >= 1, `recent=${(after.json.recent ?? []).length}`)

  // 重置统计：计数归零，但冷却（服务端事实）不许动
  const getOnReset = await callRoute({ path: RESET_PATH })
  check('P11 重置路由拒绝非 POST（405）', getOnReset.status === 405, `status=${getOnReset.status}`)
  const untrustedReset = await callRoute({ path: RESET_PATH, method: 'POST', contentType: 'application/json', referer: 'http://evil.example/x', body: '{}' })
  check('P12 重置路由同样要求同源（403）', untrustedReset.status === 403, `status=${untrustedReset.status}`)
  const plainReset = await callRoute({ path: RESET_PATH, method: 'POST', contentType: 'text/plain', body: '{}' })
  check('P13 重置路由要求 application/json（415）', plainReset.status === 415, `status=${plainReset.status}`)
  await new Promise((r) => setTimeout(r, 5))
  const reset = await callRoute({ path: RESET_PATH, method: 'POST', contentType: 'application/json', body: '{}' })
  check('P14 重置返回 200 且计数清零', reset.status === 200 && reset.json.totals.clineRequests === 0 && reset.json.totals.rotations === 0 && reset.json.totals.failFasts === 0, JSON.stringify(reset.json.totals))
  const afterReset = await callRoute()
  check('P15 重置后每把 key 的计数与 token 归零',
    (afterReset.json.keys ?? []).every((k) => k.stats.sent === 0 && k.stats.ok === 0 && k.stats.limited === 0 && k.stats.tokens.input === 0 && k.models?.[CAP_ONLY_MODEL]?.tokens?.input === 0),
    JSON.stringify((afterReset.json.keys ?? []).map((k) => k.stats)))
  check('P16 重置不动冷却（那是服务端的事实）', (afterReset.json.keys ?? []).some((k) => (k.cooling ?? []).length > 0), JSON.stringify((afterReset.json.keys ?? []).map((k) => k.cooling)))
  check('P17 重置把统计起点改到当下', afterReset.json.totals.since > before.json.totals.since, `${afterReset.json.totals.since} > ${before.json.totals.since}`)
  check('P18 重置后「最近决策」清空', (afterReset.json.recent ?? []).length === 0, `recent=${(afterReset.json.recent ?? []).length}`)

  // 重置也落盘：再来一次「重启」，确认磁盘上确实归零了
  lastCtx?.__dshClineBridge?.flushQuotaState?.()
  const afterResetDisk = JSON.parse(readFileSync(statePath, 'utf8'))
  check('P19 重置结果落盘（磁盘上的计数与 token 也归零）',
    afterResetDisk.totals?.clineRequests === 0 && Number(afterResetDisk.usage?.[label8(SECRET_B)]?.stats?.tokens?.input) === 0,
    JSON.stringify(afterResetDisk.totals))
  check('P20 重置后统计起点也写进了磁盘', Number(afterResetDisk.totals?.since) === afterReset.json.totals.since, String(afterResetDisk.totals?.since))
}

// ───────────────── 4j. 重置速度：只清 tokens.ms，其余统计保留 ─────────────────
{
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  // 先挂一次，让插件自己建好状态文件（拿到正确的初始形状）
  const speedConfig = { clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath }
  mount(speedConfig)
  lastCtx?.__dshClineBridge?.flushQuotaState?.()
  // 直接在磁盘状态里注入 ms 数据（模拟 v2.9.0 修复前留下的脏耗时）
  const rawSpeed = readFileSync(statePath, 'utf8')
  const speedDisk = JSON.parse(rawSpeed)
  const labelB = label8(SECRET_B)
  speedDisk.usage = speedDisk.usage ?? {}
  speedDisk.usage[labelB] = {
    firstSeenAt: Date.now() - 60000,
    lastUsedAt: Date.now(),
    stats: { sent: 5, ok: 5, failed: 0, limited: 0, lastModel: CAP_ONLY_MODEL, lastUsedAt: Date.now(), tokens: { input: 5000, output: 400, total: 5400, cached: 4800, ms: 99999 } },
    models: { [CAP_ONLY_MODEL]: { sent: 5, ok: 5, failed: 0, limited: 0, lastUsedAt: Date.now(), tokens: { input: 5000, output: 400, total: 5400, cached: 4800, ms: 99999 } } },
  }
  writeFileSync(statePath, JSON.stringify(speedDisk))
  mount({ clineKeys: [SECRET_A, SECRET_B], quotaStatePath: statePath }) // 重新挂载：让插件把注入的 ms 读进内存
  const beforeSpeed = await callRoute()
  const keyB = (beforeSpeed.json.keys ?? []).find((k) => k.label === labelB)
  check('S1 速度重置前 ms 已在统计里', Number(keyB?.stats?.tokens?.ms) === 99999, JSON.stringify(keyB?.stats?.tokens))
  const speedReset = await callRoute({ path: RESET_PATH, method: 'POST', contentType: 'application/json', body: JSON.stringify({ scope: 'speed' }) })
  check('S2 scope=speed 返回 200 且带 scope 标记', speedReset.status === 200 && speedReset.json.scope === 'speed', JSON.stringify(speedReset.json))
  const afterSpeed = await callRoute()
  const keyBAfter = (afterSpeed.json.keys ?? []).find((k) => k.label === labelB)
  check('S3 速度重置只清 ms（计数与 token 原样保留）',
    Number(keyBAfter?.stats?.tokens?.ms) === 0 && keyBAfter?.stats?.sent === 5 && keyBAfter?.stats?.tokens?.input === 5000 && keyBAfter?.models?.[CAP_ONLY_MODEL]?.tokens?.ms === 0,
    JSON.stringify(keyBAfter?.stats))
  // 全量重置照常工作（scope 缺省 = 全部归零）
  await callRoute({ path: RESET_PATH, method: 'POST', contentType: 'application/json', body: '{}' })
  const afterFull = await callRoute()
  const keyBFull = (afterFull.json.keys ?? []).find((k) => k.label === labelB)
  check('S4 空正文重置仍是全量（计数 token ms 都清零）',
    keyBFull?.stats?.sent === 0 && keyBFull?.stats?.tokens?.input === 0 && Number(keyBFull?.stats?.tokens?.ms ?? 0) === 0,
    JSON.stringify(keyBFull?.stats))
}

// ───────────────── 4k. 上游观测跨重启保留（用户要求） ─────────────────
{
  const statePath = join(TEST_STATE_DIR, `state-${++stateSeq}.json`)
  mount({ clineKeys: [SECRET_A], quotaStatePath: statePath })
  lastCtx?.__dshClineBridge?.flushQuotaState?.()
  // 在磁盘状态里注入一条上游观测（模拟运行期间记录的观测）
  const diskUp = JSON.parse(readFileSync(statePath, 'utf8'))
  const labelA = label8(SECRET_A)
  diskUp.upstream = { [`${labelA}\u0000z-ai/glm-5.3-flash`]: { provider: 'Parasail', fallbacks: 1, servedModel: '', at: Date.now() - 30000 } }
  writeFileSync(statePath, JSON.stringify(diskUp))
  mount({ clineKeys: [SECRET_A], quotaStatePath: statePath }) // 「重启」
  const up = await callRoute()
  const row = (up.json.keys ?? []).find((k) => k.label === labelA)
  check('U1 重启后上游观测保留（key+模型 维度）',
    row?.models?.['z-ai/glm-5.3-flash']?.upstream?.provider === 'Parasail',
    JSON.stringify(row?.models?.['z-ai/glm-5.3-flash']?.upstream))
}

// ───────────────── 4i. 主 Key 挂载即入池（不必等第一条请求） ─────────────────
// 以前主 Key 只在随请求头出现时才登记，于是 DSH 重启后面板只有备用 key，
// 得先发一条请求才变全——这一组钉住「挂载即补齐」。
{
  const credsFile = join(TEST_STATE_DIR, `main-key-${++stateSeq}.yaml`)
  writeFileSync(credsFile, 'version: 1\nrefs:\n  CLINE_API_KEY: "' + SECRET_A + '"\n  CLINE_API_KEY_2: "' + SECRET_B + '"\n', 'utf8')
  // 设置表里的 Cline baseURL 必须命中本用例的 clineMatch（与真实判据同构，见 4c），
  // 否则插件认不出「哪个提供方是 Cline 通道」，也就找不到主 Key 的 apiKeyEnv。
  const table = {
    providers: {
      cline: { displayName: 'Cline', apiKeyEnv: 'CLINE_API_KEY', baseURL: `http://${match}/api/v1`, models: [{ id: 'cline-free/deepseek-v4.1-flash' }] },
    },
  }
  mount({ clineKeys: [], credentialsFile: credsFile, __settingsValues: { 'llm-pi-ai': table } })
  await new Promise((r) => setTimeout(r, 30)) // 主 Key 的解析挂在微任务上，等它落地
  const r = await callRoute()
  const keys = r.json.keys ?? []
  check('W1 重启后主 Key 直接在池子里（不必先发一条请求）', keys.length === 2, `keys=${keys.length}`)
  check('W2 主 Key 来源标成 DSH 请求（与请求头同义）',
    keys.find((k) => k.label === label8(SECRET_A))?.source === 'request',
    String(keys.find((k) => k.label === label8(SECRET_A))?.source))
  check('W3 备用 key 的来源不受影响',
    keys.find((k) => k.label === label8(SECRET_B))?.source === '.credentials.yaml: CLINE_API_KEY_2',
    String(keys.find((k) => k.label === label8(SECRET_B))?.source))
  check('W4 载荷里依然没有 key 原文', !r.body.includes(SECRET_A) && !r.body.includes(SECRET_B))
  check('W5 settings 缺席时也不报错（静默跳过）', r.status === 200, `status=${r.status}`)
}

// 主机半边测完再关 mock 服务器（G 组还要发请求，不能提前关）
dispose()
server.closeAllConnections?.()
await new Promise((r) => server.close(r))

// ───────────────────────── 5. 浏览器半边：沙箱加载 + 渲染 ─────────────────────────
/**
 * 迷你 React 运行时：只实现面板用到的那部分（createElement / useState / useEffect），
 * 但会**真正展开函数组件**（按树中路径保存 hook 槽位，递归到宿主元素），
 * 这样断言就能看到子组件渲染出来的真实内容，而不只是根节点。
 */
function createMiniReact() {
  let hooksByPath = new Map()
  let pendingEffects = []
  let cleanups = []
  let dirty = false
  let path = []
  let cursor = 0

  const slotsOf = () => {
    const key = path.join('.')
    let slots = hooksByPath.get(key)
    if (!slots) {
      slots = []
      hooksByPath.set(key, slots)
    }
    return slots
  }

  const React = {
    createElement(type, props, ...children) {
      const list = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
      // 真实 React 会把子节点放进 props.children；这里必须一致，否则函数组件（例如
      // Button 桩）收到的 children 是 undefined，按钮上的文案在断言里就消失了。
      return { type, props: { ...(props || {}), children: list }, children: list }
    },
    useState(initial) {
      const slots = slotsOf()
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next
        dirty = true
      }]
    },
    useEffect(fn, deps) {
      const slots = slotsOf()
      const index = cursor++
      const prev = slots[index]
      const changed = !prev || !deps || !prev.deps || deps.length !== prev.deps.length || deps.some((d, i) => d !== prev.deps[i])
      slots[index] = { deps }
      if (changed) pendingEffects.push(fn)
    },
  }

  /** 展开一棵元素树：函数组件在这里被调用并替换为它的输出。 */
  function expand(node, at) {
    if (node === null || node === undefined || node === false || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => expand(child, at.concat(index)))
    if (typeof node.type === 'function') {
      path = at
      cursor = 0
      return expand(node.type(node.props || {}), at.concat('out'))
    }
    return { type: node.type, props: node.props, children: node.children.map((child, index) => expand(child, at.concat(index))) }
  }

  return {
    React,
    /** 渲染到稳定：渲染 → 跑 effect → 若有 setState 再渲染，最多 8 轮。 */
    async render(Component, props) {
      let tree
      for (let round = 0; round < 8; round++) {
        dirty = false
        pendingEffects = []
        tree = expand(React.createElement(Component, props), ['root'])
        for (const fn of pendingEffects) {
          const cleanup = fn()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        }
        // 让 fetch 的 promise 链落地
        await new Promise((r) => setTimeout(r, 0))
        if (!dirty) break
      }
      return tree
    },
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try { cleanup() } catch {}
      }
    },
  }
}

/** 深度遍历渲染树，收集所有字符串节点。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out }
  if (node.children) for (const child of node.children) textOf(child, out)
  return out
}

/** 在渲染树里找第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (predicate(node)) return node
  for (const child of node.children || []) {
    const hit = findNode(child, predicate)
    if (hit) return hit
  }
  return undefined
}

/** 渲染树里所有「人类可读」的字符串：文本子节点 + 字符串型 props（title / placeholder 等）。
 *  只查文本会漏掉属性——「英文界面无中文残留」恰恰在 title 上漏过一次，
 *  所以这条断言必须连属性一起看。 */
function visibleStringsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) {
    for (const child of node) visibleStringsOf(child, out)
    return out
  }
  for (const value of Object.values(node.props || {})) {
    if (typeof value === 'string' && value) out.push(value)
  }
  for (const child of node.children || []) visibleStringsOf(child, out)
  return out
}

/** 表格表头文本，用于断言列集合（列数是接口的一部分，增删列必须同步改断言）。 */
function table_headers(tree) {
  const head = findNode(tree, (n) => n.type === 'thead')
  if (!head) return []
  return textOf(head).map((text) => text.trim()).filter(Boolean)
}

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MODULE_ID = 'dsh-cline-bridge'
const ROUTE = '/dsh-cline-bridge/keys'
const CLIENT_IMPORT_ROUTE = '/dsh-cline-bridge/keys/import'
const CLIENT_RESET_ROUTE = '/dsh-cline-bridge/keys/stats/reset'
const CLIENT_SELECT_ROUTE = '/dsh-cline-bridge/keys/select'

/** 把客户端半边装进 vm 沙箱，返回它的模块导出。 */
function loadClientBundle() {
  let captured
  const styleTags = []
  const mini = createMiniReact()
  // 键盘监听（导入弹窗的 Esc）：桩里也要收得到，这样「按 Esc 关窗」才测得了
  const keyListeners = new Map()
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    document: {
      // 有状态的 document 桩：appendChild 真的把元素记下来，getElementById 也能找到它，
      // 这样「重复加载时覆盖同一个 <style>」才测得到（否则每次都返回 null，永远走新建分支）。
      head: { appendChild: (el) => styleTags.push(el) },
      getElementById: (id) => styleTags.find((el) => el.id === id) ?? null,
      hidden: false,
      createElement: () => ({ dataset: {}, textContent: '', id: '' }),
      addEventListener(type, fn) {
        const list = keyListeners.get(type) ?? []
        list.push(fn)
        keyListeners.set(type, list)
      },
      removeEventListener(type, fn) {
        const list = keyListeners.get(type) ?? []
        const at = list.indexOf(fn)
        if (at >= 0) list.splice(at, 1)
      },
    },
    navigator: { language: 'zh-CN' },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    fetch: async () => { throw new Error('fetch not stubbed for this case') },
  }
  createContext(sandbox)
  runInContext(CLIENT_SOURCE, sandbox)

  if (!captured) throw new Error('客户端半边没有调用 window.__ModuleLoader__.load')
  const exportsObj = captured.factory((request) => {
    if (request === 'react') return mini.React
    if (request === '@deepseek-ai/dsh-client-ui-primitives') {
      return { Button: (props) => mini.React.createElement('button', { onClick: props.onClick }, props.icon, props.children) }
    }
    throw new Error(`unexpected require: ${request}`)
  })
  return { exports: exportsObj, sandbox, mini, styleTags, id: captured.id, load: captured, keyListeners }
}

/** 用给定的路由载荷渲染一次面板，返回渲染树与插槽注册信息。 */
async function renderPanel(payload, { fetchError = null, locale = 'zh-CN' } = {}) {
  const bundle = loadClientBundle()
  const registered = []
  const dictionaries = []

  // 每次渲染前替换 sandbox 的 fetch。
  // 桩要**忠实**于真实 Response：headers 必须存在（面板会读 etag 做条件请求），
  // 否则测出来的失败是桩的问题、不是代码的问题。测试也可以主动回 304（见 withEtag 用例）。
  bundle.sandbox.fetch = async () => {
    if (fetchError) throw new Error(fetchError)
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"test-etag"' : null) },
      json: async () => payload,
    }
  }

  const slots = {
    inject: (name, cb) => cb(),
    register: (options, Component) => { registered.push({ options, Component }); return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('locale')) return undefined
      return callback({
        get: () => ({
          register: (ns, lang, dict) => { dictionaries.push([ns, lang, dict]); return () => {} },
          getSnapshot: () => ({ active: locale }),
        }),
        effect: (factory) => factory(),
      })
    },
  }
  bundle.exports.apply(ctx)

  const tree = await bundle.mini.render(registered[0].Component, {})
  return { bundle, tree, registered, dictionaries, payload }
}

{
  const payload = {
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
    // 主机端总会带上模型清单与「当前模型」——面板恒定按某个模型看，靠它们出筛选条
    models: [{ id: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() }],
    currentModel: 'cline-free/deepseek-v4.1-flash',
    totals: { poolSize: 2, clineRequests: 61, rotations: 3, failFasts: 1 },
    extras: { credentialsFileRead: true, extrasResolved: true, lastExtrasAt: '2026-09-17T07:45:16.602Z' },
    keys: [
      { index: 1, label: 'db694bbf', preview: MASK_A, source: 'request',
        cooling: [{ model: 'cline-free/deepseek-v4.1-flash', readyAt: Date.now() + 21 * 3600 * 1000, readyInMin: 1300 }],
        stats: { sent: 12, ok: 11, failed: 2, limited: 1, lastModel: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() - 5000, tokens: { input: 16800, output: 1500, total: 18300, cached: 900 } },
        models: { 'cline-free/deepseek-v4.1-flash': { sent: 12, ok: 11, failed: 2, limited: 1, lastUsedAt: Date.now() - 5000, tokens: { input: 16800, output: 1500, total: 18300, cached: 900 } } } },
      { index: 2, label: '761f9875', preview: MASK_B, source: '.credentials.yaml: CLINE_API_KEY_2',
        cooling: [], stats: { sent: 4, ok: 4, limited: 0, lastModel: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() - 61000 },
        models: { 'cline-free/deepseek-v4.1-flash': { sent: 4, ok: 4, limited: 0, lastUsedAt: Date.now() - 61000, tokens: { input: 0, output: 0, total: 0, cached: 0 } } } },
    ],
    recent: [{ at: new Date().toISOString(), model: 'cline-free/deepseek-v4.1-flash', decision: 'rotated a→b', bodyLen: 413503, poolSize: 2 }],
  }

  const { registered, dictionaries, tree, bundle } = await renderPanel(payload)
  const text = textOf(tree).join('\n')
  const serialized = JSON.stringify(tree)

  check('C1 bundle id 与 package.json name 一致', bundle.id === MODULE_ID, bundle.id)
  check('C2 声明了 slots 依赖', Array.isArray(bundle.exports.inject) && bundle.exports.inject.includes('slots'), JSON.stringify(bundle.exports.inject))
  check('C3 注册进 settings.section 座位', registered.length === 1 && registered[0].options.name === 'settings.section', JSON.stringify(registered.map((r) => r.options?.name)))
  check('C4 座位 id/order/locale 齐备', registered[0].options.id === MODULE_ID && typeof registered[0].options.order === 'number' && registered[0].options.locale === 'dshClineBridge', JSON.stringify(registered[0].options))
  check('C5 座位标签是可调用 thunk（切换语言无需重注册）', typeof registered[0].options.label === 'function' && registered[0].options.label() === 'Cline Key', String(registered[0].options.label?.()))
  check('C6 zh/en 两套字典都注册进 DSH locale', dictionaries.length === 2 && dictionaries.some((d) => d[1] === 'zh') && dictionaries.some((d) => d[1] === 'en'), JSON.stringify(dictionaries.map((d) => d[1])))
  // 漏译不会报错，只会让界面回退成键名，所以这里必须自己盯住两套字典的键集合一致
  const zhKeys = Object.keys(dictionaries.find((d) => d[1] === 'zh')?.[2] ?? {}).sort()
  const enKeys = Object.keys(dictionaries.find((d) => d[1] === 'en')?.[2] ?? {}).sort()
  check('C6b zh/en 字典键集合完全一致', zhKeys.length > 0 && zhKeys.join('|') === enKeys.join('|'),
    `zh=${zhKeys.length} en=${enKeys.length}${zhKeys.join('|') === enKeys.join('|') ? '' : ' 差异=' + zhKeys.filter((k) => !enKeys.includes(k)).concat(enKeys.filter((k) => !zhKeys.includes(k))).join(',')}`)
  check('C7 样式只注入一个 <style> 并带 plugin 标记', bundle.styleTags.length === 1 && bundle.styleTags[0].dataset.plugin === MODULE_ID, `tags=${bundle.styleTags.length}`)
  // 重复加载（模拟客户端 bundle 热重载 / 插件更新后不刷新页面）必须**覆盖**同一个
  // <style> 的内容，而不是「已存在就跳过」——跳过会让新结构配旧 CSS，布局错乱极难查。
  const styleTag = bundle.styleTags[0]
  styleTag.textContent = 'STALE-CSS-FROM-PREVIOUS-VERSION'
  bundle.load.factory((request) => (request === 'react' ? bundle.mini.React : { Button: 'button' }))
  check('C7b 重复加载时覆盖同一 <style> 的内容，且不会多插一个',
    bundle.styleTags.length === 1 && styleTag.textContent !== 'STALE-CSS-FROM-PREVIOUS-VERSION' && styleTag.textContent.includes('_dsh_ofb_table'),
    `tags=${bundle.styleTags.length} len=${styleTag.textContent.length}`)

  check('C8 渲染出标题', text.includes('Cline Key 使用情况'), text.split('\n').slice(0, 3).join(' / '))
  check('C9 渲染出两把 key 的掩码预览', text.includes(MASK_A) && text.includes(MASK_B))
  check('C10 渲染树里不含任何 key 原文', !serialized.includes(SECRET_A) && !serialized.includes(SECRET_B))
  check('C11 面板不再渲染 8 位哈希标签（它是内部标识，不是给人认的）',
    !text.includes('db694bbf') && !text.includes('761f9875'), text.split('\n').filter((s) => /^[0-9a-f]{8}$/.test(s.trim())).join(',') || '（无）')
  check('C12 渲染出模型筛选条、恢复倒计时与该模型的用量明细', /2[01]h\d\dm/.test(text) && text.includes('deepseek-v4.1-flash') && text.includes('16.8k'), (/[0-9]+h[0-9]{2}m/.exec(text) ?? ['none'])[0])
  check('C13 渲染出状态药丸（可用/冷却中）', text.includes('冷却中') && text.includes('可用'))
  check('C14 表格里没有「来源」这一列', !table_headers(tree).some((h) => /来源|source/i.test(h)) && !text.includes('.credentials.yaml: CLINE_API_KEY_2') && !text.includes('DSH 请求头'), table_headers(tree).join(' | '))
  check('C15 表格第 5 列是「上游渠道」（原「请求 / Token」列已按用户要求替换）',
    table_headers(tree)[4] === '上游渠道', table_headers(tree).join(' | '))
  check('C16 渲染出统计卡数值', text.includes('61') && text.includes(PLUGIN_VERSION), PLUGIN_VERSION)
  check('C17 渲染出最近决策', text.includes('最近决策') && text.includes('rotated a→b'))
  check('C18 面板里没有「运行参数」卡片', !text.includes('运行参数') && !text.includes('凭据文件') && !text.includes('15分钟') && !text.includes('Runtime parameters'))
  check('C19 面板里没有掩码说明文字', !text.includes('首尾各 4 位') && !text.includes('掩码预览'))
  check('C20 表格表头恰好是这 7 列', table_headers(tree).join('|') === '#|Key|状态|冷却 / 恢复|上游渠道|最近使用|使用', table_headers(tree).join(' | '))

  // 关键 DOM 结构：表格确实有 2 行数据
  const table = findNode(tree, (n) => n.type === 'table')
  const bodyRows = table ? findNode(table, (n) => n.type === 'tbody')?.children?.length : 0
  check('C21 表格渲染出 2 行 key', bodyRows === 2, `rows=${bodyRows}`)

  // ── 布局断言：这几条钉的是用户实际看到的问题（列被挤到一起、长内容把行撑高）──
  const colgroup = findNode(table, (n) => n.type === 'colgroup')
  const cols = colgroup?.children ?? []
  const widths = cols.map((c) => String(c.props?.style?.width ?? ''))
  check('C26 表格用 colgroup 按百分比分配列宽（跟着容器走，不由内容撑开）',
    cols.length === 7 && widths.every((w) => /^\d+(\.\d+)?%$/.test(w)), widths.join(' | '))
  check('C27 列宽百分比之和正好 100%（不会几列互相挤压）',
    Math.abs(widths.reduce((sum, w) => sum + Number.parseFloat(w), 0) - 100) < 0.001, String(widths.reduce((s, w) => s + Number.parseFloat(w), 0)))

  // 用户反馈：加上「使用」列后，窄侧栏里要横向拖滚动条才看得到它，而 Key 与「状态」之间
  // 还空着一大片。两条锁——表格 min-width 不高于 520px（七列在一屏里放得下）＋ Key 列不
  // 超过 17%（它只放 9 个字符的掩码，给多了就是那片空白）。
  const tableRule = /_dsh_ofb_table \{([^}]*)\}/.exec(bundle.styleTags[0]?.textContent ?? '')?.[1] ?? ''
  const minWidth = Number.parseInt(/min-width:\s*(\d+)px/.exec(tableRule)?.[1] ?? '0', 10)
  const keyShare = Number.parseFloat(widths[1] ?? '0')
  check('C27d 表格 min-width ≤ 520px 且 Key 列 ≤ 17%（七列一屏放得下，Key↔状态之间不留空白）',
    minWidth > 0 && minWidth <= 520 && keyShare <= 17, `min-width=${minWidth}px key=${keyShare}%`)

  // 表头必须自带裁剪：只看 nowrap 的话，列一窄标题就会压到隔壁列头上（用户截图里的现象）
  const css = bundle.styleTags[0]?.textContent ?? ''
  const thRule = /_dsh_ofb_table th \{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('C27b 表头规则带 overflow:hidden + text-overflow:ellipsis',
    thRule.includes('overflow: hidden') && thRule.includes('text-overflow: ellipsis') && thRule.includes('white-space: nowrap'),
    thRule.slice(0, 80))
  const tdRule = /_dsh_ofb_table td \{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('C27c 单元格规则带 overflow:hidden', tdRule.includes('overflow: hidden'), tdRule.slice(0, 60))

  const firstRow = findNode(table, (n) => n.type === 'tbody')?.children?.[0]
  const rowCells = firstRow?.children ?? []
  const lastUsedCell = rowCells[5]
  const lastUsedText = textOf(lastUsedCell).join('')
  check('C28 「最近使用」只显示相对时间，完整模型名放 title（不再被 30 字符模型名撑宽）',
    lastUsedText === '5 秒前' && lastUsedCell?.children?.[0]?.props?.title === 'cline-free/deepseek-v4.1-flash',
    `${lastUsedText} / title=${lastUsedCell?.children?.[0]?.props?.title}`)

  // 冷却单元格：按模型视图下一把 key 最多一条记录，所以只显示「倒计时 + 恢复时刻」
  const coolingCell = rowCells[3]
  check('C29 冷却单元格只显示倒计时与恢复时刻（模型由筛选条决定）',
    textOf(coolingCell).join(' ').includes('h') && findNode(coolingCell, (n) => String(n.props?.className ?? '') === '_dsh_ofb_cooling_line') !== undefined,
    textOf(coolingCell).join(' | '))

  // 回归（用户实测：上游渠道盖住了恢复时间）：冷却格内容超宽时会越界压进隔壁列——
  // td 的 overflow:hidden 对表格单元格不生效，防护必须在格内自己完成。
  // 锁三件事：冷却行允许格内折行（flex-wrap）、恢复时刻自带裁剪壳与完整时刻的 title、
  // 倒计时 flex:none（不被压缩变形）。
  const coolingLine = findNode(coolingCell, (n) => String(n.props?.className ?? '') === '_dsh_ofb_cooling_line')
  const coolingStamp = findNode(coolingCell, (n) => String(n.props?.className ?? '').includes('_dsh_ofb_clip'))
  const coolingLineCss = /_dsh_ofb_cooling_line \{([^}]*)\}/.exec(css)?.[1] ?? ''
  const remainingCss = /_dsh_ofb_remaining \{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('C29b 冷却格内容绝不越界：行内可折行（flex-wrap）、时刻带裁剪壳+title、倒计时不被压缩',
    coolingLine !== undefined && coolingLineCss.includes('flex-wrap: wrap') &&
      coolingStamp !== undefined && Boolean(coolingStamp.props?.title) &&
      remainingCss.includes('flex: none'),
    'wrap=' + coolingLineCss.includes('flex-wrap: wrap') +
      ' clip=' + (coolingStamp !== undefined) + ' title=' + Boolean(coolingStamp?.props?.title) +
      ' flexNone=' + remainingCss.includes('flex: none'))

  // Key 单元格：只有掩码预览一行，且带裁剪类（长 key 不会换行撑高）
  const keyCellItems = rowCells[1]?.children?.[0]?.children ?? []
  const clipped = (node) => String(node?.props?.className ?? '').includes('_dsh_ofb_clip')
  check('C30 Key 单元格只剩预览一行且带裁剪类（哈希标签已移除）',
    keyCellItems.length === 1 && clipped(keyCellItems[0]) &&
      !serialized.includes('_dsh_ofb_key_meta'),
    keyCellItems.map((c) => c.props?.className).join(' | '))
  check('C31 表内所有可能变长的文本节点都带裁剪类', (() => {
    const offenders = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const cls = String(node.props?.className ?? '')
      if (node.type === 'td' && node.children.some((c) => typeof c === 'string' && c.length > 12)) offenders.push(String(node.children[0]).slice(0, 20))
      if (cls.includes('_dsh_ofb_mono') && !cls.includes('_dsh_ofb_clip')) offenders.push(cls)
      ;(node.children ?? []).forEach(walk)
    }
    walk(table)
    return offenders.length === 0
  })(), 'mono 文本必须带 _dsh_ofb_clip 才会省略号收口')

  check('C32 面板里不再出现「主 Key」标记（池内 key 一律同级）',
    !text.includes('主 Key') && !serialized.includes('isRequestKey') && !serialized.includes('_dsh_ofb_badge'),
    textOf(tree).filter((s) => s.includes('主 Key')).join(' / ') || '（无）')

  // 哈希标签已从面板移除；maskKeyPreview:false（preview 为空串）时也不能拿它兜底，
  // 否则「关掉掩码」反而把标签露出来——正是移除它的理由。
  const noPreview = await renderPanel({
    plugin: MODULE_ID, version: PLUGIN_VERSION, updatedAt: Date.now(),
    models: [{ id: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() }],
    currentModel: 'cline-free/deepseek-v4.1-flash',
    totals: { poolSize: 2, clineRequests: 0, rotations: 0, failFasts: 0 },
    keys: [
      { index: 1, label: 'db694bbf', preview: '', source: 'request', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} },
      { index: 2, label: '761f9875', preview: '', source: 'request', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} },
    ],
    recent: [],
  })
  const noPreviewText = textOf(noPreview.tree).join('\n')
  check('C33 maskKeyPreview:false 时面板既不显示预览、也不拿哈希标签兜底',
    !noPreviewText.includes('db694bbf') && !noPreviewText.includes('761f9875') && noPreviewText.includes('—'),
    noPreviewText.split('\n').filter((s) => s.trim()).slice(0, 12).join(' | '))
  noPreview.bundle.mini.dispose()

  bundle.mini.dispose()
}

// ───────────────────────── 5b. 按模型分别查看（用户报告的问题）─────────────────────────
// 场景：deepseek 撞了每日上限、已切到 glm 继续用。此时面板若仍把 deepseek 的冷却
// 算作「这把 key 冷却中」，看起来就像没有可用 key——必须在默认筛选（当前模型）下
// 显示为「可用」，并能切到「全部模型」或具体模型分别查看。
{
  const DEEPSEEK = 'cline-free/deepseek-v4.1-flash'
  const GLM = 'z-ai/glm-5.3-flash'
  const payload = {
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
    // 模型维度的观测（芯片徽标用）：当前模型 glm 的预期上游是 deepseek，但实际漂到了 alibaba。
    // 注意这是**模型维度**的事实，只喂给芯片徽标；表格里每行的上游必须来自各自的 models 明细。
    models: [
      { id: GLM, lastUsedAt: Date.now(), upstream: { provider: 'alibaba', preferred: 'deepseek', fallbacks: 15, at: Date.now(), stale: false, other: true } },
      { id: DEEPSEEK, lastUsedAt: Date.now() - 3600_000, upstream: { provider: 'deepseek', preferred: 'deepseek', fallbacks: 15, at: Date.now(), stale: false, other: false } },
    ],
    currentModel: GLM,
    totals: { poolSize: 2, readyKeys: 1, coolingKeys: 1, clineRequests: 40, rotations: 2, failFasts: 0 },
    extras: {},
    keys: [
      {
        index: 1, label: 'db694bbf', preview: MASK_A, source: 'request',
        cooling: [{ model: DEEPSEEK, readyAt: Date.now() + 21 * 3600 * 1000, readyInMin: 1260 }],
        stats: { sent: 19, ok: 18, limited: 1, lastModel: GLM, lastUsedAt: Date.now() - 4000, tokens: { input: 16800, output: 1500, total: 18300, cached: 900, ms: 180000 } },
        models: {
          [DEEPSEEK]: { sent: 16, ok: 15, failed: 2, limited: 1, lastUsedAt: Date.now() - 3600_000, tokens: { input: 12300, output: 1200, total: 13500, cached: 800, ms: 120000 }, upstream: { provider: 'deepseek', fallbacks: 15, at: Date.now() } },
          [GLM]: { sent: 3, ok: 3, limited: 0, lastUsedAt: Date.now() - 4000, tokens: { input: 4500, output: 300, total: 4800, cached: 100, ms: 60000 }, upstream: { provider: 'deepinfra', fallbacks: 4, at: Date.now() } },
        },
      },
      {
        index: 2, label: '761f9875', preview: MASK_B, source: '.credentials.yaml: CLINE_API_KEY_2',
        cooling: [],
        stats: { sent: 21, ok: 21, limited: 0, lastModel: GLM, lastUsedAt: Date.now() - 9000, tokens: { input: 21000, output: 2100, total: 23100, cached: 0, ms: 60000 } },
        models: { [GLM]: { sent: 21, ok: 21, limited: 0, lastUsedAt: Date.now() - 9000, tokens: { input: 21000, output: 2100, total: 23100, cached: 0, ms: 60000 }, upstream: { provider: 'togetherai', fallbacks: 4, at: Date.now() } } },
      },
    ],
    recent: [{ at: new Date().toISOString(), model: GLM, decision: 'pass-through status=200', bodyLen: 1000, poolSize: 2 }],
  }

  const { registered, tree, bundle } = await renderPanel(payload)
  const renderedText = () => textOf(tree).join('\n')
  const chipsOf = (node) => {
    const found = []
    // 只收「芯片按钮」本身：芯片可能被 `_dsh_ofb_chipwrap` 包住（配了上游时里面还有徽标），
    // 而那个容器的 className 也含 `_dsh_ofb_chip` 子串——不排除它会把同一个芯片数两次。
    const isChip = (cls) => {
      const parts = String(cls).split(/\s+/)
      return parts.includes('_dsh_ofb_chip') || parts.includes('_dsh_ofb_chip_on')
    }
    const walk = (current) => {
      if (!current || typeof current !== 'object') return
      if (Array.isArray(current)) return current.forEach(walk)
      if (isChip(current.props?.className ?? '')) found.push(current)
      ;(current.children ?? []).forEach(walk)
    }
    walk(node)
    return found
  }
  const clickChip = async (label) => {
    const chip = chipsOf(tree).find((c) => textOf(c).join('') === label)
    if (!chip) throw new Error(`chip not found: ${label}（现有：${chipsOf(tree).map((c) => textOf(c).join('')).join(',')}）`)
    chip.props.onClick()
    // 迷你 React 的 hook 槽按树中路径保存，所以直接再渲染一次就能看到新状态
    return bundle.mini.render(registered[0].Component, {})
  }
  const tableText = (node) => textOf(findNode(node, (n) => n.type === 'table')).join('\n')
  const rowText = (node, label) => {
    const body = findNode(node, (n) => n.type === 'tbody')
    const row = (body?.children ?? []).find((tr) => JSON.stringify(tr).includes(label))
    return textOf(row).join('\n')
  }

  // 行定位改用掩码预览：8 位哈希标签已从面板移除，不再能当锚点。
  const rowA = rowText(tree, MASK_A)
  check('F1 deepseek 上被限的 key 在 glm 视图下显示「可用」', rowA.includes('可用') && !rowA.includes('冷却中'), rowA.replace(/\n/g, ' | '))
  check('F2 glm 视图下不出现 deepseek 的冷却记录', !tableText(tree).includes('deepseek'), tableText(tree).replace(/\n/g, ' | ').slice(0, 120))
  check('F3 glm 视图下该 key 的上游来自它自己的 glm 明细（deepinfra）', rowA.includes('deepinfra'), rowA.replace(/\n/g, ' | '))
  check('F4 另一把 key 显示它自己在 glm 上的上游（togetherai）', rowText(tree, MASK_B).includes('togetherai'), rowText(tree, MASK_B).replace(/\n/g, ' | '))
  check('F5 概览卡随筛选变化（该模型可用 / 该模型冷却）', renderedText().includes('该模型可用') && renderedText().includes('该模型冷却'), textOf(tree).filter((s) => s.includes('该模型')).join(' | '))

  const chips = chipsOf(tree).map((c) => textOf(c).join(''))
  check('F6 筛选条只列模型本身（没有「全部模型」选项）',
    chips.length === 2 && chips.includes('deepseek-v4.1-flash') && chips.includes('glm-5.3-flash') && !chips.some((c) => c.includes('全部')),
    chips.join(' / '))
  const activeChip = chipsOf(tree).find((c) => String(c.props.className).includes('_dsh_ofb_chip_on'))
  check('F7 默认选中项是当前模型（glm）', textOf(activeChip ?? {}).join('') === 'glm-5.3-flash', textOf(activeChip ?? {}).join(''))

  // 切到 deepseek：只剩 deepseek 的数据（面板没有「跨模型汇总」这种视图）
  const dsView = await clickChip('deepseek-v4.1-flash')
  const dsRow = rowText(dsView, MASK_A)
  check('F8 切到 deepseek 后该 key 显示冷却中并给出恢复倒计时', dsRow.includes('冷却中') && /2[01]h\d\dm/.test(dsRow), dsRow.replace(/\n/g, ' | '))
  check('F9 切到 deepseek 后该 key 的上游换成它在 deepseek 上的（deepseek）', dsRow.includes('deepseek'), dsRow.replace(/\n/g, ' | '))
  check('F10 切回 glm 后该 key 恢复「可用」', rowText(tree, MASK_A).includes('可用'), rowText(tree, MASK_A).replace(/\n/g, ' | '))
  const dsOther = rowText(dsView, MASK_B)
  check('F11 另一把没在 deepseek 上跑过：上游显示「—」、可用、最近使用「从未」', dsOther.includes('—') && dsOther.includes('可用') && dsOther.includes('从未'), dsOther.replace(/\n/g, ' | '))
  // ── 按模型用量明细卡（用户要求：显示每个 key 的每个模型的用量）──
  // 面板恒定在某个模型的筛选下，所以这张卡每把 key 就一行：key 预览 + 数字，
  // 模型名不重复出现（它写在筛选芯片上），哈希标签也不再出现（内部标识）。
  const usageCardOf = (node) => findNode(node, (n) => String(n.props?.className ?? '') === '_dsh_ofb_usage')
  const usageOf = (node, label) => {
    const card = usageCardOf(node)
    if (!card) return ''
    const row = (card.children ?? []).find((k) => String(k.props?.className ?? '').includes('_dsh_ofb_usage_row') && JSON.stringify(k).includes(label))
    return row ? textOf(row).join(' ') : ''
  }

  const usageDsRow = usageOf(dsView, MASK_A)
  // 每个数值各占一列（发送|成功|失败|限流、输入|速度 tok/s），所以 textOf 用空格连接。
  // deepseek 视图下这把 key：output=1200 ms=120000 → 10.0 tok/s
  check('I1 明细卡按当前模型逐行列出用量（deepseek 视图）',
    usageDsRow.includes('1 sk-l…4444 16 15 2 1 12.3k 10.0'), usageDsRow)
  check('I2 另一把 key 在 glm 视图下有自己的一行（21k 输入、35.0 tok/s）',
    usageOf(tree, MASK_B).includes('2 sk-t…8888 21 21 0 0 21k 35.0'), usageOf(tree, MASK_B))
  const usageHeadOf = (node) => findNode(usageCardOf(node), (n) => String(n.props?.className ?? '') === '_dsh_ofb_usage_head')
  const usageHeadSpans = usageHeadOf(tree)?.children ?? []
  // 表头与数据行同构：每列一个标签，含义直接可见（不靠悬停），且短标签不会折行
  const usageHeadFlat = usageHeadSpans.map((s) => textOf(s).join('')).join('|')
  check('I3 明细卡表头逐列标注（Key、发送/成功/失败/限流、输入/速度），与数据列一一对应',
    usageHeadFlat === 'Key|发送成功失败限流|输入速度|最近使用' &&
      String(usageHeadSpans[0]?.props?.className ?? '') === '_dsh_ofb_usage_lead' &&
      String(usageHeadSpans[1]?.props?.className ?? '') === '_dsh_ofb_usage_req' &&
      String(usageHeadSpans[2]?.props?.className ?? '') === '_dsh_ofb_tokencell',
    usageHeadFlat)
  check('I3b 明细卡不再重复模型名（它已在筛选芯片上）',
    !usageCardOf(tree) || !JSON.stringify(usageCardOf(tree)).includes('z-ai/glm-5.3-flash'),
    JSON.stringify(usageCardOf(tree) ?? {}).slice(0, 200))
  check('I3c 「缓存命中」列已被「速度」替换（不再出现命中率）',
    usageHeadFlat.includes('速度') && !usageHeadFlat.includes('缓存命中'),
    usageHeadFlat)

  const usageGlm = usageOf(tree, MASK_A)
  check('I4 glm 视图下明细不含 deepseek 的行', usageGlm.includes('3 3 0 0 4.5k') && !usageGlm.includes('deepseek'), usageGlm)

  // 该模型上没用过的 key 不再各占一块，而是折叠成一行提示（否则半张卡都是「没用过」）
  const cardText = (node) => textOf(usageCardOf(node)).join('\n')
  check('I5 该模型上未使用的 key 折叠成一行提示',
    cardText(dsView).includes('其余 1 把在该模型上没用过') && !cardText(dsView).includes(MASK_B),
    cardText(dsView).replace(/\n/g, ' | '))
  // glm 视图：output=300 ms=60000 → 5.0 tok/s
  check('I6 切到 glm 时同一把 key 显示 glm 的计数与速度', usageGlm.includes('1 sk-l…4444 3 3 0 0 4.5k 5.0'), usageGlm)

  // ── 上游渠道列（第 1 张表的第 5 列，替代原「请求 / Token」）──
  // 逐 key 显示各自在该模型上的实际上游。没观测到必须是「—」，
  // 绝不退回别的模型的结论、也不假装知道。
  const upstreamRowOf = (node, label) => {
    const body = findNode(node, (n) => n.type === 'tbody')
    const row = (body?.children ?? []).find((tr) => JSON.stringify(tr).includes(label))
    const cell = (row?.children ?? [])[4]
    return textOf(cell).join('')
  }
  check('I7 明细卡显示该模型的输入 token（与速度并排两列）',
    usageDsRow.includes('12.3k') && !usageDsRow.includes('1.2k'), usageDsRow)
  check('I8 上游列逐 key 各记各的（glm 视图：一把 deepinfra、一把 togetherai）',
    upstreamRowOf(tree, MASK_A) === 'deepinfra' && upstreamRowOf(tree, MASK_B) === 'togetherai',
    `${upstreamRowOf(tree, MASK_A)} / ${upstreamRowOf(tree, MASK_B)}`)
  check('I9 切到 deepseek 后该 key 的上游跟着换成它在 deepseek 上的',
    upstreamRowOf(dsView, MASK_A) === 'deepseek', upstreamRowOf(dsView, MASK_A))
  check('I10 该模型上没观测过的 key：上游显示「—」，不退回别的模型的结论',
    upstreamRowOf(dsView, MASK_B) === '—', upstreamRowOf(dsView, MASK_B))
  // 模型维度的观测（alibaba）绝不能漏到每一行——那会把「模型漂了」显示成「每把 key 都漂了」
  check('I10b 芯片徽标用模型维度的观测，但表格各行用各自 key 的数据（互不串味）',
    upstreamRowOf(tree, MASK_A) !== 'alibaba' && upstreamRowOf(tree, MASK_B) !== 'alibaba',
    `${upstreamRowOf(tree, MASK_A)} / ${upstreamRowOf(tree, MASK_B)}`)

  // ── 可视化：占比条与合计 ──
  const barsOf = (node) => {
    const found = []
    const walk = (current) => {
      if (!current || typeof current !== 'object') return
      if (Array.isArray(current)) return current.forEach(walk)
      if (String(current.props?.className ?? '') === '_dsh_ofb_bar') found.push(current)
      ;(current.children ?? []).forEach(walk)
    }
    walk(usageCardOf(node))
    return found
  }
  const fillOf = (bar) => findNode(bar, (n) => String(n.props?.className ?? '') === '_dsh_ofb_bar_fill')
  // glm 视图下有两行有数据：db694bbf(input 4.5k) 与 761f9875(input 21k)
  const bars = barsOf(tree)
  check('I11 每行 token 都配一根占比条', bars.length === 2, `bars=${bars.length}`)
  const barWidths = bars.map((bar) => Number.parseFloat(fillOf(bar)?.props?.style?.width ?? '0'))
  check('I12 输入量最大的那行占满整条（条长按卡内最大输入量归一）',
    Math.max(...barWidths) === 100 && barWidths.filter((w) => w === 100).length === 1, barWidths.map((w) => w.toFixed(0) + '%').join(' / '))
  check('I13 条是单段纯输入占比（缓存分段已随「缓存命中」列一起移除）',
    bars.every((bar) => {
      const segs = (fillOf(bar)?.children ?? []).map((c) => String(c.props?.className ?? ''))
      return segs.length === 1 && segs[0] === '_dsh_ofb_bar_in'
    }), JSON.stringify(bars.map((bar) => (fillOf(bar)?.children ?? []).map((c) => String(c.props?.className ?? '').replace('_dsh_ofb_bar_', '')))))
  // 速度列的第二格数字：deepseek 视图第一行 output=1200 ms=120000 → 10.0
  const speedCell = Number.parseFloat(usageOf(dsView, MASK_A).split('12.3k ')[1] ?? '')
  check('I14 速度列 = 累计输出 ÷ 累计流式秒数（1200/120s = 10.0）', Math.abs(speedCell - 10) < 0.05, String(speedCell))
  check('I15 标题行给出当前模型的合计（请求 + token，取自面板整体文本，因为它在卡片外）',
    (() => {
      const whole = textOf(tree).join('\n')
      return whole.includes('合计') && whole.includes('24/24/0') && whole.includes('25.5k/2.4k')
    })(),
    textOf(tree).filter((s) => s.includes('合计')).join(' '))
  check('I16 条的 title 给出精确 输入/输出（悬停可见原始数）',
    (() => {
      const tip = String(findNode(bars[0], (n) => typeof n.props?.title === 'string')?.props?.title ?? '')
      return tip.includes('输入') && tip.includes('4500') && tip.includes('输出')
    })(),
    findNode(bars[0], (n) => typeof n.props?.title === 'string')?.props?.title)
  check('I17 合计行不显示速度（跨 key 加权平均没有「哪把快」的信息量，用户要求移除）',
    (() => {
      const total = textOf(tree).filter((s) => s.includes('合计')).join(' ')
      return total.includes('25.5k/2.4k') && !total.includes('速度')
    })(), textOf(tree).filter((s) => s.includes('合计')).join(' '))
  check('I18 速度计算不产生 NaN / Infinity（除零路径有守卫）',
    (() => {
      const card = textOf(usageCardOf(tree)).join(' ')
      return !card.includes('NaN') && !card.includes('Infinity')
    })(),
    textOf(usageCardOf(tree)).join(' ').slice(0, 120))

  // I19：模型行存在但无流式耗时（ms=0，如纯非流式流量）——真正走到 tps=null 的分支。
  // 断言显示「—」而不是 0 —— 把「没有数据」说成「速度 0」是错误信息。
  {
    const zeroPayload = {
      plugin: MODULE_ID, version: PLUGIN_VERSION, updatedAt: Date.now(),
      models: [{ id: 'z-ai/glm-5.3-flash', lastUsedAt: Date.now() }],
      currentModel: 'z-ai/glm-5.3-flash',
      totals: { poolSize: 1, clineRequests: 0, rotations: 0, failFasts: 0 },
      keys: [{
        index: 1, label: 'aa11bb22', preview: MASK_A, source: 'request', cooling: [],
        stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: Date.now(), tokens: {} },
        models: { 'z-ai/glm-5.3-flash': { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: Date.now(), tokens: { input: 0, output: 0, total: 0, cached: 0, ms: 0 } } },
      }],
      recent: [],
    }
    const zero = await renderPanel(zeroPayload)
    const zeroText = textOf(usageCardOf(zero.tree)).join(' ')
    check('I19 没有耗时数据的行速度显示「—」而不是 0（不把「没数据」说成「速度 0」）',
      zeroText.includes('—') && !zeroText.includes('NaN'), zeroText)
    zero.bundle.mini.dispose()
  }

  bundle.mini.dispose()
}

// ───────────────────────── 6. 面板的退化路径 ─────────────────────────
// ────────────────────── 5c. 导入入口：按钮 → 弹窗 → POST ──────────────────────
// 浏览器半边这条链路的每一步都要走一遍：按钮长在版本卡右边、点开是粘贴框、
// 提交发出一次 JSON POST、结果以摘要收口（只出现 ref / 标签 / 掩码，没有 Key 原文）。
{
  const bundle = loadClientBundle()
  const calls = []
  const payload = {
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
    models: [{ id: 'cline-free/deepseek-v4.1-flash', lastUsedAt: 0 }],
    currentModel: 'cline-free/deepseek-v4.1-flash',
    totals: { poolSize: 1, clineRequests: 0, rotations: 0, failFasts: 0, since: Date.now() - 3600_000 },
    keys: [{ index: 1, label: 'db694bbf', preview: 'sk_c…ead1', source: 'request', cooling: [], stats: { sent: 0, ok: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} }],
    recent: [],
  }
  const importReply = {
    ok: true, writeMode: 'credentials',
    imported: [{ ref: 'CLINE_API_KEY_2', label: '1c4dd756', preview: 'sk-i…4444' }],
    duplicates: [], rejected: [], failed: [], refsFree: 7, poolSize: 2, maxKeys: 20,
  }
  const resetReply = { ok: true, since: Date.now(), totals: { since: Date.now(), clineRequests: 0, rotations: 0, failFasts: 0 }, poolSize: 1 }
  // 桩要忠实于真实 Response：headers.get 必须可用（面板会读 etag 做条件请求）
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"test-etag"' : null) },
    json: async () => body,
  })
  bundle.sandbox.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url, method, headers: (init && init.headers) || {}, body: init && init.body })
    if (url === CLIENT_RESET_ROUTE) return jsonResponse(resetReply)
    if (method === 'POST') return jsonResponse(importReply)
    return jsonResponse(payload)
  }

  const registered = []
  const slots = {
    inject: (name, cb) => cb(),
    register: (options, Component) => { registered.push({ options, Component }); return () => {} },
  }
  bundle.exports.apply({ get: (name) => (name === 'slots' ? slots : undefined), inject: () => undefined })
  const Component = registered[0].Component

  let tree = await bundle.mini.render(Component, {})
  const importButton = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === '导入 Key')
  check('N1 版本卡右边有「导入 Key」按钮', Boolean(importButton))
  const statsRow = findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_stats')
  const statsText = statsRow ? textOf(statsRow) : []
  check('N2 按钮排在版本卡右侧（统计行末尾）', statsText[statsText.length - 1] === '导入 Key' && statsText.includes(PLUGIN_VERSION), statsText.join(' | '))
  check('N3 没点开时不渲染弹窗', !findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_dialog'))

  importButton.props.onClick()
  tree = await bundle.mini.render(Component, {})
  const dialog = findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_dialog')
  check('N4 点开后是导入弹窗（标题 + 粘贴框 + 取消/导入）',
    Boolean(dialog) && textOf(dialog).join(' | ').includes('导入 Cline Key') && Boolean(findNode(dialog, (n) => n.type === 'textarea')) && textOf(dialog).includes('取消'),
    dialog ? textOf(dialog).join(' | ').slice(0, 90) : 'no dialog')

  const textarea = findNode(dialog, (n) => n.type === 'textarea')
  textarea.props.onChange({ target: { value: SECRET_C } })
  tree = await bundle.mini.render(Component, {})
  const confirm = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === '导入')
  const pending = confirm.props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  if (pending && typeof pending.then === 'function') await pending
  tree = await bundle.mini.render(Component, {})

  const post = calls.find((c) => c.method === 'POST')
  check('N5 提交后向导入路由发一次 JSON POST',
    post?.url === CLIENT_IMPORT_ROUTE && post?.headers['content-type'] === 'application/json' && JSON.parse(post.body).keys === SECRET_C,
    post ? `${post.url} ${post.headers['content-type']}` : 'no POST')
  const summary = findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_import_summary')
  check('N6 结果以摘要收口并列出落到的 ref', Boolean(summary) && textOf(summary).join(' | ').includes('CLINE_API_KEY_2'), summary ? textOf(summary).join(' | ') : 'no summary')
  check('N7 导入成功后自动重拉一次面板数据', calls.filter((c) => c.method === 'GET').length >= 2, `GET=${calls.filter((c) => c.method === 'GET').length}`)
  check('N8 渲染树里不出现 Key 原文', !JSON.stringify(tree).includes(SECRET_C))

  const escListeners = bundle.keyListeners.get('keydown') ?? []
  check('N9 弹窗打开时注册了 Esc 监听', escListeners.length >= 1, `listeners=${escListeners.length}`)
  for (const fn of escListeners) fn({ key: 'Escape' })
  tree = await bundle.mini.render(Component, {})
  check('N10 Esc 能关掉弹窗', !findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_dialog'))

  const panelText = textOf(tree).join(' | ')
  check('N11 面板给出累计统计的起点（说明跨重启保留）', panelText.includes('统计自') && panelText.includes('跨重启保留'), panelText.split(' | ').filter((x) => x.includes('统计自')).join(''))

  const resetButton = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === '重置统计')
  check('N12 顶部有「重置统计」按钮', Boolean(resetButton))
  const armedPromise = resetButton ? resetButton.props.onClick() : undefined
  if (armedPromise && typeof armedPromise.then === 'function') await armedPromise
  tree = await bundle.mini.render(Component, {})
  const confirmButton = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === '确认重置')
  check('N13 第一次点击只变成「确认重置」（两段式，防误触）',
    Boolean(confirmButton) && !calls.some((c) => c.url === CLIENT_RESET_ROUTE),
    calls.map((c) => c.url).join(' | '))
  const pendingReset = confirmButton ? confirmButton.props.onClick() : undefined
  await new Promise((r) => setTimeout(r, 20))
  if (pendingReset && typeof pendingReset.then === 'function') await pendingReset
  tree = await bundle.mini.render(Component, {})
  const resetCall = calls.find((c) => c.url === CLIENT_RESET_ROUTE)
  check('N14 第二次点击才真的 POST 重置统计',
    Boolean(resetCall) && resetCall.method === 'POST' && resetCall.headers['content-type'] === 'application/json',
    resetCall ? resetCall.method + ' ' + resetCall.headers['content-type'] : 'no POST')
  check('N15 重置后有结果提示并自动重拉数据', textOf(tree).join(' | ').includes('统计已重置'), textOf(tree).split ? '' : '')
  bundle.mini.dispose()
}

// ──────────────── 5d. 选定「使用中」的 Key：按模型独立，按钮 → POST → 徽标切换 ────────────────
// 表格最后一列「使用」：点一下就把这把设为**当前模型**上「使用中」的那把（该模型的首发送
// 优先用它），再点一次取消。这一组把整条链路走一遍——按钮存在、点击发出一次 JSON POST
// （带上模型名）、成功后重拉、徽标跟着当前模型切换。
{
  const MODEL_A = 'cline-free/deepseek-v4.1-flash'
  const MODEL_B = 'z-ai/glm-5.3-flash'
  const bundle = loadClientBundle()
  const calls = []
  const payload = {
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    models: [{ id: MODEL_A, lastUsedAt: 0 }, { id: MODEL_B, lastUsedAt: 0 }],
    currentModel: MODEL_A,
    totals: { poolSize: 2, clineRequests: 3, rotations: 1, failFasts: 0, since: Date.now() - 3600_000 },
    keys: [
      { index: 1, label: 'db694bbf', preview: 'sk_c…ead1', source: 'request', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} },
      { index: 2, label: '761f9875', preview: 'sk_t…8888', source: '.credentials.yaml: CLINE_API_KEY_2', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} },
    ],
    // 两个模型各选一把：面板只该点亮**当前模型**（MODEL_A）选中的那把
    selection: { [MODEL_A]: '761f9875', [MODEL_B]: 'db694bbf' },
    recent: [],
  }
  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"select-etag"' : null) },
    json: async () => body,
  })
  const selectReply = { ok: true, model: MODEL_A, selection: { label: 'db694bbf' } }
  bundle.sandbox.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET'
    calls.push({ url, method, headers: (init && init.headers) || {}, body: init && init.body })
    return jsonResponse(url === CLIENT_SELECT_ROUTE ? selectReply : payload)
  }

  const registered = []
  const slots = {
    inject: (name, cb) => cb(),
    register: (options, Component) => { registered.push({ options, Component }); return () => {} },
  }
  bundle.exports.apply({ get: (name) => (name === 'slots' ? slots : undefined), inject: () => undefined })
  const Component = registered[0].Component
  let tree = await bundle.mini.render(Component, {})

  const collectUseButtons = (node, out = []) => {
    if (!node || typeof node !== 'object') return out
    if (Array.isArray(node)) {
      for (const child of node) collectUseButtons(child, out)
      return out
    }
    if (String(node.props?.className ?? '').includes('_dsh_ofb_usebtn')) out.push(node)
    for (const child of node.children ?? []) collectUseButtons(child, out)
    return out
  }
  const headers = table_headers(tree)
  let useButtons = collectUseButtons(tree)
  check('X1 表格末尾有「使用」列，每行一个按钮（且第 5 列已是上游渠道）',
    headers.join('|') === '#|Key|状态|冷却 / 恢复|上游渠道|最近使用|使用' && useButtons.length === 2,
    `${headers.join('|')} buttons=${useButtons.length}`)
  const activeButton = useButtons.find((n) => String(n.props.className).includes('_on'))
  check('X2 当前模型选中的那把显示「使用中」并带 aria-pressed（其余显示「使用」）',
    Boolean(activeButton) && textOf(activeButton).join('') === '使用中' && activeButton.props['aria-pressed'] === 'true' &&
      useButtons.some((n) => textOf(n).join('') === '使用'),
    useButtons.map((n) => textOf(n).join('')).join(' | '))

  // 点当前模型视图里未选中的那把 → POST 它的标签（带上模型名）
  const passive = useButtons.find((n) => !String(n.props.className).includes('_on'))
  const pending = passive.props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  if (pending && typeof pending.then === 'function') await pending
  tree = await bundle.mini.render(Component, {})
  const post = calls.find((c) => c.method === 'POST')
  check('X3 点击发出一次 JSON POST（模型名 + 这把的 8 位标签）',
    post?.url === CLIENT_SELECT_ROUTE && post?.headers['content-type'] === 'application/json' &&
      JSON.parse(post.body).model === MODEL_A && JSON.parse(post.body).label === 'db694bbf',
    post ? `${post.url} ${post.body}` : 'no POST')
  check('X4 成功后自动重拉面板数据（不必等 5 秒轮询）',
    calls.filter((c) => c.method === 'GET').length >= 2, `GET=${calls.filter((c) => c.method === 'GET').length}`)

  // 再点「使用中」那把 → 发空标签（取消该模型的选定）
  useButtons = collectUseButtons(tree)
  const activeAgain = useButtons.find((n) => String(n.props.className).includes('_on'))
  const clearPending = activeAgain ? activeAgain.props.onClick() : undefined
  await new Promise((r) => setTimeout(r, 20))
  if (clearPending && typeof clearPending.then === 'function') await clearPending
  const posts = calls.filter((c) => c.method === 'POST')
  check('X5 再点「使用中」发出空标签（取消当前模型的选定）',
    posts.length === 2 && JSON.parse(posts[1].body).model === MODEL_A && JSON.parse(posts[1].body).label === '',
    posts.map((c) => String(c.body)).join(' ; '))
  check('X6 渲染树里不出现 Key 原文', !JSON.stringify(tree).includes(SECRET_A) && !JSON.stringify(tree).includes(SECRET_B))

  // 切到另一个模型的芯片：徽标跟着当前模型走（选定按模型独立）
  const chip = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === 'glm-5.3-flash')
  if (chip) chip.props.onClick()
  tree = await bundle.mini.render(Component, {})
  const switchedButtons = collectUseButtons(tree)
  const switchedActive = switchedButtons.find((n) => String(n.props.className).includes('_on'))
  check('X7 切到另一个模型后，点亮的是它自己选中的那把（第 1 行 db694bbf）',
    Boolean(chip) && Boolean(switchedActive) &&
      textOf(switchedActive).join('') === '使用中' &&
      switchedButtons.indexOf(switchedActive) === 0,
    switchedButtons.map((n) => textOf(n).join('')).join(' | '))
  bundle.mini.dispose()
}

{
  // 面板还不知道有哪些模型（配置读到之前就打开了设置页）：按钮禁用并说明原因，
  // 而不是发出一次注定 400 的请求（选定必须落在某个模型上）。
  const noModel = await renderPanel({
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    models: [],
    currentModel: '',
    totals: { poolSize: 1, clineRequests: 0, rotations: 0, failFasts: 0, since: Date.now() },
    keys: [{ index: 1, label: 'db694bbf', preview: 'sk_c…ead1', source: 'request', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} }],
    selection: {},
    recent: [],
  })
  const button = findNode(noModel.tree, (n) => String(n.props?.className ?? '').includes('_dsh_ofb_usebtn'))
  check('X8 还不知道有哪些模型时「使用」按钮禁用并说明原因',
    Boolean(button) && button.props.disabled === true && String(button.props.title).includes('模型'),
    button ? `disabled=${button.props.disabled} title=${button.props.title}` : 'no button')
  noModel.bundle.mini.dispose()
}

{
  // 选定的 Key 已不在池中（凭据被删）：面板要给出提示，而不是让徽标凭空消失
  const missing = await renderPanel({
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    models: [{ id: 'cline-free/deepseek-v4.1-flash', lastUsedAt: 0 }],
    currentModel: 'cline-free/deepseek-v4.1-flash',
    totals: { poolSize: 1, clineRequests: 0, rotations: 0, failFasts: 0, since: Date.now() },
    keys: [{ index: 1, label: 'db694bbf', preview: 'sk_c…ead1', source: 'request', cooling: [], stats: { sent: 0, ok: 0, failed: 0, limited: 0, lastUsedAt: 0, tokens: {} }, models: {} }],
    selection: { 'cline-free/deepseek-v4.1-flash': 'aaaaaaaa' },
    recent: [],
  })
  const missingText = textOf(missing.tree).join('\n')
  check('X9 本模型选定的 Key 已不在池中时给出提示（且没有任何行被点亮）',
    missingText.includes('本模型选定的 Key 已不在池中') &&
      !findNode(missing.tree, (n) => String(n.props?.className ?? '').includes('_dsh_ofb_usebtn_on')),
    missingText.split('\n').filter((s) => s.includes('不在池中')).join(''))
  missing.bundle.mini.dispose()
}

{
  // 空池：应给出空态而不是空白
  const empty = await renderPanel({
    plugin: MODULE_ID, version: PLUGIN_VERSION, updatedAt: Date.now(),
    totals: { poolSize: 0, readyKeys: 0, coolingKeys: 0 }, extras: {}, keys: [], recent: [],
  })
  const emptyText = textOf(empty.tree).join('\n')
  check('C22 空池时显示空态引导', emptyText.includes('还没有捕获到 Cline Key'), emptyText.slice(0, 40))
  check('C23 空池时仍然给出刷新入口', emptyText.includes('刷新'))
  empty.bundle.mini.dispose()

  // 请求失败且还没有任何数据：显示错误
  const failed = await renderPanel({}, { fetchError: 'HTTP 500' })
  const failedText = textOf(failed.tree).join('\n')
  check('C24 路由读取失败时显示错误而不崩', failedText.includes('读取 Key 池状态失败') && failedText.includes('HTTP 500'), failedText.slice(0, 40))
  failed.bundle.mini.dispose()

  // locale 服务缺席时仍要注册座位（文案退回模块级字典）
  const bundle = loadClientBundle()
  const registered = []
  bundle.exports.apply({
    get: (name) => (name === 'slots' ? { inject: (n, cb) => cb(), register: (o) => { registered.push(o); return () => {} } } : undefined),
    // 故意提供 inject 但永不回调（模拟 locale 服务缺席）
    inject: () => undefined,
  })
  check('C25 locale 缺席时面板仍然注册（非门控）', registered.length === 1 && registered[0].id === MODULE_ID)
  bundle.mini.dispose()
}

// ───────────────────── 6b. 英文界面无中文残留 ──────────────────────
// 面板跟随 DSH 的语言设置，但渲染代码里**绕过词典**的中文字面量很容易漏网：
// token 占比条的悬停提示、导入摘要里 ref 之间的连接符都这么漏过——它们不在文本节点上
// 或只在某个弹窗里，靠「看一眼中文面板」永远发现不了。这里用 en-US 渲染一遍**带数据**的
// 面板，并在导入弹窗里真的走一次提交，断言整棵树（文本 + 属性）里没有 CJK 字符。
{
  const enPayload = {
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    models: [{ id: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() }],
    currentModel: 'cline-free/deepseek-v4.1-flash',
    totals: { poolSize: 1, clineRequests: 12, rotations: 3, failFasts: 1, since: Date.now() - 86400_000 },
    keys: [
      {
        index: 1,
        label: 'db694bbf',
        preview: 'sk_c…ead1',
        source: 'request',
        cooling: [{ model: 'cline-free/deepseek-v4.1-flash', readyAt: Date.now() + 3600_000, readyInMin: 60 }],
        stats: { sent: 3, ok: 2, failed: 1, limited: 1, lastModel: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() - 5000, tokens: { input: 1200, output: 340 } },
        models: {
          'cline-free/deepseek-v4.1-flash': { sent: 3, ok: 2, failed: 1, limited: 1, lastUsedAt: Date.now() - 5000, tokens: { input: 1200, output: 340 } },
        },
      },
    ],
    selection: { 'cline-free/deepseek-v4.1-flash': 'db694bbf' },
    recent: [{ at: new Date().toISOString(), model: 'cline-free/deepseek-v4.1-flash', decision: 'pass-through status=200' }],
  }

  const panel = await renderPanel(enPayload, { locale: 'en-US' })
  let tree = panel.tree
  const cjk = visibleStringsOf(tree).filter((text) => /[\u4e00-\u9fff]/.test(text))
  check('Z1 英文界面整棵树（含 title 等属性）里没有中文字面量', cjk.length === 0, cjk.join(' | ').slice(0, 140))

  // 摘要里的 ref 连接符也要跟着语言走（中文用「、」、英文用逗号），且原因码文案是英文。
  const importReply = {
    ok: true,
    writeMode: 'credentials',
    imported: [
      { ref: 'CLINE_API_KEY_2', label: '1c4dd756', preview: 'sk-i…4444' },
      { ref: 'CLINE_API_KEY_3', label: '9f2c1ab0', preview: 'sk-t…8888' },
    ],
    duplicates: [],
    rejected: [{ preview: 'ab…cd', reason: 'too-short' }],
    failed: [],
    refsFree: 5,
    refsUnknown: ['CLINE_API_KEY_4'],
    poolSize: 3,
    maxKeys: 20,
  }
  panel.bundle.sandbox.fetch = async (url, init) => {
    const body = (init && init.method) === 'POST' ? importReply : enPayload
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? '"en-etag"' : null) },
      json: async () => body,
    }
  }

  const Component = panel.registered[0].Component
  const importButton = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === 'Import keys')
  importButton.props.onClick()
  tree = await panel.bundle.mini.render(Component, {})
  const textarea = findNode(tree, (n) => n.type === 'textarea')
  textarea.props.onChange({ target: { value: 'sk-en-locale-check-123456' } })
  tree = await panel.bundle.mini.render(Component, {})
  const confirm = findNode(tree, (n) => n.type === 'button' && textOf(n).join('') === 'Import')
  const pending = confirm.props.onClick()
  await new Promise((r) => setTimeout(r, 20))
  if (pending && typeof pending.then === 'function') await pending
  tree = await panel.bundle.mini.render(Component, {})

  const summary = findNode(tree, (n) => n.props && n.props.className === '_dsh_ofb_import_summary')
  const summaryText = textOf(summary ?? {}).join(' | ')
  check('Z2 英文界面导入摘要：ref 用逗号连接、原因码也是英文，且无中文残留',
    Boolean(summary) && summaryText.includes('CLINE_API_KEY_2, CLINE_API_KEY_3') && summaryText.includes('too short') &&
      !/[\u4e00-\u9fff]/.test(JSON.stringify(summary)),
    summaryText.slice(0, 140))
  check('Z3 摘要带出「状态不明槽位已跳过」一行（英文文案 + ref 名）',
    summaryText.includes('could not read') && summaryText.includes('CLINE_API_KEY_4'),
    summaryText.slice(0, 200))
  panel.bundle.mini.dispose()
}

// ───────────────────────── 7. 清单与 bundle 的契约 ─────────────────────────
// 浏览器半边只有在 package.json 的 dsh.client 声明、./client 导出、以及 Loader
// 条目名三者对齐时才会被 dsh-client-modules 打包投放。这一组断言就是防止
// 「面板代码写好了但根本没被装载」这种静默失败。
{
  const manifest = MANIFEST
  const clientRel = manifest.exports?.['./client']
  const clientAbs = new URL(`../${String(clientRel).replace(/^\.\//, '')}`, import.meta.url)

  check('M1 package.json 声明了 dsh.client 且 platform=web', manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client ?? null))
  check('M2 ./client 导出指向真实存在的文件', Boolean(clientRel) && existsSync(clientAbs), String(clientRel))
  check('M3 测试加载的正是 ./client 导出的那份文件', clientAbs.href === new URL('../lib/client.js', import.meta.url).href, clientAbs.pathname)
  check('M4 dsh.client.inject 覆盖 slots / locale / modules 三个供应方',
    ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-modules']
      .every((name) => (manifest.dsh?.client?.inject ?? []).includes(name)),
    JSON.stringify(manifest.dsh?.client?.inject ?? []))
  check('M5 bundle patch 存在', Boolean(manifest.dsh?.bundle?.patch) && existsSync(new URL('../cordis.patch.yml', import.meta.url)), String(manifest.dsh?.bundle?.patch))

  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const entryMatch = /name:\s*'?([^'\s]+)'?/.exec(patch)
  check('M6 Loader 条目名 == 包名（client-modules 靠它识别浏览器模块）', entryMatch?.[1] === manifest.name, `${entryMatch?.[1]} vs ${manifest.name}`)

  const bundle = loadClientBundle()
  check('M7 bundle 自报的 id == 包名', bundle.id === manifest.name, `${bundle.id} vs ${manifest.name}`)
  check('M8 主机半边入口存在', existsSync(new URL('../index.js', import.meta.url)))
  // 版本号有两个来源：package.json（清单）与 defaults.js 的主机端常量（随载荷下发到面板，
  // 也是诊断里的 pluginVersion）。两处不一致时，用户在面板上看到的版本就是错的。
  check('M9 主机端 PLUGIN_VERSION 与 package.json 的 version 一致', HOST_VERSION === manifest.version, `${HOST_VERSION} vs ${manifest.version}`)
  mount({})
  check('M9b 只读载荷下发的 version 就是主机端那个常量', ctxStatusOf()?.version === HOST_VERSION, String(ctxStatusOf()?.version))
  dispose()
  bundle.mini.dispose()
}

// ───────────────── 5e. 上游信息只在 Key 表里出现，芯片上不重复 ─────────────────
// 上游原先在模型芯片上挂了一枚徽标，用户指出「渠道来源不应该在这个位置重复出现」——
// Key 表的「上游渠道」列已经按 key 逐个显示，芯片上再标一次是同一信息两处。
// 这一组就钉住「只在 Key 表里出现」，并保留警示色的语义。
{
  const PINNED = 'cline-free/deepseek-v4.1-flash'
  const baseKey = (upstream) => ({
    index: 1, label: 'db694bbf', preview: MASK_A, source: 'request',
    cooling: [],
    stats: { sent: 1, ok: 1, failed: 0, limited: 0, lastUsedAt: Date.now(), tokens: {} },
    models: {
      [PINNED]: {
        sent: 1, ok: 1, failed: 0, limited: 0, lastUsedAt: Date.now(),
        tokens: { input: 1000, output: 10, total: 1010, cached: 500 },
        ...(upstream ? { upstream: { provider: upstream, fallbacks: 15, at: Date.now() } } : {}),
      },
    },
  })
  const payloadWith = (upstream, preferred = 'deepseek') => ({
    plugin: MODULE_ID,
    version: PLUGIN_VERSION,
    updatedAt: Date.now(),
    models: [{ id: PINNED, lastUsedAt: Date.now(), upstream: { provider: preferred, preferred, fallbacks: 15, at: Date.now(), stale: false, other: false } }],
    currentModel: PINNED,
    totals: { poolSize: 1, clineRequests: 1, rotations: 0, failFasts: 0 },
    keys: [baseKey(upstream)],
  })
  const badgeOf = (tree) => findNode(tree, (n) => String(n.props?.className ?? '').includes('_dsh_ofb_pin'))
  const upstreamCellOf = (tree) => {
    const body = findNode(tree, (n) => n.type === 'tbody')
    const row = (body?.children ?? [])[0]
    return (row?.children ?? [])[4]
  }

  // 1) 芯片上不再有上游徽标——无论有没有观测数据
  {
    const { tree, bundle } = await renderPanel(payloadWith('deepseek'))
    check('PB1 模型芯片上不再挂上游徽标（渠道来源不在这个位置重复出现）',
      badgeOf(tree) === undefined)
    check('PB2 芯片仍然只有模型名（筛选功能不受影响）',
      textOf(findNode(tree, (n) => String(n.props?.className ?? '').includes('_dsh_ofb_chip')) ?? {}).join('') === 'deepseek-v4.1-flash')
    bundle.mini.dispose()
  }

  // 2) 上游只出现在 Key 表的「上游渠道」列
  {
    const { tree, bundle } = await renderPanel(payloadWith('deepseek'))
    const cell = upstreamCellOf(tree)
    check('PB3 上游显示在 Key 表的上游渠道列里',
      textOf(cell ?? {}).join('') === 'deepseek', textOf(cell ?? {}).join(''))
    bundle.mini.dispose()
  }

  // 3) 不是预期上游时该列用警示色（这是用户真正关心的信号）
  {
    const { tree, bundle } = await renderPanel(payloadWith('alibaba'))
    const cell = upstreamCellOf(tree)
    const cls = String(cell?.children?.[0]?.props?.className ?? '')
    check('PB4 漂到非预期上游时该列带警示色类',
      cls.includes('_dsh_ofb_up_other') && textOf(cell ?? {}).join('') === 'alibaba',
      `class=${cls} text=${textOf(cell ?? {}).join('')}`)
    bundle.mini.dispose()
  }

  // 4) 没有观测数据时显示「—」，不猜
  {
    const { tree, bundle } = await renderPanel(payloadWith(undefined))
    const cell = upstreamCellOf(tree)
    check('PB5 没有观测数据时该列显示「—」（不猜上游）',
      textOf(cell ?? {}).join('') === '—' && badgeOf(tree) === undefined,
      textOf(cell ?? {}).join(''))
    bundle.mini.dispose()
  }

  // 5) 英文界面：表头走词典，无中文残留
  {
    const { tree, bundle } = await renderPanel(payloadWith('alibaba'), { locale: 'en-US' })
    const headers = findNode(tree, (n) => n.type === 'thead')
    const headerText = textOf(headers ?? {}).join('|')
    check('PB6 英文界面表头是 Upstream（无中文残留）',
      headerText.includes('Upstream') && !/[\u4e00-\u9fa5]/.test(headerText), headerText)
    bundle.mini.dispose()
  }
}

rmSync(TEST_STATE_DIR, { recursive: true, force: true })

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.length} 项`)
// 注意：这里**不能**用 process.exit()——本文件用了 node:vm 上下文，
// 在 vm 的 microtask 队列还有挂起工作时强杀进程会触发 libuv 的
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`（Windows 上必现），
// 于是「全部通过」也会变成退出码 1。改用 exitCode 让 Node 自然收尾。
process.exitCode = failed === 0 ? 0 : 1
