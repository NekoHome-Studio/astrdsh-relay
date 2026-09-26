#!/usr/bin/env node
/**
 * `dsh-astrbot-relay/lib/questions.js` 的单元测试。
 *
 * 该模块零外部 import，所以不需要安装 dsh 依赖即可运行。CI 会执行本脚本。
 * 带副作用的那半条链（挂 waterfall、等答案、结算）在 `scripts/test-question-chain.mjs`。
 *
 * 用法：node scripts/test-questions.mjs
 */
import assert from 'node:assert/strict'
import { normalizeAnswers, questionError, renderQuestion } from '../dsh-astrbot-relay/lib/questions.js'

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

console.log('questionError')

test('code 挂在 error.code 上（宿主侧只认这个字段）', () => {
  const error = questionError('ASK_ABORTED')
  assert.ok(error instanceof Error)
  assert.equal(error.code, 'ASK_ABORTED')
  assert.match(error.message, /ASK_ABORTED/)
  assert.doesNotMatch(error.message, /（/, '无 detail 时不该出现括号')
})

test('detail 出现在消息里', () => {
  assert.match(questionError('ASK_ABORTED', 'timeout').message, /（timeout）/)
})

console.log('\nrenderQuestion')

test('只带渲染必需字段，剥掉给 Web UI 的 detail / intent', () => {
  const out = renderQuestion({
    id: 'q1',
    question: '选哪个',
    header: '标题',
    multiSelect: true,
    detail: { why: '内部原因' },
    intent: 'x',
    options: [{ label: 'A', description: '描述 A' }, { label: 'B' }],
  })
  assert.deepEqual(Object.keys(out).sort(), ['header', 'id', 'multiSelect', 'options', 'question'])
  assert.equal(out.id, 'q1')
  assert.equal(out.question, '选哪个')
  assert.equal(out.header, '标题')
  assert.equal(out.multiSelect, true)
  assert.equal(out.options.length, 2)
  assert.deepEqual(out.options[0], { label: 'A', description: '描述 A' })
  assert.equal(out.options[1].description, undefined, '缺 description 时是 undefined，不是空串')
  assert.equal('detail' in out, false)
  assert.equal('intent' in out, false)
})

test('label 为空的选项被过滤', () => {
  const out = renderQuestion({ id: 'q', options: [{ label: '' }, { label: 'A' }, {}] })
  assert.deepEqual(out.options, [{ label: 'A', description: undefined }])
})

test('item 为 undefined 时给出空骨架而不抛', () => {
  assert.deepEqual(renderQuestion(undefined), {
    id: '', question: '', header: undefined, multiSelect: false, options: [],
  })
})

test('multiSelect 归一为布尔（非布尔真值 → true）', () => {
  assert.equal(renderQuestion({ id: 'q', multiSelect: 1 }).multiSelect, true)
  assert.equal(renderQuestion({ id: 'q', multiSelect: 0 }).multiSelect, false)
  assert.equal(renderQuestion({ id: 'q' }).multiSelect, false)
})

test('options 非数组时视为空数组', () => {
  assert.deepEqual(renderQuestion({ id: 'q', options: 'nope' }).options, [])
})

console.log('\nnormalizeAnswers')

test('有效条目原样保留', () => {
  assert.deepEqual(normalizeAnswers([{ id: 'q1', selected: ['A'] }]), [{ id: 'q1', selected: ['A'] }])
})

test('id 为空即丢弃', () => {
  assert.deepEqual(normalizeAnswers([{ id: '', selected: ['A'] }, { selected: ['A'] }]), [])
})

test('既无 selected 也无 custom 即丢弃（fail-closed）', () => {
  assert.deepEqual(normalizeAnswers([{ id: 'q1' }, { id: 'q2', selected: [] }]), [])
})

test('custom 只判 trim 非空，返回值不回写 trim（既有行为）', () => {
  assert.deepEqual(normalizeAnswers([{ id: 'q1', custom: '  文字  ' }]), [
    { id: 'q1', selected: [], custom: '  文字  ' },
  ])
  assert.deepEqual(normalizeAnswers([{ id: 'q1', custom: '   ' }]), [], '纯空白视同没答')
  assert.deepEqual(normalizeAnswers([{ id: 'q1', custom: 42 }]), [], '非字符串 custom 不算数')
})

test('selected 里的空串被去掉，但纯空白项会留下（既有行为）', () => {
  assert.deepEqual(normalizeAnswers([{ id: 'q1', selected: ['', 'A', ''] }])[0].selected, ['A'])
  assert.deepEqual(normalizeAnswers([{ id: 'q1', selected: ['  '] }])[0].selected, ['  '])
})

test('非数组输入返回空数组而不抛', () => {
  assert.deepEqual(normalizeAnswers(null), [])
  assert.deepEqual(normalizeAnswers('x'), [])
  assert.deepEqual(normalizeAnswers({ id: 'q1' }), [])
  assert.deepEqual(normalizeAnswers(undefined), [])
})

test('selected 非数组时视为空', () => {
  assert.deepEqual(normalizeAnswers([{ id: 'q1', selected: 'A' }]), [])
})

test('混合有效与无效时只留有效', () => {
  const out = normalizeAnswers([
    { id: '', selected: ['A'] },
    { id: 'q1', selected: ['A'] },
    { id: 'q2' },
    { id: 'q3', custom: 'C' },
  ])
  assert.deepEqual(out, [{ id: 'q1', selected: ['A'] }, { id: 'q3', selected: [], custom: 'C' }])
})

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length) {
  console.error(`失败项：${failures.join('、')}`)
  process.exit(1)
}
