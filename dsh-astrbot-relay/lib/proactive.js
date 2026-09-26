/**
 * 星驿 · 自主心跳（B）的纯逻辑（DSH 侧）
 *
 * 本文件是**纯函数**集合——不 import 任何外部包、不碰 ctx/host、不起定时器——
 * 因此可在普通 Node 下单测（见 `scripts/test-proactive.mjs`，CI 会跑）。
 * 与 `location.js` / `questions.js` / `session-title.js` 同属「零依赖、可单测」那一层。
 *
 * 有副作用的部分（定时器、起一轮、写发件箱）在 `lib/index.js`；
 * 设计依据是 `docs/PLAN-heartbeat.md`。
 */

/** 跳过心跳的原因。**顺序即优先级**：先判便宜的、后判贵的。 */
export const PROACTIVE_SKIP = Object.freeze({
  /** 未启用（proactiveHeartbeatMs <= 0） */
  DISABLED: 'disabled',
  /** 该对话还没有绑定会话（state.json 里没有映射），或没有 live agent */
  NO_SESSION: 'no-session',
  /** 连通性判定为离线：IM 侧没在听，发出去只会白烧一次 LLM 调用且回复会丢 */
  OFFLINE: 'offline',
  /** 有投递在途，或闸门已放但 turn 未必闭合（stuckAt） */
  BUSY: 'busy',
  /** 还有待答的审批或问答：此刻插一轮会把两条等待链搅在一起 */
  PENDING: 'pending',
  /** 静默时长不够 */
  TOO_SOON: 'too-soon',
  /** 不在允许时段内 */
  OUTSIDE_WINDOW: 'outside-window',
  /** 当日配额用完 */
  QUOTA_EXCEEDED: 'quota-exceeded',
})

/** 允许发起 */
export const PROACTIVE_FIRE = 'fire'

/**
 * 把 "HH:MM" 解析成「当日第几分钟」。非法输入返回 null（由调用方决定是忽略还是拒绝）。
 * 只认 24 小时制的 `H:MM` / `HH:MM`。
 */
export function parseClock(text) {
  const match = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/** `nowMs` → 宿主本地时区的「当日第几分钟」。非纯的部分只在这一个函数里。 */
export function localMinutesOfDay(nowMs) {
  const date = new Date(nowMs)
  return date.getHours() * 60 + date.getMinutes()
}

/**
 * 判断是否落在允许时段内。
 *
 * @param minutesOfDay 当日第几分钟（用 {@link localMinutesOfDay} 算）
 * @param window `["09:00","23:00"]`；空数组/非法 = 不限时段
 * @returns 在时段内返回 true
 *
 * 支持跨零点（`["22:00","02:00"]`：start > end 即视为跨天）。
 * 边界取**闭区间**：09:00 与 23:00 都算在时段内——「允许到 23:00」不该把 23:00 整这一分钟排除。
 */
export function inWindow(minutesOfDay, window) {
  if (!Array.isArray(window) || window.length !== 2) return true
  const start = parseClock(window[0])
  const end = parseClock(window[1])
  if (start === null || end === null) return true
  if (start === end) return true // 起止相同视为「全天」，而不是「零长度窗口」
  if (start < end) return minutesOfDay >= start && minutesOfDay <= end
  return minutesOfDay >= start || minutesOfDay <= end
}

/**
 * 八条闸门逐一判定，返回**第一个**不通过的原因（便于排查「为什么它不说话」）。
 *
 * @returns {{ fire: boolean, reason: string }}
 */
export function evaluateProactiveGates({
  enabled,
  hasSession,
  online,
  attaching,
  queue,
  stuckAt,
  approvals,
  questions,
  nowMs,
  lastActiveAt,
  minIdleMs,
  window,
  minutesOfDay,
  usedToday,
  maxPerDay,
}) {
  if (enabled !== true) return { fire: false, reason: PROACTIVE_SKIP.DISABLED }
  if (hasSession !== true) return { fire: false, reason: PROACTIVE_SKIP.NO_SESSION }
  // 离线判定优先于「忙」：离线时既发不出去也没人听，先如实报告这个更根本的原因。
  if (online !== true) return { fire: false, reason: PROACTIVE_SKIP.OFFLINE }
  if (attaching === true || Number(queue) > 0 || Number(stuckAt) > 0) {
    return { fire: false, reason: PROACTIVE_SKIP.BUSY }
  }
  if (Number(approvals) > 0 || Number(questions) > 0) {
    return { fire: false, reason: PROACTIVE_SKIP.PENDING }
  }
  const idle = Number(nowMs) - Number(lastActiveAt ?? 0)
  if (!Number.isFinite(idle) || idle < Number(minIdleMs)) {
    return { fire: false, reason: PROACTIVE_SKIP.TOO_SOON }
  }
  if (!inWindow(minutesOfDay, window)) return { fire: false, reason: PROACTIVE_SKIP.OUTSIDE_WINDOW }
  if (Number(maxPerDay) > 0 && Number(usedToday) >= Number(maxPerDay)) {
    return { fire: false, reason: PROACTIVE_SKIP.QUOTA_EXCEEDED }
  }
  return { fire: true, reason: PROACTIVE_FIRE }
}

/**
 * 这一轮的最终文本是否表示「不说话」。
 *
 * 判据是**整条等于**哨兵（去首尾空白后），或整条为空——**不做子串匹配**：
 * 子串匹配会把「我本想说 `[SILENT]` 这个词」这种正常回复也吞掉。
 * 抑制放在 DSH 侧（出门之前），哨兵有泄漏到群里的风险就只剩这一个判据要守。
 */
export function isSilentReply(text, sentinel) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return true
  return trimmed === String(sentinel ?? '').trim()
}

/** 心跳提示词的占位符：`{conversation}` 与 `{silent}`。未知占位符原样保留（便于发现写错）。 */
export function renderProactivePrompt(template, { conversation, silentSentinel } = {}) {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, key) => {
    switch (key) {
      case 'conversation': return String(conversation ?? '')
      case 'silent': return String(silentSentinel ?? '')
      default: return whole
    }
  })
}

/**
 * 有界发件箱入队：超出 `cap` 时**丢最旧的**并返回丢弃条数。
 * 主动消息的价值随时间衰减（一条两小时前的「我想到一件事」发出去只会让人困惑），
 * 所以宁可丢最旧的，也不要无限堆积。
 */
export function enqueueBounded(list, item, cap) {
  const out = Array.isArray(list) ? list : []
  out.push(item)
  const limit = Math.max(1, Math.trunc(Number(cap) || 1))
  let dropped = 0
  while (out.length > limit) {
    out.shift()
    dropped++
  }
  return { list: out, dropped }
}
