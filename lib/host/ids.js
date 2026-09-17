/**
 * OpenCode 会话/请求 ID 生成 + key 标签与掩码预览。
 *
 * 前半复刻 opencode 官方 ID 规范（会话/请求 ID 的形状被 Zen 免费通道严格校验）；
 * 后半是 Cline 侧的辅助函数：key 只以 8 位哈希标签出现，掩码只用于设置面板。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const LOWER_HEX = '0123456789abcdef'

// 严格对齐官方源码 packages/opencode/src/session/llm/request.ts 的 `USER_AGENT`：
//   const USER_AGENT = `opencode/${InstallationVersion}`
// 官方只发 `opencode/<版本号>`，并无 ai-sdk/runtime 之类的后缀（那些是 SDK 或网关侧另行附加的）。
// 实测 Zen 仅校验 UA 中存在 `opencode/` 前缀，故裸写版本号既忠于官方又稳定。
export const OPENCODE_UA = 'opencode/1.18.31'

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
export function opencodeId(prefix, seedText) {
  if (seedText) {
    const seed = seedOf(seedText)
    return `${prefix}_${seededChars(seed, LOWER_HEX, 12)}${seededChars(seed ^ 0x5bf03635, BASE62, 14)}`
  }
  return `${prefix}_${randomChars(LOWER_HEX, 12)}${randomChars(BASE62, 14)}`
}

export function canonicalSession(hint, fallback) {
  const value = hint && String(hint).trim()
  if (!value) return fallback()
  if (CANONICAL_SESSION.test(value)) return value
  // DSH 原生渠道（pi-ai）下发的 x-session-affinity / x-session-id 不是 opencode 形状，
  // 直接透传会被免费通道拒绝，此处改为「同一来源稳定映射」到合法 ID。
  return opencodeId('ses', value)
}


/** 只用于日志的短标签，绝不记录 key 原文。 */
export function keyLabel(key) {
  return seedOf(key).toString(16).padStart(8, '0')
}

// ── 掩码预览 ─────────────────────────────────────────────────────────
// 设置面板里为了让人认出「这是哪把 key」，会显示首尾各几位（形如 abcd…wxyz）。
// 这条通道有严格的边界，改动时务必保持：
//   · 只在内存里现算，只在同一个 HTTP 响应里回给本机设置面板；
//   · 绝不进日志，绝不进 <DSH_HOME>/.opencode-free-bridge-cline-quota.json
//     （落盘仍然只写 8 位哈希标签，见 quotaStore）；
//   · 可用 maskKeyPreview: false 整体关闭，关闭后连首尾几位也不下发。
// 注意：首尾各 4 位仍属于部分密钥材料，因此它只经由同源校验的只读路由暴露。
const MASK_HEAD = 4
const MASK_TAIL = 4

/** 形如 `sk-a…9f2c`；太短的 key 不猜结构，直接少露。 */
export function maskKey(key) {
  const value = typeof key === 'string' ? key.trim() : ''
  if (!value) return ''
  if (value.length <= MASK_HEAD + MASK_TAIL) {
    // 短到首尾会重叠时只露尾巴，避免拼出完整 key
    return value.length <= 4 ? '…' : `…${value.slice(-4)}`
  }
  return `${value.slice(0, MASK_HEAD)}…${value.slice(-MASK_TAIL)}`
}
