/**
 * 星驿 · WebUI 面板的**纯逻辑**（DSH 侧）
 *
 * 本文件是纯函数集合——不 import 任何外部包、不碰 ctx/host——因此可在普通 Node 下
 * 单测（见 `scripts/test-panel.mjs`）。与 `location.js` / `proactive.js` / `state.js`
 * 同属「零依赖、可单测」那一层。
 *
 * 两件事：
 *
 *   1. `buildPanelSnapshot()` —— 把宿主侧的活状态压成一份**只读快照**给浏览器。
 *      刻意只读：面板是**诊断面**，不是控制面（改指/认领那些写操作留给 IM 指令
 *      与将来的 P5 控制面，那里的权限门是硬要求——见 `docs/DESIGN.md` §7.3.1）。
 *   2. `panelAccessDecision()` —— 决定这次请求能不能读快照。
 *      ⚠️ 这里**不是认证**：它只挡「跨站读取」与「非本机访问」，不证明调用者是谁。
 *      理由与代价见函数注释与 `docs/WEBUI.md`。
 */

/** 面板路由。**刻意不放进 `contract.js` 的 `ROUTES`**：那张表是 IM↔DSH 协议，
 *  进去就要镜像到 `contract.py` 并升 `bridgeVersion`；而面板只是 DSH 本机的 UI 面，
 *  IM 永远不会调它。混进去等于用一个协议版本号去记录一件与协议无关的事。 */
export const PANEL_ROUTE = '/panel/status'

/** 快照里每条对话最多带几条发件箱条目（面板不该变成数据倾倒口）。 */
export const OUTBOX_PREVIEW = 3

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 从 `Host` 头里切出主机名（去掉端口与 IPv6 方括号）。 */
export function hostOf(hostHeader) {
  const raw = String(hostHeader ?? '').trim()
  if (!raw) return ''
  const withoutPort = raw.startsWith('[')
    ? raw.slice(0, raw.indexOf(']') + 1)
    : raw.split(':')[0]
  return withoutPort.toLowerCase()
}

/**
 * 这次请求能不能读面板快照。
 *
 * **这不是认证**，别把它当权限门用。它做三件事，每件都对应一类真实误用：
 *
 *   1. `enabled` 为假 → 404（**不是 403**：403 等于对外宣告「这里有个东西」）。
 *   2. `Sec-Fetch-Site` 是 `cross-site` → 拒绝。浏览器跨站发起的读取一律挡掉；
 *      该头缺失（老浏览器 / 非浏览器客户端）不当作跨站。
 *   3. `Host` 不是回环、且没开 `allowRemote` → 拒绝。跨机部署下 3080 若被直接暴露，
 *      这条能挡住「顺手读到群里有哪些对话、目录在哪」。
 *
 * 代价要写明白：**同一台机器上的任何进程都能读**（它和 DSH 自己的端口同级）。
 * 快照里没有 token、没有消息正文，只有对话键、会话 id、标题与目录。
 * 需要更强的保证就走反向代理加认证——本模块不假装自己解决了那个问题。
 */
export function panelAccessDecision({
  enabled,
  hostHeader,
  secFetchSite,
  originHeader,
  allowRemote = false,
} = {}) {
  if (enabled !== true) {
    return { ok: false, status: 404, reason: 'disabled' }
  }
  if (String(secFetchSite ?? '').toLowerCase() === 'cross-site') {
    return { ok: false, status: 403, reason: 'cross-site' }
  }
  const host = hostOf(hostHeader)
  const isLoopback = LOOPBACK_HOSTS.has(host)
  if (!isLoopback && !allowRemote) {
    return { ok: false, status: 403, reason: 'non-loopback' }
  }
  // Origin 若存在就必须与本机 Host 同源（防「DNS rebinding 读到别人家面板」）。
  const origin = String(originHeader ?? '').trim()
  if (origin) {
    let originHost = ''
    try {
      originHost = hostOf(new URL(origin).host)
    } catch {
      return { ok: false, status: 403, reason: 'bad-origin' }
    }
    if (originHost !== host) {
      return { ok: false, status: 403, reason: 'origin-mismatch' }
    }
  }
  return { ok: true, status: 200, reason: 'ok' }
}

/**
 * 把宿主侧的活状态压成只读快照。
 *
 * 入参刻意全是**已算好的普通值**（不传 records/bridges 这些 Map），这样这个函数
 * 是纯的、可单测的，而且「面板到底暴露了什么」在调用点一眼可见——
 * 新加一个字段必须显式写进来，不会因为把某个内部对象整个序列化而顺手泄露出去。
 */
export function buildPanelSnapshot({
  bridgeVersion,
  uptimeMs,
  pathPrefix,
  policy,
  cwd,
  statePath,
  stateExisted,
  heartbeatMs,
  sessionTitleTemplate,
  conversations = [],
  pending = [],
  im = {},
  now = Date.now(),
} = {}) {
  const items = conversations
    .filter((item) => item && typeof item.conversation === 'string' && item.conversation)
    .map((item) => ({
      conversation: item.conversation,
      // 反向定位的抓手：DSH Web 的会话列表按这个标题显示
      title: item.title ?? '',
      dshSessionId: item.dshSessionId ?? null,
      // 对话级覆盖还是跟随全局——与契约 §12.3 同一口径，面板上要能看出来
      cwd: item.cwd ?? null,
      cwdSource: item.cwdSource ?? 'global',
      lastActiveAt: Number(item.lastActiveAt) || 0,
      /** 距上次活动多久（面板直接显示，免得每个客户端各算一遍） */
      idleMs: Math.max(0, Number(now) - (Number(item.lastActiveAt) || 0)),
      seq: Number(item.seq) || 0,
      outbox: Array.isArray(item.outbox) ? item.outbox.slice(0, OUTBOX_PREVIEW) : [],
      outboxSize: Array.isArray(item.outbox) ? item.outbox.length : 0,
      /** 这一轮是自主心跳发起的（输出要过哨兵，不进正常下行） */
      proactiveTurn: item.proactiveTurn === true,
      live: item.live === true,
    }))

  const lastPollAt = Number(im.lastPollAt) || 0
  const imAliveMs = Math.max(0, Number(im.imAliveMs) || 0)
  return {
    ok: true,
    generatedAt: Number(now) || Date.now(),
    bridge: {
      bridgeVersion: bridgeVersion ?? '',
      uptimeMs: Number(uptimeMs) || 0,
      pathPrefix: pathPrefix ?? '',
      policy: policy ?? '',
      cwd: cwd ?? '',
      statePath: statePath ?? '',
      stateExisted: stateExisted === true,
      heartbeatMs: Number(heartbeatMs) || 0,
      sessionTitleTemplate: sessionTitleTemplate ?? '',
    },
    /**
     * 「IM 侧还在听吗」——DSH 这边唯一能观测到的 IM 活性证据，
     * 也正是自主心跳 `online` 闸门取的那个判据（契约 §18.5）。
     */
    im: {
      lastPollAt,
      sinceLastPollMs: lastPollAt ? Math.max(0, Number(now) - lastPollAt) : null,
      aliveMs: imAliveMs,
      online: lastPollAt > 0 && Number(now) - lastPollAt <= imAliveMs,
      pollCount: Number(im.pollCount) || 0,
    },
    counts: {
      conversations: items.length,
      mapped: items.filter((item) => item.dshSessionId).length,
      withOutbox: items.filter((item) => item.outboxSize > 0).length,
      pending: pending.length,
    },
    conversations: items,
    pending,
  }
}
