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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'
import { apply } from '../index.js'

const TEST_STATE_DIR = join(tmpdir(), `ofb-panel-state-${process.pid}`)
mkdirSync(TEST_STATE_DIR, { recursive: true })
let stateSeq = 0

const results = []
const check = (label, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

// key 原文只出现在这两个常量里；任何输出都不得包含它们
const SECRET_A = 'sk-live-AAAA1111BBBB2222CCCC3333DDDD4444'
const SECRET_B = 'sk-test-EEEE5555FFFF6666GGGG7777HHHH8888'
const MASK_A = `${SECRET_A.slice(0, 4)}…${SECRET_A.slice(-4)}`
const MASK_B = `${SECRET_B.slice(0, 4)}…${SECRET_B.slice(-4)}`

// ───────────────────────── mock Cline 上游 ─────────────────────────
const seen = []
const server = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    let model = '?'
    try { model = JSON.parse(body).model ?? '?' } catch {}
    seen.push({ key, model })
    if (key === SECRET_B) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
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
const routes = []

/** 挂载插件，并把 ctx.inject(['webServer'], ...) 里的路由捕获下来。 */
function mount(config = {}) {
  dispose()
  routes.length = 0
  const ctx = {
    on: (event, fn) => { if (event === 'dispose') dispose = fn },
    logger: { warn: () => {} },
    get: () => undefined,
    // DSH 真实 ctx 上的子 fiber 等待模式
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('webServer')) return undefined
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
    credentialsFile: join(TEST_STATE_DIR, 'no-such-credentials.yaml'),
    quotaStatePath: join(TEST_STATE_DIR, `state-${++stateSeq}.json`),
    ...config,
  }
  apply(ctx, merged)
  return ctx
}

const fakeReq = ({ method = 'GET', referer = 'http://127.0.0.1:3080/settings', host = '127.0.0.1:3080' } = {}) => ({
  method,
  headers: { host, referer },
})
const fakeRes = () => {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.statusCode = status; res.headers = headers || {} },
    end(body) { if (body !== undefined) res.body += String(body) },
  }
  return res
}
const callRoute = async (options) => {
  const route = routes[0]
  if (!route) throw new Error('route not registered')
  const res = fakeRes()
  await route.handler(fakeReq(options), res)
  let json
  try { json = JSON.parse(res.body) } catch { json = undefined }
  return { route, status: res.statusCode, headers: res.headers, body: res.body, json }
}

// ───────────────────────── 1. 路由注册与契约 ─────────────────────────
{
  mount({ skipCoolingRequestKey: true })
  check('H1 只在 ctx.inject([\'webServer\']) 里注册路由（不门控整个插件）', routes.length === 1, `routes=${routes.length}`)
  check('H2 路由是 exact 匹配且路径固定', routes[0]?.kind === 'exact' && routes[0]?.path === '/opencode-free-bridge/cline-keys', `${routes[0]?.kind} ${routes[0]?.path}`)

  const ok = await callRoute()
  check('H3 同源 GET 返回 200 JSON', ok.status === 200 && ok.json?.plugin === 'opencode-free-bridge', `status=${ok.status}`)
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
  check('H17 ctx.__opencodeFreeBridge.status() 与路由载荷一致', ctx.__opencodeFreeBridge.status().plugin === 'opencode-free-bridge')
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
  check('H23 首个请求用的 key 被标为 DSH 主 key', keys.some((k) => k.isRequestKey === true))
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
  ctx.__opencodeFreeBridge.flushQuotaState()
  const disk = readFileSync(statePath, 'utf8')
  check('H25 磁盘状态文件不含 key 原文', !disk.includes(SECRET_A) && !disk.includes(SECRET_B))
  check('H26 磁盘状态文件连掩码片段也不含', !disk.includes(SECRET_A.slice(0, 4) + '…') && !disk.includes(MASK_A), disk.slice(0, 60))
  check('H27 磁盘状态文件里只有哈希标签', /"entries":\{"[0-9a-f]{8}"/.test(disk))
}

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
      return { type, props: props || {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }
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

const CLIENT_SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const MODULE_ID = 'opencode-free-bridge'
const ROUTE = '/opencode-free-bridge/cline-keys'

/** 把客户端半边装进 vm 沙箱，返回它的模块导出。 */
function loadClientBundle() {
  let captured
  const styleTags = []
  const mini = createMiniReact()
  const sandbox = {
    console,
    window: { __ModuleLoader__: { load: (definition) => { captured = definition } } },
    document: {
      head: { appendChild: (el) => styleTags.push(el) },
      getElementById: () => null,
      hidden: false,
      createElement: () => ({ dataset: {}, textContent: '', id: '' }),
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
  return { exports: exportsObj, sandbox, mini, styleTags, id: captured.id, load: captured }
}

/** 用给定的路由载荷渲染一次面板，返回渲染树与插槽注册信息。 */
async function renderPanel(payload, { fetchError = null } = {}) {
  const bundle = loadClientBundle()
  const registered = []
  const dictionaries = []
  const registeredSchemas = []

  // 每次渲染前替换 sandbox 的 fetch
  bundle.sandbox.fetch = async () => {
    if (fetchError) throw new Error(fetchError)
    return { ok: true, status: 200, json: async () => payload }
  }

  const slots = {
    inject: (name, cb) => { registeredSchemas.push(name); return cb() },
    register: (options, Component) => { registered.push({ options, Component }); return () => {} },
  }
  const ctx = {
    get: (name) => (name === 'slots' ? slots : undefined),
    inject: (deps, callback) => {
      if (!Array.isArray(deps) || !deps.includes('locale')) return undefined
      return callback({
        get: () => ({
          register: (ns, locale) => { dictionaries.push([ns, locale]); return () => {} },
          getSnapshot: () => ({ active: 'zh-CN' }),
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
    version: '1.6.0',
    updatedAt: Date.now(),
    settings: {
      clineMatch: 'cline.bot', clineCooldownMs: 900000, failFastMinMs: 300000,
      skipCoolingRequestKey: true, allCoolingFailFast: true, rotateStatuses: [429],
      maskKeyPreview: true, readCredentialsFile: true,
      credentialsFile: 'C:/Users/x/.dsh/.credentials.yaml', clineKeyRefs: ['CLINE_API_KEY_2'],
    },
    quotaStatePath: 'C:/Users/x/.dsh/.opencode-free-bridge-cline-quota.json',
    totals: { poolSize: 2, readyKeys: 1, coolingKeys: 1, clineRequests: 61, rotations: 3, failFasts: 1 },
    extras: { credentialsFileRead: true, extrasResolved: true, lastExtrasAt: '2026-09-17T07:45:16.602Z' },
    lastDecision: 'rotated 983d80c1→953d7c08 model=cline-free/deepseek-v4.1-flash',
    keys: [
      { index: 1, label: 'db694bbf', preview: MASK_A, source: 'request', isRequestKey: true,
        cooling: [{ model: 'cline-free/deepseek-v4.1-flash', readyAt: Date.now() + 21 * 3600 * 1000, readyInMin: 1300 }],
        stats: { sent: 12, ok: 11, limited: 1, lastModel: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() - 5000 } },
      { index: 2, label: '761f9875', preview: MASK_B, source: '.credentials.yaml: CLINE_API_KEY_2', isRequestKey: false,
        cooling: [], stats: { sent: 4, ok: 4, limited: 0, lastModel: 'cline-free/deepseek-v4.1-flash', lastUsedAt: Date.now() - 61000 } },
    ],
    recent: [{ at: new Date().toISOString(), model: 'cline-free/deepseek-v4.1-flash', decision: 'rotated a→b', bodyLen: 413503, poolSize: 2 }],
  }

  const { registered, dictionaries, tree, bundle } = await renderPanel(payload)
  const text = textOf(tree).join('\n')
  const serialized = JSON.stringify(tree)

  check('C1 bundle id 与 package.json name 一致', bundle.id === MODULE_ID, bundle.id)
  check('C2 声明了 slots 依赖', Array.isArray(bundle.exports.inject) && bundle.exports.inject.includes('slots'), JSON.stringify(bundle.exports.inject))
  check('C3 注册进 settings.section 座位', registered.length === 1 && registered[0].options.name === 'settings.section', JSON.stringify(registered.map((r) => r.options?.name)))
  check('C4 座位 id/order/locale 齐备', registered[0].options.id === MODULE_ID && typeof registered[0].options.order === 'number' && registered[0].options.locale === 'opencodeFreeBridge', JSON.stringify(registered[0].options))
  check('C5 座位标签是可调用 thunk（切换语言无需重注册）', typeof registered[0].options.label === 'function' && registered[0].options.label() === 'Cline Key', String(registered[0].options.label?.()))
  check('C6 zh/en 两套字典都注册进 DSH locale', dictionaries.length === 2 && dictionaries.some((d) => d[1] === 'zh') && dictionaries.some((d) => d[1] === 'en'), JSON.stringify(dictionaries.map((d) => d[1])))
  check('C7 样式只注入一次 <style> 并带 plugin 标记', bundle.styleTags.length === 1 && bundle.styleTags[0].dataset.plugin === MODULE_ID, `tags=${bundle.styleTags.length}`)

  check('C8 渲染出标题', text.includes('Cline Key 使用情况'), text.split('\n').slice(0, 3).join(' / '))
  check('C9 渲染出两把 key 的掩码预览', text.includes(MASK_A) && text.includes(MASK_B))
  check('C10 渲染树里不含任何 key 原文', !serialized.includes(SECRET_A) && !serialized.includes(SECRET_B))
  check('C11 渲染出哈希标签', text.includes('db694bbf') && text.includes('761f9875'))
  check('C12 渲染出冷却模型与恢复倒计时', text.includes('cline-free/deepseek-v4.1-flash') && /2[01]h\d\dm/.test(text), (/[0-9]+h[0-9]{2}m/.exec(text) ?? ['none'])[0])
  check('C13 渲染出状态药丸（可用/冷却中）', text.includes('冷却中') && text.includes('可用'))
  check('C14 渲染出来源标签（DSH 主 Key / 凭据文件 ref）', text.includes('DSH 请求头') && text.includes('.credentials.yaml: CLINE_API_KEY_2'))
  check('C15 渲染出用量计数 发送/成功/限流', text.includes('12 / 11 / 1') && text.includes('4 / 4 / 0'))
  check('C16 渲染出统计卡数值', text.includes('61') && text.includes('1.6.0'))
  check('C17 渲染出最近决策', text.includes('最近决策') && text.includes('rotated a→b'))
  check('C18 渲染出运行参数', text.includes('运行参数') && text.includes('15分钟'))
  check('C19 渲染出掩码说明', text.includes('首尾各 4 位'))
  check('C20 详情卡里出现 key 池表格表头', text.includes('冷却模型 / 恢复') && text.includes('发送 / 成功 / 限流'))

  // 关键 DOM 结构：表格确实有 2 行数据
  const table = findNode(tree, (n) => n.type === 'table')
  const bodyRows = table ? findNode(table, (n) => n.type === 'tbody')?.children?.length : 0
  check('C21 表格渲染出 2 行 key', bodyRows === 2, `rows=${bodyRows}`)

  bundle.mini.dispose()
}

// ───────────────────────── 6. 面板的退化路径 ─────────────────────────
{
  // 空池：应给出空态而不是空白
  const empty = await renderPanel({
    plugin: MODULE_ID, version: '1.6.0', updatedAt: Date.now(),
    settings: { maskKeyPreview: true }, totals: { poolSize: 0, readyKeys: 0, coolingKeys: 0 }, extras: {}, keys: [], recent: [],
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

// ───────────────────────── 7. 清单与 bundle 的契约 ─────────────────────────
// 浏览器半边只有在 package.json 的 dsh.client 声明、./client 导出、以及 Loader
// 条目名三者对齐时才会被 dsh-client-modules 打包投放。这一组断言就是防止
// 「面板代码写好了但根本没被装载」这种静默失败。
{
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
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
  bundle.mini.dispose()
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
