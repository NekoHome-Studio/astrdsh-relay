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
// 后来居上的一批（ADOPT / ANSWER / PROACTIVE / RPC）走的是同一份清单，
// 因此这里必须逐个列全：控制面（§11 的 RPC）恰恰是最不能漂移的一条，
// 它带着方法白名单，路径写错只会在运行期被宿主的 404 挡下。
for (const key of [
  'MESSAGE', 'EVENTS', 'APPROVAL', 'HEALTH',
  'WHERE', 'CONVERSATIONS', 'WORKSPACES', 'REBIND', 'FORK',
  'ADOPT', 'ANSWER', 'PROACTIVE', 'RPC',
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

// ── 6. 图准入闭集（v0.9.5 增量）────────────────────────────────────
// 这枚常量此前处在**校验盲区**：下面的 Python 解析器只认 `NAME = "str"` 与
// `frozenset({...})`，没有 tuple 分支，于是有人把它写成 `"png"` 也能全绿——
// 而它在 DSH 侧是拿去做**严格相等**比对的，写 `"png"` 当场吃 `IMAGE_TYPE_MISMATCH`
// （400，unsupported），本地自检全绿、上线即炸。加这个分支就是为了把
// 「本地全绿 + 线上必炸」这种最贵的失败提前到 CI。
compareSequences('IMAGE_MEDIA_TYPES', js.IMAGE_MEDIA_TYPES, py.sequences.get('IMAGE_MEDIA_TYPES'))

// 光比两侧常量还不够：真正决定线上行为的是 AstrBot 侧那张 MIME 映射表的**值**。
// 而那张表的错法与常量一模一样（两边一起漏前缀，所以互相印证着都「对」），
// 因此这里直接读 main.py，把映射表的值逐个数出来确认都在闭集内。
checkImageMimeMap(js.IMAGE_MEDIA_TYPES)

// ── 结果 ──────────────────────────────────────────────────────────
if (problems.length) {
  console.error('✗ 两侧契约常量不一致：\n')
  for (const line of problems) console.error(`  - ${line}`)
  console.error(
    '\n  请同步修改 dsh-astrbot-relay/lib/contract.js、astrbot_plugin_dsh_relay/contract.py' +
    '（图相关的还有同目录 main.py 的 _IMAGE_MEDIA_TYPE_BY_MIME），必要时更新 docs/BRIDGE-CONTRACT.md。',
  )
  process.exit(1)
}

console.log(
  `✓ 契约常量一致：BRIDGE_VERSION=${js.BRIDGE_VERSION}，` +
  `${Object.keys(jsEvents).length} 个事件类型，${Object.keys(jsErrors).length} 个错误码，` +
  `${Object.keys(js.ROUTES ?? {}).length} 条路由，` +
  `${(js.IMAGE_MEDIA_TYPES ?? []).length} 种图片 mediaType`,
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
 * 顺序敏感的对照组：用在**有序**常量上（例如闭集元组）。
 * 与 compareSets 的差别只在「顺序不同也算不一致」——元组的顺序本身没有语义，
 * 但两侧既然都写成有序形态，就顺手把顺序也钉住，省得有人只在一边重排。
 */
function compareSequences(label, jsValues, pyValues) {
  if (!jsValues?.length || !pyValues) {
    problems.push(`${label}：一侧缺失（JS=${show(jsValues)}，PY=${show(pyValues)}）`)
    return
  }
  const a = jsValues.map(String)
  if (a.join('|') === pyValues.join('|')) return
  const onlyJs = a.filter((v) => !pyValues.includes(v))
  const onlyPy = pyValues.filter((v) => !a.includes(v))
  if (onlyJs.length) problems.push(`${label}：仅 JS 有 ${onlyJs.map(show).join('、')}`)
  if (onlyPy.length) problems.push(`${label}：仅 Python 有 ${onlyPy.map(show).join('、')}`)
  if (!onlyJs.length && !onlyPy.length) {
    problems.push(`${label}：元素相同但顺序不同（JS=${a.join('、')} / PY=${pyValues.join('、')}）`)
  }
}

/**
 * 核对 AstrBot 侧 `main.py` 的 MIME → `mediaType` 映射表。
 *
 * 这张表是**实际发车的那一站**：常量写对了但表里漏写前缀，线上照样吃
 * `IMAGE_TYPE_MISMATCH`。所以不能只比常量。
 */
function checkImageMimeMap(closedSet) {
  const path = join(ROOT, 'astrbot_plugin_dsh_relay', 'main.py')
  let src
  try {
    src = readFileSync(path, 'utf8')
  } catch {
    problems.push('main.py：读不到文件（路径变了？）')
    return
  }
  const block = src.match(/_IMAGE_MEDIA_TYPE_BY_MIME[\s\S]*?\{([\s\S]*?)\n\}/)
  if (!block) {
    problems.push('main.py：解析不到 _IMAGE_MEDIA_TYPE_BY_MIME 映射表')
    return
  }
  const pairs = [...block[1].matchAll(/"([^"\n]*)"\s*:\s*"([^"\n]*)"/g)].map((m) => [m[1], m[2]])
  if (!pairs.length) {
    problems.push('main.py：映射表里一个键值对都没解析出来（形态变了？）')
    return
  }
  for (const [mime, mediaType] of pairs) {
    if (!closedSet.includes(mediaType)) {
      problems.push(`main.py 映射表：${mime} → ${show(mediaType)} 不在闭集内`)
    }
    if (mediaType !== mime && !/^image\//.test(mediaType)) {
      problems.push(`main.py 映射表：${mime} 的值 ${show(mediaType)} 少了 image/ 前缀`)
    }
  }
  // 值全合法也可能漏行：少一整行不报错，但那一类图从此静默地发不出去。
  const covered = new Set(pairs.map(([, value]) => value))
  const uncovered = closedSet.filter((type) => !covered.has(type))
  if (uncovered.length) {
    problems.push(`main.py 映射表：没有任何一条能产出 ${uncovered.map(show).join('、')}`)
  }
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
 * 只认本仓库 contract.py 里出现的三种形态：
 *   NAME = "字面量"
 *   NAME = frozenset({ A, B, ... })      // 可跨行，元素是标识符
 *   NAME = ("字面量", "字面量", ...)      // 可跨行，有序元组（如 IMAGE_MEDIA_TYPES）
 * 这是一个**刻意**不通用的小解析器：契约副本的形态由我们自己控制，
 * 用真 Python 解析器会引入对 python 可执行文件的依赖，
 * 而闸门必须能被任何一台只装了 node 的机器跑起来。
 */
function parsePython(path) {
  const scalars = new Map()
  const sets = new Map()
  const sequences = new Map()
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

    // 有序元组：元素是字符串字面量（不是标识符——闭集要能与文档逐字对照）。
    if (/^\(\s*["']/.test(raw)) {
      let body = raw
      while (!/\)\s*$/.test(body) && i + 1 < lines.length) {
        body += ` ${lines[++i]}`
      }
      const inner = body.replace(/^\s*\(/, '').replace(/\)\s*$/, '')
      const values = [...inner.matchAll(/"([^"]*)"|'([^']*)'/g)].map((mm) => mm[1] ?? mm[2])
      sequences.set(name, values)
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

  return { scalars, sets: resolved, sequences }
}
