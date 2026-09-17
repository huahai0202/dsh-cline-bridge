/**
 * 面板「导入 Key」的主机侧逻辑：把粘贴进来的文本解析成候选 Key，
 * 再落到 .credentials.yaml 的空闲 ref（默认 CLINE_API_KEY_2 ~ _10）上。
 *
 * 这里只有解析 / 分配 / 编排三件事，真正的读写由调用方注入（优先凭据服务，
 * 服务缺席时直写文件），所以这一段能脱离 DSH 单测。
 *
 * 返回值**不含 Key 原文**：只有 ref、8 位哈希标签与首尾掩码——与只读状态路由
 * 同一条隐私边界（见 README 的「数据通道与隐私边界」）。
 */
import { keyLabel, maskKey } from './ids.js'

/** 一次最多导入多少把。面板是手工粘贴，超过这个数一定是误操作（或粘错了东西）。 */
export const MAX_IMPORT_KEYS = 20
/** 长度边界：太短不像密钥（也顺带挡住手滑），太长一定是把别的东西一起粘进来了。 */
const MIN_KEY_LENGTH = 8
const MAX_KEY_LENGTH = 200

/** 解析粘贴文本 → 候选列表。
 *  一行一把是最常见的形态，同时容忍空格 / 逗号 / 分号分隔（从别处复制常常带着它们）。
 *  同一批里粘了两遍按 8 位标签去重：池子本来就是按标签认 Key 的，同标签不可能当成两把用。
 *  返回的 rejected 只带掩码与原因码，供面板显示「哪几条没被接受、为什么」。 */
export function parseKeyInput(text) {
  const values = []
  const rejected = []
  const seen = new Set()
  // 先整体剥掉可能带上的 Bearer 前缀：它本身由空格分隔，等按词切开再剥就晚了一步
  // （那样 "Bearer" 会变成一个 6 字符的「候选」，被当成格式错误报出来）。
  for (const raw of String(text ?? '').replace(/\bBearer\s+/gi, ' ').split(/[\s,;]+/)) {
    // 去掉包裹引号（从 YAML/JSON 里复制常见）
    const value = raw.trim().replace(/^["']+/, '').replace(/["']+$/, '')
    if (!value) continue // 空行与多余分隔符不是错误，直接跳过
    const preview = maskKey(value)
    if (value.length < MIN_KEY_LENGTH) { rejected.push({ preview, reason: 'too-short' }); continue }
    if (value.length > MAX_KEY_LENGTH) { rejected.push({ preview, reason: 'too-long' }); continue }
    if (/[\u0000-\u001f\u007f]/.test(value)) { rejected.push({ preview, reason: 'unsupported-chars' }); continue }
    const label = keyLabel(value)
    if (seen.has(label)) continue // 同一批内重复：当重复处理，不报错
    seen.add(label)
    values.push(value)
  }
  return { values, rejected }
}

/**
 * 把候选 Key 落到空闲 ref 上并写入。
 *
 * 分配是**顺序填空**：refs 按给定顺序（默认 _2 → _10）取第一个未被占用的，
 * 所以「先导入的先用小号」稳定可预期；写失败的那把不吃掉槽位，下一个候选接着用它。
 *
 * @param options.text - 粘贴原文。
 * @param options.refs - 本次允许使用的 ref 名，顺序即优先级。
 * @param options.existing - Map<ref, value|undefined>，ref 当前是否已被占用。
 * @param options.writeRef - async (ref, value) => void，写失败必须抛错。
 * @param options.poolLabels - 池内已知 Key 的 8 位标签（去重用，可为空）。
 * @returns 分组结果：imported / duplicates / rejected / failed（都不含 Key 原文）。
 */
export async function importClineKeys(options) {
  const { values, rejected } = parseKeyInput(options.text)
  const refs = Array.isArray(options.refs) ? options.refs.filter((ref) => typeof ref === 'string' && ref) : []
  const existing = options.existing ?? new Map()

  // 已占用的 ref 本身就是「池内已有」的 Key；再加上池内已知标签，
  // 于是「粘一把已经在用的 Key」会被判为重复，而不是又写一份。
  const knownLabels = new Set(options.poolLabels ?? [])
  for (const value of existing.values()) {
    if (typeof value === 'string' && value) knownLabels.add(keyLabel(value))
  }

  const free = refs.filter((ref) => {
    const value = existing.get(ref)
    return typeof value !== 'string' || value.length === 0
  })

  const imported = []
  const duplicates = []
  const failed = []
  let used = 0

  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    const label = keyLabel(value)
    const preview = maskKey(value)
    if (i >= MAX_IMPORT_KEYS) { rejected.push({ preview, reason: 'over-limit' }); continue }
    if (knownLabels.has(label)) { duplicates.push({ label, preview }); continue }
    const ref = free[used]
    if (!ref) { rejected.push({ preview, reason: 'no-free-ref' }); continue }
    try {
      await options.writeRef(ref, value)
    } catch (error) {
      failed.push({ ref, label, preview, message: String(error?.message ?? error) })
      continue // 槽位没写进去，留给下一个候选
    }
    used += 1
    knownLabels.add(label)
    imported.push({ ref, label, preview })
  }

  return {
    imported,
    duplicates,
    rejected,
    failed,
    refsFree: Math.max(0, free.length - used),
  }
}
