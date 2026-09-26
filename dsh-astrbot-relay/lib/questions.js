/**
 * 星驿 · 用户问答链的纯逻辑（DSH 侧）
 *
 * 契约 §16（问答双通道）。本文件是**纯函数**集合——不 import 任何外部包、
 * 不碰 ctx/host——因此可在普通 Node 下单测（见 `scripts/test-questions.mjs`，CI 会跑）。
 *
 * 为什么单独拆出来：`lib/index.js` 顶部要 import `@deepseek-ai/schemastery` /
 * `dsh-brand` / `dsh-agent` / `dsh-llm`，测试环境解析不到，于是整个文件都测不了。
 * 本模块与 `location.js` / `session-title.js` / `state.js` 同属「零依赖、可单测」那一层。
 *
 * 有副作用的部分（挂 waterfall、等答案、结算）仍在 `lib/index.js` 里，
 * 它们靠假宿主驱动（见 `scripts/test-question-chain.mjs`）。
 */

/**
 * 把失败统一包成带 `code` 的 Error。
 *
 * 为什么用 `error.code` 而不是自定义错误类：waterfall 的 `next` 是
 * `() => Promise<...>`、**不接受参数**，想拒绝只能 throw；
 * 而宿主侧只认 `error.code`（错误码全集见 `@deepseek-ai/dsh-user-questions` 的 types）。
 */
export function questionError(code, detail) {
  const error = new Error(detail ? `用户问答未完成：${code}（${detail}）` : `用户问答未完成：${code}`)
  error.code = code
  return error
}

/**
 * 把 AskUserQuestionItem 投影成 IM 侧够用的载荷。
 *
 * 只带渲染必需字段（`id` / `question` / `header` / `options` / `multiSelect`）：
 * 契约里的 `detail` / `intent` 是给 Web UI 的，转发过去只会让 IM 侧多写无用分支。
 *
 * 注意本桥对 IM 的输出统一用**驼峰**（`multiSelect`），而宿主入参写作 `multi_select`。
 */
export function renderQuestion(item) {
  const options = (Array.isArray(item?.options) ? item.options : [])
    .map((option) => ({
      label: String(option?.label ?? ''),
      description: option?.description ? String(option.description) : undefined,
    }))
    .filter((option) => option.label)
  return {
    id: String(item?.id ?? ''),
    question: String(item?.question ?? ''),
    header: item?.header ? String(item.header) : undefined,
    multiSelect: !!item?.multiSelect,
    options,
  }
}

/**
 * `answers[]` → `AskUserQuestionAnswerItem[]`，只留 `{id, selected[], custom?}`。
 *
 * fail-closed：筛完一条都不剩就当作「没答」，**绝不**把空数组当成
 * 「用户选了空」塞回工具——那会让模型以为用户明确选择了「什么都不选」。
 *
 * 注意当前行为：`custom` 只判 `.trim()` 非空，返回值**原样保留**（不回写 trim 后的值）；
 * `selected` 里的纯空白项（如 `'  '`）因为 `filter(Boolean)` 只去空串而**会被保留**。
 * 这两条是既有行为，改动属于行为变更，要单独进 CHANGELOG。
 */
export function normalizeAnswers(list) {
  const out = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.id ?? '')
    if (!id) continue
    const selected = (Array.isArray(item?.selected) ? item.selected : [])
      .map((label) => String(label))
      .filter(Boolean)
    const custom = typeof item?.custom === 'string' && item.custom.trim() ? item.custom : undefined
    if (!selected.length && custom === undefined) continue
    out.push(custom === undefined ? { id, selected } : { id, selected, custom })
  }
  return out
}
