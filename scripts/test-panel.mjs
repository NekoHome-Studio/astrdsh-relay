#!/usr/bin/env node
/**
 * 星驿 · WebUI 面板纯逻辑的单元测试（`dsh-astrbot-relay/lib/panel.js`）。
 *
 * 该模块零外部 import，所以不需要安装 dsh 依赖即可单测；CI 会跑。
 * 用法：node scripts/test-panel.mjs
 */
import {
  OUTBOX_PREVIEW, PANEL_ROUTE, buildPanelSnapshot, hostOf, panelAccessDecision,
} from '../dsh-astrbot-relay/lib/panel.js'

let passed = 0
const failed = []
const test = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed.push(name)
    console.log(`  ✗ ${name}\n      ${error.message}`)
  }
}
const eq = (actual, expected, what = '') => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what}期望 ${b}，实际 ${a}`)
}
const assert = (ok, message) => { if (!ok) throw new Error(message) }

console.log('hostOf')
test('去掉端口', () => eq(hostOf('127.0.0.1:3080'), '127.0.0.1'))
test('小写化', () => eq(hostOf('LOCALHOST:3080'), 'localhost'))
test('IPv6 保留方括号', () => eq(hostOf('[::1]:3080'), '[::1]'))
test('空输入给空串，不抛', () => eq(hostOf(undefined), ''))

console.log('\npanelAccessDecision')
const base = { enabled: true, hostHeader: '127.0.0.1:3080', secFetchSite: 'same-origin' }
test('未启用 ⇒ 404（不是 403：403 等于对外宣告这里有个东西）',
  () => eq(panelAccessDecision({ ...base, enabled: false }), { ok: false, status: 404, reason: 'disabled' }))
test('本机同源 ⇒ 放行', () => eq(panelAccessDecision(base).ok, true))
test('cross-site ⇒ 403', () => eq(panelAccessDecision({ ...base, secFetchSite: 'cross-site' }).reason, 'cross-site'))
test('Sec-Fetch-Site 缺失不当作跨站（老浏览器/非浏览器客户端）',
  () => eq(panelAccessDecision({ ...base, secFetchSite: undefined }).ok, true))
test('非回环 + 未开 allowRemote ⇒ 403', () => {
  const decision = panelAccessDecision({ ...base, hostHeader: '10.0.0.5:3080' })
  eq(decision.status, 403)
  eq(decision.reason, 'non-loopback')
})
test('非回环 + 开了 allowRemote ⇒ 放行', () => {
  eq(panelAccessDecision({ ...base, hostHeader: '10.0.0.5:3080', allowRemote: true }).ok, true)
})
test('Origin 与 Host 不同源 ⇒ 403（防 DNS rebinding）', () => {
  const decision = panelAccessDecision({ ...base, originHeader: 'http://evil.example' })
  eq(decision.reason, 'origin-mismatch')
})
test('Origin 与 Host 同源 ⇒ 放行', () => {
  eq(panelAccessDecision({ ...base, originHeader: 'http://127.0.0.1:3080' }).ok, true)
})
test('Origin 不是合法 URL ⇒ 403 而不是抛出去', () => {
  eq(panelAccessDecision({ ...base, originHeader: 'not a url' }).reason, 'bad-origin')
})

console.log('\nbuildPanelSnapshot')
const NOW = 1_700_000_000_000
const snapshot = buildPanelSnapshot({
  bridgeVersion: '6',
  uptimeMs: 1234,
  pathPrefix: '/astrbot-relay',
  policy: 'one-to-one',
  cwd: 'C:\\work',
  statePath: 'C:\\st\\state.json',
  stateExisted: true,
  heartbeatMs: 15000,
  sessionTitleTemplate: '星驿 · {platform}/{messageType}/{sessionId}',
  now: NOW,
  conversations: [
    {
      conversation: 'default:GroupMessage:1', title: '星驿 · default/GroupMessage/1',
      dshSessionId: 'im-a', cwd: null, cwdSource: 'global', lastActiveAt: NOW - 5000, seq: 3,
      outbox: [{ id: 1, text: 'x' }, { id: 2, text: 'y' }, { id: 3, text: 'z' }, { id: 4, text: 'w' }],
      proactiveTurn: true, live: true,
    },
    { conversation: 'default:FriendMessage:2', title: 'T2', dshSessionId: null, lastActiveAt: 0 },
    { conversation: '', title: '空会话键应被丢掉' },
    null,
  ],
  pending: [{ conversation: 'default:GroupMessage:1', approvals: 1 }],
  im: { lastPollAt: NOW - 1000, imAliveMs: 180000, pollCount: 42 },
})
test('末尾的空会话键与 null 被丢掉（面板不该出现无主行）',
  () => eq(snapshot.conversations.length, 2))
test('计数与内容一致', () => {
  eq(snapshot.counts.conversations, 2)
  eq(snapshot.counts.mapped, 1)       // 第二条还没建会话
  eq(snapshot.counts.withOutbox, 1)
  eq(snapshot.counts.pending, 1)
})
test('发件箱只带前几条（面板不是数据倾倒口）', () => {
  eq(snapshot.conversations[0].outbox.length, OUTBOX_PREVIEW)
  eq(snapshot.conversations[0].outboxSize, 4)
})
test('idleMs 由 now 与 lastActiveAt 算出', () => eq(snapshot.conversations[0].idleMs, 5000))
test('从未活动过时 idleMs 不变成负数或 NaN', () => {
  const idle = snapshot.conversations[1].idleMs
  assert(Number.isFinite(idle) && idle >= 0, `idleMs=${idle}`)
})
test('cwd 为 null 时如实给 null（前端据此显示「跟随全局」）',
  () => eq(snapshot.conversations[0].cwd, null))
test('IM 在线判定：最后一轮询在存活窗口内', () => {
  eq(snapshot.im.online, true)
  eq(snapshot.im.sinceLastPollMs, 1000)
})
test('从未轮询过时 online=false、sinceLastPollMs=null（不是 0，语义不同）', () => {
  const cold = buildPanelSnapshot({ now: NOW, im: { imAliveMs: 180000 } })
  eq(cold.im.online, false)
  eq(cold.im.sinceLastPollMs, null)
})
test('轮询过期 ⇒ online=false', () => {
  const stale = buildPanelSnapshot({ now: NOW, im: { lastPollAt: NOW - 200000, imAliveMs: 180000 } })
  eq(stale.im.online, false)
})
test('空快照不抛（刚装上、还没有任何对话时也得能渲染）', () => {
  const empty = buildPanelSnapshot({ now: NOW })
  eq(empty.ok, true)
  eq(empty.conversations, [])
  eq(empty.counts.conversations, 0)
})
test('快照里不含 token 之类字段（只读面板不该带密钥）', () => {
  const text = JSON.stringify(snapshot)
  for (const needle of ['token', 'secret', 'authorization', 'Bearer']) {
    assert(!text.toLowerCase().includes(needle.toLowerCase()), `快照里出现了 ${needle}`)
  }
})
test('面板路由落在 /panel/status（与 IM 协议路由分开）', () => eq(PANEL_ROUTE, '/panel/status'))

console.log(`\n通过 ${passed} 项，失败 ${failed.length} 项`)
if (failed.length) {
  console.log(`失败项：${failed.join('、')}`)
  process.exit(1)
}
