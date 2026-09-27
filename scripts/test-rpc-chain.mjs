#!/usr/bin/env node
/**
 * 星驿 · **控制面转发**（`POST /rpc`，契约 §11）的假宿主端到端测试。
 *
 * 这条路由没有对应的「纯逻辑」测试文件，因为它的全部价值就在**接线**上：
 *
 *     auth → 签名 → 读体 → 形状 → 白名单 → 流式 → 粒度 → 转发 → 审计
 *
 * 九道里任何一道少接了，都只在「真的有人拿 IM 调了一次」时才暴露。
 * 所以这里不测函数，测**线**。
 *
 * ## 四条口径（改断言前先读 `lib/index.js:1828-1918` 的注释，别凭印象改）
 *
 *   ① **400 与 403 必须分开。** 粒度对不上是「请求写错了」（400 `unsupported`），
 *      方法不在白名单或属流式是「你不许调它」（403 `forbidden`）。混成一个码，
 *      IM 侧要么白重试同一个必然失败的请求，要么把权限问题当成自己的参数问题。
 *   ② **坏 JSON 与空体不得退化成 `{}` 去派发一个零参 RPC。** 这条单独有断言，
 *      并且顺手断言宿主**一次都没被调用**——「没派发」比「派发失败」更该被钉住。
 *   ③ **业务失败走 HTTP 200**（信封里 `ok:false`）；只有网关本身不可用才是 500。
 *      把业务失败折成 500，等于让 IM 侧把「宿主说你没权限」读成「宿主挂了」。
 *   ④ **审计行成功失败都记**；被 403 拦下的调用不该留审计（它连日志都不该进）。
 *
 * ## 隔离
 *
 * 走 `scripts/_fake-host.mjs` 的 `loadHermeticPlugin()`：插件被复制到
 * `.test-tmp/<label>/pkg/`，桩只建在那份副本里，真实目录永不被写入。
 * 且**不用** `_fake-host.mjs` 里现成的 `makeHarness`（没有那个东西）——
 * harness 在本文件内按 `/rpc` 的需要现搭，唯一必须动的是 `makeRequest`：
 * panel chain 那份不带请求体，而 `/rpc` 的**全部**输入都在请求体里。
 *
 * 用法：node scripts/test-rpc-chain.mjs
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PLUGIN_DIR, ROOT, loadHermeticPlugin, materializeDefaults } from './_fake-host.mjs'

const PREFIX = '/astrbot-relay'
/**
 * ⚠️ 别用 node:path 的 `join` 拼路由：Windows 上它给的是 `\astrbot-relay
pc`，
 * 而 `lib/index.js:2716` 那份 `join` 是**纯正斜杠**拼接（插件的路由表按这个键注册）。
 * 拿 path.join 去查 routes，会在 Windows 上得到一条假失败。
 */
const routePath = (path) => `${PREFIX.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`
const TOKEN = 'T'.repeat(40)
const SIGNATURE_SKEW_MS = 60_000

// 桩建在插件的**隔离副本**里；fixtures 目录放在它下面，且必须等 load 之后再建
// ——`loadHermeticPlugin` 会 `rmSync` 整个 `.test-tmp/<label>`。
const { mod, cleanup } = await loadHermeticPlugin({ label: 'rpc-chain' })
const TMP = join(ROOT, '.test-tmp', 'rpc-chain', 'fixtures')
mkdirSync(TMP, { recursive: true })

let seq = 0

/** 预置一份 state.json：apply() 阶段就要把它读掉，路径非法会让加载直接失败。 */
function seedState(records = {}) {
  const path = join(TMP, `state-${++seq}.json`)
  writeFileSync(path, `${JSON.stringify({ version: 1, conversations: records }, null, 2)}\n`)
  return path
}

const DEFAULT_DISPATCH = async (endpoint) => ({ ok: true, value: { echo: endpoint } })

/**
 * @param config   覆盖 Config 字段（会先物化一遍默认值，再盖上去）
 * @param dispatch 自定义转发实现；省略则回 `{ ok: true, ... }`
 * @param gateway  'default' | 'none'（服务缺席）| 'broken'（dispatchRpc 不是函数）
 */
function makeHarness({ config: configOverrides = {}, dispatch, gateway = 'default' } = {}) {
  const config = {
    ...materializeDefaults(mod.Config),
    token: TOKEN,
    cwd: ROOT,
    pathPrefix: PREFIX,
    signatureSkewMs: SIGNATURE_SKEW_MS,
    statePath: seedState(),
    ...configOverrides,
  }
  const routes = new Map()
  const logs = { info: [], warn: [] }
  const logger = {
    info: (m) => logs.info.push(String(m)),
    warn: (m) => logs.warn.push(String(m)),
    error: (m) => logs.warn.push(String(m)),
  }

  /** 每次转发的实参都留档：测的是「插件往外递了什么」，不只是「回了什么」。 */
  const dispatchCalls = []
  const dispatchRpc = async (endpoint, payload, signal) => {
    dispatchCalls.push({ endpoint, payload, signal })
    return dispatch === undefined ? DEFAULT_DISPATCH(endpoint) : dispatch(endpoint, payload, signal)
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
  if (gateway === 'default') host.typertGateway = { dispatchRpc }
  else if (gateway === 'broken') host.typertGateway = { dispatchRpc: 'not-a-function' }
  // 'none'：整个服务缺席，等价于本进程装错了。

  const ctx = {
    logger,
    inject: (_deps, callback) => { callback(host) },
    effect: (fn) => fn(),
    get: () => undefined,
  }
  return { config, ctx, host, routes, logs, dispatchCalls }
}

/**
 * 请求桩。比 panel chain 那份多两样：**可注入请求体**、**带 signal**。
 *
 * `signal` 不是装饰：handleRpc 把它作为第三参递给宿主网关，
 * 断言它原样透传，等于顺手钉住「转发是带着可取消语义出去的」。
 */
function makeRequest({ method = 'POST', url = '/', headers = {}, body, signal } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.url = url
  request.headers = headers
  request.signal = signal
  // 超 1 MiB 时 readRawBody 会调它。EventEmitter 没有这个方法，给个 no-op，
  // 让「超限 → 400」这条用例能跑到判定，而不是先撞 TypeError。
  request.destroy = () => {}
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

/** 按契约 §5.2 算签名：对象是**服务端收到的原文**，不是重新序列化过的 JSON。 */
function signHeaders(rawBody, { ts = Date.now(), token = TOKEN } = {}) {
  const digest = createHmac('sha256', token).update(`${ts}.${rawBody ?? ''}`, 'utf8').digest('hex')
  return { 'x-bridge-timestamp': String(ts), 'x-bridge-signature': `sha256=${digest}` }
}

/** apply() 一次，拿回它注册好的路由表。 */
function boot(overrides = {}) {
  const h = makeHarness(overrides)
  mod.apply(h.ctx, h.config)
  return h
}

/**
 * 打一次 `POST /rpc`。
 *
 * 请求体的注入时机是本文件最容易踩的地方：`authorize` 失败时函数**不读体**就返回了，
 * 所以数据必须在 handler 已经跑到 `await readRawBody`（监听器已挂）之后才 emit。
 * `process.nextTick` 正好落在那个缝里——此时若监听器不存在（401 路径），
 * emit `data` / `end` 也只是空转，EventEmitter 对这些事件没有监听器不报错。
 */
async function rpc(h, { body, headers = {}, signed = false, ts, signal } = {}) {
  const handler = h.routes.get(routePath('/rpc'))
  assert.ok(handler, '控制面转发路由未注册')
  const allHeaders = { authorization: `Bearer ${h.config.token}`, ...headers }
  if (signed) Object.assign(allHeaders, signHeaders(body, { ts: ts ?? Date.now(), token: h.config.token }))
  const request = makeRequest({ headers: allHeaders, body, signal })
  const response = makeResponse()
  response.request = request
  const done = handler(request, response)
  process.nextTick(() => {
    if (body !== undefined) request.emit('data', Buffer.from(body, 'utf8'))
    request.emit('end')
  })
  await done
  return response
}

/** 一次「端点合法、白名单缺省」的转发。 */
function ask(h, payload, extra = {}) {
  return rpc(h, { body: JSON.stringify(payload), ...extra })
}

function errorCode(response) {
  return response.json()?.error?.code
}

const signalOf = () => new AbortController().signal

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

console.log('路由与契约')

await test('第 13 条路由已注册，路径与契约 ROUTES.RPC 一致', async () => {
  const h = boot()
  assert.ok(h.routes.has(routePath('/rpc')), '控制面转发路由未注册')
  const { ROUTES } = await import(pathToFileURL(join(PLUGIN_DIR, 'lib', 'contract.js')).href)
  assert.equal(ROUTES.RPC, '/rpc')
  assert.ok(h.routes.has(routePath(ROUTES.RPC)), `契约 ROUTES.RPC=${ROUTES.RPC} 对应的路由未注册`)
})

console.log('\n鉴权（Bearer）')

await test('无 Authorization ⇒ 401 unauthorized，且宿主未被调用', async () => {
  const h = boot()
  const response = await rpc(h, { body: JSON.stringify({ endpoint: 'agentPresets/list' }), headers: { authorization: undefined } })
  assert.equal(response.status, 401)
  assert.equal(errorCode(response), 'unauthorized')
  assert.equal(h.dispatchCalls.length, 0)
})

await test('坏 token ⇒ 401（响应体不区分「token 错」与「token 缺」）', async () => {
  const h = boot()
  const bad = await rpc(h, { body: '{}', headers: { authorization: `Bearer ${'X'.repeat(40)}` } })
  const missing = await rpc(h, { body: '{}', headers: { authorization: undefined } })
  assert.equal(bad.status, 401)
  assert.equal(bad.status, missing.status)
  assert.equal(bad.text(), missing.text(), '两种失败必须回同一个响应体')
})

await test('非 Bearer 前缀（Basic / 裸 token）⇒ 401', async () => {
  const h = boot()
  for (const authorization of [`Basic ${TOKEN}`, TOKEN, `bearer ${TOKEN}`]) {
    const response = await rpc(h, { body: '{}', headers: { authorization } })
    assert.equal(response.status, 401, `authorization=${authorization} 不该放行`)
  }
})

await test('大写 Authorization 头同样认（底层会小写化，但实现里显式兼容了）', async () => {
  const h = boot()
  const response = await rpc(h, {
    body: JSON.stringify({ endpoint: 'agentPresets/list' }),
    headers: { authorization: undefined, Authorization: `Bearer ${TOKEN}` },
  })
  assert.equal(response.status, 200, response.text())
})

console.log('\n鉴权（hmacMode 强化签名）')

await test('hmacMode 关闭（默认）时，不带签名也能过——签名是可选强化，不是第二道 token', async () => {
  const h = boot()
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 200, response.text())
})

await test('hmacMode + 正确签名 ⇒ 200；签名对象是**服务端收到的原文**', async () => {
  const h = boot({ config: { hmacMode: true } })
  // 刻意用带缩进与键序「不对」的 JSON：若实现是「parse 后再 stringify 重算」，
  // 这里必然对不上。签原文这条口径就靠这个用例钉住。
  const body = '{\n  "args": {},\n  "endpoint": "agentPresets/list"\n}'
  const response = await rpc(h, { body, signed: true })
  assert.equal(response.status, 200, response.text())
})

await test('hmacMode + 缺签名头 ⇒ 401', async () => {
  const h = boot({ config: { hmacMode: true } })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 401)
})

await test('hmacMode + 签名不匹配 ⇒ 401', async () => {
  const h = boot({ config: { hmacMode: true } })
  const body = JSON.stringify({ endpoint: 'agentPresets/list' })
  const headers = signHeaders(body, { token: 'W'.repeat(40) })
  const response = await rpc(h, { body, headers })
  assert.equal(response.status, 401)
})

await test('hmacMode + 时间戳过期 / 来自未来 ⇒ 401（时间窗是本地钟的 |Δ|）', async () => {
  const h = boot({ config: { hmacMode: true } })
  const body = JSON.stringify({ endpoint: 'agentPresets/list' })
  for (const skew of [-(SIGNATURE_SKEW_MS * 3), SIGNATURE_SKEW_MS * 3]) {
    const response = await rpc(h, { body, signed: true, ts: Date.now() + skew })
    assert.equal(response.status, 401, `偏移 ${skew}ms 不该放行`)
  }
})

await test('hmacMode + 时间戳非数字（空串 / NaN）⇒ 401', async () => {
  const h = boot({ config: { hmacMode: true } })
  const body = JSON.stringify({ endpoint: 'agentPresets/list' })
  const headers = { ...signHeaders(body), 'x-bridge-timestamp': '' }
  assert.equal((await rpc(h, { body, headers })).status, 401)
})

console.log('\n请求体形状（400，且绝不放行到宿主）')

await test('空体 ⇒ 400，宿主一次都没被调用（不许退化成 {} 去派发零参 RPC）', async () => {
  const h = boot()
  const response = await rpc(h, { body: undefined })
  assert.equal(response.status, 400)
  assert.equal(errorCode(response), 'unsupported')
  assert.match(response.json().error.message, /endpoint/)
  assert.equal(h.dispatchCalls.length, 0, '空体竟然递到了宿主')
})

await test('坏 JSON ⇒ 400，宿主一次都没被调用', async () => {
  const h = boot()
  for (const body of ['{', '{"endpoint":}', 'null-ish', 'NaN']) {
    const response = await rpc(h, { body })
    assert.equal(response.status, 400, `body=${body}`)
    assert.equal(errorCode(response), 'unsupported')
  }
  assert.equal(h.dispatchCalls.length, 0)
})

await test('顶层是数组 / 标量 ⇒ 400（"JSON 对象"是硬要求）', async () => {
  const h = boot()
  for (const body of ['[]', '[{"endpoint":"agentPresets/list"}]', '"x"', '123', 'true', 'null']) {
    const response = await rpc(h, { body })
    assert.equal(response.status, 400, `body=${body}`)
    assert.equal(errorCode(response), 'unsupported')
  }
  assert.equal(h.dispatchCalls.length, 0)
})

await test('超过 1 MiB ⇒ 400（readRawBody 掐断后返回 null，不是半截 JSON）', async () => {
  const h = boot()
  const body = `{"endpoint":"agentPresets/list","pad":"${'p'.repeat(1_100_000)}"}`
  const response = await rpc(h, { body })
  assert.equal(response.status, 400)
  assert.equal(h.dispatchCalls.length, 0)
})

console.log('\nendpoint 形状（400）')

await test('endpoint 缺失 / 非字符串 / 空白 ⇒ 400', async () => {
  const h = boot()
  for (const payload of [{}, { endpoint: 123 }, { endpoint: null }, { endpoint: '' }, { endpoint: '   ' }, { endpoint: {} }]) {
    const response = await ask(h, payload)
    assert.equal(response.status, 400, JSON.stringify(payload))
    assert.equal(errorCode(response), 'unsupported')
  }
  assert.equal(h.dispatchCalls.length, 0)
})

await test('不是两段（三段 / 一段 / 空段 / 点号写法）⇒ 400', async () => {
  const h = boot()
  for (const endpoint of ['a/b/c', 'agentPresets', 'agentPresets/list/extra', 'a/', '/b', '/', 'host.describe']) {
    const response = await ask(h, { endpoint })
    assert.equal(response.status, 400, `endpoint=${endpoint}`)
    assert.match(response.json().error.message, /<namespace>\/<method>/)
  }
  assert.equal(h.dispatchCalls.length, 0)
})

await test('endpoint 不做 trim：带空格的合法名落进「白名单外」⇒ 403', async () => {
  const h = boot()
  const response = await ask(h, { endpoint: ' agentPresets/list ' })
  assert.equal(response.status, 403)
  assert.equal(errorCode(response), 'forbidden')
})

console.log('\n白名单与流式（403）')

await test('形状合法但不在描述符表（host/describe、workspace/list、goals/blocked）⇒ 403', async () => {
  const h = boot()
  for (const endpoint of ['host/describe', 'workspace/list', 'goals/blocked', 'nope/nope']) {
    const response = await ask(h, { endpoint })
    assert.equal(response.status, 403, `endpoint=${endpoint} 该是 403 而不是 ${response.status}`)
    assert.equal(errorCode(response), 'forbidden')
    assert.match(response.json().error.message, /不在控制面白名单里/)
  }
  assert.equal(h.dispatchCalls.length, 0, '403 竟然还是递到了宿主')
})

await test('在描述符表里、但没进白名单（settings/mutate）⇒ 403，不是 400', async () => {
  const h = boot()
  const response = await ask(h, { endpoint: 'settings/mutate', args: { ns: 'x', ops: [], expectedRevision: 1 } })
  assert.equal(response.status, 403)
  assert.equal(errorCode(response), 'forbidden')
})

await test('白名单为空数组 ⇒ 一律 403（配成什么样就按什么样跑）', async () => {
  const h = boot({ config: { allowedRpcMethods: [] } })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 403)
})

await test('流式四类进白名单 ⇒ **加载期**抛错，而不是运行期 403', async () => {
  // 这条把设计意图钉死：v1 的 /rpc 不暴露流式控制面（契约 §11.3 第 2 条），
  // 写进白名单是**配置自相矛盾**，就该在加载时响亮地失败。
  for (const endpoint of ['session/control', 'session/follow', 'workspace/follow', 'workspaceFiles/changes']) {
    assert.throws(
      () => boot({ config: { allowedRpcMethods: [endpoint] } }),
      /流式方法，v1 的 \/rpc 不转发流式控制面/,
      `${endpoint} 该让加载失败`,
    )
  }
})

await test('白名单里的非法项 / 表外方法 ⇒ 加载期抛错（拼错名字不该伪装成「权限不够」）', async () => {
  assert.throws(() => boot({ config: { allowedRpcMethods: [''] } }), /非法项/)
  assert.throws(() => boot({ config: { allowedRpcMethods: [123] } }), /非法项/)
  assert.throws(() => boot({ config: { allowedRpcMethods: ['host/describe'] } }), /不在描述符表里/)
  assert.throws(() => boot({ config: { allowedRpcMethods: ['host.describe'] } }), /不在描述符表里/)
  assert.throws(() => boot({ config: { allowedRpcMethods: 'agentPresets/list' } }), /必须是字符串数组/)
})

console.log('\nargs 粒度（400）')

await test('零参方法多传一个键（agentPresets/list + {x:1}）⇒ 400，宿主未被调用', async () => {
  const h = boot()
  const response = await ask(h, { endpoint: 'agentPresets/list', args: { x: 1 } })
  assert.equal(response.status, 400)
  assert.equal(errorCode(response), 'unsupported')
  assert.match(response.json().error.message, /args\.x 不属于方法 agentPresets\/list/)
  assert.match(response.json().error.message, /允许的键：无/)
  assert.equal(h.dispatchCalls.length, 0)
})

await test('args 非对象 / 数组 / 标量 ⇒ 400', async () => {
  const h = boot()
  for (const args of ['x', 1, true, [], ['a']]) {
    const response = await ask(h, { endpoint: 'agentPresets/list', args })
    assert.equal(response.status, 400, JSON.stringify(args))
  }
  assert.equal(h.dispatchCalls.length, 0)
})

await test('args 缺省 / null ⇒ 200，且递给宿主的是 `{ args: {} }`（不是 undefined）', async () => {
  const h = boot()
  assert.equal((await ask(h, { endpoint: 'agentPresets/list' })).status, 200)
  assert.equal((await ask(h, { endpoint: 'agentPresets/list', args: null })).status, 200)
  assert.equal(h.dispatchCalls.length, 2)
  for (const call of h.dispatchCalls) {
    assert.deepEqual(Object.keys(call.payload), ['args'], '第二参只该有 args 一个键')
    assert.deepEqual(call.payload.args, {})
  }
})

await test('wire 键 ≠ 参数名：session/list 用 `_request` 放行，用 `request` 挡下', async () => {
  // 全表 28 条参数名与 wire 不同名（lib/rpc-methods.js 导言第 2 条）。
  // 这条用例是那批重命名的代表，写错键必须 400，而不是透传给宿主折成 gateway/internal。
  const h = boot()
  const ok = await ask(h, { endpoint: 'session/list', args: { _request: { limit: 10 } } })
  assert.equal(ok.status, 200, ok.text())
  const bad = await ask(h, { endpoint: 'session/list', args: { request: { limit: 10 } } })
  assert.equal(bad.status, 400)
  assert.match(bad.json().error.message, /args\.request 不属于方法 session\/list/)
  assert.equal(h.dispatchCalls.length, 1, '写错键的那次不该被转发出去')
})

console.log('\n转发与信封（200 / 500）')

await test('合法请求 ⇒ 宿主收到 (endpoint, { args }, signal)，第三参原样透传', async () => {
  const h = boot()
  const signal = signalOf()
  const response = await rpc(h, {
    body: JSON.stringify({ endpoint: 'workspaceFiles/read', args: { workspaceFileScopeId: 's', path: 'a.txt' } }),
    signal,
  })
  assert.equal(response.status, 200, response.text())
  const [call] = h.dispatchCalls
  assert.equal(call.endpoint, 'workspaceFiles/read')
  assert.deepEqual(Object.keys(call.payload), ['args'])
  assert.deepEqual(call.payload.args, { workspaceFileScopeId: 's', path: 'a.txt' })
  assert.equal(call.signal, signal)
  assert.deepEqual(response.json(), { ok: true, value: { echo: 'workspaceFiles/read' } })
})

await test('业务失败（信封 ok:false）⇒ **HTTP 200** + 信封原样透出', async () => {
  const envelope = { ok: false, error: { code: 'gateway/internal', message: '宿主说不行' } }
  const h = boot({ dispatch: async () => envelope })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 200, '业务失败不该折成 500')
  assert.deepEqual(response.json(), envelope)
})

await test('dispatchRpc 抛错 ⇒ 500 internal，消息指出是网关侧', async () => {
  const h = boot({ dispatch: async () => { throw new Error('gateway down') } })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 500)
  assert.equal(errorCode(response), 'internal')
  assert.match(response.json().error.message, /控制面转发失败：gateway down/)
})

await test('宿主没提供 typertGateway ⇒ 500 internal（本进程装错了，不是调用方写错了）', async () => {
  const h = boot({ gateway: 'none' })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 500)
  assert.match(response.json().error.message, /宿主未提供 typertGateway\.dispatchRpc/)
})

await test('typertGateway 在、但 dispatchRpc 不是函数 ⇒ 同样 500，不是 TypeError 逃逸', async () => {
  const h = boot({ gateway: 'broken' })
  const response = await ask(h, { endpoint: 'agentPresets/list' })
  assert.equal(response.status, 500)
  assert.equal(errorCode(response), 'internal')
})

console.log('\n审计')

await test('成功与业务失败各留一行 [rpc-audit]，ok= 如实反映信封', async () => {
  const h = boot({ dispatch: async (endpoint) => (endpoint === 'pluginInventory/list' ? { ok: false } : { ok: true }) })
  await ask(h, { endpoint: 'agentPresets/list' })
  await ask(h, { endpoint: 'pluginInventory/list' })
  const audits = h.logs.info.filter((line) => line.includes('[rpc-audit]'))
  assert.equal(audits.length, 2)
  assert.ok(audits.some((line) => line.includes('agentPresets/list ok=true')), audits.join(' | '))
  assert.ok(audits.some((line) => line.includes('pluginInventory/list ok=false')), audits.join(' | '))
})

await test('被 403 拦下的调用不留审计（它连宿主都没碰）', async () => {
  const h = boot()
  await ask(h, { endpoint: 'host/describe' })
  assert.ok(!h.logs.info.some((line) => line.includes('[rpc-audit]')))
})

await test('401 也不留审计，且 warn 是空的（鉴权失败不是异常路径）', async () => {
  const h = boot()
  await rpc(h, { body: '{}', headers: { authorization: undefined } })
  assert.ok(!h.logs.info.some((line) => line.includes('[rpc-audit]')))
  assert.deepEqual(h.logs.warn, [])
})

cleanup()

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.log(`失败项：${failures.join('、')}`)
  process.exit(1)
}
