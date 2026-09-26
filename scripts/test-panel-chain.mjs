#!/usr/bin/env node
/**
 * 星驿 · WebUI 面板的**假宿主**端到端测试。
 *
 * 纯逻辑另有 `scripts/test-panel.mjs`；这里验的是 `lib/index.js` 里刚接的那条线：
 * 路由注册 → 访问判定（未启用 / 跨站 / 非回环）→ 快照内容与真实 records 一致。
 *
 * 三条测试纪律：
 *   ① 用**预置 state.json** 造出映射，而不是驱动 `/message`——面板读的就是 records，
 *      而 records 在 apply() 时从 state 文件加载；这样每个用例只需一个文件。
 *   ② 访问判定必须**用真实的请求头**跑（host / sec-fetch-site / origin），
 *      不能直接调 `panelAccessDecision`——那样测的是纯函数，不是接线。
 *   ③ 快照里**绝不能出现 token**：面板是诊断口，不是后门。这条单独有一个用例。
 *
 * 用法：node scripts/test-panel-chain.mjs
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(ROOT, 'dsh-astrbot-relay')
const TMP = join(ROOT, '.test-tmp', 'panel-chain')
const PREFIX = '/astrbot-relay'
const CONV = 'default:GroupMessage:1000000001'

const STUBS = {
  schemastery: `const chain = () => {
  const node = { value: undefined, required: false }
  const api = {
    default(v) { node.value = v; return api },
    required() { node.required = true; return api },
    description() { return api },
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

function ensureStubs() {
  const created = []
  for (const [name, source] of Object.entries(STUBS)) {
    const dir = join(PLUGIN, 'node_modules', '@deepseek-ai', name)
    if (existsSync(dir)) continue
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: `@deepseek-ai/${name}`, version: '0.0.0-test-stub', type: 'module',
      main: 'index.js', exports: { '.': './index.js' },
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'index.js'), source)
    writeFileSync(join(dir, '__STUB__'), '由 scripts/test-panel-chain.mjs 创建，可安全删除\n')
    created.push(dir)
  }
  return created
}

function removeStubs(created) {
  for (const dir of created) rmSync(dir, { recursive: true, force: true })
  for (const dir of [join(PLUGIN, 'node_modules', '@deepseek-ai'), join(PLUGIN, 'node_modules')]) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true })
    } catch { /* 清理失败不影响结论 */ }
  }
}

const createdStubs = ensureStubs()
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

function materializeDefaults(Config) {
  const out = {}
  for (const [key, field] of Object.entries(Config?.__shape ?? {})) {
    if (field?.__node?.value !== undefined) out[key] = field.__node.value
  }
  return out
}

let seq = 0

/** 预置一份 state.json：面板读的就是它加载出来的 records。 */
function seedState(records) {
  const path = join(TMP, `state-${++seq}.json`)
  writeFileSync(path, `${JSON.stringify({ version: 1, conversations: records }, null, 2)}\n`)
  return path
}

function makeHarness(overrides = {}) {
  const id = ++seq
  const config = {
    ...materializeDefaults(mod.Config),
    token: 'T'.repeat(40),
    cwd: ROOT,
    pathPrefix: PREFIX,
    statePath: seedState({
      [CONV]: {
        dshSessionId: 'im-seeded-1',
        cwd: null,
        policy: 'one-to-one',
        createdAt: 1_700_000_000_000,
        lastActiveAt: Date.now() - 5_000,
        seq: 3,
      },
    }),
    ...overrides,
  }
  const routes = new Map()
  const logs = { info: [], warn: [] }
  const logger = {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.warn.push(String(m)),
  }
  const host = {
    logger,
    webServer: {
      register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
    },
    on: () => () => {},
    get: () => undefined,
    agents: { get: () => undefined, create: async () => { throw new Error('unexpected') } },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sessionQuery: {},
    workspaceRegistry: undefined,
  }
  const ctx = {
    logger,
    inject: (_deps, callback) => { callback(host) },
    effect: (fn) => { const d = fn(); return d },
    get: () => undefined,
  }
  return { id, config, ctx, host, routes, logs }
}

function makeRequest({ method = 'GET', url = '/', headers = {} } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  return request
}

function makeResponse() {
  const response = new EventEmitter()
  response.status = 0
  const chunks = []
  response.writeHead = (status) => { response.status = status }
  response.write = (chunk) => { chunks.push(String(chunk)); return true }
  response.end = (payload) => { if (payload !== undefined) chunks.push(String(payload)) }
  response.text = () => chunks.join('')
  response.json = () => { try { return JSON.parse(response.text()) } catch { return null } }
  return response
}

const mod = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)

/** 跑一个 harness：apply() 一次，然后返回它注册好的路由表。 */
function boot(overrides = {}) {
  const h = makeHarness(overrides)
  mod.apply(h.ctx, h.config)
  return h
}

async function getPanel(h, headers = {}) {
  const handler = h.routes.get(`${PREFIX}/panel/status`)
  assert.ok(handler, '面板路由未注册')
  const response = makeResponse()
  await handler(makeRequest({ headers }), response)
  return response
}

const LOOPBACK = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }

let passed = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}

console.log('路由与访问判定')

await test('面板路由已注册，且**不在**契约 ROUTES 表里（不参与版本协商）', async () => {
  const h = boot({ panelEnabled: true })
  assert.ok(h.routes.has(`${PREFIX}/panel/status`))
  const { ROUTES } = await import(pathToFileURL(join(PLUGIN, 'lib', 'contract.js')).href)
  const values = Object.values(ROUTES)
  assert.ok(!values.includes('/panel/status'), '面板路由不该混进契约常量表')
})

await test('默认（panelEnabled 未开）⇒ 404，且正文里没有任何快照内容', async () => {
  const h = boot()
  const response = await getPanel(h, LOOPBACK)
  assert.equal(response.status, 404)
  assert.ok(!response.text().includes(CONV), '未启用时不该泄露对话键')
})

await test('开启 + 回环同源 ⇒ 200，且**不需要** Bearer（它不是 IM 协议的一部分）', async () => {
  const h = boot({ panelEnabled: true })
  const response = await getPanel(h, LOOPBACK)
  assert.equal(response.status, 200, response.text())
  assert.equal(response.json().ok, true)
})

await test('cross-site ⇒ 403', async () => {
  const h = boot({ panelEnabled: true })
  const response = await getPanel(h, { ...LOOPBACK, 'sec-fetch-site': 'cross-site' })
  assert.equal(response.status, 403)
})

await test('非回环 Host ⇒ 403；开 panelAllowRemote 后 ⇒ 200', async () => {
  const strict = boot({ panelEnabled: true })
  const denied = await getPanel(strict, { host: '10.0.0.5:3080', 'sec-fetch-site': 'same-origin' })
  assert.equal(denied.status, 403)
  assert.match(denied.json().error.message, /non-loopback/)

  const relaxed = boot({ panelEnabled: true, panelAllowRemote: true })
  const allowed = await getPanel(relaxed, { host: '10.0.0.5:3080', 'sec-fetch-site': 'same-origin' })
  assert.equal(allowed.status, 200)
})

await test('Origin 与 Host 不同源 ⇒ 403（防 DNS rebinding）', async () => {
  const h = boot({ panelEnabled: true })
  const response = await getPanel(h, { ...LOOPBACK, origin: 'http://evil.example' })
  assert.equal(response.status, 403)
})

console.log('\n快照内容')

await test('预置的映射出现在快照里，且字段与 state 一致', async () => {
  const h = boot({ panelEnabled: true })
  const body = (await getPanel(h, LOOPBACK)).json()
  assert.equal(body.counts.conversations, 1)
  const row = body.conversations[0]
  assert.equal(row.conversation, CONV)
  assert.equal(row.dshSessionId, 'im-seeded-1')
  assert.equal(row.seq, 3)
  assert.ok(row.idleMs >= 0)
})

await test('标题按 sessionTitleTemplate 渲染（反向定位的抓手）', async () => {
  const h = boot({ panelEnabled: true })
  const body = (await getPanel(h, LOOPBACK)).json()
  const row = body.conversations[0]
  assert.equal(row.title, '星驿 · default/GroupMessage/1000000001')
})

await test('无对话级覆盖时，cwd 给的是**最终生效**的全局目录，来源 global', async () => {
  const h = boot({ panelEnabled: true })
  const row = (await getPanel(h, LOOPBACK)).json().conversations[0]
  // 与契约 §12.1/§12.3 同口径：不是「null」而是「回落到全局的那个值」+ 来源标注。
  assert.equal(row.cwd, ROOT)
  assert.equal(row.cwdSource, 'global')
})

await test('记录里写了对话级 cwd 时，cwdSource 变 conversation', async () => {
  const h = boot({
    panelEnabled: true,
    statePath: seedState({
      [CONV]: {
        dshSessionId: 'im-seeded-2', cwd: 'C:\\somewhere', policy: 'one-to-one',
        createdAt: 1, lastActiveAt: 2, seq: 0,
      },
    }),
  })
  const row = (await getPanel(h, LOOPBACK)).json().conversations[0]
  assert.equal(row.cwd, 'C:\\somewhere')
  assert.equal(row.cwdSource, 'conversation')
})

await test('IM 从未轮询时 online=false、sinceLastPollMs=null', async () => {
  const h = boot({ panelEnabled: true })
  const im = (await getPanel(h, LOOPBACK)).json().im
  assert.equal(im.online, false)
  assert.equal(im.sinceLastPollMs, null)
  assert.equal(im.pollCount, 0)
})

await test('IM 轮询过一次 /proactive 之后，面板就报 online 且计数 +1', async () => {
  const h = boot({ panelEnabled: true })
  const handler = h.routes.get(`${PREFIX}/proactive`)
  const response = makeResponse()
  await handler(makeRequest({ headers: { authorization: `Bearer ${h.config.token}` } }), response)
  assert.equal(response.status, 200)

  const im = (await getPanel(h, LOOPBACK)).json().im
  assert.equal(im.online, true)
  assert.equal(im.pollCount, 1)
  assert.ok(im.sinceLastPollMs !== null && im.sinceLastPollMs < 5000)
})

await test('快照里不含 token / 密钥（面板是诊断口，不是后门）', async () => {
  const h = boot({ panelEnabled: true })
  const text = (await getPanel(h, LOOPBACK)).text().toLowerCase()
  for (const needle of ['token', 'bearer', 'authorization', 'secret']) {
    assert.ok(!text.includes(needle), `快照里出现了 ${needle}`)
  }
})

removeStubs(createdStubs)

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('、')}`)
  process.exit(1)
}
