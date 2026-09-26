#!/usr/bin/env node
/**
 * 自主心跳（B）的**假宿主**端到端测试。
 *
 * 覆盖 `lib/index.js` 里刚接的线：调度闸门 → 发起一轮（插件来源）→ 哨兵抑制 →
 * 发件箱 → `GET /proactive` 的游标与 ack。纯逻辑本身另有 `scripts/test-proactive.mjs`。
 *
 * 两个**必须**遵守的测试纪律（第一版就是踩了它们才全红的）：
 *   ① 心跳轮必须由**真实调度器**发起，不能伪造 `bridge.proactiveTurn`——
 *      伪造出来的状态测不到抑制逻辑（`push` 的闸门看的就是这个字段）。
 *   ② `createBridge` 走的 `/message` 自己会 `followup` 一条**用户消息**，
 *      所以统计心跳必须按 `source.kind === 'plugin'` 过滤，不能数 `followups.length`。
 *
 * 用法：node scripts/test-proactive-chain.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_DIR, ROOT, loadHermeticPlugin, materializeDefaults } from './_fake-host.mjs'

const TMP = join(ROOT, '.test-tmp', 'proactive-chain')
const PREFIX = '/astrbot-relay'
const CONV = 'default:GroupMessage:1000000001'

// 桩建在插件的**隔离副本**里（scripts/_fake-host.mjs），不碰真实目录。
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })


let harnessSeq = 0

function makeHarness(overrides = {}) {
  const id = ++harnessSeq
  const config = {
    ...materializeDefaults(mod.Config),
    token: 't'.repeat(40),
    cwd: ROOT,
    pathPrefix: PREFIX,
    statePath: join(TMP, `state-${id}.json`),
    ...overrides,
  }
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const logs = { info: [], warn: [] }
  const agents = []
  let idleResolve = null
  const idlePromise = new Promise((r) => { idleResolve = r })

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
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    get: () => undefined,
    agents: {
      get: () => undefined,
      create: async ({ sessionId }) => {
        const session = { id: sessionId, rename: async () => {} }
        const agent = {
          id: `agent-${id}-${agents.length + 1}`,
          session,
          followups: [],
          followup(message) { this.followups.push(message) },
          whenIdle: () => idlePromise,
          cancel: () => {},
        }
        agents.push(agent)
        return { agent, dispose: async () => {} }
      },
      resume: async () => { throw new Error('测试路径不应走 resume') },
    },
    sessions: { flush: async () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    sessionQuery: { observeSession: async () => { throw new Error('unexpected') } },
    workspaceRegistry: undefined,
  }
  const ctx = {
    logger,
    inject: (_deps, callback) => { callback(host) },
    effect: (fn) => { const d = fn(); if (typeof d === 'function') effects.push(d); return d },
    get: () => undefined,
  }
  return { config, ctx, host, routes, listeners, effects, logs, agents, releaseIdle: () => idleResolve() }
}

function makeRequest({ method = 'POST', url = '/', headers = {}, body } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    setImmediate(() => { request.emit('data', Buffer.from(text, 'utf8')); request.emit('end') })
  }
  return request
}

function makeResponse() {
  const response = new EventEmitter()
  response.status = 0
  response.headerBag = {}
  const chunks = []
  response.writeHead = (status, headers) => { response.status = status; response.headerBag = headers ?? {} }
  response.write = (chunk) => { chunks.push(String(chunk)); return true }
  response.end = (payload) => { if (payload !== undefined) chunks.push(String(payload)) }
  response.text = () => chunks.join('')
  response.json = () => { try { return JSON.parse(response.text()) } catch { return null } }
  return response
}

async function callRoute(h, path, { method = 'POST', headers = {}, body, query } = {}) {
  const handler = h.routes.get(path)
  assert.ok(handler, `路由未注册：${path}`)
  const request = makeRequest({ method, url: query ? `${path}?${query}` : path, headers, body })
  const response = makeResponse()
  await handler(request, response)
  return response
}

const auth = (h) => ({ authorization: `Bearer ${h.config.token}` })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const frames = (response) => response.text().split('\n')
  .filter((line) => line.startsWith('data: '))
  .map((line) => { try { return JSON.parse(line.slice(6)) } catch { return null } })
  .filter(Boolean)

/** 只数**心跳**发起的那些轮：`/message` 自己也 followup（source.kind === 'user'）。 */
const heartbeats = (agent) => agent.followups.filter((m) => m?.source?.kind === 'plugin')

async function createBridge(h, conversation = CONV) {
  const res = await callRoute(h, `${PREFIX}/message`, {
    headers: { ...auth(h), 'idempotency-key': randomUUID() },
    body: { conversation, text: '你好' },
  })
  assert.equal(res.status, 202, `建桥应 202：${res.text()}`)
  return h.agents.at(-1)
}

const poll = (h, since) => callRoute(h, `${PREFIX}/proactive`, {
  method: 'GET', headers: auth(h), query: since === undefined ? '' : `since=${since}`,
})

/** 等真实调度器发起一次心跳（顺便轮询，给 gates 的 online 提供证据）。 */
async function waitForHeartbeat(h, agent, want = 1) {
  await poll(h)
  for (let i = 0; i < 24; i++) {
    if (heartbeats(agent).length >= want) return
    await sleep(250)
  }
  throw new Error(`心跳未在预期时间内发起（已有 ${heartbeats(agent).length} 条）`)
}

/** 结束当前心跳轮：助手定稿 + turn/end。 */
function finishTurn(h, agent, text) {
  const listener = h.listeners.get('session/event')
  assert.ok(listener, 'session/event 监听器未注册')
  listener(agent.session, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } },
  })
  listener(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
}

const { mod, cleanup } = await loadHermeticPlugin({ label: 'proactive-chain' })

let passed = 0
const failures = []
const test = async (name, fn) => {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`  ✗ ${name}\n      ${String(error.message).split('\n').slice(0, 3).join('\n      ')}`)
  }
}

console.log('GET /proactive')

await test('无鉴权 → 401', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 0 })
  mod.apply(h.ctx, h.config)
  const res = await callRoute(h, `${PREFIX}/proactive`, { method: 'GET', headers: {} })
  assert.equal(res.status, 401)
})

await test('空发件箱 → 200 且 cursor=0、items 为空', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 0 })
  mod.apply(h.ctx, h.config)
  const res = await poll(h)
  assert.equal(res.status, 200)
  assert.deepEqual(res.json(), { ok: true, cursor: 0, items: [] })
})

console.log('\n调度闸门（真实定时器，间隔被夹到 1000ms）')

await test('proactiveHeartbeatMs=0 → 关：不建定时器、绝不发起', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 0, proactiveMinIdleMs: 0 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  await sleep(1300)
  assert.equal(heartbeats(agent).length, 0, '关闭态不该发起心跳')
  assert.equal(h.logs.info.some((m) => m.includes('自主心跳已启用')), false)
})

await test('IM 侧从未轮询 → online=false：窗口与静默都满足也不发起', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  await sleep(1300) // 不调 /proactive
  assert.equal(heartbeats(agent).length, 0, '没人听时不该发起')
})

await test('轮询过 + 静默够 → 发起一轮，消息标为插件来源而非用户消息', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  await waitForHeartbeat(h, agent)
  const message = heartbeats(agent)[0]
  assert.equal(message.role, 'user', 'followup 的入参类型是 UserMessage')
  assert.equal(message.source.kind, 'plugin', '必须标插件来源，否则模型会以为用户刚开口')
  assert.equal(message.source.form, 'notice')
  assert.equal(message.source.plugin, mod.name)
  assert.match(message.content[0].text, /定时心跳/, '提示词应说明这是心跳而非用户消息')
  assert.ok(h.logs.info.some((m) => m.includes('自主心跳')), '应有日志')
})

await test('每日配额用尽后不再发起（maxPerDay=1）', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0, proactiveMaxPerDay: 1 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  await waitForHeartbeat(h, agent)
  assert.equal(heartbeats(agent).length, 1)
  await sleep(2200) // 再等两个扫描周期
  assert.equal(heartbeats(agent).length, 1, '配额用尽后不该再发起')
})

console.log('\n哨兵抑制与发件箱')

await test('整条等于哨兵 → 不入发件箱，且下行通道零痕迹', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  await waitForHeartbeat(h, agent)
  finishTurn(h, agent, '[SILENT]')

  const res = await poll(h)
  assert.deepEqual(res.json().items, [], '沉默不该产生主动消息')
  const types = frames(sse).map((f) => f.type)
  assert.equal(types.includes('message/final'), false, `沉默轮不该下发最终文本：${types.join(',')}`)
  assert.equal(types.includes('turn/end'), false, `心跳轮的 turn/end 也该被抑制：${types.join(',')}`)
  assert.equal(types.includes('turn/start'), false)
})

await test('有正文 → 入发件箱；带 since 再取为空（ack 生效）', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  await waitForHeartbeat(h, agent)
  finishTurn(h, agent, '我想到一件事：可以用心跳做主动播报。')

  const first = (await poll(h)).json()
  assert.equal(first.items.length, 1, `应取到 1 条：${JSON.stringify(first)}`)
  assert.equal(first.items[0].conversation, CONV)
  assert.match(first.items[0].text, /我想到一件事/)
  assert.ok(first.cursor > 0, 'cursor 应前进')
  assert.equal(typeof first.items[0].id, 'number')

  const second = (await poll(h, first.cursor)).json()
  assert.deepEqual(second.items, [], 'ack 之后不该重复投递')
  assert.equal(second.cursor, first.cursor, 'cursor 应保持不变')

  const types = frames(sse).map((f) => f.type)
  assert.equal(types.includes('message/final'), false, `心跳轮输出应只进发件箱：${types.join(',')}`)
})

await test('发件箱有界：超出上限丢最旧的，并 warn', async () => {
  const h = makeHarness({ proactiveHeartbeatMs: 1000, proactiveMinIdleMs: 0, proactiveOutboxSize: 2 })
  mod.apply(h.ctx, h.config)
  const agent = await createBridge(h)
  h.releaseIdle()
  for (const [index, text] of ['第一条', '第二条', '第三条'].entries()) {
    await waitForHeartbeat(h, agent, index + 1)
    finishTurn(h, agent, text)
  }
  const body = (await poll(h)).json()
  assert.equal(body.items.length, 2, `上限为 2，实际 ${body.items.length}`)
  assert.deepEqual(body.items.map((i) => i.text), ['第二条', '第三条'], '应丢最旧的那条')
  assert.ok(h.logs.warn.some((m) => m.includes('发件箱已满')), '丢件应有 warn')
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) console.error(`失败项：${failures.join('、')}`)

cleanup()
rmSync(TMP, { recursive: true, force: true })
try {
  const parent = join(ROOT, '.test-tmp')
  if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
} catch { /* 清理失败不影响结论 */ }
process.exit(failures.length ? 1 : 0)
