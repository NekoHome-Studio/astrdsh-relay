/**
 * dsh-astrbot-relay（星驿）— IM ↔ DSH 网桥（DSH 侧 / host half）
 *
 * 这是**骨架 + 已实现部分**：
 *   - 已实现：插件契约（name / inject / Config / apply）、配置与 state 校验、
 *     路由表、Bearer 定长鉴权、健康检查、**定位（契约 §12）**、
 *     会话标题渲染、state.json 的原子读写、
 *     **投递 POST /message（§3.1：幂等表 + 背压 + create/resume 分流 + followup）**、
 *     **幂等记账（§6.1：有界 LRU + TTL + 在途标记）**、
 *     **环形缓冲与 SSE 广播骨架（§3.2 的 push/deliver/trimBuffer）**。
 *   - 未实现：SSE 端点接线、事件转发、审批 waterfall、轮转策略。
 *     未实现处一律返回 **501 not_implemented**（不是 400 unsupported：请求合法，是本端没做），
 *     并带明确的 TODO，**不会**假装成功。
 *
 * 契约真相来源：`docs/BRIDGE-CONTRACT.md`
 * 设计依据：    `docs/DESIGN.md` §3
 * API 证据：    `docs/dsh-side-capabilities.md`
 *
 * 动笔前必读的三条已核实事实（写错就废）：
 *   1. `ctx.webServer.register` 注册的路由**没有任何鉴权**，必须自己实现（§5）。
 *      因此**每个**端点（包括 /health）都要过 authorize。
 *   2. `text/delta` 来自 `session/event` 上的 `assistant/chunk`（`chunk.type === 'text-delta'`），
 *      是**瞬时**事件，无订阅者即永久丢失 → IM 侧必须先连 SSE 再 POST /message。
 *      （旧稿写的 `agent/assistant-stream` 已证伪：宿主 0.1.2-rc.1 全树无此事件。）
 *   3. 事件用 `Scoped<Agent>` 派发，但根 ctx 上未打 tag 的监听者会收到**所有** agent
 *      的事件 → 必须自己按 agent.id 过滤，否则串台到用户在 Web UI 的会话。
 */
import {
  createHash, randomInt, timingSafeEqual as nodeTimingSafeEqual,
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
import { loadState, resolveStatePath, saveState } from './state.js'

export const name = 'dsh-astrbot-relay'

/**
 * 依赖服务。框架会等它们就绪后再跑 apply。
 * 已核实：`dsh-agent-loop` 提供 agents factory，且本机 web profile 已挂载它。
 */
export const inject = ['webServer', 'agents', 'sessions', 'agentDefaultModel']

/**
 * 配置 schema。
 *
 * 【未核实】`@deepseek-ai/schemastery` 作为第三方插件依赖是否可解析——
 * P1 必须先实测；官方向导明确要求导出 Standard Schema 而非普通对象，
 * 因此这里不提供「退化成普通对象」的兜底。
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

  ctx.inject(['webServer', 'agents', 'sessions', 'agentDefaultModel'], (host) => {
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
          toolCalls: new Map(),
        }
        bridges.set(conversation, bridge)
      }
      return bridge
    }

    /** 记录请求头（node 会小写化，但不要假设，两边都查一次）。 */
    function headerOf(request, name) {
      const headers = request?.headers ?? {}
      const value = headers[name] ?? headers[name.toLowerCase()]
      return typeof value === 'string' ? value.trim() : ''
    }

    /**
     * 读并解析 JSON 请求体。
     * 超 1 MiB 直接掐断（IM 文本消息不该这么大），解析失败返回 null。
     */
    function readJsonBody(request) {
      return new Promise((resolve) => {
        let settled = false
        const done = (value) => { if (!settled) { settled = true; resolve(value) } }
        const chunks = []
        let size = 0
        request.on('data', (chunk) => {
          size += chunk.length
          if (size > 1_048_576) {
            request.destroy()
            done(null)
            return
          }
          chunks.push(chunk)
        })
        request.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          if (raw.trim() === '') { done({}); return }
          try { done(JSON.parse(raw)) } catch { done(null) }
        })
        request.on('error', () => done(null))
      })
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
        if (!agent || !dispose) continue
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
            await dispose()
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
          const chunk = data.chunk
          switch (chunk?.type) {
            case 'text-delta':
              // 只用于「边跑边显示」：最终文本一律以 message/final 为准（契约 §4.1）。
              push(bridge.conversation, {
                type: EVENT.TEXT_DELTA, turn: data.turn, step: data.step,
                index: chunk.index, text: chunk.text,
              }, { ephemeral: true })
              return
            case 'reasoning-delta':
              if (!config.forwardReasoning) return
              push(bridge.conversation, {
                type: EVENT.REASONING_DELTA, turn: data.turn, step: data.step,
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
                type: EVENT.TOOL_CALL, turn: data.turn, step: data.step, ...call,
              })
              return
            }
            case 'usage':
            case 'finish':
              // 用量与结束原因不单独下行：正文看 message/final，收尾看 turn/end。
              return
            default:
              assertNever(chunk, 'assistant/chunk')
          }
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

        // 2) 冷启动：没有映射就先分配一个 id 并落盘（轮转策略在建映射时决定）。
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

        // 每次投递取一份 selection 快照并随 agent 固定下来：
        // installModelSelection 会把选中结果回写到 .assembled。照抄 dsh-headless:126-145。
        const selection = host.agentDefaultModel.currentSelection()
        const attachOptions = {
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => {
            installModelSelection(agentCtx, { current: selection, assembled: void 0 })
          },
        }

        // 3) create / resume 分流（照抄 dsh-api-session-controller/lib/index.js:398-402、442-446）。
        //    已有映射必须走 resume：对同一个 sessionId 重复 create 会被宿主当成
        //    「会话已存在」而失败——「有映射就复用」这句注释在只有 create 的版本里
        //    根本没落地。
        const handle = hadMapping
          ? await host.agents.resume({
            resumeSessionId: brandString(bridge.dshSessionId),
            ...attachOptions,
          })
          : await host.agents.create({
            sessionId: brandString(bridge.dshSessionId),
            meta: { cwd },
            ...attachOptions,
          })
        // AgentHandle 是能力对象（{ agent, dispose }，dsh-agent/lib/types/index.d.ts:150-153）：
        // dispose 只有持有者才调得动，存下来卸载收尾时才有得拆。
        bridge.agent = handle.agent
        bridge.dispose = handle.dispose

        bridge.agent.followup(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        }))

        // 3) 不阻塞响应：空闲后 flush 会话记录再放掉在途计数（契约 §9 顺序）。
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
  // 以下三项 schema 里有、实现里没有：**加载期就响亮地失败**，
  // 而不是让人配上去、跑起来，再对「为什么没生效」百思不得其解。
  if (config.hmacMode === true) {
    throw new Error('dsh-astrbot-relay: hmacMode 尚未实现（契约 §5.2 的请求体签名校验），'
      + '置 true 只是让人以为开了强化')
  }
  if (config.policy !== POLICY.ONE_TO_ONE) {
    throw new Error(`dsh-astrbot-relay: policy=${JSON.stringify(config.policy)} 尚未实现`
      + `（轮转策略目前只写进 state.json、不执行），只支持 ${POLICY.ONE_TO_ONE}`)
  }
  if (Number(config.idleTtlMs) !== 86_400_000) {
    throw new Error('dsh-astrbot-relay: idleTtlMs 尚未实现（没有按空闲时长回收会话的逻辑），'
      + '改它不会有任何效果')
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
