/**
 * 兜底读取 .credentials.yaml 的 refs 段，以及凭据服务缺席时的兜底写入。
 *
 * 只取 / 只改显式需要的 ref，文件其余内容一概不碰（凭据文件由 DSH 自己维护）。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** 兜底路径：直接解析 .credentials.yaml 的 refs 段（凭据服务尚未就绪或不可用时）。
 *  只取显式需要的 ref，文件的其余内容一概不碰。 */
export function readCredentialRefsFromFile(path, wantedRefs) {
  const wanted = new Set(wantedRefs)
  const out = new Map()
  let inRefs = false
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (/^refs:\s*$/.test(rawLine)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(rawLine)) break // 回到顶层：refs 段结束
    const matched = /^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(rawLine)
    if (!matched || !wanted.has(matched[1])) continue
    let value = matched[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) out.set(matched[1], value)
  }
  return out
}

/** YAML 双引号标量：Key 里只有 base64url/十六进制字符，但仍然把两个会破格的字符转义掉。 */
function quoteYaml(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 兜底写入：把一把 Key 落到 .credentials.yaml 的 refs 段（服务不可用或尚未就绪时才会走到）。
 *
 * 正常路径是凭据服务的 set()——它带文件锁、原子写与变更通知，优先用它；这里只在
 * 服务缺席时补齐同一件事，因此**不改动文件其余内容**（注释、records 段、行尾风格都保留），
 * 写盘同样走「同目录临时文件 + 改名」，权限沿用 0600。
 *
 * @param path - .credentials.yaml 的绝对路径。
 * @param ref - 要写入的 ref 名（例如 CLINE_API_KEY_6）。
 * @param value - 非空密钥值。
 */
export function writeCredentialRefToFile(path, ref, value) {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error // 读不到就当作新文件；其它错误必须暴露出来
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text ? text.split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop() // 收尾换行由最后统一补

  let head = lines.findIndex((line) => /^refs:\s*$/.test(line))
  const body = lines.slice()
  if (head < 0) {
    // 没有 refs 段：顶格补一个（已有的顶层键一律不动）
    if (body.length > 0) body.push('refs:')
    else body.push('version: 1', 'refs:')
    head = body.length - 1
  }
  // refs 段范围：head 之后直到下一个顶格行为止（缩进行都属于 refs）
  let end = head + 1
  while (end < body.length && !/^\S/.test(body[end])) end += 1

  const entry = '  ' + ref + ': ' + quoteYaml(value)
  const at = body.findIndex((line, index) => index > head && index < end && new RegExp('^\\s{2}' + ref + '\\s*:').test(line))
  if (at >= 0) body[at] = entry
  else body.splice(end, 0, entry)

  const next = body.join(eol) + eol
  const tmp = path + '.tmp-' + process.pid + '-' + Date.now()
  try {
    writeFileSync(tmp, next, { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 临时文件没建成或已消失，忽略 */ }
    throw error
  }
}
