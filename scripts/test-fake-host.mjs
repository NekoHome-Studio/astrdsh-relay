#!/usr/bin/env node
/**
 * 星驿 · **假宿主加载器自身**的测试（`scripts/_fake-host.mjs`）。
 *
 * 为什么基础设施也要被测：2026-09-26 的第三方复测报告里，三个 chain 测试在
 * 「插件已部署、真实依赖在位」的机器上**全部变红**，而报错长得像功能回归——
 * 根因是当时的桩搭在插件**真实目录**里、且遇到已存在的目录就跳过，
 * 于是测试静默退化成「用真包跑、默认值物化失败」。环境问题被伪装成功能问题。
 *
 * 这里钉住修复后的三条性质：
 *   ① 物化默认值拿不到形状时**响亮抛错**，不再返回 `{}`；
 *   ② 隔离副本**不碰**插件真实目录（无论那里有没有真实依赖）；
 *   ③ 插件新增宿主机依赖时，桩清单会被**门禁拦下**（否则新依赖会让 chain 测试
 *      在别人机器上以奇怪的方式失败）。
 *
 * 用法：node scripts/test-fake-host.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_DIR, ROOT, STUBS, loadHermeticPlugin, materializeDefaults, realDepsPresent } from './_fake-host.mjs'

let passed = 0
const failed = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push(name)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

console.log('materializeDefaults：拿不到形状必须响亮失败')

await test('Config 没有 __shape ⇒ 抛错，而不是静默返回 {}', () => {
  assert.throws(() => materializeDefaults({}), /__shape/)
})

await test('空 __shape ⇒ 也抛错（物化不出任何东西同样是异常）', () => {
  assert.throws(() => materializeDefaults({ __shape: {} }), /一个默认值都没取到/)
})

await test('形状正常 ⇒ 取到默认值；没有 default 的字段不出现', () => {
  const out = materializeDefaults({
    __shape: {
      a: { __node: { value: 7 } },
      b: { __node: { value: 'x' } },
      c: { __node: {} },
    },
  })
  assert.deepEqual(out, { a: 7, b: 'x' })
})

console.log('\n隔离副本：不碰插件真实目录')

const before = realDepsPresent()
let loaded = null

await test('loadHermeticPlugin 能加载出 apply/name', async () => {
  loaded = await loadHermeticPlugin({ label: '_self-test' })
  assert.equal(typeof loaded.mod.apply, 'function')
  assert.equal(typeof loaded.mod.name, 'string')
})

await test('副本落在 .test-tmp/<label>/pkg 下，而不是插件目录', () => {
  assert.ok(loaded.pkgDir.includes(join('.test-tmp', '_self-test', 'pkg')), loaded.pkgDir)
  assert.ok(!loaded.pkgDir.startsWith(PLUGIN_DIR), '副本不该在插件真实目录里')
})

await test('副本里有全部桩包（含 __STUB__ 标记）', () => {
  for (const name of Object.keys(STUBS)) {
    const dir = join(loaded.pkgDir, 'node_modules', '@deepseek-ai', name)
    assert.ok(existsSync(join(dir, 'index.js')), `副本里缺桩：${name}`)
    assert.ok(existsSync(join(dir, '__STUB__')), `桩缺标记：${name}`)
  }
})

await test('副本带着 package.json（少了它 .js 会被当 CJS，报错对不上真实原因）', () => {
  const pkg = JSON.parse(readFileSync(join(loaded.pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.type, 'module')
})

await test('插件真实目录的依赖情况**没有被本次加载改变**', () => {
  assert.deepEqual(realDepsPresent(), before, '加载过程不该增删插件真实目录里的依赖')
})

await test('插件真实目录里没有被建出 node_modules（本次加载不写那里）', () => {
  if (before.length === 0) {
    assert.ok(!existsSync(join(PLUGIN_DIR, 'node_modules')), '不该在插件目录里建 node_modules')
  }
})

await test('cleanup 之后副本消失', () => {
  const dir = loaded.pkgDir
  loaded.cleanup()
  assert.ok(!existsSync(dir), '副本应当被清掉')
})

console.log('\n桩清单与真实依赖的漂移')

await test('lib/ 里 import 的每个 @deepseek-ai 包，要么有桩、要么是声明过的依赖', () => {
  const declared = new Set([
    ...Object.keys(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).dependencies ?? {}),
    ...Object.keys(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).peerDependencies ?? {}),
  ])
  const imported = new Set()
  for (const file of readdirSync(join(PLUGIN_DIR, 'lib'))) {
    if (!file.endsWith('.js')) continue
    const text = readFileSync(join(PLUGIN_DIR, 'lib', file), 'utf8')
    for (const match of text.matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)) imported.add(match[1])
  }
  assert.ok(imported.size > 0, '一个 @deepseek-ai 导入都没扫到，正则失效了？')
  const unstubbed = [...imported]
    .filter((name) => !name.startsWith('@deepseek-ai/'))
    .concat([...imported].filter((name) => name.startsWith('@deepseek-ai/'))
      .filter((name) => !Object.keys(STUBS).includes(name.replace('@deepseek-ai/', ''))))
  const missing = unstubbed.filter((name) => !declared.has(name))
  assert.deepEqual(missing, [],
    `这些宿主机依赖既没桩、也不在 package.json 的依赖里：${missing.join('、')}——` +
    '新增依赖时请同步 scripts/_fake-host.mjs 的 STUBS，否则 chain 测试会在别人机器上以奇怪的方式失败')
})

await test('realDepsPresent() 如实反映现状（本机应当是空数组）', () => {
  assert.ok(Array.isArray(before))
  console.log(`      本机插件目录里的真实依赖：${before.length ? before.join('、') : '（无）'}`)
})

console.log(`\n通过 ${passed} 项，失败 ${failed.length} 项`)
if (failed.length) {
  console.log(`失败项：${failed.join('、')}`)
  process.exit(1)
}
console.log(`工作区根：${ROOT.replace(PLUGIN_DIR, '<plugin>')}`)
