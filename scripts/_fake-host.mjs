/**
 * 星驿 · 三个 chain 测试共用的**隔离式假宿主加载器**。
 *
 * ## 为什么必须隔离（这是踩出来的，不是洁癖）
 *
 * 原先每个 chain 测试都在**插件的真实目录**里搭桩：
 *
 *     dsh-astrbot-relay/node_modules/@deepseek-ai/<四个包>
 *
 * 并加了一句 `if (existsSync(dir)) continue`——本意是「别覆盖真实的包」
 * （上一轮真的覆盖过一次，靠备份才还原）。但这句 guard 把**一个响亮的 bug
 * 换成了一个安静的 bug**：
 *
 * * 装了插件的机器上，真实依赖就在那儿 → 桩**从未生效**；
 * * 于是 `materializeDefaults(Config)` 面对的是真 Schema，它**没有** `__shape`
 *   → 物化出 `{}` → 插件加载期的 `sessionTitleTemplate` 强校验抛出
 *   → **该测试全部断言同时变红**，而报错长得像功能回归。
 *
 * 结果是「CI 绿、本地红」，且红得极具误导性。第三方复测报告里就是这么红的。
 *
 * ## 现在的做法
 *
 * 把插件的 `lib/` **复制**到 `.test-tmp/<label>/pkg/`，桩只建在那份副本里，
 * 再从副本 import。于是：
 *
 *   · 真实依赖在不在位**都不影响结论**（同一个环境跑出同一个结果）；
 *   · 真实目录**永远不被写入**——「桩覆盖真实包」这类事故从结构上不可能再发生；
 *   · `materializeDefaults` 拿不到形状时**直接抛**，而不是静默返回 `{}`
 *     把环境问题伪装成功能全红。
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_DIR = join(ROOT, 'dsh-astrbot-relay')

/**
 * 四个被桩掉的宿主机依赖。
 *
 * 桩的 schemastery 刻意保留 `__shape`（真包没有它）——测试要的就是「能物化出
 * schema 默认值」这件事本身；真伪差异由 `materializeDefaults` 的强校验兜住。
 */
export const STUBS = {
  schemastery: `const chain = () => {
  const node = { value: undefined, required: false }
  const api = {
    default(v) { node.value = v; return api },
    required() { node.required = true; return api },
    description() { return api },
    step() { return api },
    min() { return api },
    __node: node,
  }
  return api
}
const object = (shape) => ({ __shape: shape })
export default { object, string: chain, number: chain, boolean: chain, union: chain, array: chain }
`,
  'dsh-brand': `export const brandString = (value) => value\n`,
  'dsh-agent': `export const installModelSelection = () => {}\n`,
  'dsh-llm': `export const createUserMessage = (input) => ({ ...input, role: 'user' })\n`,
}

function writeStubs(pkgDir) {
  for (const [name, source] of Object.entries(STUBS)) {
    const dir = join(pkgDir, 'node_modules', '@deepseek-ai', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `@deepseek-ai/${name}`, version: '0.0.0-test-stub', type: 'module',
      main: 'index.js', exports: { '.': './index.js' },
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'index.js'), source)
    writeFileSync(join(dir, '__STUB__'), '由 scripts/_fake-host.mjs 创建，在临时副本里，可安全删除\n')
  }
}

/**
 * 把插件的宿主半边复制到隔离目录、在那里搭桩、再从副本 import。
 *
 * @returns {{ mod: object, pkgDir: string, cleanup: () => void }}
 */
export async function loadHermeticPlugin({ label = 'chain' } = {}) {
  const pkgDir = join(ROOT, '.test-tmp', label, 'pkg')
  rmSync(join(ROOT, '.test-tmp', label), { recursive: true, force: true })
  mkdirSync(pkgDir, { recursive: true })

  // lib/ 与 package.json 都要复制：后者带 `"type": "module"`，
  // 少了它副本里的 .js 会被当 CJS 解析，报错完全对不上真实原因。
  cpSync(join(PLUGIN_DIR, 'lib'), join(pkgDir, 'lib'), { recursive: true })
  cpSync(join(PLUGIN_DIR, 'package.json'), join(pkgDir, 'package.json'))
  if (existsSync(join(PLUGIN_DIR, 'cordis.patch.yml'))) {
    cpSync(join(PLUGIN_DIR, 'cordis.patch.yml'), join(pkgDir, 'cordis.patch.yml'))
  }
  writeStubs(pkgDir)

  const mod = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)
  return {
    mod,
    pkgDir,
    cleanup: () => rmSync(join(ROOT, '.test-tmp', label), { recursive: true, force: true }),
  }
}

/**
 * 从（桩版）Schema 里物化出各字段的默认值。
 *
 * **拿不到形状就直接抛。** 这是本次修复的另一半：原先它 `return {}`，
 * 于是「桩没生效」这件事被翻译成「15 条功能断言同时失败」。
 * 环境问题就该报成环境问题。
 */
export function materializeDefaults(Config) {
  const shape = Config?.__shape
  if (!shape || typeof shape !== 'object') {
    throw new Error(
      '物化配置默认值失败：Config.__shape 不存在。\n' +
      '  这通常意味着桩没生效（拿到的是真实的 schemastery）。\n' +
      '  本仓库的 chain 测试走 scripts/_fake-host.mjs 的隔离副本，正常不该出现这条；\n' +
      '  如果出现了，说明有人把 import 指回了插件真实目录。',
    )
  }
  const out = {}
  for (const [key, field] of Object.entries(shape)) {
    if (field?.__node?.value !== undefined) out[key] = field.__node.value
  }
  if (Object.keys(out).length === 0) {
    throw new Error('物化配置默认值失败：__shape 非空但一个默认值都没取到——桩的形状变了？')
  }
  return out
}

/** 插件真实目录里有没有真实依赖（只用于**报告**，不再影响测试走哪条路）。 */
export function realDepsPresent() {
  const scope = join(PLUGIN_DIR, 'node_modules', '@deepseek-ai')
  if (!existsSync(scope)) return []
  try {
    return readdirSync(scope)
  } catch {
    return []
  }
}
