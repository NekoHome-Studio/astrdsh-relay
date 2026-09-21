/**
 * dsh-astrbot-relay（星驿）— IM ↔ DSH 网桥（DSH 侧 / host half）
 *
 * 这是**九个端点全部落地的可运行实现**：
 *   - 已实现：插件契约（name / inject / Config / apply）、配置与 state 校验、
 *     路由表、Bearer 定长鉴权、健康检查、**定位（契约 §12）**、
 *     **请求体 HMAC 签名（§5.2 强化：服务端原文只读一次 + 时间窗 + 定长比较）**、
 *     会话标题渲染、state.json 的原子读写、
 *     **投递 POST /message（§3.1：幂等表 + 背压 + create/resume 分流 + followup）**、
 *     **幂等记账（§6.1：有界 LRU + TTL + 在途标记）**、
 *     **环形缓冲与 SSE 广播（§3.2 的 push/deliver/closeSse，含 Last-Event-ID 续传）**、
 *     **agent 事件转发（旧 session/event/assistant/chunk 与新 agent/assistant-stream 双协议 → text/delta）**、
 *     **审批 waterfall（approval/request → 4 位一次性 code → POST /approval）**、
 *     **工作区清单与改指（§13：GET /workspaces、POST /session/rebind）**、
 *     **对话中分支（§14：POST /session/fork）**、
 *     卸载期 `cancel → whenIdle → flush → dispose` 收尾。
 *   - 轮转策略已接线（§2.3）：`on-demand` 在 `idleTtlMs` 无活动即归档回收，
 *     `daily` 按宿主本地日期跨日轮转；两者都只归档、不删历史。
 *     `assertConfigIsUsable` 里对这两项的判据已由「加载即抛错」换成参数校验。
 *
 * 契约真相来源：`docs/BRIDGE-CONTRACT.md`
 * 设计依据：    `docs/DESIGN.md` §3
 * API 证据：    `docs/dsh-side-capabilities.md`
 *
 * 动笔前必读的三条已核实事实（写错就废）：
 *   1. `ctx.webServer.register` 注册的路由**没有任何鉴权**，必须自己实现（§5）。
 *      因此**每个**端点（包括 /health）都要过 authorize。
 *   2. `text/delta` 是**瞬时**事件，无订阅者即永久丢失 → IM 侧必须先连 SSE 再 POST /message。
 *      来源随宿主版本而异：≤0.1.2-rc.1 是 `session/event` 的 `assistant/chunk`
 *      （`chunk.type === 'text-delta'`）；≥0.1.5-rc.2 改为 `agent/assistant-stream` 的
 *      `frame.chunk`（与旧 StreamChunk 同形）。两条分支都保留，即双协议兼容。
 *   3. 事件用 `Scoped<Agent>` 派发，但根 ctx 上未打 tag 的监听者会收到**所有** agent
 *      的事件 → 必须自己按 agent.id 过滤，否则串台到用户在 Web UI 的会话。
 */
import {
  createHash, createHmac, randomInt, timingSafeEqual as nodeTimingSafeEqual,
} from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  BRIDGE_VERSION, ROUTES, ERROR_CODE, ERROR_STATUS, POLICY,
  APPROVAL_CODE_LENGTH, APPROVAL_OUTCOME, APPROVAL_OUTCOME_ALLOWED, EVENT, newSessionId,
} from './contract.js'
import { newRecord, resolveLocation, renderSessionTitle } from './location.js'
import { applySessionTitle, TITLE_MAX_BYTES, TITLE_RESULT, titleByteLength } from './session-title.js'
import { loadState, resolveStatePath, saveState } from './state.js'

export const name = 'dsh-astrbot-relay'

/**
 * 原始请求体的缓存槽。
 *
 * 【为什么需要】契约 §5.2 的 `hmacMode` 签名对象是 `ts + "." + rawBody` 的**字节**，
 * 必须拿服务端实际收到的原文来算。若先 `JSON.parse` 再重新 `JSON.stringify`，
 * 键序、空白、`\u` 转义都会变，签名永远对不上。所以请求体**只读一次**，
 * 原文挂在 request 上，签名校验与 JSON 解析共用同一份。
 */
const RAW_BODY = Symbol('dsh-astrbot-relay.rawBody')

/** 请求体上限：IM 文本消息不该超过 1 MiB，超了直接掐断。 */
const MAX_BODY_BYTES = 1_048_576

/**
 * 依赖服务。框架会等它们就绪后再跑 apply。
 * 已核实：`dsh-agent-loop` 提供 agents factory，且本机 web profile 已挂载它。
 */
export const inject = ['webServer', 'agents', 'sessions', 'sessionQuery', 'agentDefaultModel', 'workspaceRegistry']

/**
 * 配置 schema。
 *
 * 已核实：`@deepseek-ai/schemastery` 作为第三方插件依赖可正常解析
 * （本机 profile 已挂载本插件并生效，不再是推断）；官方向导要求导出
 * Standard Schema 而非普通对象，因此这里不提供「退化成普通对象」的兜底。
 *
 * 设计原则：凡不同部署可能取不同值的参数都不许硬编码；非法配置在**加载时**失败。
 */
export const Config = Schema.object({
  // ---- 必填 ----
  token: Schema.string().required(),        // 共享密钥，两侧各自持有，不进日志
  cwd: Schema.string().required(),          // agent 工作目录，必须绝对路径

  // ---- 传输 ----
  pathPrefix: Schema.string().default('/astrbot-relay'),   // 不要写尾斜杠
  heartbeatMs: Schema.number().default(15000),
  eventBufferSize: Schema.number().default(512),
  hmacMode: Schema.boolean().default(false),            // 可选强化，见契约 §5.2
  signatureSkewMs: Schema.number().default(60_000),     // HMAC 时间窗，仅在 hmacMode 下生效

  // ---- 会话映射与定位 ----
  statePath: Schema.string().default(''),              // 空 = <DSH_HOME>/astrbot-relay/state.json
  policy: Schema.union([POLICY.ONE_TO_ONE, POLICY.ON_DEMAND, POLICY.DAILY])
    .default(POLICY.ONE_TO_ONE),
  idleTtlMs: Schema.number().default(86_400_000),
  /**
   * DSH 会话标题模板——反向定位的抓手：标题里带上来源 IM 对话，
   * 用户才能在 DSH Web UI 的会话列表里认出「哪条来自哪个群」。
   * 占位符：{platform} {messageType} {sessionId} {conversation}
   */
  sessionTitleTemplate: Schema.string().default('星驿 · {platform}/{messageType}/{sessionId}'),

  // ---- 背压与幂等 ----
  maxQueuedPerConversation: Schema.number().default(4),
  idempotencyEntries: Schema.number().default(512),
  idempotencyTtlMs: Schema.number().default(600_000),

  // ---- 审批 ----
  approvalEnabled: Schema.boolean().default(true),
  approvalTimeoutMs: Schema.number().default(120_000),

  // ---- 输出 ----
  forwardReasoning: Schema.boolean().default(false),
})

/**
 * 插件入口。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 已由 Config schema 校验并填好默认值
 */
export function apply(ctx, config) {
  // 配置错误要响亮：宁可加载失败，也不要运行期静默降级。
  assertConfigIsUsable(config)

  // state 在 apply 阶段就要定妥：路径非法或文件损坏都必须让**插件加载失败**，
  // 而不是等到第一条消息进来才炸（契约 §2.2）。
  const statePath = resolveStatePath(config.statePath)
  const { records, existed: stateExisted } = loadState(statePath)

  ctx.inject(['webServer', 'agents', 'sessions', 'agentDefaultModel', 'workspaceRegistry'], (host) => {
    const log = host.logger ?? ctx.logger
    const tag = `[${name}]`

    // ────────────────────────────────────────────────────────────────
    // 运行时状态（纯内存）
    // ────────────────────────────────────────────────────────────────

    /** UUIDv4 形状校验（幂等键必填，契约 §3.1）。 */
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    /**
     * conversation → 网桥实例。
     * `queue` 只统计**在途**投递（已接受、尚未 whenIdle），用于背压（契约 §6.3）。
     */
    const bridges = new Map()

    /**
     * Idempotency-Key → { body, at }。
     * 有界 LRU（`idempotencyEntries`，默认 512）+ TTL（`idempotencyTtlMs`，默认 10 分钟），
     * **只覆盖 /message**（契约 §6.1）。不持久化：进程重启即作废，这是契约允许的。
     */
    const idempotency = new Map()

    /** 所有活着的 SSE 连接（模块级：卸载收尾要能同步遍历到）。 */
    const sseConnections = new Set()

    /** 取（必要时新建）某对话的网桥实例；dshSessionId 优先取 state.json 里的既有映射。 */
    function bridgeOf(conversation) {
      let bridge = bridges.get(conversation)
      if (!bridge) {
        bridge = {
          conversation,
          // 内存态直接用 state 的字段名（dshSessionId），避免「同一件事两个叫法」
          // 在序列化处被手滑写错；面向 IM 的 sessionId 只在 handleWhere 出口转译。
          dshSessionId: records.get(conversation)?.dshSessionId ?? '',
          agent: null,
          // create/resume 返回的 AgentHandle 是**能力对象**（{ agent, dispose }）：
          // 只有持有者能拆，所以 dispose 必须留着，卸载收尾时才拆得掉（本文件 TODO(P1)）。
          dispose: null,
          // 「正在附着」标志：同一 DSH 会话不允许并发 resume，网桥侧自己判定，
          // 不指望宿主抛出稳定的忙异常（grep 全 dsh 包无 AgentBusy 类）。
          attaching: false,
          queue: 0,
          subscribers: new Set(),
          buffer: [],
          seq: 0,
          approvals: new Map(),
          turn: 0,
          // 新版助手流的 start 帧带着 {attemptId, turn, step}，而 chunk 帧**不带**
          // （dsh-agent/lib/types/runtime-types.d.ts 的 AssistantStreamFrame），
          // 所以必须在 start 时记下来，否则新协议下 step 恒为 undefined。
          attempt: null,
          toolCalls: new Map(),
        }
        bridges.set(conversation, bridge)
      }
      return bridge
    }

    /**
     * 取 session-title 服务。由 dsh-base 的 cordis.patch.yml 挂载（config 里给了
     * maxTitleBytes: 80），本插件**不自己补挂**，取不到就退化成写标题功能缺席。
     * 写法与上面的 loader 取值一致：注入作用域优先，退回根 ctx。
     */
    function titlesOf() {
      try {
        return (typeof host.get === 'function' ? host : ctx).get('sessionTitle')
      } catch {
        return void 0
      }
    }

    /**
     * R3「反向定位」的落点：把来源 IM 对话的标题写进 DSH 会话，于是从 Web UI 的
     * 会话列表出发就能认出这条会话对应哪个群 / 哪个人。
     *
     * 调用前置条件：`bridge.agent` 必须是**已 live** 的 agent —— dsh-session-title 的
     * rename 第一步就校验 `ctx.sessions.get(session.id) === session`，排在
     * create/resume 之前必抛 not live。三个调用点都排在赋值之后。
     *
     * 只记日志、绝不抛错：起标题是锦上添花，不该让一条 IM 消息投不出去。
     * 已知副作用（有意为之）：用户来源标题会 supersede 自动生成，写入之后该会话
     * 不再随对话内容自动改标题，只有显式 refresh 才解钉 —— 反向定位要的正是这种稳定。
     */
    function writeSessionTitle(bridge) {
      const result = applySessionTitle({
        titles: titlesOf(),
        session: bridge.agent?.session,
        template: config.sessionTitleTemplate,
        conversation: bridge.conversation,
      })
      if (result.ok) {
        // 比的是**交出去原文**（rendered）而不是落盘结果：dsh 侧永远把超长截到限内，
        // 拿 title 比必然「没超」，这条提示会变成死代码。
        const bytes = titleByteLength(result.rendered)
        if (bytes > TITLE_MAX_BYTES) {
          log?.warn?.(`${tag} 会话标题 ${bytes} 字节超过上限 ${TITLE_MAX_BYTES}，`
            + `已被 dsh 侧按字节截断：${result.title}`)
        }
        return result
      }
      // 服务缺席是**容错分支**，不是部署错误：老 profile 不升 dsh-base 时静默跳过。
      if (result.reason === TITLE_RESULT.SERVICE_MISSING) return result
      log?.warn?.(`${tag} 写会话标题失败（${result.reason}，已忽略）：`
        + `${result.error === undefined ? '标题为空' : String(result.error)}`
        + ` / conversation=${bridge.conversation}`)
      return result
    }

    /** 记录请求头（node 会小写化，但不要假设，两边都查一次）。 */
    function headerOf(request, name) {
      const headers = request?.headers ?? {}
      const value = headers[name] ?? headers[name.toLowerCase()]
      return typeof value === 'string' ? value.trim() : ''
    }

    /**
     * 读**原始**请求体。只读一次，原文缓存到 request 上（见 RAW_BODY 的说明）。
     * 超 1 MiB 直接掐断（IM 文本消息不该这么大）；读失败返回 null。
     */
    function readRawBody(request) {
      if (request[RAW_BODY] !== undefined) return Promise.resolve(request[RAW_BODY])
      return new Promise((resolve) => {
        let settled = false
        const done = (value) => {
          if (settled) return
          settled = true
          request[RAW_BODY] = value
          resolve(value)
        }
        const chunks = []
        let size = 0
        request.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            request.destroy()
            done(null)
            return
          }
          chunks.push(chunk)
        })
        request.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
        request.on('error', () => done(null))
      })
    }

    /**
     * 读并解析 JSON 请求体。
     * 空体视作 `{}`（沿用旧行为）；解析失败返回 null。
     */
    async function readJsonBody(request) {
      const raw = await readRawBody(request)
      if (raw === null) return null
      if (raw.trim() === '') return {}
      try { return JSON.parse(raw) } catch { return null }
    }

    /**
     * 请求签名校验（契约 §5.2 的**可选强化**，只在 `hmacMode: true` 时生效）。
     *
     * 签名对象是服务端**实际收到的原文**：
     *   `X-Bridge-Signature: sha256=<hex(hmac_sha256(token, ts + "." + rawBody))>`
     *   `X-Bridge-Timestamp: <毫秒时间戳>`
     * 时间戳偏离本地时钟超过 `signatureSkewMs`（默认 60000）即拒，堵住重放。
     *
     * 失败一律回 `unauthorized`：契约 §8 要求这个响应体**不区分**失败原因，
     * 多吐一句「是签名错还是过期了」等于把爆破用的反馈送给对方。
     * 时间窗与签名**一起**判、且比较定长，避免两类失败在耗时上可区分。
     *
     * 只对有请求体的方法（POST）调用：GET /health、/events 这类无体请求没有 rawBody 可签。
     */
    function verifySignature(request, response, config, rawBody) {
      if (config.hmacMode !== true) return true
      const tsRaw = headerOf(request, 'x-bridge-timestamp')
      const presented = headerOf(request, 'x-bridge-signature')
      const ts = Number(tsRaw)
      const skew = Number(config.signatureSkewMs)
      const expected = 'sha256=' + createHmac('sha256', String(config.token))
        .update(`${tsRaw}.${rawBody ?? ''}`, 'utf8')
        .digest('hex')
      const fresh = tsRaw !== '' && Number.isFinite(ts) && Math.abs(Date.now() - ts) <= skew
      const matches = presented !== '' && timingSafeEqual(presented, expected)
      if (fresh && matches) return true
      writeError(response, ERROR_CODE.UNAUTHORIZED, 'unauthorized')
      return false
    }

    /** 只广播不入缓冲：给「结果说明帧」用（gap 就是这一类）。 */
    function broadcast(bridge, envelope) {
      for (const subscriber of [...bridge.subscribers]) {
        try {
          subscriber(envelope)
        } catch (error) {
          // 单个订阅者发送失败不得拖垮其他连接。
          log?.warn?.(`${tag} SSE 写出失败：${String(error)}`)
        }
      }
    }

    /** 广播一帧：先入环形缓冲（供 Last-Event-ID 重放），再推给所有订阅者。 */
    function deliver(bridge, envelope) {
      bridge.buffer.push(envelope)
      broadcast(bridge, envelope)
    }
    /**
     * 写一帧 SSE（`id` / `event` / `data`，以空行结尾；契约 §3.2）。
     * ephemeral 帧没有 seq，就不写 id：客户端据此知道它不参与续传。
     */
    function sseWrite(connection, envelope) {
      if (connection.closed) return
      const id = envelope.seq === undefined ? '' : `id: ${envelope.seq}\n`
      const payload = `${id}event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`
      try {
        connection.response.write(payload)
      } catch (error) {
        log?.warn?.(`${tag} SSE 写出失败：${String(error)}`)
        closeSse(connection, 'write-failed')
      }
    }

    /** 关掉一条 SSE 连接。幂等：close 事件会从 request / response 两侧各来一次。 */
    function closeSse(connection, reason) {
      if (!connection || connection.closed === true) return
      connection.closed = true
      connection.closeReason = reason
      sseConnections.delete(connection)
      if (connection.heartbeat) clearInterval(connection.heartbeat)
      if (connection.subscriber) {
        try { connection.bridge?.subscribers?.delete(connection.subscriber) } catch { /* 卸载期异常不得逃逸 */ }
      }
      try { connection.response.end() } catch { /* 对端可能已经断了 */ }
    }


    /**
     * 生成并下发一帧下行事件（带自增 seq 与 ts，契约 §4）。
     * 缓冲溢出时丢最旧的，并追发一帧 `gap` 告知客户端存在空洞（契约 §3.2）。
     *
     * `options.ephemeral === true`：只广播、**不占 seq、不入缓冲**。
     * 心跳与 text/delta 用它：它们没有重放价值，占 seq 会把 Last-Event-ID 语义弄脏。
     */
    function push(conversation, frame, options) {
      const bridge = bridgeOf(conversation)
      if (options?.ephemeral === true) {
        const ephemeral = { ts: Date.now(), ...frame }
        broadcast(bridge, ephemeral)
        return ephemeral
      }
      const envelope = { seq: (bridge.seq += 1), ts: Date.now(), ...frame }
      deliver(bridge, envelope)

      const cap = Math.max(2, Math.trunc(config.eventBufferSize))
      // 留一格给紧随其后的 gap 帧，缓冲才真正稳定在 cap 条以内（原版会留 cap+1 条）。
      if (bridge.buffer.length > cap - 1) {
        const firstDropped = bridge.buffer[0].seq
        bridge.buffer.splice(0, bridge.buffer.length - (cap - 1))
        // gap 只广播、**不入缓冲**：它是「缓冲刚被截断」的结果说明，
        // 进了缓冲就会被当成可重放的历史帧，重放时反而对不上真实的空洞。
        broadcast(bridge, {
          seq: (bridge.seq += 1), ts: Date.now(), type: EVENT.GAP, fromSeq: firstDropped,
        })
      }
      return envelope
    }

    /** 幂等查表：过期条目顺手清掉，命中后挪到 Map 末尾（LRU 语义）。 */
    function idempotencyLookup(key) {
      const entry = idempotency.get(key)
      if (!entry) return null
      if (Date.now() - entry.at > config.idempotencyTtlMs) {
        idempotency.delete(key)
        return null
      }
      idempotency.delete(key)
      idempotency.set(key, entry)
      return entry
    }

    /** 裁掉最旧的条目以维持上界（在途标记与最终结果一视同仁）。 */
    function idempotencyTrim() {
      const limit = Math.max(1, Math.trunc(config.idempotencyEntries))
      while (idempotency.size > limit) {
        idempotency.delete(idempotency.keys().next().value)
      }
    }

    /**
     * 记一个**在途标记**：必须在投递前、且在**第一个 await 之前**写下。
     * 条目形如 `{ at, pending: true, conversation, body: null }`。
     */
    function idempotencyMarkPending(key, conversation) {
      idempotency.delete(key)
      idempotency.set(key, { at: Date.now(), pending: true, conversation, body: null })
      idempotencyTrim()
    }

    /**
     * 撤掉在途标记：只有「因我方原因本次没被接受」时才用（入参错、背压、并发冲突）。
     * 否则同一把键第二次重试会命中标记、拿到 duplicate: true，消息却永远投不出去。
     */
    function idempotencyForget(key) {
      idempotency.delete(key)
    }

    /** 幂等记账：把首次响应的 202 体写下（原地覆盖在途标记），并裁到上界。 */
    function idempotencyRemember(key, body) {
      const previous = idempotency.get(key)
      idempotency.delete(key)
      idempotency.set(key, {
        at: Date.now(),
        pending: false,
        conversation: previous?.conversation || body.conversation,
        body,
      })
      idempotencyTrim()
    }

    // ────────────────────────────────────────────────────────────────
    // 路由表
    // ────────────────────────────────────────────────────────────────
    // 注意：path 不要写尾斜杠；重复 (kind, path) 会抛错，必须降级为 no-op
    // 而不是把 host 搞崩。
    const routes = [
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.HEALTH), handler: handleHealth },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.MESSAGE), handler: handleMessage },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.EVENTS), handler: handleEvents },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.APPROVAL), handler: handleApproval },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.WHERE), handler: handleWhere },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.CONVERSATIONS), handler: handleConversations },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.WORKSPACES), handler: handleWorkspaces },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.REBIND), handler: handleRebind },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.FORK), handler: handleFork },
      { kind: 'exact', path: join(config.pathPrefix, ROUTES.ADOPT), handler: handleAdopt },
    ]

    ctx.effect(() => {
      const disposers = []
      for (const route of routes) {
        try {
          disposers.push(host.webServer.register(route))
        } catch (error) {
          // 重复注册：降级为 no-op，保住 host。
          log?.warn?.(`${tag} 路由注册失败，已跳过 ${route.path}：${String(error)}`)
        }
      }
      log?.info?.(
        `${tag} mounted at ${config.pathPrefix} (bridgeVersion=${BRIDGE_VERSION})，` +
        `state=${statePath}（${stateExisted ? `已载入 ${records.size} 条映射` : '新建'}）`,
      )
      return () => {
        for (const dispose of disposers.reverse()) {
          try { dispose() } catch { /* 卸载期异常不得逃逸 */ }
        }
      }
    }, `${name}: routes`)

    /**
     * 卸载收尾（TODO(P1) 落地，顺序见契约 §9 未决 #1）：
     * cancel({ kind: 'user' }) → await whenIdle() → await sessions.flush(agent.session) → dispose()。
     *
     * ⚠️ dispose() 的语义是「停 loop、注销 agent、**把该会话从 store 里删掉**、展开 scope」
     *    （dsh-agent/lib/types/index.d.ts:136-153），所以它只能在**卸载期**调：
     *    放进 handleMessage 的 .finally() 会把下一轮 resume 的前提拆掉，静默变「每轮都是新会话」。
     *    AgentCancelCause 是 `{ kind: 'user' }` 而非自由对象（dsh-session/lib/types/index.d.ts）。
     */
    async function shutdownBridges(reason) {
      const pending = []
      for (const bridge of bridges.values()) {
        const agent = bridge.agent
        const dispose = bridge.dispose
        // 只要求有 agent：复用 live 的路径（见 handleMessage 的 live 优先分流）拿不到 handle，
        // dispose 为 null，但那条会话仍要 cancel + flush，否则卸载时它的记录不落盘。
        if (!agent) continue
        // 先摘引用再收尾：收尾期间新到的 /message 会重新 attach，不会撞上这次拆除。
        bridge.agent = null
        bridge.dispose = null
        pending.push((async () => {
          try {
            agent.cancel({ kind: 'user' })
            await agent.whenIdle()
            await host.sessions.flush(agent.session)
          } catch (error) {
            // 收尾失败也必须继续 dispose，否则 handle 永远留在 registry 里。
            log?.warn?.(`${tag} ${reason}：${bridge.conversation} 排空失败，仍继续拆除：${String(error)}`)
          }
          try {
            // 复用路径没有 handle 可拆（见 handleMessage 的 live 优先分流），
            // 那具 agent 的 teardown 归 provider 卸载时统一排空（dsh-agent types index.d.ts:141-148）。
            if (dispose) await dispose()
          } catch (error) {
            log?.warn?.(`${tag} ${reason}：${bridge.conversation} dispose 失败：${String(error)}`)
          }
        })())
      }
      await Promise.allSettled(pending)
      persistRecords()
    }

    ctx.effect(() => () => {
      // SSE 长连接先同步断干净：disposer 不等 Promise，异步收尾只能挂出去。
      for (const connection of [...sseConnections]) closeSse(connection, 'unload')
      sseConnections.clear()
      // Cordis 的 disposer 不等 Promise，所以这里只能挂出去；必须接住 rejection，否则算 unhandled。
      shutdownBridges('卸载收尾').catch((error) => {
        log?.warn?.(`${tag} 卸载收尾异常：${String(error)}`)
      })
    }, `${name}: shutdown`)

    // ────────────────────────────────────────────────────────────────
    // agent 事件转发 + 审批（P2 已落地）
    // ────────────────────────────────────────────────────────────────
    //
    // 反查辅助：宿主把事件派发到根 ctx 时只给对象身份，**不给** conversation，
    // 所以必须自己比对回网桥实例（文件头第 3 条：不过滤就串台到 Web UI 的会话）。
    // 本项目唯一的注册表就是 `bridges`（对象身份 → 对话）。

    /** 按 agent.id 反查网桥。审批 waterfall 只拿得到 Agent，不给 session。 */
    function bridgeByAgent(agentId) {
      if (!agentId) return null
      for (const bridge of bridges.values()) {
        if (bridge.agent?.id === agentId) return bridge
      }
      return null
    }

    /** 按 agent.session 的**对象身份**反查网桥：不比 id，避免同名会话误伤。 */
    function bridgeBySession(session) {
      if (!session) return null
      for (const bridge of bridges.values()) {
        if (bridge.agent?.session === session) return bridge
      }
      return null
    }

    /** 穷尽性检查：漏一个变体要在开发期就炸出来，而不是静默丢事件。 */
    function assertNever(value, context) {
      throw new Error(`dsh-astrbot-relay: ${context} 出现未覆盖的变体：${JSON.stringify(value)}`)
    }

    /**
     * 助手流 chunk 的统一出口：旧版走 session/event 的 assistant/chunk，
     * 新版走 agent/assistant-stream 的 frame.chunk（二者同形），语义完全一致。
     * turn/step 由调用方给出，避免两条链路各自解包。
     */
    function forwardAssistantChunk(bridge, chunk, at) {
      const turn = at?.turn
      const step = at?.step
      switch (chunk?.type) {
        case 'text-delta':
          // 只用于「边跑边显示」：最终文本一律以 message/final 为准（契约 §4.1）。
          push(bridge.conversation, {
            type: EVENT.TEXT_DELTA, turn, step,
            index: chunk.index, text: chunk.text,
          }, { ephemeral: true })
          return
        case 'reasoning-delta':
          if (!config.forwardReasoning) return
          push(bridge.conversation, {
            type: EVENT.REASONING_DELTA, turn, step,
            index: chunk.index, text: chunk.text,
          }, { ephemeral: true })
          return
        case 'tool-call-delta': {
          // 工具参数是流式拼出来的：按 index 聚合，到 block-end 才发完整帧。
          const pending = bridge.toolCalls.get(chunk.index) ?? { id: '', name: '', arguments: '' }
          if (chunk.id) pending.id = chunk.id
          if (chunk.name) pending.name = chunk.name
          pending.arguments += chunk.argumentsDelta ?? ''
          bridge.toolCalls.set(chunk.index, pending)
          return
        }
        case 'block-start':
          return
        case 'block-end': {
          const block = chunk.block
          if (block?.type !== 'tool-call') return
          const pending = bridge.toolCalls.get(chunk.index)
          const call = {
            callId: block.id ?? pending?.id ?? '',
            name: block.name ?? pending?.name ?? '',
            arguments: block.arguments ?? pending?.arguments ?? '',
          }
          bridge.toolCalls.delete(chunk.index)
          push(bridge.conversation, {
            type: EVENT.TOOL_CALL, turn, step, ...call,
          })
          return
        }
        case 'usage':
        case 'finish':
          // 用量与结束原因不单独下行：正文看 message/final，收尾看 turn/end。
          return
        default:
          assertNever(chunk, 'assistant-chunk')
      }
    }


    // 单监听器 + 内部 switch：多注册几个监听器只会让「谁先谁后」变成隐式契约。
    host.on('session/event', (session, event) => {
      const bridge = bridgeBySession(session)
      if (!bridge) return
      const data = event?.data ?? {}
      switch (event.type) {
        case 'turn/start': {
          bridge.turn = data.turn
          bridge.toolCalls.clear()
          push(bridge.conversation, { type: EVENT.TURN_START, turn: bridge.turn })
          return
        }
        case 'assistant/chunk': {
          // 旧协议（宿主 ≤ 0.1.2-rc.1）：chunk 直接挂在 session/event 上派发。
          // 新版宿主不再发这个事件，但分支保留即构成双协议兼容（见下方 agent/assistant-stream）。
          forwardAssistantChunk(bridge, data.chunk, { turn: data.turn, step: data.step })
          return
        }
        case 'assistant/message': {
          const content = data.message?.content ?? []
          const text = content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('')
          push(bridge.conversation, {
            type: EVENT.MESSAGE_FINAL, turn: data.turn, step: data.step,
            text, interrupted: data.message?.interrupted === true,
          })
          return
        }
        case 'turn/end': {
          push(bridge.conversation, {
            type: EVENT.TURN_END, turn: data.turn, reason: data.reason,
          })
          bridge.turn = 0
          return
        }
        default:
          // session/event 是 append-only 火管：user/message、tool/result 等都会到这里。
          // 不属于下行契约的一律忽略——**不要** assertNever，那会把正常事件当 bug 抛。
          return
      }
    })

    // ── 新版宿主（≥ 0.1.5-rc.2）的助手流入口 ──────────────────────────────
    // 新版不再 append assistant/chunk，改为 `dispatch.emit('agent/assistant-stream', { frame })`
    // （dsh-agent-loop/lib/index.js:1031-1033），frame 三变体 start / chunk / end。
    // 派发 scope 是 Scoped<Agent>：根 ctx 上未打 tag 的监听者会收到**所有** agent 的帧，
    // 因此必须按 agent.id 过滤（与文件头第 3 条同理），否则串台到 Web UI 会话。
    // start/end 不下行：turn 边界看 turn/start 与 turn/end，正文看 assistant/message。
    host.on('agent/assistant-stream', (payload) => {
      const bridge = bridgeByAgent(payload?.agent?.id)
      if (!bridge) return
      const frame = payload?.frame
      if (!frame) return
      if (frame.type === 'start') {
        // chunk/end 帧不带 turn/step，只有 start 帧带：
        // 在这里把 (attemptId → turn/step) 记下来，chunk 才有准确的归属。
        bridge.attempt = { id: frame.attemptId, turn: frame.turn, step: frame.step }
        return
      }
      if (frame.type === 'end') {
        if (bridge.attempt?.id === frame.attemptId) bridge.attempt = null
        return
      }
      if (frame.type !== 'chunk') return
      // 对得上 attemptId 就用 start 帧的记录；对不上（漏了 start 的极端情况）
      // 才回落到 session/event 维持的 bridge.turn，step 保持 undefined 而不是瞎填。
      const at = bridge.attempt?.id === frame.attemptId
        ? { turn: bridge.attempt.turn, step: bridge.attempt.step }
        : { turn: bridge.turn, step: void 0 }
      forwardAssistantChunk(bridge, frame.chunk, at)
    })



    // 心跳：必须包在 ctx.effect 里并返回 clearInterval，否则定时器会拖住进程退出。
    ctx.effect(() => {
      const timer = setInterval(() => {
        for (const bridge of bridges.values()) {
          push(bridge.conversation, { type: EVENT.HEARTBEAT }, { ephemeral: true })
        }
      }, Math.max(1000, Math.trunc(config.heartbeatMs)))
      timer.unref?.()
      return () => clearInterval(timer)
    }, `${name}: heartbeat`)

    // ────────────────────────────────────────────────────────────────
    // 会话轮转与回收（契约 §2.3：on-demand 空闲回收 / daily 跨日轮转）
    // ────────────────────────────────────────────────────────────────

    /**
     * 拆掉一个网桥持有的会话，收尾序与 shutdownBridges 逐字一致：
     * 摘引用 → cancel({kind:'user'}) → whenIdle() → sessions.flush() → dispose()。
     *
     * ⚠️ 先摘引用再收尾：收尾期间新到的 /message 会重新 attach，不会撞上这次拆除。
     * ⚠️ flush 必须排在 dispose 之前：dispose 会把会话从 store 里删掉
     *    （dsh-agent types index.d.ts:136-153），顺序反了最后那轮记录直接丢。
     */
    async function detachSession(bridge, reason) {
      const agent = bridge.agent
      const dispose = bridge.dispose
      if (!agent) {
        // 复用 live 的路径拿不到 handle（handleMessage 的 live 优先分流）：
        // 没有 agent 可拆就只剩引用要摘，别凭空造一个 dispose 出来。
        bridge.dshSessionId = ''
        return
      }
      bridge.agent = null
      bridge.dispose = null
      try {
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        await host.sessions.flush(agent.session)
      } catch (error) {
        // 排空失败也必须继续 dispose，否则 handle 永远留在 registry 里。
        log?.warn?.(`${tag} ${reason}：${bridge.conversation} 排空失败，仍继续拆除：${String(error)}`)
      }
      try {
        if (typeof dispose === 'function') await dispose()
      } catch (error) {
        log?.warn?.(`${tag} ${reason}：${bridge.conversation} dispose 失败：${String(error)}`)
      }
      bridge.dshSessionId = ''
    }

    /**
     * 归档一个 DSH 会话（契约 §2.3：回收与轮转都走 `workspace.archiveSession`）。
     *
     * 语义（宿主 dsh-workspace/lib/index.js）：经 enqueueOperation 串行、**已归档幂等**、
     * 会话不在任何工作区时抛 WorkspaceUnknownSessionError。最后一种在本插件里是**正常**
     * 路径（本插件建的会话未必挂过工作区），所以只 warn，不把它算成回收失败——
     * 归档失败也照样摘映射：留一个指向「已拆掉的会话」的映射才是真的坏。
     */
    async function archiveSessionOf(sessionId, reason) {
      const registry = workspaceRegistryOf()
      if (!registry || typeof registry.archiveSession !== 'function') {
        log?.warn?.(`${tag} ${reason}：宿主未提供 workspaceRegistry.archiveSession()，${sessionId} 未归档`)
        return false
      }
      try {
        await registry.archiveSession(sessionId)
        return true
      } catch (error) {
        log?.warn?.(`${tag} ${reason}：归档会话 ${sessionId} 失败（已忽略）：${String(error?.message ?? error)}`)
        return false
      }
    }

    /**
     * 回收一个对话的 DSH 会话：拆桥 → 归档 → 摘映射（**保留历史**）。
     *
     * 映射一并删掉是刻意的：契约 §2.3 的 on-demand 是「首次触发创建」，回收之后
     * 下一次投递就该按首次触发重新分配 id（见 handleMessage 第 2 步）。
     * 会话本体与日志留在 DSH 侧归档里，本插件不留悬空指针。
     */
    async function recycleConversation(conversation, reason) {
      const record = records.get(conversation)
      if (!record?.dshSessionId) return false
      const sessionId = record.dshSessionId
      const bridge = bridges.get(conversation)
      if (bridge) await detachSession(bridge, reason)
      await archiveSessionOf(sessionId, reason)
      records.delete(conversation)
      persistRecords()
      log?.info?.(`${tag} ${reason}：会话 ${sessionId} 已归档回收（历史保留）`)
      return true
    }

    /** 宿主本地日期（契约 §2.3 的 daily 判据就是「DSH 服务器本地日期」，不做时区换算）。 */
    function localDateKey(at) {
      const date = new Date(at)
      return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    }

    /**
     * 空闲扫描：`on-demand` 的回收判据，只对**确实空闲**的会话生效。
     *
     * 在途判定用网桥自己的 attaching / queue（与 /message 的串行化同一份状态）：
     * 正在 attach 或还有未排空的投递，就不是「无活动」，绝不能回收。
     */
    async function sweepIdleSessions() {
      const ttl = Math.trunc(config.idleTtlMs)
      const now = Date.now()
      for (const [conversation, record] of [...records]) {
        if (!record?.dshSessionId) continue
        const bridge = bridges.get(conversation)
        if (bridge && (bridge.attaching || bridge.queue > 0)) continue
        const last = Number(record.lastActiveAt) || Number(record.createdAt) || 0
        if (now - last < ttl) continue
        await recycleConversation(conversation, '空闲回收')
      }
    }

    if (config.policy === POLICY.ON_DEMAND) {
      // ⚠️ 与心跳同理：必须包在 ctx.effect 里并返回 clearInterval，否则定时器拖住进程退出。
      // 轮询间隔取 min(60s, idleTtlMs)：再大就会让回收晚过「Ttl + 一个间隔」，
      // 再小纯属空转（判据是墙钟时间差，扫描快慢不改变回收时刻）。
      const sweepIntervalMs = Math.max(1000, Math.min(60_000, Math.trunc(config.idleTtlMs)))
      let sweeping = false
      ctx.effect(() => {
        const timer = setInterval(() => {
          // 上一轮还没扫完就跳过这一轮：扫描里含 await（拆桥 + 归档），
          // 允许重入会让同一个会话被两条路径同时归档。
          if (sweeping) return
          sweeping = true
          sweepIdleSessions()
            .catch((error) => log?.warn?.(`${tag} 空闲回收异常：${String(error)}`))
            .finally(() => { sweeping = false })
        }, sweepIntervalMs)
        timer.unref?.()
        return () => clearInterval(timer)
      }, `${name}: idle-sweep`)
    }

    /** 审批验证码字母表：去掉 I/O/0/1，人工抄码时不容易认错。 */
    const APPROVAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

    /** 生成 APPROVAL_CODE_LENGTH 位验证码。它只是「人确认」的凭据，不参与安全判定。 */
    function randomApprovalCode() {
      let code = ''
      for (let i = 0; i < APPROVAL_CODE_LENGTH; i += 1) {
        code += APPROVAL_CODE_ALPHABET[randomInt(APPROVAL_CODE_ALPHABET.length)]
      }
      return code
    }

    /**
     * 向 IM 用户要一次审批，resolve 出 ApprovalOutcome（契约 §7）。
     *
     * ⚠️ 审批服务自身**零超时**：不自己加超时就会永久堵死该 turn，
     *    所以这里必须 setTimeout + unref，且超时 resolve REJECTED（fail closed，不是 cancelled）。
     * ⚠️ `finish` 只能生效一次：超时、signal abort、IM 回执三条路可能同时到达。
     * ⚠️ approval/asked 与 approval/decided 由审批服务自己记审计，本端不代发。
     */
    function askApproval(bridge, request) {
      const callId = request.callId ?? `im-call-${Date.now()}-${randomInt(1_000_000)}`
      const expiresAt = Date.now() + Math.max(1000, Math.trunc(config.approvalTimeoutMs))
      const code = randomApprovalCode()
      return new Promise((resolve) => {
        let timer = null
        const finish = (outcome, via) => {
          if (!bridge.approvals.has(callId)) return   // 超时路径已删表：不重复结算
          bridge.approvals.delete(callId)
          if (timer) clearTimeout(timer)
          push(bridge.conversation, {
            type: EVENT.APPROVAL_RESOLVED, callId, outcome, via,
          })
          resolve(outcome)
        }
        timer = setTimeout(() => finish(APPROVAL_OUTCOME.REJECTED, 'timeout'), expiresAt - Date.now())
        timer.unref?.()
        bridge.approvals.set(callId, { code, expiresAt, settle: finish })
        push(bridge.conversation, {
          type: EVENT.APPROVAL_REQUIRED, callId,
          toolName: request.toolName ?? '', reason: request.reason ?? '',
          code, expiresAt,
        })
        // turn 被取消 → 必须把它结算掉，否则这个审批会挂到进程结束。
        request.signal?.addEventListener?.('abort', () => finish('cancelled', 'abort'), { once: true })
      })
    }

    host.on('approval/request', (request, next) => {
      const bridge = bridgeByAgent(request?.agent?.id)
      // 不接管就让框架按默认策略处理（next 的返回值必须原样透出）。
      if (!bridge || !config.approvalEnabled) return next()
      return askApproval(bridge, request)
    })

    // ────────────────────────────────────────────────────────────────
    // 路由实现
    // ────────────────────────────────────────────────────────────────

    /**
     * GET /health — 存活、版本协商与非敏感定位概览。
     *
     * 契约 §3「通用要求：所有端点都要求鉴权」→ 这里也要过 authorize。
     * （骨架早期版本把它做成了裸端点，本版修正：它现在会返回 cwd / statePath
     *   这类本机路径信息，裸奔等于把部署细节送给任何能连到端口的人。）
     */
    function handleHealth(request, response) {
      if (!authorize(request, response, config)) return
      writeJson(response, 200, {
        ok: true,
        bridgeVersion: BRIDGE_VERSION,
        uptimeMs: Math.round(process.uptime() * 1000),
        conversations: records.size,
        // 定位相关的诊断信息：让排查的人不必去翻配置文件
        pathPrefix: config.pathPrefix,
        cwd: config.cwd,
        statePath,
        stateExisted,
        policy: config.policy,
        sessionTitleTemplate: config.sessionTitleTemplate,
        // dshVersion 需要从 host.describe 之类的服务读取——【未核实】，
        // 实现阶段补上；契约允许字段缺失时由 IM 侧忽略。
      })
    }

    /**
     * POST /message — 投递一条 IM 用户消息（契约 §3.1）。**已实现**。
     *
     * 顺序不可换：鉴权 → Idempotency-Key（必填 UUIDv4）→ 幂等查表 → 背压判定
     * → loader.await()（等 boot 完成）→ agents.create（setup 装 model selection）
     * → followup → 202。
     *
     * ⚠️ `text/delta` 是瞬时事件，IM 侧必须先连 SSE 再 POST，否则丢流（文件头第 2 条）。
     */
    async function handleMessage(request, response) {
      if (!authorize(request, response, config)) return

      // 签名校验必须先拿到**原文**：readRawBody 只消费一次并缓存，
      // 下面的 readJsonBody 命中同一份缓存，不会二次读流。
      const rawBody = await readRawBody(request)
      if (!verifySignature(request, response, config, rawBody)) return

      const key = headerOf(request, 'idempotency-key')
      if (!key || !UUID_V4.test(key)) {
        writeError(response, ERROR_CODE.UNSUPPORTED,
          'Idempotency-Key 必填且必须是 UUIDv4（契约 §3.1）')
        return
      }

      // 幂等命中：原样重放首次的 202，只把 duplicate 置 true，绝不二次投递。
      const seen = idempotencyLookup(key)
      if (seen) {
        // 在途标记：同一把键的第一封还没落地。此时**不能**当 duplicate 放行
        // （duplicate 的语义是「已经投出去过」，这里恰好相反），回 409 让客户端稍后重试。
        if (seen.pending) {
          writeError(response, ERROR_CODE.AGENT_BUSY,
            '同一 Idempotency-Key 的上一封消息仍在投递中',
            { conversation: seen.conversation || null })
          return
        }
        writeJson(response, 202, { ...seen.body, duplicate: true })
        return
      }

      // ⚠️ 顺序有讲究：在途标记必须写在**第一个 await 之前**。
      // 写在 readJsonBody / agents.create 之后的话，同一把键并发两封会在
      // 两个 await 之间双双查不到标记，各自投一遍——这就是 TOCTOU。
      idempotencyMarkPending(key, '')

      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object') {
        idempotencyForget(key)
        writeError(response, ERROR_CODE.UNSUPPORTED, '请求体必须是合法 JSON 对象')
        return
      }
      const conversation = typeof body.conversation === 'string' ? body.conversation.trim() : ''
      const text = typeof body.text === 'string' ? body.text : ''
      if (!conversation) {
        idempotencyForget(key)
        writeError(response, ERROR_CODE.UNSUPPORTED, '缺少 conversation（IM 会话键，形如 default:GroupMessage:1000000001）')
        return
      }
      if (text.trim() === '') {
        idempotencyForget(key)
        writeError(response, ERROR_CODE.UNSUPPORTED, 'text 不能为空')
        return
      }
      // 解析出会话键后回填标记，好让并发的那一封的 409 里带上 conversation。
      const pendingEntry = idempotency.get(key)
      if (pendingEntry) pendingEntry.conversation = conversation

      const bridge = bridgeOf(conversation)
      const maxQueued = Math.max(1, Math.trunc(config.maxQueuedPerConversation))
      if (bridge.queue >= maxQueued) {
        // 背压：429 + retry-after，IM 侧**不得**立即自动重试（契约 §6.3）。
        idempotencyForget(key)
        writeError(response, ERROR_CODE.QUEUE_FULL,
          `会话在途消息已达上限 ${maxQueued}`, { conversation, queueDepth: bridge.queue })
        return
      }
      // 同一会话的 attach 串行化：已有一次 resume/create 在途时直接 409。
      // dsh 包内没有 AgentBusy 类可以依赖（grep 过全包），所以由网桥自己判定；
      // 否则两次 resume 同一 sessionId 会各拿一个 handle，dispose 谁都拆不对。
      if (bridge.attaching) {
        idempotencyForget(key)
        writeError(response, ERROR_CODE.AGENT_BUSY,
          '该会话已有一次 create/resume 在途', { conversation })
        return
      }
      bridge.attaching = true
      bridge.queue += 1

      try {
        // 1) boot 闸门：loader 未就绪时 agents.create 会失败。loader 缺席也不阻塞投递。
        try {
          await (typeof host.get === 'function' ? host : ctx).get('loader')?.await?.()
        } catch { /* 非 launcher 环境下没有 loader，忽略 */ }

        // 2) 跨日轮转闸门（契约 §2.3 的 daily）：宿主本地日期一变，旧会话先归档、
        //    映射摘掉，于是下面自动走「首次触发」那条路建新会话。
        //    判据取 createdAt 而非 lastActiveAt：一个会话属于它被造出来的那一天，
        //    同一天里聊到深夜不算跨日，否则「活跃会话」会天天换 id。
        //    只对 daily 生效——one-to-one 永不轮转，on-demand 归空闲扫描管。
        if (config.policy === POLICY.DAILY && bridge.dshSessionId) {
          const existing = records.get(conversation)
          if (existing && localDateKey(existing.createdAt ?? 0) !== localDateKey(Date.now())) {
            await recycleConversation(conversation, '跨日轮转')
          }
        }

        // 3) 冷启动：没有映射就先分配一个 id 并落盘（轮转策略在建映射时决定）。
        //    注意这里只分配 **id**，会话本体由下面的 create 建；已有映射时连 id 都不动。
        const hadMapping = Boolean(bridge.dshSessionId)
        if (!bridge.dshSessionId) {
          bridge.dshSessionId = newSessionId()
          // 只写契约 §2.2 / §12.5 规定的字段。
          // 不落 platform / messageType / title：前两者可从会话键
          // （parseConversation）推出来，落盘等于复制一份会漂移的真相；
          // 标题由 sessionTitleTemplate 渲染，是**渲染结果**而非状态。
          // 落盘字段多一个，normalizeRecord/serializeState 的白名单就多一处要同步，
          // 一旦漏同步就会出现「写进去了、重启后没了」的静默丢数据。
          // 记录形状的唯一权威是 location.js 的 normalizeRecord/newRecord，
          // 这里不再手写字段列表：手写就等于把白名单抄了第二份，漂移的后果是
          // 「写进去的字段重启后读不回来」——静默丢映射，最难查。
          // 不落的字段：platform / messageType（可从会话键推出，落盘是复制一份会漂移的
          // 真相）、title（是 sessionTitleTemplate 的**渲染结果**而非状态）。
          records.set(conversation, newRecord({
            conversation,
            dshSessionId: bridge.dshSessionId,
            // cwd 留 null = 对话级无覆盖，跟随全局配置（§12.3）。
            // workspaceId 已删除（P5 控制面才有实现，留着只会让人以为配了会生效）。
            policy: config.policy,
          }))
          persistRecords()
        }

        // 工作目录必须走 locationFor（对话级覆盖 → 全局配置，§12.3）：
        // 直接取 config.cwd 会让人工写进 state.json 的对话级 cwd 形同虚设。
        const location = locationFor(conversation)
        const cwd = location.cwd ?? config.cwd

        // 预设（agentPreset）是**工具行的唯一载体**：dsh-agent-presets 把工具行、提示词段与
        // 技能目录挂在一个常驻 scope 上，agent 只能靠 setup 期的 presets.mount(agentCtx, id)
        // 加入它；没加入的 agent 落到**空全局层**，模型手里一支工具都没有——本插件此前
        // tools 恒为空就是这个原因（只抄了 dsh-headless 的 installModelSelection，漏了这段）。
        // 官方权威序：dsh-api-session-controller/lib/index.js:350-363 composeAgent
        //（presets.resolve 取 id，返回的 setup 里 presets.mount(agentCtx, resolvedId)），
        // 以及 :441-451 ensureSession 把 resolvedId 写进 meta.agentPreset。
        const presets = (() => {
          try {
            return typeof host.get === 'function' ? host.get('agentPresets') : void 0
          } catch {
            return void 0
          }
        })()
        if (presets === void 0) {
          // 宿主没装预设服务（不是 web profile，或被裁过的装配）。只警告不抛：
          // 缺预设仍能对话，只是模型没有工具；把整条投递打挂是更坏的结果。
          log?.warn?.(`${tag} agentPresets 服务缺席：本次会话不挂预设，模型将没有任何工具`)
        }
        // 恢复旧会话要沿用**存档里的**预设（官方 assertPresetUnchanged 的同一语义）：
        // 存档头没有 agentPreset（本插件早期建的会话就是这种）时才回落到当前默认预设。
        let storedPresetId
        if (hadMapping && presets !== void 0) {
          let observation
          try {
            const observe = host.sessionQuery?.observeSession
            if (typeof observe === 'function') {
              observation = await observe.call(host.sessionQuery, brandString(bridge.dshSessionId))
              storedPresetId = observation?.header?.agentPreset
            }
          } catch { /* 读不到存档头就按默认预设挂，不值得让投递失败 */ } finally {
            // SessionObservation 是**租约**（dsh-session-query/lib/types/observation.d.ts：
            // 「pinning it until every lease releases」），不释放会 pin 住 prepared 缓存条目
            // 让缓存无法淘汰。官方的调用点一律用 using/__addDisposableResource 释放。
            observation?.[Symbol.dispose]?.()
          }
        }
        const presetId = presets === void 0 ? void 0 : (await presets.resolve(storedPresetId)).id

        // 每次投递取一份 selection 快照并随 agent 固定下来：
        // installModelSelection 会把选中结果回写到 .assembled。照抄 dsh-headless:126-145。
        const selection = host.agentDefaultModel.currentSelection()
        const attachOptions = {
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
            // 顺序与官方一致：先定模型选择，再把 agent 加入预设 scope。
            if (presets !== void 0) await presets.mount(agentCtx, presetId)
          },
        }

        // 4) live 优先，冷会话才 create / resume。
        //    宿主 resume 的前提是目标会话**不在 live registry**：
        //    dsh-session-persistence/lib/index.js:951-965 的 prepare() 一读到
        //    `ctx.sessions.get(id) !== undefined` 就抛
        //    `cannot prepare session "…" while it is live`。
        //    而本网桥的 handle 只在卸载期 dispose（见 shutdownBridges 的 ⚠️），
        //    live 占用**不随 turn/end 释放**，所以「有映射就 resume」会在同一个
        //    conversation 的第二封上稳定 500 —— 与密钥、配额、幂等键全都无关。
        //    官方 dsh-api-session-controller/lib/index.js:405-408 的序是先取 live、命中即复用：
        //    `const live = this.ctx.agents.get(sessionId); if (live !== void 0) return live;`
        //    这里照抄同一条序。
        const live = typeof host.agents.get === 'function'
          ? host.agents.get(brandString(bridge.dshSessionId))
          : void 0
        if (live !== void 0) {
          // 复用不产生新 handle：dispose 仍归真正建出它的那次 create/resume 的持有者
          // （bridge.dispose，卸载期交给 shutdownBridges 拆）。若 live 是跨持有点来的
          // （进程内首次 attach 之前别人已建过），这里拿不到 handle，但 provider 卸载会
          // 排空并 dispose 它自己造的每一个 live（dsh-agent/lib/types/index.d.ts:141-148），
          // 不会漏拆 agent 本体。
          // 已知取舍：复用时上面那份 selection 快照不生效 —— 同一 agent 换模型本来就得
          // 重建会话，官方复用路径同样沿用既有选择。
          bridge.agent = live
        } else {
          const handle = hadMapping
            ? await host.agents.resume({
              resumeSessionId: brandString(bridge.dshSessionId),
              ...attachOptions,
            })
            : await host.agents.create({
              sessionId: brandString(bridge.dshSessionId),
              meta: {
                cwd,
                // 照抄官方 ensureSession 的写法：presetId 缺席时**不写这个键**，
                // 写 undefined 会让存档头凭空多出一个 null 字段。
                ...presetId === void 0 ? {} : { agentPreset: presetId },
              },
              ...attachOptions,
            })
          // AgentHandle 是能力对象（{ agent, dispose }，dsh-agent/lib/types/index.d.ts:150-153）：
          // dispose 只有持有者才调得动，存下来卸载收尾时才有得拆。
          bridge.agent = handle.agent
          bridge.dispose = handle.dispose
        }

        // R3：把来源 IM 对话写进会话标题。排在两分支之后 —— live 复用与 create/resume
        // 到这一步都已经拿到 live agent，rename 的 not live 校验才过得去；同时也排在
        // followup 之前，标题先定下来，用户点进去看时列表里就已经认得出是哪个群了。
        writeSessionTitle(bridge)

        bridge.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))

        // 5) 不阻塞响应：空闲后 flush 会话记录再放掉在途计数（契约 §9 顺序）。
        bridge.agent.whenIdle()
          .then(() => host.sessions.flush(bridge.agent.session))
          .catch((error) => log?.warn?.(`${tag} 会话收尾失败：${String(error)}`))
          .finally(() => {
            bridge.queue = Math.max(0, bridge.queue - 1)
            bridge.attaching = false
          })

        // 记账：lastActiveAt 是轮转策略（on-demand / daily）判活的依据（§2.3），
        // 投递成功必须更新它，否则「久未活动」永远判不出来。
        const record = records.get(conversation)
        if (record) {
          record.lastActiveAt = Date.now()
          persistRecords()
        }

        const accepted = {
          accepted: true, conversation, queueDepth: bridge.queue, duplicate: false,
        }
        idempotencyRemember(key, accepted)
        writeJson(response, 202, accepted)
      } catch (error) {
        bridge.queue = Math.max(0, bridge.queue - 1)
        bridge.attaching = false
        // 因我方原因没接受：撤掉在途标记，否则同一把键重试会命中标记拿到
        // duplicate: true，而消息其实一次都没投出去。
        idempotencyForget(key)
        writeError(response, ERROR_CODE.INTERNAL,
          `投递失败：${String(error?.message ?? error)}`)
      }
    }

    /** GET /events — SSE 下行通道（契约 §3.2 / §4.1）。 */
    function handleEvents(request, response) {
      if (!authorize(request, response, config)) return
      const conversation = queryOf(request).searchParams.get('conversation')
      if (!conversation) {
        writeError(response, ERROR_CODE.UNSUPPORTED,
          '缺少 conversation 查询参数（IM 会话键，形如 default:GroupMessage:1000000001）')
        return
      }
      // 契约 §4.1 规定 IM 侧顺序固定为「先连 SSE → 再 POST /message」，
      // 所以首次通话时这里必然还没有映射：必须用 bridgeOf 按需建桥，
      // 否则 /events 先回 404，IM 侧一旦把 404 视为永久失败就死锁（首帧永远到不了）。
      // 只建内存桥、不落盘映射，dshSessionId 由 handleMessage 在第 722-743 行分配。
      const bridge = bridgeOf(conversation)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 反代默认会缓冲响应体，SSE 就退化成「一次全吐出来」，必须显式关掉。
        'x-accel-buffering': 'no',
      })
      response.write(': connected\n\n')

      const connection = { bridge, response, heartbeat: null, closed: false, subscriber: null }
      // 先补历史、**再**登记订阅者：反过来会漏掉重放期间新产生的事件。
      const from = Number.parseInt(headerOf(request, 'last-event-id'), 10)
      if (Number.isFinite(from)) {
        for (const envelope of [...bridge.buffer]) {
          if (envelope.seq > from) sseWrite(connection, envelope)
        }
      }
      connection.subscriber = (envelope) => sseWrite(connection, envelope)
      bridge.subscribers.add(connection.subscriber)
      sseConnections.add(connection)

      // 心跳走 ephemeral：不占 seq、不入缓冲，只用来让中间设备别掐连接。
      connection.heartbeat = setInterval(() => {
        if (connection.closed) return
        try {
          response.write(`event: ${EVENT.HEARTBEAT}\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`)
        } catch {
          closeSse(connection, 'heartbeat-failed')
        }
      }, Math.max(1000, Math.trunc(config.heartbeatMs)))
      connection.heartbeat.unref?.()

      request.on('close', () => closeSse(connection, 'request-close'))
      request.on('error', () => closeSse(connection, 'request-error'))
      response.on('close', () => closeSse(connection, 'response-close'))
    }

    /** POST /approval — IM 回执审批（契约 §3.3）。 */
    async function handleApproval(request, response) {
      if (!authorize(request, response, config)) return
      const rawBody = await readRawBody(request)
      if (!verifySignature(request, response, config, rawBody)) return
      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        writeError(response, ERROR_CODE.UNSUPPORTED, '请求体必须是 JSON 对象')
        return
      }
      const fields = ['conversation', 'callId', 'outcome', 'code']
      for (const field of fields) {
        const value = body[field]
        if (typeof value !== 'string' || value.trim() === '') {
          writeError(response, ERROR_CODE.UNSUPPORTED, `字段 ${field} 必须是非空字符串`)
          return
        }
      }
      const { conversation, callId, outcome, code } = body
      if (!APPROVAL_OUTCOME_ALLOWED.includes(outcome)) {
        writeError(response, ERROR_CODE.UNSUPPORTED,
          `outcome 只能是 ${APPROVAL_OUTCOME_ALLOWED.join(' / ')}`)
        return
      }
      const bridge = bridges.get(conversation)
      if (!bridge) {
        writeError(response, ERROR_CODE.NOT_FOUND, `未知对话 ${conversation}`)
        return
      }
      const pending = bridge.approvals.get(callId)
      if (!pending) {
        // 契约 §3.3：已决议 / 已超时都归为「幂等冲突」，用 409 表达，不算错误。
        // 本端 ERROR_STATUS 里 409 只有 agent_busy 一个码，故复用之。
        writeError(response, ERROR_CODE.AGENT_BUSY, `该审批已决议或已超时：${callId}`)
        return
      }
      if (Date.now() > pending.expiresAt) {
        bridge.approvals.delete(callId)
        pending.settle(APPROVAL_OUTCOME.REJECTED, 'timeout')
        writeError(response, ERROR_CODE.AGENT_BUSY, '该审批已超时')
        return
      }
      if (pending.code !== code.trim().toUpperCase()) {
        writeError(response, ERROR_CODE.UNSUPPORTED, '验证码不正确')
        return
      }
      bridge.approvals.delete(callId)
      pending.settle(outcome, 'im')
      writeJson(response, 200, { ok: true })
    }

    /**
     * GET /where?conversation=<umo> — **已实现**（契约 §12）。
     *
     * 只读地回答「这个 IM 对话落在哪个工作区、对应哪个 DSH 会话」。
     * 会话尚未建立映射时也照样作答（found:false，但 cwd 与来源仍给出），
     * 因为「它将会落在哪」正是排查时最想知道的事。
     */
    function handleWhere(request, response) {
      if (!authorize(request, response, config)) return
      const conversation = queryOf(request).searchParams.get('conversation')
      if (!conversation) {
        writeError(response, ERROR_CODE.UNSUPPORTED,
          '缺少 conversation 查询参数（IM 会话键，形如 default:GroupMessage:1000000001）')
        return
      }
      writeJson(response, 200, locationFor(conversation))
    }

    /**
     * GET /conversations?limit=N — **已实现**（契约 §12）。
     * 列出已知映射，默认 50 条、上限 200，避免一次拉爆。
     */
    function handleConversations(request, response) {
      if (!authorize(request, response, config)) return
      const raw = Number(queryOf(request).searchParams.get('limit') ?? 50)
      const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50
      const items = [...records.keys()].sort().slice(0, limit).map((conversation) => locationFor(conversation))
      writeJson(response, 200, { count: records.size, returned: items.length, limit, items })
    }

    /**
     * 取宿主的工作区注册表（注入声明里有它，但被裁过的装配仍可能缺席）。
     * 缺席一律走 500，而不是静默返回空清单——「没有工作区」和「问不到工作区」
     * 对 IM 侧是完全不同的两件事，混在一起会让人按空清单去排查半天。
     */
    function workspaceRegistryOf() {
      try {
        if (host.workspaceRegistry) return host.workspaceRegistry
        return typeof host.get === 'function' ? host.get('workspaceRegistry') : void 0
      } catch {
        return void 0
      }
    }

    /**
     * GET /workspaces?limit=N — **已实现**（契约 §13.1）。
     *
     * 列出宿主 `workspaceRegistry` 里登记的工作区，供 IM 侧挑「改指」的目标。
     *
     * 为什么直接问服务、不走控制面 RPC：`workspace.list` 在 docs/control-plane-transport.md
     * 里**没有对应端点**（第 44 / 452 / 490 / 500 / 693 行只有服务与事件），
     * 唯一可用的入口就是 `workspaceRegistry.list()`。
     *
     * 注意 `list()` 是**同步**的（官方 dsh-workspace/lib/index.js:384-390：按持久化的
     * workspaceIds 顺序返回，读内存、不做持久化读、不排队），所以本函数不是 async。
     */
    function handleWorkspaces(request, response) {
      if (!authorize(request, response, config)) return
      const registry = workspaceRegistryOf()
      if (!registry || typeof registry.list !== 'function') {
        writeError(response, ERROR_CODE.INTERNAL, '宿主未提供 workspaceRegistry.list()，工作区清单不可用')
        return
      }
      let listed
      try {
        listed = registry.list()
      } catch (error) {
        writeError(response, ERROR_CODE.INTERNAL,
          `读取工作区清单失败：${String(error?.message ?? error)}`)
        return
      }
      // 只暴露公开读取面（id / path / title / sessionIds），不碰实体内部的 record：
      // 私有字段是官方实现细节，抄进来等于给自己埋一个「升级即断」的点。
      const all = (Array.isArray(listed) ? listed : []).map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds,
      }))
      // limit 的读法与 /conversations 逐字一致（默认 50、上限 200）：两个列表端点若在
      // 截断口径上分叉，就成了「必须靠人记住」的差异，迟早被踩。
      const raw = Number(queryOf(request).searchParams.get('limit') ?? 50)
      const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50
      const items = all.slice(0, limit)
      writeJson(response, 200, { count: all.length, returned: items.length, limit, items })
    }

    /**
     * POST /session/rebind — **已实现**（契约 §13.2）。
     *
     * 把某个 IM 对话**改指**到另一个工作区：为它新建一个落在目标目录的 DSH 会话，
     * 再把映射换过去。旧会话**不删也不摘**——它的 cwd 仍是原目录，从原工作区里
     * 摘掉它才是说谎（官方 attachSession 的四条校验也是按 cwd 认账的）。
     *
     * 为什么必须换会话 id、不能「就地改 cwd」：会话头里的 cwd 在创建时定死，
     * 官方唯一允许的路径是「建会话 → attachSession」，且 attachSession 要求
     * readSessionHeader(sessionId).cwd === record.path，没有任何一条路能改已存在的会话。
     *
     * 建会话与挂载的**顺序照抄**官方 SessionCommandController.create
     *（dsh-api-session-controller/lib/index.js:548-600）：workspaceId 与 cwd 互斥
     * → 查注册表 → 先 create → 成功后再 attachSession。
     */
    async function handleRebind(request, response) {
      if (!authorize(request, response, config)) return
      const rawBody = await readRawBody(request)
      if (!verifySignature(request, response, config, rawBody)) return
      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        writeError(response, ERROR_CODE.UNSUPPORTED, '请求体必须是 JSON 对象')
        return
      }
      // 校验文案与 /approval 的字段校验保持一致：同一份契约里不该有两套措辞。
      const fields = ['conversation', 'workspaceId']
      for (const field of fields) {
        const value = body[field]
        if (typeof value !== 'string' || value.trim() === '') {
          writeError(response, ERROR_CODE.UNSUPPORTED, `字段 ${field} 必须是非空字符串`)
          return
        }
      }
      const conversation = body.conversation.trim()
      const workspaceId = body.workspaceId.trim()

      const registry = workspaceRegistryOf()
      if (!registry || typeof registry.get !== 'function') {
        writeError(response, ERROR_CODE.INTERNAL, '宿主未提供 workspaceRegistry.get()，按 id 改指不可用')
        return
      }
      // get() 同步、未命中返回 undefined（官方 dsh-workspace/lib/index.js:375-377）。
      const workspace = registry.get(workspaceId)
      if (!workspace) {
        writeError(response, ERROR_CODE.NOT_FOUND, `未知工作区 ${workspaceId}`)
        return
      }
      // 目录没了的登记项要在**建会话之前**拦下：拖到 attachSession 才炸的话，
      // 报错会是一句没有上下文的 stat 失败，排查的人只能自己去翻注册表。
      const status = typeof workspace.status === 'function' ? workspace.status() : 'ok'
      if (status !== 'ok') {
        // 收口到 409，不回 400：400 在 IM 侧一律被判成「调用方的问题、不可重试」
        // （`_unpack` 的 retryable 只看状态码），而目录不可用是**服务端侧的环境故障**，
        // 等目录回来再试才是正确动作。
        // 复用 `agent_busy` 是权衡结果：ERROR_STATUS 表里 409 只挂着这一个码，
        // 新增 503 要同改两侧常量、契约文档与 parity 白名单，收益不抵成本。
        writeError(response, ERROR_CODE.AGENT_BUSY,
          `工作区目录当前不可用（${status}）：${workspace.path}`,
          { conversation, workspaceId, status })
        return
      }

      const bridge = bridgeOf(conversation)
      // 与 /message 同一条串行化纪律：有投递在途时改指，会让同一条消息落到两个会话里。
      if (bridge.attaching || bridge.queue > 0) {
        writeError(response, ERROR_CODE.AGENT_BUSY,
          '该会话有投递或附着在途，请稍后再改指', { conversation })
        return
      }
      bridge.attaching = true

      try {
        const previousSessionId = records.get(conversation)?.dshSessionId ?? ''
        const nextSessionId = newSessionId()
        const cwd = workspace.path

        // boot 闸门：loader 未就绪时 agents.create 会失败（与 /message 同一处理）。
        try {
          await (typeof host.get === 'function' ? host : ctx).get('loader')?.await?.()
        } catch { /* 非 launcher 环境下没有 loader，忽略 */ }

        // 预设（工具行的唯一载体）：取舍同 /message——缺预设只警告，不把改指打挂。
        const presets = (() => {
          try {
            return typeof host.get === 'function' ? host.get('agentPresets') : void 0
          } catch {
            return void 0
          }
        })()
        if (presets === void 0) {
          log?.warn?.(`${tag} agentPresets 服务缺席：改指后的会话不挂预设，模型将没有任何工具`)
        }
        // 新会话沿用**旧存档里的**预设（官方 assertPresetUnchanged 的同一语义）：
        // 改指不该顺手把工具行换掉，那会变成一次没人预期的能力变更。
        // 存档头没有该字段（早期会话就是这种）时才回落到当前默认预设。
        let storedPresetId
        if (previousSessionId && presets !== void 0) {
          let observation
          try {
            const observe = host.sessionQuery?.observeSession
            if (typeof observe === 'function') {
              observation = await observe.call(host.sessionQuery, brandString(previousSessionId))
              storedPresetId = observation?.header?.agentPreset
            }
          } catch { /* 读不到存档头就按默认预设挂，不值得让改指失败 */ } finally {
            // SessionObservation 是租约，不释放会 pin 住 prepared 缓存条目。
            observation?.[Symbol.dispose]?.()
          }
        }
        const presetId = presets === void 0 ? void 0 : (await presets.resolve(storedPresetId)).id

        // 每次附着取一份 selection 快照并随 agent 固定下来（照抄 dsh-headless:126-145）。
        const selection = host.agentDefaultModel.currentSelection()
        const attachOptions = {
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
            if (presets !== void 0) await presets.mount(agentCtx, presetId)
          },
        }

        // 【顺序是有意的】新会话先建、先挂，**旧 agent 在此之前原封不动**：
        // 这样改指的每一步失败都能原地退出——bridge 仍指着旧会话，不需要任何回滚。
        // 反序（先拆旧、再建新）的代价是拆完才发现新会话建不起来，桥会停在
        // 「旧 agent 已没了、新会话也没有」的中间态上。
        const handle = await host.agents.create({
          sessionId: brandString(nextSessionId),
          meta: {
            cwd,
            // 照抄官方 ensureSession 的写法：presetId 缺席时**不写这个键**。
            ...presetId === void 0 ? {} : { agentPreset: presetId },
          },
          ...attachOptions,
        })

        try {
          // attachSession 要求存档头里的 cwd 存在、能被 realpath 归一、且等于
          // record.path——四者全过才记账。任何一条不过都会抛，这属**正常失败路径**，
          // 抛到外层兜底变成 500 会让人以为网桥坏了，所以在这里就地收口成 409。
          // ⚠ 此刻新会话**已经落盘**（create 成功即写档），只是没挂上工作区：
          // 把它连同 sessionId 一起回报出去，IM 侧才知道「建出来过一个会话」不是幻觉。
          await workspace.attachSession(nextSessionId)
        } catch (error) {
          let released = false
          try {
            if (typeof handle.dispose === 'function') { handle.dispose(); released = true }
          } catch { /* 收尾失败不掩盖主因 */ }
          writeError(response, ERROR_CODE.AGENT_BUSY,
            `会话已建立，但挂到工作区失败：${String(error?.message ?? error)}`,
            { conversation, workspaceId, sessionId: nextSessionId, cwd, orphaned: true, released })
          return
        }

        // 新会话就位之后才拆旧的，收尾序照搬 shutdownBridges（同文件下方）：
        // 先摘引用（收尾期间新到的 /message 会因 attaching 拿到 409，撞不上这次拆除）
        // → cancel({kind:'user'}) → await whenIdle() → await sessions.flush(session) → dispose()。
        // dispose() 会把该会话从 store 里删掉（dsh-agent types index.d.ts:136-153），
        // 所以 flush 必须排在它**之前**，否则旧会话最后那轮记录直接丢。
        const previousAgent = bridge.agent
        const previousDispose = bridge.dispose
        bridge.agent = null
        bridge.dispose = null
        if (previousAgent) {
          try {
            previousAgent.cancel({ kind: 'user' })
            await previousAgent.whenIdle()
            await host.sessions.flush(previousAgent.session)
          } catch (error) {
            // 排空失败也必须继续 dispose，否则 handle 永远留在 registry 里。
            log?.warn?.(`${tag} 改指：${conversation} 旧会话排空失败，仍继续拆除：${String(error)}`)
          }
        }
        if (typeof previousDispose === 'function') {
          try {
            // dispose 只在**本网桥持有 handle 时**才有值（复用别人建的 live 时拿不到），
            // 拿不到就交给 provider 卸载时自己排空，不能凭空造一个 dispose 出来。
            await previousDispose()
          } catch (error) {
            // 拆不掉旧 agent 不该连累改指本身：新会话是新建的，与旧 handle 无关。
            log?.warn?.(`${tag} 改指时释放旧 agent 失败（已忽略）：${String(error)}`)
          }
        }

        // 映射换成新会话。字段**只能**经 newRecord 生产：手写就等于把 location.js 的
        // 白名单抄了第二份，漂移的后果是「写进去了、重启后没了」的静默丢映射。
        records.set(conversation, newRecord({
          conversation,
          dshSessionId: nextSessionId,
          // 对话级 cwd 覆盖：这正是「改指」在本插件里的落点（§12.3）。
          cwd,
          policy: config.policy,
        }))
        persistRecords()

        // 就地改写网桥，**不 delete 重建**：SSE 订阅者、环形缓冲与 seq 都挂在它身上，
        // 换实例等于把正在看流的客户端全踢掉，Last-Event-ID 续传也会出洞。
        // agent 事件按 agent.id 过滤，旧 agent 的残帧会在这一步之后自动被丢弃。
        bridge.dshSessionId = nextSessionId
        bridge.agent = handle.agent
        bridge.dispose = handle.dispose
        bridge.turn = 0
        bridge.attempt = null
        bridge.toolCalls = new Map()
        bridge.approvals = new Map()

        // R3：改指后新会话还没被任何东西写过标题，这里就地补上，否则列表里那一条
        // 会退回显示成一串 dshSessionId。旧会话的标题原样留着（它不再被本对话指向，
        // 但本体还在原工作区，不该顺手抹掉别人的痕迹）。
        writeSessionTitle(bridge)

        writeJson(response, 200, {
          ok: true,
          conversation,
          workspaceId,
          sessionId: nextSessionId,
          cwd,
          // 旧会话只是「不再被这个对话指向」，本体与账目都原样留在原工作区。
          previousSessionId: previousSessionId || null,
        })
      } catch (error) {
        writeError(response, ERROR_CODE.INTERNAL,
          `改指失败：${String(error?.message ?? error)}`, { conversation })
      } finally {
        bridge.attaching = false
      }
    }

    /**
     * POST /session/adopt（契约 §15）：把某个 IM 对话**改指到一个已存在的** DSH 会话。
     *
     * 与 /session/rebind 的唯一差别是「会话从哪来」：rebind 新建一个再挂，adopt 认领现成的。
     * 补这一步的原因：/session/fork 建出的子会话既不是本对话的映射目标，也没有任何既有
     * 路由能把映射改指过去——/message 的建会话分支被 hadMapping 锁死（有映射时一律
     * resume 旧 id），/session/rebind 只会 create，两者合起来仍然缺「把映射改成某个
     * sessionId」这唯一一步，于是 v3 里「子会话可被接管」是句兑现不了的话。
     *
     * 只做三件事，一概不碰会话本体：
     *   1. 确认目标会话存在（observeSession），并取存档头里的 cwd；
     *   2. 拆掉本对话此刻握着的旧 agent（顺序照搬 /session/rebind 的收尾序）；
     *   3. 映射换成目标 sessionId，bridge.dshSessionId 就地改指。
     * 不 resume、不 rename、不 create：目标会话本体一个字节都不动，真正的 resume 交给
     * 下一次 /message（那时 hadMapping 为真、目标又不在 live registry 里，正好命中
     * host.agents.resume 那条路），于是「认领」这一步不会因为宿主环境而变成半成品。
     */
    async function handleAdopt(request, response) {
      if (!authorize(request, response, config)) return
      const rawBody = await readRawBody(request)
      if (!verifySignature(request, response, config, rawBody)) return
      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        writeError(response, ERROR_CODE.UNSUPPORTED, '请求体必须是 JSON 对象')
        return
      }
      // 校验文案与 /approval、/session/rebind 共用同一套措辞：一份契约不该有两套。
      for (const field of ['conversation', 'sessionId']) {
        const value = body[field]
        if (typeof value !== 'string' || value.trim() === '') {
          writeError(response, ERROR_CODE.UNSUPPORTED, `字段 ${field} 必须是非空字符串`)
          return
        }
      }
      const conversation = body.conversation.trim()
      const sessionId = body.sessionId.trim()
      // workspaceId 可选：给了就必须**真的**包含这个会话，否则「认领到某工作区」是假账。
      let workspaceId = ''
      if (body.workspaceId !== void 0 && body.workspaceId !== null) {
        if (typeof body.workspaceId !== 'string' || body.workspaceId.trim() === '') {
          writeError(response, ERROR_CODE.UNSUPPORTED, '字段 workspaceId 必须是非空字符串')
          return
        }
        workspaceId = body.workspaceId.trim()
      }

      const observe = host.sessionQuery?.observeSession
      if (typeof observe !== 'function') {
        writeError(response, ERROR_CODE.INTERNAL, '宿主未提供 sessionQuery.observeSession，认领不可用')
        return
      }
      let observation
      try {
        observation = await observe.call(host.sessionQuery, brandString(sessionId))
      } catch (error) {
        // 「目标会话不存在」是调用方的问题，其余（服务缺席、读档失败）归 500——
        // 与 /session/fork 对源会话的判定同一套。
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          writeError(response, ERROR_CODE.NOT_FOUND, `会话 ${sessionId} 不存在`, { sessionId })
          return
        }
        writeError(response, ERROR_CODE.INTERNAL,
          `无法读取待认领的会话 ${sessionId}：${String(error?.message ?? error)}`, { sessionId })
        return
      }
      try {
        // cwd 取**存档头里的**，不接受请求参数指定：会话属于哪个目录是它出生时定死的事实，
        // 让调用方改等于允许把 record.cwd 写成一句假话（§12.3 的对话级覆盖同理）。
        const cwd = typeof observation.header?.cwd === 'string' ? observation.header.cwd : void 0

        if (workspaceId) {
          const registry = workspaceRegistryOf()
          const workspace = registry && typeof registry.get === 'function'
            ? registry.get(workspaceId)
            : void 0
          if (!workspace) {
            writeError(response, ERROR_CODE.NOT_FOUND, `未知工作区 ${workspaceId}`, { workspaceId })
            return
          }
          if (!(Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId))) {
            // 收口到 409：请求本身没错，是「此刻不成立」，判定同 /session/rebind 的目录不可用。
            writeError(response, ERROR_CODE.AGENT_BUSY,
              `工作区 ${workspaceId} 并未包含会话 ${sessionId}，认领会写出一条假挂载`,
              { conversation, sessionId, workspaceId })
            return
          }
        }

        const bridge = bridgeOf(conversation)
        // 与 /message、/session/rebind 同一条串行化纪律：有投递在途时改指，
        // 会让同一条消息落到两个会话里。
        if (bridge.attaching || bridge.queue > 0) {
          writeError(response, ERROR_CODE.AGENT_BUSY,
            '该会话有投递或附着在途，请稍后再认领', { conversation })
          return
        }
        const previousSessionId = records.get(conversation)?.dshSessionId ?? ''
        if (previousSessionId === sessionId) {
          // 幂等：已经指着它了，什么都不用做，也不该报错。
          writeJson(response, 200, {
            ok: true,
            conversation,
            sessionId,
            cwd: cwd ?? null,
            previousSessionId: previousSessionId || null,
            adopted: false,
            workspaceId: workspaceId || null,
          })
          return
        }

        bridge.attaching = true
        try {
          // 旧 agent 的收尾序照抄 /session/rebind 与 shutdownBridges：
          // 先摘引用（收尾期间新到的 /message 会因 attaching 吃到 409，撞不上这次拆除）
          // → cancel({kind:'user'}) → await whenIdle() → flush → dispose()。
          // 目标会话**不参与**这一步：它不是本对话握着的那个，我们手里没有它的 handle。
          const previousAgent = bridge.agent
          const previousDispose = bridge.dispose
          bridge.agent = null
          bridge.dispose = null
          if (previousAgent) {
            try {
              previousAgent.cancel({ kind: 'user' })
              await previousAgent.whenIdle()
              await host.sessions.flush(previousAgent.session)
            } catch (error) {
              log?.warn?.(`${tag} 认领：${conversation} 旧会话排空失败，仍继续拆除：${String(error)}`)
            }
          }
          if (typeof previousDispose === 'function') {
            try {
              await previousDispose()
            } catch (error) {
              log?.warn?.(`${tag} 认领时释放旧 agent 失败（已忽略）：${String(error)}`)
            }
          }

          // 记录只能经 newRecord 生产：手写字段等于把 location.js 的白名单抄了第二份，
          // 漂移的症状是「写进去了、重启后没了」的静默丢映射。
          records.set(conversation, newRecord({
            conversation,
            dshSessionId: sessionId,
            // 对话级 cwd 覆盖：目标会话存档头里的目录。头里缺 cwd（早期会话）时才留 null
            // 跟随全局配置——注意 E:\0d00\dsh-workspace 这种**未登记为工作区**的目录
            // 也能这么跟上，resume 只认 cwd，不要求它在工作区注册表里。
            cwd,
            policy: config.policy,
          }))
          persistRecords()

          // 就地改写网桥，不 delete 重建：SSE 订阅者、环形缓冲与 seq 都挂在它身上。
          // agent/dispose 留 null——认领不建 handle，下一次 /message 会自己 resume 拿到。
          bridge.dshSessionId = sessionId
          bridge.agent = null
          bridge.dispose = null
          bridge.turn = 0
          bridge.attempt = null
          bridge.toolCalls = new Map()
          bridge.approvals = new Map()

          // 这里**不**调 writeSessionTitle：目标会话此刻没有 live agent，rename 的
          // not-live 校验过不去，调了只会刷一条没用的警告。标题由下一次 /message 的
          // writeSessionTitle 补上（那时刚 resume 完，已经 live 了）。

          writeJson(response, 200, {
            ok: true,
            conversation,
            sessionId,
            cwd: cwd ?? null,
            previousSessionId: previousSessionId || null,
            adopted: true,
            workspaceId: workspaceId || null,
          })
        } finally {
          bridge.attaching = false
        }
      } catch (error) {
        writeError(response, ERROR_CODE.INTERNAL,
          `认领失败：${String(error?.message ?? error)}`, { conversation, sessionId })
      } finally {
        // SessionObservation 是租约，不释放会 pin 住 prepared 缓存条目。
        observation?.[Symbol.dispose]?.()
      }
    }

    /**
     * POST /session/fork（契约 §14）：把某个**已完成轮次**的前缀复制成一个新会话。
     *
     * 逐行对照官方 `ApiSessionController.fork`
     *（dsh-api-session-controller/lib/index.js:652-745），差异只在这几处：
     *   1. 官方 `composeAgent` 是那个类自己的方法，网桥没注入 `agentPresets`，
     *      所以按 `handleRebind` 的做法手搓 `{agentPreset, setup}`；
     *   2. 官方 `forkWorkspace` 只在 `origin === 'subagent'` 时回溯祖先工作区，
     *      IM 会话走的是「直接包含」那一条，等价物就是 registry.list().find(...)；
     *   3. 子会话不进 records、也不建 bridge——它只是一个「已建好并落了档的新会话」，
     *      何时接管由 IM 侧用 /message、/session/rebind 或 /session/adopt（契约 §15）决定。
     */
    async function handleFork(request, response) {
      if (!authorize(request, response, config)) return
      const rawBody = await readRawBody(request)
      if (!verifySignature(request, response, config, rawBody)) return
      const body = await readJsonBody(request)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        writeError(response, ERROR_CODE.UNSUPPORTED, '请求体必须是 JSON 对象')
        return
      }
      // 校验文案与 /approval、/session/rebind 共用同一套措辞：一份契约不该有两套。
      if (typeof body.sessionId !== 'string' || body.sessionId.trim() === '') {
        writeError(response, ERROR_CODE.UNSUPPORTED, '字段 sessionId 必须是非空字符串')
        return
      }
      const sessionId = body.sessionId.trim()
      // atSeq 可选。官方用 SessionSeq 品牌校验（"atSeq must be a non-negative safe
      // integer"），网桥不引 dsh-session 的运行时品牌，就地做等价判定。
      let atSeq
      if (body.atSeq !== void 0 && body.atSeq !== null) {
        if (!Number.isSafeInteger(body.atSeq) || body.atSeq < 0) {
          writeError(response, ERROR_CODE.UNSUPPORTED, '字段 atSeq 必须是非负安全整数')
          return
        }
        atSeq = body.atSeq
      }

      const observe = host.sessionQuery?.observeSession
      if (typeof observe !== 'function') {
        writeError(response, ERROR_CODE.INTERNAL, '宿主未提供 sessionQuery.observeSession，分支不可用')
        return
      }
      let observation
      try {
        // ⚠ 绝不能传 projectionMode:'none'：官方 presetForObservation 在
        // projections 缺席时直接抛（api-session-controller:471-474），分支取预设要用它。
        observation = await observe.call(host.sessionQuery, brandString(sessionId))
      } catch (error) {
        // 只有「源会话不存在」是调用方的问题，其余（服务缺席、读档失败）归 500。
        if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
          writeError(response, ERROR_CODE.NOT_FOUND, `会话 ${sessionId} 不存在`, { sessionId })
          return
        }
        writeError(response, ERROR_CODE.INTERNAL,
          `无法读取分支源会话 ${sessionId}：${String(error?.message ?? error)}`, { sessionId })
        return
      }

      try {
        const source = observation
        const events = source.events
        const lastSeq = events.at(-1)?.seq ?? -1
        // 刀口三元式照抄官方：给了 atSeq 就找「覆盖它或更晚的第一个 turn/end」；
        // 没给 atSeq、或 atSeq 落在日志末尾之后就找**最后一个** turn/end；
        // 给了 atSeq 却还没走到那一轮（或那一轮没结束）时 boundary 为 undefined。
        const boundary = (atSeq === void 0
          ? void 0
          : events.find((event) => event.type === EVENT.TURN_END && event.seq >= atSeq))
          ?? (atSeq === void 0 || atSeq > lastSeq
            ? events.findLast((event) => event.type === EVENT.TURN_END)
            : void 0)
        if (boundary === void 0) {
          // 收口到 409 的理由同 /session/rebind 的目录不可用：这不是请求写错了，
          // 是「现在还不成」，等那一轮跑完再分就行。
          writeError(response, ERROR_CODE.AGENT_BUSY,
            atSeq !== void 0 && atSeq <= lastSeq
              ? `会话 ${sessionId} 尚未完成包含事件 ${atSeq} 的那一轮`
              : `会话 ${sessionId} 没有可分支的完整轮次`,
            { sessionId })
          return
        }
        // seed 必须从 seq 0 连续、不得停在未闭合的 turn 或悬空 tool call 上：
        // 官方把刀口一路推到下一个 turn/start，这里逐字照抄。
        let cut = boundary.seq + 1
        while (cut < events.length && events[cut]?.type !== EVENT.TURN_START) cut += 1

        // forkWorkspace 的等价物：只认「直接包含这个会话」的工作区，未命中就不挂
        // （官方那条 origin === 'subagent' 的祖先回溯在 IM 场景下不可能命中）。
        const registry = workspaceRegistryOf()
        let workspace
        if (registry && typeof registry.list === 'function') {
          // registry.list() 是**同步**的，按持久化顺序返回登记项（dsh-workspace:384-390）。
          workspace = registry.list()
            .find((entry) => Array.isArray(entry.sessionIds) && entry.sessionIds.includes(sessionId))
        }

        // 预设（工具行的唯一载体）：口径与 /session/rebind 一致——缺预设只警告；
        // 取的是**源会话存档里的**预设，分支不该顺手换掉工具行。
        const presets = (() => {
          try {
            return typeof host.get === 'function' ? host.get('agentPresets') : void 0
          } catch {
            return void 0
          }
        })()
        if (presets === void 0) {
          log?.warn?.(`${tag} agentPresets 服务缺席：分支出的会话不挂预设，模型将没有任何工具`)
        }
        const storedPresetId = source.projections?.values?.agentPreset ?? source.header?.agentPreset
        const presetId = presets === void 0 ? void 0 : (await presets.resolve(storedPresetId)).id
        const selection = host.agentDefaultModel.currentSelection()
        const setup = async (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 })
          if (presets !== void 0) await presets.mount(agentCtx, presetId)
        }

        const childId = newSessionId()
        // seed 与 inheritedEventCount 是**平级字段**，且必须与 meta.isSeeded 成套给：
        // seed 与 events.slice(0, cut) 是同一份数据，少给一个 create 就会拒。
        let handle
        try {
          handle = await host.agents.create({
            sessionId: brandString(childId),
            seed: events.slice(0, cut),
            inheritedEventCount: cut,
            meta: {
              // 照抄官方：cwd 缺席时**不写这个键**，写了 undefined 会被当成显式覆盖。
              ...source.header?.cwd === void 0 ? {} : { cwd: source.header.cwd },
              parentSession: source.header?.id ?? sessionId,
              isSeeded: true,
              ...presetId === void 0 ? {} : { agentPreset: presetId },
            },
            agentOptions: { provider: selection.provider, model: selection.model },
            setup,
          })
        } catch (error) {
          // create 失败即无残留（archive 只在这一步之后写），如实报 500。
          writeError(response, ERROR_CODE.INTERNAL,
            `分支会话建立失败：${String(error?.message ?? error)}`, { sessionId })
          return
        }

        // R3 刻意**不在这里**写标题：fork 的请求体里没有 conversation（它只是「把某个
        // 会话的前缀复制一份」），没有源 IM 对话可反查；而且子会话此刻不属于任何对话，
        // 硬写只会落一条谁也认不出归属的标题。等 IM 侧真的接管它（/message 或
        // /session/rebind）时，那两处的 writeSessionTitle 会自然补上。
        if (workspace !== void 0) {
          try {
            // attachSession 要求存档头里的 cwd 存在、能被 realpath 归一、且等于
            // record.path——子会话刚在 create 里落过档，所以失败成因只剩归一不一致或
            // 目录消失。这是**正常失败路径**，就地收口成 409，别让它变成「网桥坏了」。
            await workspace.attachSession(childId)
          } catch (error) {
            let released = false
            try {
              if (typeof handle.dispose === 'function') { handle.dispose(); released = true }
            } catch { /* 收尾失败不掩盖主因 */ }
            writeError(response, ERROR_CODE.AGENT_BUSY,
              `会话已分支，但挂到工作区失败：${String(error?.message ?? error)}`,
              { sessionId: childId, sourceSessionId: sessionId, workspaceId: workspace.id, orphaned: true, released })
            return
          }
        }

        // 子会话立刻释放 handle：dispose() 的语义是「停 loop、注销 agent、把会话从
        // 内存 store 里摘掉」，**不删持久化档**（dsh-agent/lib/types/index.d.ts:136-153），
        // 所以子会话之后仍能被 /message 或 /session/rebind 接管——反过来，把它留在
        // 内存里才是不对的：没有 bridge 认领它，它只会白占一个 live agent。
        try {
          if (typeof handle.dispose === 'function') handle.dispose()
        } catch (error) {
          log?.warn?.(`${tag} 分支：子会话 ${childId} 释放失败（已忽略）：${String(error)}`)
        }

        writeJson(response, 200, {
          ok: true,
          sessionId: childId,
          sourceSessionId: sessionId,
          // 复制过去的事件条数= 刀口位置，IM 侧报文案与排查都要它。
          inheritedEventCount: cut,
          workspaceId: workspace?.id ?? null,
          cwd: source.header?.cwd ?? null,
        })
      } catch (error) {
        writeError(response, ERROR_CODE.INTERNAL,
          `分支失败：${String(error?.message ?? error)}`, { sessionId })
      } finally {
        // SessionObservation 是租约，不释放会 pin 住 prepared 缓存条目。
        observation?.[Symbol.dispose]?.()
      }
    }

    // ────────────────────────────────────────────────────────────────
    // 定位与 state
    // ────────────────────────────────────────────────────────────────

    /**
     * 组装某个会话的定位结果。工作目录顺序：对话级覆盖 → 全局配置（§12.3）。
     *
     * 注意输出的 `sessionId` 是**面向 IM 的字段名**，内部存的叫 dshSessionId
     * （见 lib/location.js 顶部说明）；转译只发生在这里与 resolveLocation 一处。
     */
    function locationFor(conversation) {
      return resolveLocation({
        conversation,
        record: records.get(conversation) ?? null,
        globalCwd: config.cwd,
        titleTemplate: config.sessionTitleTemplate,
        statePath,
      })
    }

    /**
     * 落盘映射表（原子写）。调用点：建映射、更新 lastActiveAt（§2.2）。
     * 只读面以外的写路径仍留给 P5 控制面——state.json 可以人工编辑。
     */
    function persistRecords() {
      // 落盘失败**不得**逃逸：它一旦抛出去就会落到 handleMessage 的兜底 catch 里，
      // 被记成「投递失败」并递减 queue，掩盖真实故障（磁盘满、state.json 只读……）。
      // 映射表在内存里已经是对的，写不进去只该留一条 warn，不该影响已接受的投递。
      try {
        saveState(statePath, records)
      } catch (error) {
        log?.warn?.(`${tag} state.json 落盘失败（内存态仍有效）：${String(error?.message ?? error)}`)
      }
    }

    log?.info?.(`${tag} loaded（投递与定位已可用：POST ${config.pathPrefix}${ROUTES.MESSAGE}）`)
  })
}

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

/** 拼接基址与路径，保证恰好一个斜杠且无尾斜杠。 */
function join(prefix, path) {
  const left = String(prefix || '').replace(/\/+$/, '')
  const right = String(path || '').replace(/^\/+/, '')
  return `${left}/${right}`
}

/** 解析请求 URL 的查询串。node 的 http 请求不带 base，需要一个占位 origin。 */
function queryOf(request) {
  return new URL(request?.url ?? '/', 'http://astrbot-relay.internal')
}

/**
 * 配置可用性校验。
 *
 * 这些约束无法用 Schemastery 表达（需要跨字段 / 与运行环境比较），
 * 因此手工检查，并且**加载即失败**。
 */
function assertConfigIsUsable(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('dsh-astrbot-relay: 缺少配置')
  }
  if (typeof config.token !== 'string' || config.token.length < 32) {
    throw new Error('dsh-astrbot-relay: token 必须是 >=32 字符的共享密钥')
  }
  if (typeof config.cwd !== 'string' || !isAbsolutePath(config.cwd)) {
    throw new Error(`dsh-astrbot-relay: cwd 必须是绝对路径，收到 ${JSON.stringify(config.cwd)}`)
  }
  if (typeof config.pathPrefix !== 'string' || config.pathPrefix.trim() === '') {
    throw new Error('dsh-astrbot-relay: pathPrefix 不能为空')
  }
  if (config.pathPrefix.endsWith('/')) {
    throw new Error('dsh-astrbot-relay: pathPrefix 不要以 "/" 结尾（prefix 匹配会因此错位）')
  }
  if (typeof config.sessionTitleTemplate !== 'string' || config.sessionTitleTemplate.trim() === '') {
    throw new Error('dsh-astrbot-relay: sessionTitleTemplate 不能为空（它承担反向定位，空标题等于定位失效）')
  }
  // policy / idleTtlMs 曾经与实现脱节（schema 里有、代码里没有）：当时的选择是
  // **加载期就响亮地失败**。接线之后（§2.3 的回收与轮转都真的有代码在跑），
  // 这里只剩参数校验：不再拒绝非默认值，但拒绝不可能执行的值。
  if (![POLICY.ONE_TO_ONE, POLICY.ON_DEMAND, POLICY.DAILY].includes(config.policy)) {
    throw new Error(`dsh-astrbot-relay: policy=${JSON.stringify(config.policy)} 不是已知策略`
      + `（只认 ${POLICY.ONE_TO_ONE} / ${POLICY.ON_DEMAND} / ${POLICY.DAILY}）`)
  }
  if (!Number.isFinite(Number(config.idleTtlMs)) || Number(config.idleTtlMs) <= 0) {
    throw new Error('dsh-astrbot-relay: idleTtlMs 必须是正的有限毫秒数，'
      + `收到 ${JSON.stringify(config.idleTtlMs)}`)
  }

  // 渲染一次做冒烟：模板里未知占位符会原样保留，这里只保证渲染本身不抛错。
  const probe = renderSessionTitle(config.sessionTitleTemplate, 'platform:MessageType:0')
  if (probe.trim() === '') {
    throw new Error('dsh-astrbot-relay: sessionTitleTemplate 渲染结果为空')
  }
}

/** Windows 与 POSIX 通用的绝对路径判定。 */
function isAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
}

/**
 * Bearer 鉴权。
 *
 * 已核实：框架**不提供**任何鉴权，注册的路由是裸的，所以这里是唯一防线。
 * 失败一律 401，且响应体不区分「token 错」与「token 缺失」。
 *
 * 实现在此完成（不依赖未核实 API），因为它是安全边界，不能留 TODO。
 * 比较必须是定长（timing-safe）：先各自 sha256 到等长再比较。
 */
function authorize(request, response, config) {
  const header = request?.headers?.authorization ?? request?.headers?.Authorization ?? ''
  const presented = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : ''
  if (presented && timingSafeEqual(presented, config.token)) return true
  writeError(response, ERROR_CODE.UNAUTHORIZED, 'unauthorized')
  return false
}

/**
 * 定长比较：`node:crypto` 的 timingSafeEqual 要求等长入参，
 * 因此先把两者各自 sha256 到固定 32 字节再比较，
 * 使比较时间与输入长度、内容前缀都无关。
 */
function timingSafeEqual(a, b) {
  const ha = createHash('sha256').update(String(a), 'utf8').digest()
  const hb = createHash('sha256').update(String(b), 'utf8').digest()
  return nodeTimingSafeEqual(ha, hb)
}

/** 写 JSON 响应。 */
function writeJson(response, status, body, extraHeaders) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 安全头，与 dsh 页面路由的口径一致。
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(payload)
}

/**
 * 写统一错误响应。契约 §8。
 * @param {string} code ERROR_CODE 之一
 */
function writeError(response, code, message, details) {
  const status = ERROR_STATUS[code] ?? 500
  const headers = code === ERROR_CODE.QUEUE_FULL
    // 背压：明确告知不要立即重试。契约 §6.3。
    ? { 'retry-after': '5' }
    : undefined
  const body = { error: { code, message } }
  if (details !== undefined) body.error.details = details
  writeJson(response, status, body, headers)
}
