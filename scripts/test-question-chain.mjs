#!/usr/bin/env node
/**
 * 问答链与在途投递单的**假宿主**端到端测试（v0.8.5 的 PLAN §5.2）。
 *
 * 为什么不用普通单测：`askQuestions` / `drainPending` / `settleInflight` / `handleAnswer`
 * 都是 `apply()` 里的闭包，且 `lib/index.js` 顶部 import 了四个 `@deepseek-ai/*` 包。
 * 这里的做法是：
 *   1. 把这四个包**桩在插件的隔离副本里**（`scripts/_fake-host.mjs` 负责复制 lib/ 并搭桩，
 *      **绝不碰插件真实目录**——见该文件里那段事故记录）；
 *   2. 用**假 ctx / 假 host** 调 `apply()`，把路由与事件监听器捕获下来；
 *   3. 通过**真实路由**驱动：`/message` 建桥、`/events`(SSE) 读下行帧、`/answer` 回执、
 *      `/health` 的 `pending[]` 作为 bridge 内部状态的观测窗口。
 *
 * 用法：node scripts/test-question-chain.mjs
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PLUGIN_DIR, ROOT, loadHermeticPlugin, materializeDefaults } from './_fake-host.mjs'

const TMP = join(ROOT, '.test-tmp', 'question-chain')
const PREFIX = '/astrbot-relay'
const CONV = 'default:GroupMessage:1000000001'

// ─────────────────────────────────────────────────────────────────────
// 1. 临时目录（隔离副本与 state 都落在 .test-tmp 下）
// ─────────────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

// ─────────────────────────────────────────────────────────────────────
// 2. 假 ctx / 假 host
// ─────────────────────────────────────────────────────────────────────
/** 从真实的 `Config` 声明里物化默认值（由上面的桩捕获）。 */

let harnessSeq = 0

function makeHarness(overrides = {}) {
  const id = ++harnessSeq
  const config = {
    // 默认值来自插件真实的 Config 声明（经桩捕获），不在这里手抄第二份
    ...materializeDefaults(mod.Config),
    // 必填项与测试专属项
    token: 't'.repeat(40),
    cwd: ROOT,
    pathPrefix: PREFIX,
    statePath: join(TMP, `state-${id}.json`),
    ...overrides,
  }

  const routes = new Map()
  const listeners = new Map()
  const disposers = []
  const logs = { info: [], warn: [] }
  const agents = []
  let idleResolve = null
  let idlePromise = new Promise((r) => { idleResolve = r })
  const resetIdle = () => { idlePromise = new Promise((r) => { idleResolve = r }) }

  const logger = {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.warn.push(String(m)),
  }

  const host = {
    logger,
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    get: () => undefined,
    agents: {
      // 恒为 undefined → 让 /message 走 create 分支
      get: () => undefined,
      create: async ({ sessionId }) => {
        const session = { id: sessionId, rename: async () => {} }
        const agent = {
          id: `agent-${id}-${agents.length + 1}`,
          session,
          followup: () => {},
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
    sessionQuery: {
      observeSession: async (sessionId) => ({
        header: { id: sessionId, cwd: ROOT },
        projections: { values: {} },
        [Symbol.dispose]: () => {},
      }),
    },
    workspaceRegistry: undefined,
  }

  const ctx = {
    logger,
    inject: (_deps, callback) => { callback(host) },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
    get: () => undefined,
  }

  return {
    config, ctx, host, routes, listeners, disposers, logs, agents,
    resolveIdle: () => idleResolve(), resetIdle,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. 假 request / response + 调用工具
// ─────────────────────────────────────────────────────────────────────
function makeRequest({ method = 'POST', url = '/', headers = {}, body } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // 处理器会同步挂上 data/end 监听，所以下一拍再发就够
    setImmediate(() => {
      request.emit('data', Buffer.from(text, 'utf8'))
      request.emit('end')
    })
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
  assert.ok(handler, `路由未注册：${path}（已注册：${[...h.routes.keys()].join(', ')}）`)
  const url = query ? `${path}?${query}` : path
  const request = makeRequest({ method, url, headers, body })
  const response = makeResponse()
  await handler(request, response)
  return response
}

const auth = (h) => ({ authorization: `Bearer ${h.config.token}` })

/** SSE 帧：把 response 文本里的 `data: ` 行解析出来。 */
function frames(response) {
  return response.text()
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => { try { return JSON.parse(line.slice(6)) } catch { return null } })
    .filter(Boolean)
}

/** 在 ms 内看 promise 有没有落定，避免"永挂"把整个测试拖死。 */
async function settledWithin(promise, ms) {
  return Promise.race([
    promise.then(
      (value) => ({ status: 'resolved', value }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((r) => setTimeout(() => r({ status: 'pending' }), ms)),
  ])
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 建桥：走真实 /message，返回 { bridgeAgent }。 */
async function createBridge(h, { text = '你好', conversation = CONV } = {}) {
  const res = await callRoute(h, `${PREFIX}/message`, {
    headers: { ...auth(h), 'idempotency-key': randomUUID() },
    body: { conversation, text },
  })
  assert.equal(res.status, 202, `建桥应 202，实际 ${res.status}：${res.text()}`)
  return { agent: h.agents.at(-1) }
}

/** 触发 turn/end，让在途单结算。 */
function fireTurnEnd(h, agent) {
  const listener = h.listeners.get('session/event')
  assert.ok(listener, 'session/event 监听器未注册')
  listener(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
}

/** 触发 user-questions/request，返回 { promise, nextCalled }。 */
function fireQuestion(h, agent, questions, { signal } = {}) {
  const listener = h.listeners.get('user-questions/request')
  assert.ok(listener, 'user-questions/request 监听器未注册')
  const seen = { nextCalled: false }
  const promise = listener({ agent: { id: agent.id }, questions, signal }, () => {
    seen.nextCalled = true
    return Promise.resolve({ answers: [] })
  })
  return { promise, seen }
}

const SAMPLE_QUESTIONS = [{
  id: 'q1',
  question: '选哪个',
  header: '选择',
  multiSelect: false,
  detail: { internal: true },
  options: [{ label: 'A', description: '选项 A' }, { label: 'B' }],
}]

// ─────────────────────────────────────────────────────────────────────
// 4. 测试
// ─────────────────────────────────────────────────────────────────────
const { mod, cleanup } = await loadHermeticPlugin({ label: 'question-chain' })

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

console.log('/answer 校验阶梯（无需 bridge）')

await test('无 Authorization → 401', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const res = await callRoute(h, `${PREFIX}/answer`, {
    headers: {}, body: { conversation: CONV, callId: 'x', answers: [] },
  })
  assert.equal(res.status, 401)
})

await test('缺 conversation / callId / answers → 400 unsupported', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const res = await callRoute(h, `${PREFIX}/answer`, { headers: auth(h), body: { conversation: CONV } })
  assert.equal(res.status, 400)
  assert.equal(res.json().error.code, 'unsupported')
})

await test('未知对话 → 404 not_found', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const res = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h), body: { conversation: CONV, callId: 'x', answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(res.status, 404)
  assert.equal(res.json().error.code, 'not_found')
})

console.log('\n在途投递单（inflight）')

await test('/message 建桥后 /health 显示 queue=1 attaching=true', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  await createBridge(h)
  const res = await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })
  const pending = res.json().pending
  assert.equal(pending.length, 1, `pending 应有一条：${JSON.stringify(pending)}`)
  assert.equal(pending[0].queue, 1)
  assert.equal(pending[0].attaching, true)
  assert.equal(pending[0].stuckAt, 0)
})

await test('turn/end 结算在途单：queue 归零、attaching 转 false，且幂等', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  fireTurnEnd(h, agent) // 第二次应被幂等吸收
  const res = await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })
  assert.deepEqual(res.json().pending, [], `结算后不该再有在途：${JSON.stringify(res.json().pending)}`)
})

await test('waitTimeoutMs 到点 → stuckAt>0（fail-closed 解闸），随后 turn/end 清零', async () => {
  const h = makeHarness({ waitTimeoutMs: 30 })
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  await sleep(90)
  let pending = (await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })).json().pending
  assert.equal(pending.length, 1)
  assert.equal(pending[0].queue, 0, '超时解闸后 queue 应归零')
  assert.equal(pending[0].attaching, false)
  assert.ok(pending[0].stuckAt > 0, '超时应写入 stuckAt')
  assert.ok(h.logs.warn.some((m) => m.includes('在途投递超过')), '超时应 warn')
  fireTurnEnd(h, agent)
  pending = (await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })).json().pending
  assert.deepEqual(pending, [], '迟到的 turn/end 应清掉 stuckAt')
})

await test('waitTimeoutMs=0 → 关闭超时兜底，仍为在途', async () => {
  const h = makeHarness({ waitTimeoutMs: 0 })
  mod.apply(h.ctx, h.config)
  await createBridge(h)
  await sleep(60)
  const pending = (await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })).json().pending
  assert.equal(pending[0].queue, 1)
  assert.equal(pending[0].stuckAt, 0)
})

console.log('\n问答链：正常路径')

await test('question/required 下发 → /answer 回执 → promise resolve，且一次生效', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })

  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS)
  const required = frames(sse).find((f) => f.type === 'question/required')
  assert.ok(required, `应下发 question/required：${JSON.stringify(frames(sse))}`)
  assert.match(required.callId, /^im-q-/, 'callId 前缀应为 im-q-')
  assert.equal(required.questions.length, 1)
  assert.equal(required.questions[0].id, 'q1')
  assert.equal(required.questions[0].multiSelect, false)
  assert.equal('detail' in required.questions[0], false, 'detail 不该转发给 IM')

  const ok = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h),
    body: { conversation: CONV, callId: required.callId, answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.json(), { ok: true })

  const settled = await settledWithin(promise, 500)
  assert.equal(settled.status, 'resolved', '有效回执应 resolve')
  assert.deepEqual(settled.value, { answers: [{ id: 'q1', selected: ['A'] }] })

  const resolved = frames(sse).find((f) => f.type === 'question/resolved')
  assert.ok(resolved, '应下发 question/resolved')
  assert.equal(resolved.via, 'im')
  assert.equal(resolved.answered, true)

  const again = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h),
    body: { conversation: CONV, callId: required.callId, answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(again.status, 409, '重复回执应 409（一次生效）')
})

await test('无效 answers 回 400 且**不消费**该问答（可重试）', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS)
  const callId = frames(sse).find((f) => f.type === 'question/required').callId

  const bad = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h), body: { conversation: CONV, callId, answers: [{ id: '' }] },
  })
  assert.equal(bad.status, 400, '全是无效条目应 400')

  const good = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h), body: { conversation: CONV, callId, answers: [{ id: 'q1', custom: '自定义' }] },
  })
  assert.equal(good.status, 200, '400 之后仍应能正常回执（说明没被消费）')
  const settled = await settledWithin(promise, 500)
  assert.equal(settled.status, 'resolved')
  assert.deepEqual(settled.value.answers, [{ id: 'q1', selected: [], custom: '自定义' }])
})

console.log('\n问答链：超时与 abort')

await test('到 questionTimeoutMs 无人应 → reject ASK_ABORTED(timeout)，随后 /answer 409', async () => {
  const h = makeHarness({ questionTimeoutMs: 1000 })
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS)
  const callId = frames(sse).find((f) => f.type === 'question/required').callId

  const settled = await settledWithin(promise, 2000)
  assert.equal(settled.status, 'rejected', '超时应 reject')
  assert.equal(settled.error.code, 'ASK_ABORTED')
  assert.match(settled.error.message, /timeout/)

  const resolved = frames(sse).find((f) => f.type === 'question/resolved')
  assert.equal(resolved.via, 'timeout')
  assert.equal(resolved.answered, false)

  const late = await callRoute(h, `${PREFIX}/answer`, {
    headers: auth(h), body: { conversation: CONV, callId, answers: [{ id: 'q1', selected: ['A'] }] },
  })
  assert.equal(late.status, 409, '超时后回执应 409')
})

await test('signal 已 abort → 立即 reject（不得永挂）', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const controller = new AbortController()
  controller.abort()
  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS, { signal: controller.signal })
  const settled = await settledWithin(promise, 500)
  assert.notEqual(settled.status, 'pending', '预中止的 signal 必须立刻落定，否则 turn 永久悬挂')
  assert.equal(settled.status, 'rejected')
  assert.equal(settled.error.code, 'ASK_ABORTED')
  assert.match(settled.error.message, /abort/)
})

await test('await 期间 abort → reject(abort) 且清掉定时器', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const controller = new AbortController()
  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS, { signal: controller.signal })
  controller.abort()
  const settled = await settledWithin(promise, 500)
  assert.equal(settled.status, 'rejected')
  assert.match(settled.error.message, /abort/)
})

console.log('\n问答链：开关与改指结算')

await test('questionsEnabled=false → 交还框架（next 被调），不下发帧', async () => {
  const h = makeHarness({ questionsEnabled: false })
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  const { promise, seen } = fireQuestion(h, agent, SAMPLE_QUESTIONS)
  assert.equal(seen.nextCalled, true, '关掉问答后应原样交还框架')
  assert.deepEqual(frames(sse).filter((f) => String(f.type).startsWith('question/')), [])
  await promise // 交还框架时返回的是 next() 的结果
})

await test('bridgeByAgent 反查不到 → next（fail-open，不越权）', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const listener = h.listeners.get('user-questions/request')
  let nextCalled = false
  await listener({ agent: { id: 'unknown-agent' }, questions: SAMPLE_QUESTIONS }, () => {
    nextCalled = true
    return Promise.resolve({ answers: [] })
  })
  assert.equal(nextCalled, true, '非本桥托管的 agent 应原样交还')
})

await test('/session/adopt 换映射前先 drainPending：在等答案的问答以 retarget 结算', async () => {
  const h = makeHarness()
  mod.apply(h.ctx, h.config)
  const { agent } = await createBridge(h)
  fireTurnEnd(h, agent)
  h.resolveIdle() // 让 whenIdle 落定，adopt 才能通过「无投递在途」的闸门
  await sleep(20)

  const sse = await callRoute(h, `${PREFIX}/events`, {
    method: 'GET', headers: auth(h), query: `conversation=${encodeURIComponent(CONV)}`,
  })
  const { promise } = fireQuestion(h, agent, SAMPLE_QUESTIONS)
  const callId = frames(sse).find((f) => f.type === 'question/required').callId

  const adopted = await callRoute(h, `${PREFIX}/session/adopt`, {
    headers: auth(h), body: { conversation: CONV, sessionId: 'im-adopted-1' },
  })
  assert.equal(adopted.status, 200, `认领应 200：${adopted.text()}`)
  assert.equal(adopted.json().adopted, true)

  const settled = await settledWithin(promise, 500)
  assert.equal(settled.status, 'rejected', '改指应把在等答案的问答结算掉')
  assert.equal(settled.error.code, 'ASK_ABORTED')
  assert.match(settled.error.message, /retarget/)

  const health = (await callRoute(h, `${PREFIX}/health`, { method: 'GET', headers: auth(h) })).json()
  assert.equal(health.pending.length, 0, `drain 后不该还有在途：${JSON.stringify(health.pending)}`)
  assert.ok(callId, '前置条件：确实有过一个待答问题')
})

// ─────────────────────────────────────────────────────────────────────
// 收尾
// ─────────────────────────────────────────────────────────────────────
console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) console.error(`失败项：${failures.join('、')}`)

cleanup()
rmSync(TMP, { recursive: true, force: true })
// TMP 只是 .test-tmp 下的子目录，父目录若已空也一并收掉（与 test-location.mjs 同级）
try {
  const parent = join(ROOT, '.test-tmp')
  if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
} catch { /* 清理失败不影响测试结论 */ }
// 心跳/定时器可能仍在（插件用 unref 的除外），显式退出保证测试进程结束
process.exit(failures.length ? 1 : 0)
