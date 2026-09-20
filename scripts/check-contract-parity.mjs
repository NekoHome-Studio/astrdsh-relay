#!/usr/bin/env node
/**
 * 校验两侧契约常量是否一致。
 *
 * 契约的机器可读副本有两份，必须逐字对应：
 *   dsh-astrbot-relay/lib/contract.js           (JS)
 *   astrbot_plugin_dsh_relay/contract.py        (Python)
 *
 * 真相来源是 docs/BRIDGE-CONTRACT.md；这两份副本只是让代码不必硬编码字面量。
 * 一旦漂移（例如有人在 JS 侧加了事件类型却忘了 Python 侧），
 * 症状会是运行期「IM 侧收到未知事件直接忽略」这类**静默**故障，
 * 所以这里用 CI 闸门把它变成响亮的失败。
 *
 * 用法：node scripts/check-contract-parity.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JS_PATH = join(ROOT, 'dsh-astrbot-relay', 'lib', 'contract.js')
const PY_PATH = join(ROOT, 'astrbot_plugin_dsh_relay', 'contract.py')

// JS 侧直接 import——它只依赖 node:crypto，副作用安全。
const js = await import(pathToFileURL(JS_PATH).href)

// 注意顺序：problems 必须先于 parsePython 初始化——解析器在遇到无法解析的
// 标识符时会往 problems 里记一笔（否则会撞上 const 的 TDZ）。
const problems = []
const py = parsePython(PY_PATH)

// ── 1. 契约版本 ────────────────────────────────────────────────────
expect('BRIDGE_VERSION', js.BRIDGE_VERSION, py.scalars.get('BRIDGE_VERSION'))

// ── 2. 路由 ───────────────────────────────────────────────────────
// v2 起是八条：WHERE / CONVERSATIONS / WORKSPACES / REBIND 补进白名单。
// v3 起是九条：再补 FORK。
// 这几条各自对应 IM 侧一条指令——漏在名单外就等于把新端点放进漂移盲区：
// JS 侧改了路径而 Python 侧没跟上，闸门仍然绿灯。
for (const key of [
  'MESSAGE', 'EVENTS', 'APPROVAL', 'HEALTH',
  'WHERE', 'CONVERSATIONS', 'WORKSPACES', 'REBIND', 'FORK',
]) {
  expect(`ROUTES.${key}`, js.ROUTES?.[key], py.scalars.get(`ROUTE_${key}`))
}

// ── 3. 下行事件类型 ────────────────────────────────────────────────
const jsEvents = js.EVENT ?? {}
for (const key of Object.keys(jsEvents)) {
  expect(`EVENT.${key}`, jsEvents[key], py.scalars.get(`EVENT_${key}`))
}
compareSets('KNOWN_EVENT_TYPES', Object.values(jsEvents), py.sets.get('KNOWN_EVENT_TYPES'))

// ── 4. 错误码 ─────────────────────────────────────────────────────
const jsErrors = js.ERROR_CODE ?? {}
for (const key of Object.keys(jsErrors)) {
  expect(`ERROR_CODE.${key}`, jsErrors[key], py.scalars.get(`ERROR_${key}`))
}

// ── 5. 审批结论白名单 ─────────────────────────────────────────────
const jsOutcomes = js.APPROVAL_OUTCOME ?? {}
expect('APPROVAL_OUTCOME.ALLOW_ONCE', jsOutcomes.ALLOW_ONCE, py.scalars.get('APPROVAL_ALLOW_ONCE'))
expect('APPROVAL_OUTCOME.REJECTED', jsOutcomes.REJECTED, py.scalars.get('APPROVAL_REJECTED'))
compareSets('APPROVAL_OUTCOMES_ALLOWED', Object.values(jsOutcomes), py.sets.get('APPROVAL_OUTCOMES_ALLOWED'))

// ── 结果 ──────────────────────────────────────────────────────────
if (problems.length) {
  console.error('✗ 两侧契约常量不一致：\n')
  for (const line of problems) console.error(`  - ${line}`)
  console.error(
    '\n  请同步修改 dsh-astrbot-relay/lib/contract.js 与' +
    ' astrbot_plugin_dsh_relay/contract.py，必要时更新 docs/BRIDGE-CONTRACT.md。',
  )
  process.exit(1)
}

console.log(
  `✓ 契约常量一致：BRIDGE_VERSION=${js.BRIDGE_VERSION}，` +
  `${Object.keys(jsEvents).length} 个事件类型，${Object.keys(jsErrors).length} 个错误码，` +
  `${Object.keys(js.ROUTES ?? {}).length} 条路由`,
)

// ─────────────────────────────────────────────────────────────────────
function expect(label, jsValue, pyValue) {
  if (jsValue === undefined || pyValue === undefined) {
    problems.push(`${label}：一侧缺失（JS=${show(jsValue)}，PY=${show(pyValue)}）`)
    return
  }
  if (jsValue !== pyValue) {
    problems.push(`${label}：JS=${show(jsValue)} ≠ PY=${show(pyValue)}`)
  }
}

function compareSets(label, jsValues, pyValues) {
  if (!pyValues) {
    problems.push(`${label}：Python 侧缺失`)
    return
  }
  const a = [...new Set(jsValues)].sort()
  const b = [...new Set(pyValues)].sort()
  const onlyJs = a.filter((v) => !b.includes(v))
  const onlyPy = b.filter((v) => !a.includes(v))
  if (onlyJs.length) problems.push(`${label}：仅 JS 有 ${onlyJs.map(show).join('、')}`)
  if (onlyPy.length) problems.push(`${label}：仅 Python 有 ${onlyPy.map(show).join('、')}`)
}

/**
 * ⚠️ 必须是**函数声明**，不能写成 const 箭头函数：
 * 上面第 40 行起就在顶层调用 expect()，而 expect() 在「一侧缺失」时会用到
 * show()。写成 const 会踩 TDZ——即**唯独在契约真的不一致时**脚本崩溃，
 * 拿 ReferenceError 顶替本该打印的差异清单，闸门等于在最该响的时候哑掉。
 */
function show(value) {
  return value === undefined ? 'undefined' : JSON.stringify(value)
}

/**
 * 极简 Python 常量解析器。
 *
 * 只认本仓库 contract.py 里出现的两种形态：
 *   NAME = "字面量"
 *   NAME = frozenset({ A, B, ... })      // 可跨行，元素是标识符
 * 这是一个**刻意**不通用的小解析器：契约副本的形态由我们自己控制，
 * 用真 Python 解析器会引入对 python 可执行文件的依赖。
 */
function parsePython(path) {
  const scalars = new Map()
  const sets = new Map()
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, name, raw] = m

    const literal = raw.match(/^"([^"]*)"$/) ?? raw.match(/^'([^']*)'$/)
    if (literal) {
      scalars.set(name, literal[1])
      continue
    }

    if (/^frozenset\s*\(\s*\{?/.test(raw)) {
      // 收集到闭合括号为止，元素按标识符解析
      let body = raw
      while (!/\}\s*\)/.test(body) && i + 1 < lines.length) {
        body += ` ${lines[++i]}`
      }
      const inner = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}'))
      const names = inner.split(/[,\s]+/).filter((token) => /^[A-Z][A-Z0-9_]*$/.test(token))
      sets.set(name, names)
    }
  }

  // 把 set 元素里的标识符解析成字面量（可能有前向引用，故做两轮）
  const resolved = new Map()
  for (const [name, names] of sets) {
    const values = []
    const unresolved = []
    for (const element of names) {
      const value = scalars.get(element)
      if (value === undefined) unresolved.push(element)
      else values.push(value)
    }
    resolved.set(name, values)
    if (unresolved.length) {
      problems.push(`${name}：引用了无法解析的标识符 ${unresolved.join('、')}`)
    }
  }

  return { scalars, sets: resolved }
}
