#!/usr/bin/env node
/**
 * 一键跑完全部分项自检 —— 分项文件照旧各自可单独运行，这个入口只是省得记三条命令。
 *
 *   node tools/self-check.mjs                # 全部
 *   node tools/self-check.mjs cline-panel    # 只跑名字匹配的那几项
 *   node tools/self-check.mjs --live         # 透传给分项（目前只有 zen-check 认 --live）
 *
 * 每个分项都按「自己的进程」跑：输出直接继承到当前终端（不吞进管道，
 * 便于定位失败时逐条看断言），退出码汇总决定本进程的退出码。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const CHECKS = [
  { name: 'zen-check', file: 'zen-check.mjs', what: 'Zen 头部形状、会话稳定性、渠道隔离' },
  { name: 'cline-key', file: 'cline-key-check.mjs', what: 'Cline 多 Key 轮换、粘性选 Key、冷却与持久化' },
  { name: 'cline-panel', file: 'cline-panel-check.mjs', what: '设置面板：只读路由契约 + 浏览器半边渲染' },
]

const argv = process.argv.slice(2)
const filters = argv.filter((arg) => !arg.startsWith('-'))
const flags = argv.filter((arg) => arg.startsWith('-'))

const selected = filters.length
  ? CHECKS.filter((check) => filters.some((filter) => check.name.includes(filter) || check.file.includes(filter)))
  : CHECKS

if (selected.length === 0) {
  console.error(`没有匹配的自检项。可选：${CHECKS.map((check) => check.name).join(' / ')}`)
  process.exit(2)
}

const results = []
for (const check of selected) {
  const file = join(here, check.file)
  if (!existsSync(file)) {
    results.push({ ...check, code: -1, note: '文件不存在' })
    continue
  }
  console.log(`\n══════ ${check.name} — ${check.what} ═════`)
  const run = spawnSync(process.execPath, [file, ...flags], { cwd: root, stdio: 'inherit' })
  results.push({ ...check, code: run.status ?? -1, note: run.error ? String(run.error.message) : '' })
}

console.log(`\n══════ 汇总 ══════`)
for (const row of results) {
  const mark = row.code === 0 ? 'PASS' : 'FAIL'
  console.log(`${mark} | ${row.name.padEnd(12)} | ${row.what}${row.note ? ` | ${row.note}` : ''}`)
}

const failed = results.filter((row) => row.code !== 0)
console.log(
  failed.length === 0
    ? `\nALL PASS | ${results.length} 个分项全部通过`
    : `\n${failed.length} 个分项失败：${failed.map((row) => row.name).join(', ')}`,
)
process.exitCode = failed.length === 0 ? 0 : 1