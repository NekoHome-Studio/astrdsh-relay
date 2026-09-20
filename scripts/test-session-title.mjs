#!/usr/bin/env node
/**
 * 会话标题写入（R3「反向定位」）的单元测试。
 *
 * lib/session-title.js 刻意只 import 内置 + ./location.js，所以本脚本能在
 * **没装 dsh 依赖**的普通 Node 下直接跑（CI 会执行本脚本）。
 *
 * 测的是四条降级路径与一条正常路径：
 *   正常写入 / 未知占位符 / 空白标题 / 服务缺席 / 服务抛错（invalid + 其他）/ 绝不抛。
 * 断言的重点不是「标题字符串长什么样」，而是**副作用有没有发生**：
 * rename 该被调用时必须恰好调用一次、参数正确；不该被调用时一次都不能调。
 *
 * 用法：node scripts/test-session-title.mjs
 */
import assert from 'node:assert/strict'
import { applySessionTitle, TITLE_MAX_BYTES, TITLE_RESULT, titleByteLength } from '../dsh-astrbot-relay/lib/session-title.js'

let passed = 0
const failures = []

const test = (name, fn) => {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures.push(name)
    console.error(`  ✗ ${name}\n      ${error.message.split('\n')[0]}`)
  }
}

/** 造一个只记录调用的假 session-title 服务，返回 [service, calls]。 */
const fakeTitles = (impl) => {
  const calls = []
  const service = {
    rename(session, title) {
      calls.push({ session, title })
      if (impl) return impl(session, title, calls.length)
      return { title, eventSeq: 7, source: { kind: 'user' } }
    },
  }
  return [service, calls]
}

// 会话对象只被原样透传，这里不需要它有真行为——反倒是**对象身份**要被断言，
// 所以固定一个常量，测试里用 === 比对。
const SESSION = { id: 'sess-abc', cwd: 'E:/tmp/ws' }
const TEMPLATE = '星驿 · {platform}/{messageType}/{sessionId}'
const CONVERSATION = 'default:GroupMessage:123456'

console.log('applySessionTitle')

test('正常写入：rename 收到同一个 session 对象与渲染后的标题', () => {
  const [titles, calls] = fakeTitles()
  const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
  assert.equal(result.ok, true)
  assert.equal(result.reason, TITLE_RESULT.OK)
  assert.equal(calls.length, 1, 'rename 应恰好调用一次')
  assert.equal(calls[0].session, SESSION, '必须把 live session 对象原样交出去（不是 id、不是副本）')
  assert.equal(calls[0].title, '星驿 · default/GroupMessage/123456')
  assert.equal(result.title, calls[0].title)
  assert.equal(result.rendered, calls[0].title)
})

test('落盘结果优先：服务归一化后的 title 覆盖 rendered', () => {
  const [titles] = fakeTitles((session, title) => ({ title: '被服务改写过的标题', eventSeq: 1 }))
  const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
  assert.equal(result.ok, true)
  assert.equal(result.title, '被服务改写过的标题')
  assert.equal(result.rendered, '星驿 · default/GroupMessage/123456', 'rendered 必须是交出去的原文')
})

test('accepted 快照原样带回（调用方记日志要用 eventSeq）', () => {
  const [titles] = fakeTitles()
  const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
  assert.equal(result.accepted.eventSeq, 7)
  assert.equal(result.accepted.source.kind, 'user')
})

test('未知占位符原样保留，不替换成空串（配置写错要看得见）', () => {
  const [titles, calls] = fakeTitles()
  applySessionTitle({ titles, session: SESSION, template: '{platform}/{typo}/{sessionId}', conversation: CONVERSATION })
  assert.equal(calls[0].title, 'default/{typo}/123456')
})

test('{conversation} 占位符给出完整 UMO（含冒号也不切坏）', () => {
  const [titles, calls] = fakeTitles()
  applySessionTitle({ titles, session: SESSION, template: '[{conversation}]', conversation: 'tg:PrivateMessage:user:42' })
  assert.equal(calls[0].title, '[tg:PrivateMessage:user:42]')
})

test('超长标题照交不误：不在这里做第二遍截断', () => {
  const [titles, calls] = fakeTitles()
  const long = '群'.repeat(60)
  const result = applySessionTitle({ titles, session: SESSION, template: '{sessionId}', conversation: `default:GroupMessage:${long}` })
  assert.equal(result.ok, true)
  assert.ok(titleByteLength(result.rendered) > TITLE_MAX_BYTES, '交出去的原文应超过上限')
  assert.equal(calls[0].title, long, '原文一字不减地交给 dsh 侧去截')
})

test('会话缺席（时序排在 create/resume 之前）→ no-session，且不调服务', () => {
  for (const session of [undefined, null]) {
    const [titles, calls] = fakeTitles()
    const result = applySessionTitle({ titles, session, template: TEMPLATE, conversation: CONVERSATION })
    assert.equal(result.ok, false)
    assert.equal(result.reason, TITLE_RESULT.NO_SESSION)
    assert.equal(calls.length, 0, '没有 live session 时绝不能碰服务')
  }
})

test('渲染结果为空白 → empty-title，且不调服务', () => {
  const [titles, calls] = fakeTitles()
  const result = applySessionTitle({ titles, session: SESSION, template: '   ', conversation: CONVERSATION })
  assert.equal(result.ok, false)
  assert.equal(result.reason, TITLE_RESULT.EMPTY_TITLE)
  assert.equal(calls.length, 0)
})

test('服务缺席 → service-missing（静默降级，不是错误）', () => {
  const cases = [undefined, null, {}, { rename: 'not-a-function' }]
  for (const titles of cases) {
    const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
    assert.equal(result.ok, false)
    assert.equal(result.reason, TITLE_RESULT.SERVICE_MISSING, `titles=${JSON.stringify(titles)} 应归为 service-missing`)
    assert.equal(result.rendered, '星驿 · default/GroupMessage/123456', '降级也要把渲染结果带回去，便于日志')
  }
})

test('SessionTitleInvalidError → invalid-title（按 name 字符串判定，不 import 类）', () => {
  const [titles] = fakeTitles(() => {
    const error = new Error('title is empty after normalization')
    error.name = 'SessionTitleInvalidError'
    throw error
  })
  const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
  assert.equal(result.ok, false)
  assert.equal(result.reason, TITLE_RESULT.INVALID_TITLE)
  assert.equal(result.error.name, 'SessionTitleInvalidError')
})

test('会话不 live / 服务已 dispose → rename-failed，原错误带回', () => {
  const [titles] = fakeTitles(() => { throw new Error('session "sess-abc" is not live in this store') })
  const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
  assert.equal(result.ok, false)
  assert.equal(result.reason, TITLE_RESULT.RENAME_FAILED)
  assert.match(result.error.message, /not live/)
})

test('绝不抛错：服务抛字符串、抛 undefined 也只归类', () => {
  for (const thrown of ['boom', undefined, { message: '对象型错误' }]) {
    const [titles] = fakeTitles(() => { throw thrown })
    const result = applySessionTitle({ titles, session: SESSION, template: TEMPLATE, conversation: CONVERSATION })
    assert.equal(result.ok, false)
    assert.equal(result.reason, TITLE_RESULT.RENAME_FAILED)
  }
})

test('空参调用不炸（调用点写错也要能活）', () => {
  const result = applySessionTitle()
  assert.equal(result.ok, false)
  assert.equal(result.reason, TITLE_RESULT.NO_SESSION)
})

console.log('\ntitleByteLength / TITLE_MAX_BYTES')

test('字节数按 UTF-8 算：中文 3 字节、· 2 字节、ASCII 1 字节', () => {
  assert.equal(titleByteLength('abc'), 3)
  assert.equal(titleByteLength('中文'), 6)
  // 默认模板里的分隔符是 U+00B7（MIDDLE DOT），落在 Latin-1 补充区，**只占 2 字节**；
  // 3 字节的是 U+30FB「・」或 U+2022「•」，别把两者搞混（曾经搞混过一次）。
  assert.equal(titleByteLength('·'), 2)
  assert.equal(titleByteLength('・'), 3)
})

test('上限 80 是字节而不是字符（默认模板前缀就吃掉三十几字节）', () => {
  assert.equal(TITLE_MAX_BYTES, 80)
  const prefix = '星驿 · default/GroupMessage/'
  // 星(3)驿(3)空格(1)·(2)空格(1)default(7)/(1)GroupMessage(12)/(1) = 31
  assert.equal(titleByteLength(prefix), 31)
  assert.ok(titleByteLength(prefix) < TITLE_MAX_BYTES, '默认前缀本身不该超限')
  // 27 个中文字 = 81 字节 > 80，会被截；26 个 = 78 字节，刚好放得下。
  assert.ok(titleByteLength('群'.repeat(27)) > TITLE_MAX_BYTES)
  assert.ok(titleByteLength('群'.repeat(26)) <= TITLE_MAX_BYTES)
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
