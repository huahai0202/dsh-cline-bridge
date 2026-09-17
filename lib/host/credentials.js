/**
 * 兜底读取 .credentials.yaml 的 refs 段。
 *
 * 只取显式需要的 ref，文件其余内容一概不碰（凭据文件由 DSH 自己维护）。
 *
 * 从原本单文件的 index.js 按语义边界原样拆出；实现未做任何改写。
 */
import { readFileSync } from 'node:fs'

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
