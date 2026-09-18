/**
 * key 的 8 位哈希标签与掩码预览。
 *
 * 两者是同一份 key 材料的两种表示，用途截然不同：
 *   · keyLabel —— 稳定、不可逆、可落盘可入日志（状态文件与日志里只有它）；
 *   · maskKey  —— 首尾各 4 位的可读片段，**只**经由同源校验的本机面板路由回给浏览器。
 *
 * 本文件原先还承载 opencode 会话/请求 ID 的复刻实现（Zen 免费通道曾按其形状放行），
 * 自 Zen 通道因传输层指纹门禁被移除后，那部分随之删除。
 */

// FNV-1a：把 key 原文折叠成稳定种子。单向且定长，故可以安全地写进日志与磁盘。
function seedOf(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** 只用于日志与落盘的短标签（8 位十六进制），绝不记录 key 原文。 */
export function keyLabel(key) {
  return seedOf(key).toString(16).padStart(8, '0')
}

// ── 掩码预览 ─────────────────────────────────────────────────────────
// 设置面板里为了让人认出「这是哪把 key」，会显示首尾各几位（形如 abcd…wxyz）。
// 这条通道有严格的边界，改动时务必保持：
//   · 只在内存里现算，只在同一个 HTTP 响应里回给本机设置面板；
//   · 绝不进日志，绝不进 <DSH_HOME>/.dsh-cline-bridge-quota.json
//     （落盘仍然只写 8 位哈希标签，见 quotaStore）；
//   · 可用 maskKeyPreview: false 整体关闭，关闭后连首尾几位也不下发。
// 注意：首尾各 4 位仍属于部分密钥材料，因此它只经由同源校验的本机路由回给面板。
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