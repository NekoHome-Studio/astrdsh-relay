/**
 * AstrDsh Relay（星驿）：契约常量的机器可读副本。
 *
 * 唯一真相来源是 `docs/BRIDGE-CONTRACT.md`。
 * 本文件只是把契约里会被两侧代码同时引用的字面量集中一处，避免散落在实现里写错。
 * 修改本文件必须同步修改 docs/BRIDGE-CONTRACT.md 与 AstrBot 侧
 * `astrbot_plugin_dsh_relay/contract.py`。
 */
import { randomUUID } from 'node:crypto'

/**
 * 契约版本。破坏性变更必须递增；/health 会返回它，IM 侧不匹配时拒绝启用。
 *
 * v2：新增 `GET /workspaces` 与 `POST /session/rebind`（契约 §13）。
 *     对 v1 客户端而言是**增量**，但版本号仍递增——两侧的常量表是逐字对应的，
 *     让版本号忠实记录「这份常量表是哪一版」，比让客户端去猜差异更省事。
 */
export const BRIDGE_VERSION = '2'

/** 路由。契约 §3。相对基址（AstrBot 侧配置项 bridge_url）。 */
export const ROUTES = Object.freeze({
  MESSAGE: '/message',              // POST  投递用户消息（要求 Idempotency-Key）
  EVENTS: '/events',                // GET   SSE 下行通道（支持 Last-Event-ID 续传）
  APPROVAL: '/approval',            // POST  回执审批
  HEALTH: '/health',                // GET   存活与版本协商
  WHERE: '/where',                  // GET   定位：某对话 → 工作区 / DSH 会话（契约 §12）
  CONVERSATIONS: '/conversations',  // GET   列出已知的对话映射（契约 §12）
  WORKSPACES: '/workspaces',        // GET   列出宿主已登记的工作区（契约 §13.1）
  REBIND: '/session/rebind',        // POST  把某 IM 对话改指到指定工作区（契约 §13.2）
})

/** 下行事件类型。契约 §4。 */
export const EVENT = Object.freeze({
  TURN_START: 'turn/start',
  TEXT_DELTA: 'text/delta',
  REASONING_DELTA: 'reasoning/delta',
  TOOL_CALL: 'tool/call',
  APPROVAL_REQUIRED: 'approval/required',
  APPROVAL_RESOLVED: 'approval/resolved',
  MESSAGE_FINAL: 'message/final',
  TURN_END: 'turn/end',
  HEARTBEAT: 'heartbeat',
  GAP: 'gap',
})

/** 统一错误码。契约 §8。 */
export const ERROR_CODE = Object.freeze({
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not_found',
  QUEUE_FULL: 'queue_full',
  AGENT_BUSY: 'agent_busy',
  UNSUPPORTED: 'unsupported',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',
})

/**
 * 错误码 → HTTP 状态码。
 *
 * `unsupported` 与 `not_implemented` 是两件事，别混：
 *   - unsupported（400）：**请求**不合法（缺字段、类型错、Idempotency-Key 非 UUIDv4）。
 *   - not_implemented（501）：请求合法，但**本端还没做**。
 * 骨架阶段把两者混成 400 会让 IM 侧误以为是自己写错了参数，
 * 于是反复重试同一个必然失败的请求（契约 §8）。
 */
export const ERROR_STATUS = Object.freeze({
  [ERROR_CODE.UNAUTHORIZED]: 401,
  [ERROR_CODE.NOT_FOUND]: 404,
  [ERROR_CODE.QUEUE_FULL]: 429,
  [ERROR_CODE.AGENT_BUSY]: 409,
  [ERROR_CODE.UNSUPPORTED]: 400,
  [ERROR_CODE.NOT_IMPLEMENTED]: 501,
  [ERROR_CODE.INTERNAL]: 500,
})

/**
 * 网桥暴露给 IM 的审批结论白名单。契约 §7.2 第 4 条。
 *
 * DSH 侧完整枚举是 `allowed-once | rejected | cancelled | unavailable`，
 * 但后两个是系统语义，**不允许**由 IM 用户触发，因此不在此表内。
 * 超时一律 resolve `rejected`（fail closed）。
 */
export const APPROVAL_OUTCOME = Object.freeze({
  ALLOW_ONCE: 'allowed-once',
  REJECTED: 'rejected',
})

/** IM 用户可接受的审批结论（白名单校验用）。 */
export const APPROVAL_OUTCOME_ALLOWED = Object.freeze([
  APPROVAL_OUTCOME.ALLOW_ONCE,
  APPROVAL_OUTCOME.REJECTED,
])

/** 会话轮转策略。契约 §2.3。 */
export const POLICY = Object.freeze({
  ONE_TO_ONE: 'one-to-one',
  ON_DEMAND: 'on-demand',
  DAILY: 'daily',
})

/** 该会话的 DSH sessionId 前缀，便于在 Web UI 会话列表里辨识来源。 */
export const SESSION_ID_PREFIX = 'im-'

/** 生成一个新的网桥会话 id。 */
export function newSessionId() {
  return `${SESSION_ID_PREFIX}${randomUUID()}`
}

/** 一次性的审批验证码长度（字符）。契约 §7.1。 */
export const APPROVAL_CODE_LENGTH = 4
