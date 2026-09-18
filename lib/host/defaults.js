/**
 * 插件版本、各通道的可调常量，以及 DSH 相关路径解析。
 *
 * 全部集中在这里，方便一眼看到默认值与含义；改动它们等于改插件行为。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；插件更名时追加了旧状态文件的迁移。
 */
import { existsSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_VERSION = '2.2.0'

// Cline 免费额度是「按 key + 按模型」的每日上限，撞限流时服务端返回：
//   429 {"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached
//        on model deepseek/deepseek-v4.1-flash. Try again in 22h 47m"}
// 重试窗口以小时计，退避等待毫无意义，只能换 key。本插件位于 openai SDK 之下、
// pi-ai 的 retryProviderRequest 之上，是唯一能「换 key 重发」的层次：只要换 key 后拿到
// 成功响应就直接返回，pi-ai 根本看不到那次 429。
export const DEFAULT_CLINE_MATCH = 'cline.bot'
export const DEFAULT_CLINE_COOLDOWN_MS = 15 * 60 * 1000
export const DEFAULT_FAIL_FAST_MIN_MS = 5 * 60 * 1000
export const MAX_ROTATE_ATTEMPTS = 6
// 默认从凭据仓库 / 启动环境探测的额外 key 名（主 key 由 DSH 的 CLINE_API_KEY 提供）
export const DEFAULT_CLINE_KEY_REFS = Array.from({ length: 9 }, (_, i) => `CLINE_API_KEY_${i + 2}`)
// 额外 key 的解析节流：服务未就绪时 2 秒后重试；就绪后每 5 分钟复扫一次以发现新增 ref
export const EXTRAS_RETRY_MS = 2000
export const EXTRAS_TTL_MS = 5 * 60 * 1000
export const CLINE_ROTATE_STATUSES = [429]

/** 429 是否属于「额度已耗尽」这类终局错误：这类错误退避重试毫无意义。 */
export const TERMINAL_CAP_RE = /INFERENCE_CAP_ERROR|daily\s+free\s+limit|free\s+limit\s+reached|usage\s+limit|quota\s+exceeded|insufficient/i
export const TERMINAL_WINDOW_MS = 10 * 60 * 1000


/** 当前状态文件名：额度冷却 + 用量统计都在里面（只有哈希标签，没有 key 原文）。 */
export const QUOTA_STATE_NAME = '.dsh-cline-bridge-quota.json'
// 插件更名前（opencode-free-bridge）用的状态文件。改名不该让用户丢掉已有的冷却与累计统计，
// 所以首次启动时把它搬到新名字下（见 migrateLegacyQuotaState）。
const LEGACY_QUOTA_STATE_NAME = '.opencode-free-bridge-cline-quota.json'

export function resolveQuotaStatePath(config) {
  if (typeof config?.quotaStatePath === 'string' && config.quotaStatePath) return config.quotaStatePath
  return join(resolveDshHome(config), QUOTA_STATE_NAME)
}

/**
 * 把旧插件名留下的状态文件迁移到当前名字下。返回被迁移的旧路径（没迁移则返回空串）。
 *
 * 三道刹车，避免帮倒忙：
 *   · 用户显式配了 quotaStatePath —— 不猜，交给用户自己安排；
 *   · 新文件已存在 —— 已有归处，绝不覆盖；
 *   · 旧文件不存在 / 改名失败（跨设备、占用）—— 静默跳过，插件照常以空状态启动。
 */
export function migrateLegacyQuotaState(config) {
  if (typeof config?.quotaStatePath === 'string' && config.quotaStatePath) return ''
  try {
    const target = resolveQuotaStatePath(config)
    if (existsSync(target)) return ''
    const legacy = join(resolveDshHome(config), LEGACY_QUOTA_STATE_NAME)
    if (!existsSync(legacy)) return ''
    renameSync(legacy, target)
    return legacy
  } catch {
    return ''
  }
}

export function resolveDshHome(config) {
  if (typeof config?.dshHome === 'string' && config.dshHome) return config.dshHome
  return globalThis.process?.env?.DSH_HOME || join(homedir(), '.dsh')
}

export function resolveCredentialsFilePath(config) {
  if (typeof config?.credentialsFile === 'string' && config.credentialsFile) return config.credentialsFile
  return join(resolveDshHome(config), '.credentials.yaml')
}
