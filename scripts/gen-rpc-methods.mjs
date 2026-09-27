#!/usr/bin/env node
/**
 * 由「RPC 描述符」+「白名单全量表」生成 `dsh-astrbot-relay/lib/rpc-methods.js`。
 *
 * 为什么不手抄：契约 §11 的方法白名单是一条**安全边界**——放进去就等于把该
 * 宿主 RPC 暴露给 IM 侧，所以每条数据都必须能追回证据。这里锁两张表：
 *   - 描述符 JSON（`data/p5_rpc_descriptors.json`）：从 `@deepseek-ai/dsh-api-remotes`
 *     的**本机安装产物**按字面量切块提取，给出 `id / kind / stream / params[].wire`；
 *   - 白名单表（`data/p5_rpc_allowlist.md`）：同批 84 条的 5 列底表，第 4 列是分级建议。
 * 两者必须**逐条对上**（方法名集合相等、条数相等），否则本脚本直接失败。
 * 这样「表」与「描述符」互为证据：任何一侧漂移，CI 都会响亮报错，而不是
 * 悄悄多出一条能调的宿主方法。
 *
 * 三条口径写在断言里，改这里之前先读契约 §11.4：
 *   1. 白名单粒度 = 方法名 + wire 键集合 + 是否 stream，三者缺一不可；
 *   2. wire 键取 `params[].wire`（**不是参数名**）——报文里真正出现的是 wire 键；
 *      `cancellation` 这类框架内建参数不写入白名单（防回归，当前实测为 0 条）；
 *   3. stream 四类一律不进 `/rpc`（宿主 `invoke()` 对 `mode === 'stream'` 直接抛
 *      `gateway/signature-invalid`），在插件侧就要 403 拦下。
 *
 * 用法：node scripts/gen-rpc-methods.mjs [--check]
 *   --check  只比对、不写文件（CI / 本地闸门用；产物不一致则非零退出）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(ROOT, 'dsh-astrbot-relay', 'data')
const DESC_PATH = join(DATA, 'p5_rpc_descriptors.json')
const TABLE_PATH = join(DATA, 'p5_rpc_allowlist.md')
const OUT_PATH = join(ROOT, 'dsh-astrbot-relay', 'lib', 'rpc-methods.js')

const checkOnly = process.argv.includes('--check')

/** 表里的分级建议：A 只读 / C 需显式开启 / B 写 / X 禁入。 */
const CLASSES = ['A', 'C', 'B', 'X']
/** 分级计数的期望值，来自 P5 提案 §4.2–4.5（与三表核对报告一致）。 */
const EXPECT_CLASS_COUNTS = { A: 26, C: 38, B: 13, X: 7 }
const EXPECT_TOTAL = 84
/** §4.3：流式四类，走 /rpc 必须 403。 */
const EXPECT_STREAM = ['session/control', 'session/follow', 'workspace/follow', 'workspaceFiles/changes']
/** 参数名里出现它就不进 wire 键集合（框架内建，请求由网关自己管）。 */
const EXCLUDED_PARAM = /cancellation/i

const problems = []
const fail = (message) => { problems.push(message) }

// ── 1. 描述符 ──────────────────────────────────────────────────────
const descriptors = JSON.parse(readFileSync(DESC_PATH, 'utf8'))
if (!Array.isArray(descriptors)) throw new Error('描述符文件不是数组')

/** endpoint → wire 键集合（保持描述符顺序，产物因此是稳定 diff 友好的）。 */
const wireKeys = new Map()
const streamMethods = []
for (const item of descriptors) {
  const id = String(item?.id ?? '')
  if (!/^[A-Za-z][A-Za-z0-9]*\/[A-Za-z][A-Za-z0-9]*$/.test(id)) {
    fail(`描述符 id 形状异常：${JSON.stringify(id)}（契约 §11.2 要求恰两段）`)
    continue
  }
  if (wireKeys.has(id)) fail(`描述符里出现重复 id：${id}`)
  const keys = []
  for (const param of item.params ?? []) {
    const [name, key] = param
    if (EXCLUDED_PARAM.test(String(name)) || EXCLUDED_PARAM.test(String(key))) continue
    if (typeof key !== 'string' || key === '') {
      fail(`${id} 的 wire 键为空（参数名 ${JSON.stringify(name)}）`)
      continue
    }
    if (!keys.includes(key)) keys.push(key)
  }
  wireKeys.set(id, keys)
  if (item.stream === true) {
    streamMethods.push(id)
  } else if (item.kind !== 'direct') {
    fail(`${id} 的 kind=${JSON.stringify(item.kind)} 既不是 direct 也不是 stream`)
  }
}

// ── 2. 白名单表 ────────────────────────────────────────────────────
// 5 列版：| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
// 含 "/" 的行才计入（表里别处还有说明性的单列句子、以及「参数名 ≠ wire 键」的散文）。
const ROW = /^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/
const classOf = new Map()
for (const line of readFileSync(TABLE_PATH, 'utf8').split(/\r?\n/)) {
  const m = ROW.exec(line)
  if (!m) continue
  const [, method, , , advice] = m
  if (!method.includes('/')) continue
  const cls = CLASSES.find((c) => new RegExp(`^${c}(\\s|$|[（(])`).test(advice))
  if (!cls) fail(`表里 ${method} 的建议列无法分级：${JSON.stringify(advice)}`)
  if (classOf.has(method)) fail(`表里出现重复方法：${method}`)
  classOf.set(method, cls ?? null)
}

// ── 3. 两表互证 ────────────────────────────────────────────────────
const descIds = new Set(wireKeys.keys())
const tableIds = new Set(classOf.keys())
for (const id of descIds) if (!tableIds.has(id)) fail(`表里缺少描述符方法：${id}`)
for (const id of tableIds) if (!descIds.has(id)) fail(`表里有描述符之外的方法：${id}`)
if (descIds.size !== EXPECT_TOTAL) {
  fail(`描述符条数应为 ${EXPECT_TOTAL}，实得 ${descIds.size}`)
}
const counts = {}
for (const cls of classOf.values()) counts[cls] = (counts[cls] ?? 0) + 1
for (const cls of CLASSES) {
  if (counts[cls] !== EXPECT_CLASS_COUNTS[cls]) {
    fail(`分级 ${cls} 应有 ${EXPECT_CLASS_COUNTS[cls]} 条，实得 ${counts[cls] ?? 0}`)
  }
}
const streamSorted = [...streamMethods].sort()
if (JSON.stringify(streamSorted) !== JSON.stringify([...EXPECT_STREAM].sort())) {
  fail(`流式方法应为 ${EXPECT_STREAM.join(' / ')}，实得 ${streamSorted.join(' / ')}`)
}
// 缺省白名单 = A 类（提案 §7：缺省即 A 类，不包含 dynamicCordisRunner/*）。
const defaultMethods = [...classOf.entries()].filter(([, c]) => c === 'A').map(([id]) => id)
for (const id of defaultMethods) {
  if (streamMethods.includes(id)) fail(`缺省白名单里混进了流式方法：${id}`)
  if (id.startsWith('dynamicCordisRunner/')) fail(`缺省白名单不得包含高权限方法：${id}`)
}
if (defaultMethods.length !== EXPECT_CLASS_COUNTS.A) {
  fail(`缺省白名单应有 ${EXPECT_CLASS_COUNTS.A} 条，实得 ${defaultMethods.length}`)
}

if (problems.length) {
  console.error('✗ 生成失败，先修数据（产物未改动）：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

// ── 4. 渲染产物 ────────────────────────────────────────────────────
const jsString = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const byLines = (items, indent) => items.length === 0
  ? '[]'
  : `[\n${items.map((s) => `${indent}${s},`).join('\n')}\n${indent.slice(0, -2)}]`

const wireBody = [...wireKeys.entries()]
  .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([id, keys]) => `  ${jsString(id)}: [${keys.map(jsString).join(', ')}],`)
  .join('\n')

const generated = `/**
 * RPC 方法元数据 —— **自动生成，不要手改**。
 *
 *   生成器：\`node scripts/gen-rpc-methods.mjs\`
 *   原料：  \`dsh-astrbot-relay/data/p5_rpc_descriptors.json\`（84 条描述符，
 *           从 @deepseek-ai/dsh-api-remotes 的本机安装产物切块提取）
 *           \`dsh-astrbot-relay/data/p5_rpc_allowlist.md\`（同批 84 条的分级底表）
 *   契约：  \`docs/BRIDGE-CONTRACT.md\` §11（控制面转发）
 *
 * 三张口径固定在这里，改动前先读契约 §11.4：
 *
 *   1. **粒度 = 方法名 + wire 键集合 + 是否 stream**，三者缺一不可。
 *      只按方法名放行是不够的：同一个方法，参数键写错就该被 400 挡下，
 *      而不是把半成品透传给宿主再折成 \`gateway/internal\`。
 *   2. **wire 键才是报文里出现的键**（不是参数名）。全表 28 条参数名与 wire
 *      不同名，两组是系统性的 \`source:"lookup"\` 重命名：\`agent\`→\`agentId\`、
 *      \`workspaceFileScope\`→\`workspaceFileScopeId\`。最容易写错的是
 *      \`session/list\`：它的参数名和 wire 键**都是** \`_request\`。
 *   3. **stream 四类一律 403**：宿主 \`invoke()\` 对 \`mode === 'stream'\` 直接抛
 *      \`gateway/signature-invalid\`，插件侧必须前置拒绝，别让它变成 500。
 *
 * 另有一条禁入名单（不进任何白名单）：\`host/describe\`、\`workspace/list\`、
 * \`goals/blocked\`（实测 404）与高权限 \`dynamicCordisRunner/*\`（12 条）。
 * \`dynamicCordisRunner/*\` 在表里属 C 类（显式开启才可加），因此它**不得**
 * 出现在 \`RPC_DEFAULT_METHODS\` 里。
 */

/** 描述符条数（与契约 §11.4 的 84 条一致；闸门会在这里对不上时报错）。 */
export const RPC_METHOD_COUNT = ${wireKeys.size}

/**
 * endpoint → 允许出现在 \`args\` 里的 wire 键。
 *
 * 出现集合外的键 → **400 \`unsupported\`**（请求本身是好的，但粒度对不上）；
 * 出现未登记的方法 → **403 \`forbidden\`**（身份已确认、权限不够）。
 * 两条错误码刻意分开，见 contract.js 的 ERROR_CODE.FORBIDDEN 注释。
 */
export const RPC_WIRE_KEYS = Object.freeze({
${wireBody}
})

/**
 * 流式四类：\`POST /rpc\` 对它们一律 **403 \`forbidden\`**。
 * 理由不是「不方便」，而是宿主层根本不通：\`invoke()\` 见到
 * \`descriptor.mode === 'stream'\` 就抛 \`gateway/signature-invalid\`。
 * 将来要中继流，得走 \`ctx.typertGateway.stream()\`，那是独立的一条设计。
 */
export const RPC_STREAM_METHODS = Object.freeze(${byLines([...streamMethods].sort().map(jsString), '  ')})

/**
 * \`Config.allowedRpcMethods\` 的**缺省白名单 = A 类 26 条**（提案 §4.2 / §7）。
 * 只读、无副作用，是「开箱可用」与「不越权」的交点。
 * 想开 C 类（含 \`settings/*\`、写工作区目录等）必须显式写进配置——
 * 那时出的事算配置者自己认下的。
 */
export const RPC_DEFAULT_METHODS = Object.freeze(${byLines([...defaultMethods].sort().map(jsString), '  ')})

/** 一条 endpoint 是否登记在描述符表里。 */
export function isKnownRpcMethod(endpoint) {
  return Object.prototype.hasOwnProperty.call(RPC_WIRE_KEYS, endpoint)
}

/** 该 endpoint 的 wire 键集合（未登记返回 undefined）。 */
export function wireKeysOf(endpoint) {
  return RPC_WIRE_KEYS[endpoint]
}

/** 该 endpoint 是否属流式四类（必须走流式通道，\`/rpc\` 一律 403）。 */
export function isStreamRpcMethod(endpoint) {
  return RPC_STREAM_METHODS.includes(endpoint)
}
`

if (checkOnly) {
  let current = null
  try {
    current = readFileSync(OUT_PATH, 'utf8')
  } catch {
    fail(`产物不存在：${OUT_PATH}`)
  }
  if (current !== null && current !== generated) {
    fail('产物与原料不一致（跑 `node scripts/gen-rpc-methods.mjs` 重新生成）')
  }
  if (problems.length) {
    console.error('✗ --check 未通过：')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`✓ RPC 方法表一致：${wireKeys.size} 条（A ${counts.A} / C ${counts.C} / B ${counts.B} / X ${counts.X}），`
    + `缺省白名单 ${defaultMethods.length} 条，流式 ${streamMethods.length} 条`)
} else {
  writeFileSync(OUT_PATH, generated, 'utf8')
  console.log(`✓ 已生成 ${OUT_PATH}`)
  console.log(`  ${wireKeys.size} 条方法（A ${counts.A} / C ${counts.C} / B ${counts.B} / X ${counts.X}）｜`
    + `缺省白名单 ${defaultMethods.length} 条｜流式 ${streamMethods.length} 条`)
}
