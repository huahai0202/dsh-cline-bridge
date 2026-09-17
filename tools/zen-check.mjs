/**
 * opencode-free-bridge 自检工具
 *
 *   node tools/zen-check.mjs          # 离线断言：插件注入的头部形状 / 透传 / 兜底 / dispose
 *   node tools/zen-check.mjs --live   # additionally 走真实网络，校验 Zen 免费通道是否放行
 *
 * Zen 免费通道的放行规则（2026-09 实测，服务端可能随时调整）：
 *   - x-opencode-session 必须匹配 ses_ + 12 位小写十六进制 + 14 位 base62（总长 30）
 *   - User-Agent 必须包含 opencode/ 前缀
 *   - x-opencode-client / x-opencode-project / x-opencode-request 非必需
 */

const LIVE = process.argv.includes('--live')
const FREE_MODEL = process.env.ZEN_FREE_MODEL || 'mimo-v2.5-free'
const CANONICAL = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const MSG_ID = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const { apply } = await import('../index.js')

const realFetch = globalThis.fetch
const seen = []
let mode = 'capture'

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input))
  seen.push({ url, headers: new Headers(init?.headers ?? input?.headers ?? {}) })
  if (mode === 'capture') return new Response('{"stub":true}', { status: 200 })
  return realFetch(input, init)
}

const beforeApply = globalThis.fetch
let dispose = () => {}
apply({ on: (evt, fn) => { if (evt === 'dispose') dispose = fn } })

const results = []
const check = (label, ok, detail = '') =>
  results.push(`${ok ? 'PASS' : 'FAIL'} | ${label}${detail ? ' | ' + detail : ''}`)

const call = async (headers = {}, url = 'https://opencode.ai/zen/v1/chat/completions') => {
  seen.length = 0
  await globalThis.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' })
  return seen[0]
}

// --- Zen 渠道头部 ---
const h1 = (await call({ 'x-session-affinity': 'pi-abc-123', authorization: 'Bearer public' })).headers
const s1 = h1.get('x-opencode-session')
check('非规范 session 被改写为规范形状', CANONICAL.test(s1 ?? ''), `session=${s1}`)
check('x-opencode-request 为规范 msg_ 形状', MSG_ID.test(h1.get('x-opencode-request') ?? ''), h1.get('x-opencode-request'))
check('User-Agent 含 opencode/ 前缀', (h1.get('user-agent') ?? '').includes('opencode/'), h1.get('user-agent'))
check('x-opencode-client=cli', h1.get('x-opencode-client') === 'cli')
check('x-opencode-project=global', h1.get('x-opencode-project') === 'global')
check('UA 为官方裸形式 opencode/<version>', /^opencode\/[\d.]+$/.test(h1.get('user-agent') ?? ''), h1.get('user-agent'))
check('非 opencode 分支头已剥离 (x-session-affinity)', h1.get('x-session-affinity') === null)
check('非 opencode 分支头已剥离 (x-session-id)', h1.get('x-session-id') === null)

const h2 = (await call({ 'x-session-affinity': 'pi-abc-123' })).headers
check('同一会话稳定复用同一 session', h2.get('x-opencode-session') === s1, `${s1} vs ${h2.get('x-opencode-session')}`)

const h3 = (await call({ 'x-session-affinity': 'pi-xyz-999' })).headers
check('不同会话映射到不同 session', h3.get('x-opencode-session') !== s1)

const good = 'ses_0ad8fca2e001jhR3S20eZCbKzQ'
check('已规范的 session 原样透传', (await call({ 'x-opencode-session': good })).headers.get('x-opencode-session') === good)

const h5 = (await call()).headers
const h6 = (await call()).headers
check('无会话提示时进程内稳定', h5.get('x-opencode-session') === h6.get('x-opencode-session'), h5.get('x-opencode-session'))
check('无会话提示时同为规范形状', CANONICAL.test(h5.get('x-opencode-session') ?? ''))

// --- 鉴权兜底 ---
check('无 Key 自动 Bearer public', h5.get('authorization') === 'Bearer public')
check('真实 Key 不被覆盖', (await call({ authorization: 'Bearer sk-real-key' })).headers.get('authorization') === 'Bearer sk-real-key')
check('空 Key 回退公共通道', (await call({ authorization: 'Bearer' })).headers.get('authorization') === 'Bearer public')
check('误填 URL 回退公共通道', (await call({ authorization: 'https://wrong.example/v1' })).headers.get('authorization') === 'Bearer public')

// --- 其它渠道零副作用 ---
const other = await call({ 'x-session-affinity': 'keep-me' }, 'https://api.deepseek.com/chat/completions')
check('其它渠道不被注入 opencode 头', !other.headers.get('x-opencode-session'))
check('其它渠道原有头不变', other.headers.get('x-session-affinity') === 'keep-me')
check('其它渠道 URL 未被改写', other.url === 'https://api.deepseek.com/chat/completions')

const cline = await call({}, 'https://api.cline.bot/api/v1/chat/completions')
check('Cline 头注入', cline.headers.get('x-client-type') === 'cline-vscode' && cline.headers.get('user-agent') === 'Cline/4.1.16')
check('Cline 渠道不被注入 opencode 头', !cline.headers.get('x-opencode-session'))

// --- 真实网络 ---
const raw = (headers, url, body) =>
  realFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  })

if (LIVE) {
  mode = 'live'
  seen.length = 0
  try {
    const res = await globalThis.fetch('https://opencode.ai/zen/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: FREE_MODEL, messages: [{ role: 'user', content: 'say ok' }], max_tokens: 5 }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    check(`真实 Zen 免费模型放行 (${FREE_MODEL})`, res.ok, `${res.status} ${text.slice(0, 140).replace(/\s+/g, ' ')}`)
    check('实发 session 为规范形状', CANONICAL.test(seen[0]?.headers.get('x-opencode-session') ?? ''), seen[0]?.headers.get('x-opencode-session'))
  } catch (e) {
    check(`真实 Zen 免费模型放行 (${FREE_MODEL})`, false, `${e.name}: ${e.message}`)
  }

  // 门禁仍存在的反证：绕过插件直发非规范 session，应被服务端拒绝。
  // 若此处变为 200，说明服务端规则已放宽，可相应调整 CANONICAL 假设。
  await new Promise((r) => setTimeout(r, 2500))
  try {
    const bad = await raw(
      { 'user-agent': 'opencode/1.18.31', 'x-opencode-session': 'ses_' + 'Z' + 'a'.repeat(25) },
      'https://opencode.ai/zen/v1/chat/completions',
      { model: FREE_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 },
    )
    const t = await bad.text()
    check('服务端仍拒绝非规范 session（门禁未被放宽）', bad.status === 403, `${bad.status} ${t.slice(0, 90).replace(/\s+/g, ' ')}`)
  } catch (e) {
    check('服务端仍拒绝非规范 session（门禁未被放宽）', false, `${e.name}: ${e.message}`)
  }

  // Responses 协议端点（muse-spark-*-free 走 @ai-sdk/openai）同样受门禁约束
  const RESP_MODEL = process.env.ZEN_RESPONSES_MODEL || 'muse-spark-1.2-contributor-free'
  await new Promise((r) => setTimeout(r, 2500))
  try {
    const res = await globalThis.fetch('https://opencode.ai/zen/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: RESP_MODEL, input: 'say ok', max_output_tokens: 16 }),
      signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    check(`/v1/responses 端点放行 (${RESP_MODEL})`, res.ok, `${res.status} ${text.slice(0, 100).replace(/\s+/g, ' ')}`)
  } catch (e) {
    check(`/v1/responses 端点放行 (${RESP_MODEL})`, false, `${e.name}: ${e.message}`)
  }
} else {
  results.push('SKIP | 真实网络检查（加 --live 启用）')
}

// --- dispose ---
dispose()
check('dispose 还原全局 fetch', globalThis.fetch === beforeApply)

console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('FAIL')).length
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} | 共 ${results.filter((r) => !r.startsWith('SKIP')).length} 项`)
process.exit(failed === 0 ? 0 : 1)