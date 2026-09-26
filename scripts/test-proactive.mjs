#!/usr/bin/env node
/**
 * `dsh-astrbot-relay/lib/proactive.js` 的单元测试（自主心跳 B 的纯逻辑）。
 *
 * 该模块零外部 import，不需要安装 dsh 依赖即可运行。CI 会执行本脚本。
 * 用法：node scripts/test-proactive.mjs
 */
import assert from 'node:assert/strict'
import {
  PROACTIVE_FIRE, PROACTIVE_SKIP, enqueueBounded, evaluateProactiveGates,
  inWindow, isSilentReply, localMinutesOfDay, parseClock, renderProactivePrompt,
} from '../dsh-astrbot-relay/lib/proactive.js'

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

console.log('parseClock / inWindow')

test('parseClock 只认 H:MM 与 HH:MM', () => {
  assert.equal(parseClock('09:00'), 540)
  assert.equal(parseClock('9:05'), 545)
  assert.equal(parseClock('23:59'), 1439)
  assert.equal(parseClock('24:00'), null, '24 点非法')
  assert.equal(parseClock('09:60'), null, '60 分非法')
  assert.equal(parseClock('0900'), null)
  assert.equal(parseClock(''), null)
  assert.equal(parseClock(undefined), null)
})

test('不跨零点的时段，边界取闭区间', () => {
  const w = ['09:00', '23:00']
  assert.equal(inWindow(parseClock('09:00'), w), true, '起点算在内')
  assert.equal(inWindow(parseClock('23:00'), w), true, '终点算在内')
  assert.equal(inWindow(parseClock('08:59'), w), false)
  assert.equal(inWindow(parseClock('23:01'), w), false)
  assert.equal(inWindow(parseClock('12:00'), w), true)
})

test('跨零点时段（start > end）', () => {
  const w = ['22:00', '02:00']
  assert.equal(inWindow(parseClock('23:30'), w), true)
  assert.equal(inWindow(parseClock('01:00'), w), true)
  assert.equal(inWindow(parseClock('02:00'), w), true)
  assert.equal(inWindow(parseClock('03:00'), w), false)
  assert.equal(inWindow(parseClock('12:00'), w), false)
})

test('空/非法/等值时段一律视为「不限」', () => {
  assert.equal(inWindow(0, []), true)
  assert.equal(inWindow(0, ['09:00']), true, '长度不足视为不限')
  assert.equal(inWindow(0, ['nonsense', '23:00']), true, '非法视为不限')
  assert.equal(inWindow(600, ['09:00', '09:00']), true, '起止相同视为全天，不是零长度')
  assert.equal(inWindow(0, undefined), true)
})

test('localMinutesOfDay 落在 0..1439', () => {
  const minutes = localMinutesOfDay(Date.now())
  assert.ok(minutes >= 0 && minutes <= 1439, `实际 ${minutes}`)
})

console.log('\nevaluateProactiveGates')

const FIRE_BASE = {
  enabled: true,
  hasSession: true,
  online: true,
  attaching: false,
  queue: 0,
  stuckAt: 0,
  approvals: 0,
  questions: 0,
  nowMs: 1_000_000,
  lastActiveAt: 1_000_000 - 3_600_000,
  minIdleMs: 1_800_000,
  window: [],
  minutesOfDay: 600,
  usedToday: 0,
  maxPerDay: 4,
}

test('全部条件成立时放行', () => {
  assert.deepEqual(evaluateProactiveGates(FIRE_BASE), { fire: true, reason: PROACTIVE_FIRE })
})

test('八条闸门各自能拦住，并给出对应原因', () => {
  const cases = [
    [{ enabled: false }, PROACTIVE_SKIP.DISABLED],
    [{ hasSession: false }, PROACTIVE_SKIP.NO_SESSION],
    [{ online: false }, PROACTIVE_SKIP.OFFLINE],
    [{ attaching: true }, PROACTIVE_SKIP.BUSY],
    [{ queue: 1 }, PROACTIVE_SKIP.BUSY],
    [{ stuckAt: 1 }, PROACTIVE_SKIP.BUSY],
    [{ approvals: 1 }, PROACTIVE_SKIP.PENDING],
    [{ questions: 1 }, PROACTIVE_SKIP.PENDING],
    [{ lastActiveAt: FIRE_BASE.nowMs - 1000 }, PROACTIVE_SKIP.TOO_SOON],
    [{ minutesOfDay: 60, window: ['09:00', '23:00'] }, PROACTIVE_SKIP.OUTSIDE_WINDOW],
    [{ usedToday: 4 }, PROACTIVE_SKIP.QUOTA_EXCEEDED],
  ]
  for (const [override, expected] of cases) {
    const got = evaluateProactiveGates({ ...FIRE_BASE, ...override })
    assert.equal(got.fire, false, `${JSON.stringify(override)} 应被拦`)
    assert.equal(got.reason, expected, `${JSON.stringify(override)} 原因应为 ${expected}，实际 ${got.reason}`)
  }
})

test('优先级：离线先于忙、忙先于待答、待答先于静默不足', () => {
  assert.equal(
    evaluateProactiveGates({ ...FIRE_BASE, online: false, queue: 9 }).reason,
    PROACTIVE_SKIP.OFFLINE,
  )
  assert.equal(
    evaluateProactiveGates({ ...FIRE_BASE, queue: 9, questions: 1 }).reason,
    PROACTIVE_SKIP.BUSY,
  )
  assert.equal(
    evaluateProactiveGates({ ...FIRE_BASE, questions: 1, lastActiveAt: FIRE_BASE.nowMs }).reason,
    PROACTIVE_SKIP.PENDING,
  )
})

test('maxPerDay=0 表示不限配额', () => {
  assert.equal(evaluateProactiveGates({ ...FIRE_BASE, usedToday: 999, maxPerDay: 0 }).fire, true)
})

test('lastActiveAt 缺失/非法时按「静默不足」拦下（不炸）', () => {
  assert.equal(evaluateProactiveGates({ ...FIRE_BASE, lastActiveAt: undefined }).reason, PROACTIVE_SKIP.TOO_SOON)
  assert.equal(evaluateProactiveGates({ ...FIRE_BASE, lastActiveAt: 'x' }).reason, PROACTIVE_SKIP.TOO_SOON)
})

console.log('\nisSilentReply')

test('整条等于哨兵 → 沉默（去首尾空白）', () => {
  assert.equal(isSilentReply('[SILENT]', '[SILENT]'), true)
  assert.equal(isSilentReply('  [SILENT]  ', '[SILENT]'), true)
})

test('空串与纯空白 → 沉默', () => {
  assert.equal(isSilentReply('', '[SILENT]'), true)
  assert.equal(isSilentReply('   \n ', '[SILENT]'), true)
  assert.equal(isSilentReply(undefined, '[SILENT]'), true)
})

test('子串命中**不**算沉默（避免吞掉正常回复）', () => {
  assert.equal(isSilentReply('我觉得没什么可说的，[SILENT]', '[SILENT]'), false)
  assert.equal(isSilentReply('[SILENT] 但补充一句', '[SILENT]'), false)
})

test('大小写敏感（约定就是精确串）', () => {
  assert.equal(isSilentReply('[silent]', '[SILENT]'), false)
})

console.log('\nrenderProactivePrompt')

test('替换 {conversation} 与 {silent}', () => {
  const out = renderProactivePrompt('对话 {conversation}：不想说就只回 {silent}', {
    conversation: 'default:GroupMessage:1', silentSentinel: '[SILENT]',
  })
  assert.equal(out, '对话 default:GroupMessage:1：不想说就只回 [SILENT]')
})

test('未知占位符原样保留（写错要看得见）', () => {
  assert.equal(renderProactivePrompt('{nope}', {}), '{nope}')
})

console.log('\nenqueueBounded')

test('未超上限时原样累积', () => {
  const { list, dropped } = enqueueBounded([1, 2], 3, 5)
  assert.deepEqual(list, [1, 2, 3])
  assert.equal(dropped, 0)
})

test('超上限时丢最旧的并报丢弃数', () => {
  const { list, dropped } = enqueueBounded([1, 2, 3], 4, 3)
  assert.deepEqual(list, [2, 3, 4], '应丢最旧的 1')
  assert.equal(dropped, 1)
})

test('非法 cap 退化为 1（保底不无限堆积）', () => {
  const { list } = enqueueBounded([1, 2, 3], 4, 0)
  assert.deepEqual(list, [4])
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
