export const name = 'opencode-free-bridge'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LOWER_HEX = '0123456789abcdef'

// 严格对齐官方源码 packages/opencode/src/session/llm/request.ts 的 `USER_AGENT`：
//   const USER_AGENT = `opencode/${InstallationVersion}`
// 官方只发 `opencode/<版本号>`，并无 ai-sdk/runtime 之类的后缀（那些是 SDK 或网关侧另行附加的）。
// 实测 Zen 仅校验 UA 中存在 `opencode/` 前缀，故裸写版本号既忠于官方又稳定。
const OPENCODE_UA = 'opencode/1.18.31'

// 官方对 opencode* 提供方只发这 5 个头（详见 request.ts 的 headers 构造）：
//   x-opencode-project   ← InstanceState.context.project.id，缺省时整头省略
//   x-opencode-session   ← input.sessionID
//   x-opencode-request   ← input.user.id
//   x-opencode-client    ← input.flags.client（默认 'cli'）
//   User-Agent           ← USER_AGENT
// 注意 x-session-affinity / X-Session-Id 只出现在「非 opencode 提供方」分支，
// 发往 Zen 时不应携带，故本插件会主动剥离（DSH 底层 pi-ai 恰好会下发这两个头）。

// opencode 官方合法会话 ID 形状：ses_ + 12 位小写十六进制 + 14 位 base62（总长 30）
const CANONICAL_SESSION = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

function randomChars(alphabet, length) {
  const out = []
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(length)
    c.getRandomValues(bytes)
    for (let i = 0; i < length; i++) out.push(alphabet[bytes[i] % alphabet.length])
  } else {
    for (let i = 0; i < length; i++) out.push(alphabet[Math.floor(Math.random() * alphabet.length)])
  }
  return out.join('')
}

// FNV-1a：把 DSH 的会话标识映射为稳定种子，保证同一会话每轮派生出同一个 ID
function seedOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function seededChars(seed, alphabet, length) {
  let s = (seed || 0x9e3779b9) >>> 0
  const out = []
  for (let i = 0; i < length; i++) {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    out.push(alphabet[s % alphabet.length])
  }
  return out.join('')
}

// 复刻 opencode 官方 ID 规范，两代实现同形：
//   v1 packages/opencode/src/id/id.ts      → prefix + "_" + 12 位小写十六进制(时间戳) + 14 位 base62
//   v2 packages/schema/src/identifier.ts   → 同上（descending 仅对时间戳取反，仍是 12 位小写 hex）
// Zen 免费通道严格校验该形状：任意字符串、req_/msg_ 前缀、首位大写十六进制、64 位 hex
// 均返回 403 FreeTierError（后者见于 core runner 的 promptCacheKey 分支）。
// 时间戳本身不参与校验（可用派生值代替），故同一会话可稳定复用同一 ID 以获得路由固定与提示缓存。
function opencodeId(prefix, seedText) {
  if (seedText) {
    const seed = seedOf(seedText)
    return `${prefix}_${seededChars(seed, LOWER_HEX, 12)}${seededChars(seed ^ 0x5bf03635, BASE62, 14)}`
  }
  return `${prefix}_${randomChars(LOWER_HEX, 12)}${randomChars(BASE62, 14)}`
}

function canonicalSession(hint, fallback) {
  const value = hint && String(hint).trim()
  if (!value) return fallback()
  if (CANONICAL_SESSION.test(value)) return value
  // DSH 原生渠道（pi-ai）下发的 x-session-affinity / x-session-id 不是 opencode 形状，
  // 直接透传会被免费通道拒绝，此处改为「同一来源稳定映射」到合法 ID。
  return opencodeId('ses', value)
}

export function apply(ctx) {
  const originalFetch = globalThis.fetch
  let fallbackSession = ''
  const fallback = () => (fallbackSession ||= opencodeId('ses'))

  globalThis.fetch = async function (input, init) {
    let url = ''
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else if (input && typeof input.url === 'string') {
      url = input.url
    }

    // 1. 目标为 OpenCode Zen 的所有请求（包括 /v1/models 和 /v1/chat/completions 等）
    if (url && url.includes('opencode.ai/zen')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      const sessionHint =
        headers.get('x-opencode-session') ||
        headers.get('x-session-affinity') ||
        headers.get('x-session-id')
      const sessionId = canonicalSession(sessionHint, fallback)
      const requestId = opencodeId('msg')

      headers.set('user-agent', OPENCODE_UA)
      headers.set('x-opencode-client', 'cli')
      // 官方此处为 context.project.id；DSH 无 opencode 项目概念，等价取全局项目：
      // opencode 自身的全局项目 ID 即 ProjectV2.ID.global === 'global'（服务端不校验该值）
      headers.set('x-opencode-project', 'global')
      headers.set('x-opencode-session', sessionId)
      headers.set('x-opencode-request', requestId)
      // 对齐官方 opencode 分支：这两个头只用于非 opencode 提供方，故发往 Zen 时剥离
      // （DSH 底层 pi-ai 会下发它们，且取值并非 opencode 形状）
      headers.delete('x-session-affinity')
      headers.delete('x-session-id')

      // 若未设置 API 密钥、密钥为空，或误填成了 URL 地址，则自动切换为官方匿名通道
      const auth = headers.get('authorization')
      if (
        !auth ||
        auth.trim() === 'Bearer' ||
        auth.trim() === 'Bearer undefined' ||
        auth.trim() === 'Bearer null' ||
        auth.includes('http://') ||
        auth.includes('https://')
      ) {
        headers.set('authorization', 'Bearer public')
      }

      if (input instanceof Request) {
        const newRequest = new Request(input, { ...init, headers })
        return originalFetch.call(this, newRequest)
      }

      return originalFetch.call(this, input, { ...init, headers })
    }

    // 2. 目标为 Cline 官方中转 API (api.cline.bot) 的所有请求
    if (url && url.includes('api.cline.bot')) {
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : {}))

      // 仅注入 Cline 官方客户端协议特征头，鉴权密钥完全遵循用户在 DSH 的设置直通，不设内置兜底
      headers.set('http-referer', 'https://cline.bot')
      headers.set('x-title', 'Cline')
      headers.set('user-agent', 'Cline/4.1.16')
      headers.set('x-conversion-version', '4.1.16')
      headers.set('x-platform-version', '1.106.0')
      headers.set('x-client-version', '4.1.16')
      headers.set('x-platform', 'vscode')
      headers.set('x-client-type', 'cline-vscode')

      if (input instanceof Request) {
        const newRequest = new Request(input, { ...init, headers })
        return originalFetch.call(this, newRequest)
      }

      return originalFetch.call(this, input, { ...init, headers })
    }

    // 所有其他渠道（DeepSeek、OpenAI、Anthropic 等）100% 原样直通，完全无感
    return originalFetch.apply(this, arguments)
  }

  ctx.on('dispose', () => {
    globalThis.fetch = originalFetch
  })
}
