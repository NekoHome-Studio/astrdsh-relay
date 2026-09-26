#!/usr/bin/env node
/**
 * 语法闸门：遍历仓库内全部 .js/.mjs，逐个交给 `node --check` 解析。
 *
 * 为什么不用 shell 循环（`for f in lib/*.js; do node --check "$f"; done`）：
 *   · 那是 POSIX 语法，Windows 的 PowerShell 跑不了，本地就复现不了 CI；
 *   · 通配范围写死在 workflow 里，新增文件必须记得回来补一遍，很容易漏。
 * 这里让 Node 自己遍历目录，于是「本地 npm test」与「CI npm test」是同一条命令，
 * 也就不存在两边闸门漂移的余地。
 *
 * 只做语法解析，不做类型/风格检查（本仓库没有 lint 配置，也不打算引入）。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 客户端半边（client/）也要在这里出现：它不走 node 的模块解析，
// 语法错了只会在浏览器里变成一个安静的白屏——那是最难查的一类失败。
const DIRS = ['dsh-astrbot-relay', 'dsh-astrbot-relay/lib', 'dsh-astrbot-relay/client', 'scripts']
const EXTS = ['.js', '.mjs']

const files = []
for (const dir of DIRS) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!EXTS.some((ext) => entry.name.endsWith(ext))) continue
    files.push(join(dir, entry.name))
  }
}
files.sort()

// 目录名写错或文件被挪走时，宁可响亮报错，也不要「0 个文件全绿」这种假通过
if (files.length === 0) {
  console.error('没有找到任何待检查的 JS 文件——目录列表写错了？')
  process.exit(1)
}

const failures = []
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, file)], { stdio: 'pipe' })
    console.log(`  \u2713 ${file}`)
  } catch (error) {
    failures.push(file)
    console.error(`  \u2717 ${file}`)
    console.error(String(error.stderr ?? error.message).trim())
  }
}

console.log(`\n语法检查 ${files.length} 个文件，失败 ${failures.length} 个`)
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
