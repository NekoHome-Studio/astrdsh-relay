# AstrDsh Relay（星驿）：五层设计（核实修正版）

> 接口细节看 `docs/BRIDGE-CONTRACT.md`（唯一真相来源）。
> 两侧 API 证据看 `docs/astrbot-side-capabilities.md`、`docs/dsh-side-capabilities.md`。
>
> 本文档的目标是：把你的五层架构**逐层落到已核实的 API 上**，并把原始设计里
> 与源码不符的假设明确标出来——因为其中几条会直接决定成败。

---

## 0. 结论摘要

| 决策项 | 结论 | 依据 |
|---|---|---|
| 桥接路线 | **路线 A**：AstrBot 侧普通 Star 插件，复用现有 IM 适配器 | `Platform` 只有 `run()`/`meta()` 两个抽象方法；平台只从 `platform_cls_map` 实例化，不注册就完全不碰 |
| 是否写 Platform 适配器 | **不写** | `send_by_session()` 有默认实现（只上报指标），不实现不报错但主动消息静默发不出——路线 A 用现成适配器规避了整个问题 |
| 传输层 | **自建 DSH host 插件 + 自有鉴权路由 + SSE 下行** | `/api` 面有 Host/Origin 栅栏 + 浏览器 cookie 鉴权，跨机非浏览器客户端接不进去；且审批无法通过该面拦截 |
| 会话键 | AstrBot `unified_msg_origin` 原文 | 已内建私聊/群聊区分，优于 `platform:group:user` 三元组 |
| 审批 | 可实现，走 `approval/request` waterfall + 一次性 code；**必须自加超时** | 审批服务零超时，唯一取消源是 `req.signal` |
| 流式 | `session/event` → `assistant/chunk` → SSE `text/delta` | `agent/assistant-stream` 在本机 0.1.2-rc.1 **不存在**（全树扫描证伪）；`assistant/chunk` 是活事件 |
| 部署假设 | 跨机/容器，HTTPS + 显式 token | 你的选择；与当前同机现状不同，见 §6 |

**一句话**：这个项目的技术风险**不在架构分层**，而在三处「原始设计假设与源码不符」
的地方（流式事件名、`/api` 鉴权、审批超时）。这三个坑已经踩明，方案随之收敛。

---

## 1. 与原始设计的差异修正表

| # | 原始设计假设 | 源码事实 | 影响 |
|---|---|---|---|
| 1 | `Platform` 基类有三个抽象方法 `run()`/`meta()`/`send_by_session()` | 只有 `run()`/`meta()` 是 `@abc.abstractmethod`；`send_by_session()` 有默认实现 | 路线 B 不会「不实现就报错」，而是**静默发不出主动消息**——更危险 |
| 2 | 消息进入方式为适配器 `handle_msg()` 投入事件队列 | 正确，且 `Platform` 构造函数实际以 **3 个位置参数**调用 `(platform_config, platform_settings, event_queue)`，与基类 2 参签名不同 | 仅影响路线 B（已放弃）；如将来要做，这是必踩的坑 |
| 3 | DSH 会话事件包含 `assistant/chunk` | **该假设成立**：`assistant/chunk` 在 `KNOWN_SESSION_EVENT_TYPES`（51 项）内，是活事件；`agent/assistant-stream` 只在 `0.1.2-rc.1`（724 个 JS 全树 0 命中）不存在，`0.1.5-rc.2` 起存在 | 第 3/4 层的流式照 `dsh-headless:streamReasoning` 范式实现，无需换事件面 |
| 4 | 传输层「至少一个共享 Token」 | `ctx.webServer.register` 注册的路由**完全没有鉴权**；token/cookie 栅栏只在 `dsh-client-connection` 自己的 `/api` 路由上 | 自建路由必须**自己实现鉴权**，不能白嫖 |
| 5 | 同机部署可用信标文件 `~/.dsh/xxx-ingress.json` 自动发现端口和 Token | 本机 `$DSH_HOME` 下**不存在**任何 `*ingress*` 文件；且你选了跨机 | 该设计整体作废，改为显式配置 `bridge_url` + `token` |
| 6 | 参考 `dsh-qqbot-bridge` 的做法 | 该包在本机安装产物中**不存在**（`@deepseek-ai/` 下无此包） | 无法作为参考；实际可参考的是 `dsh-acp`（审批转发范例）与 `dsh-skin-market`（两半插件范例） |
| 7 | patch「替换目标行的整个 config 值」 | 更准确：patch 是**按顶层 key 赋值** `target[key]=value`，因此只有 `config` 是整体替换，未写出的顶层 key 保留 | 覆盖别人行时仍需重述整个 `config`，结论同原设计 |
| 8 | 审批超时由框架处理 | 审批服务**没有任何超时** | 不自己加超时 → 该 turn 永久堵死 |
| 9 | AstrBot 侧靠 `send_by_session()` 发消息 | 路线 A 用 `event.plain_result()`（必须 `yield`，会走 ResultDecorateStage）或 `await event.send(MessageChain)`（绕过该阶段）；主动推送用 `await context.send_message(umo, chain)` | 三者的取舍见 §3 第 5 层 |
| 10 | 长度切分可复用平台工具 | AstrBot **没有通用切分工具**；aiocqhttp **完全没有**切分逻辑；只有 telegram/微信/wecom 各自的私有实现 | 第 5 层必须自己实现 |
| 11 | 会话映射用 `platform + group_id + user_id` 三元组 | UMO 已含 MessageType | 见契约 §2.1，三元组会造成语义错误 |
| 12 | 持久化数据放 AstrBot `data` 目录 | 正确，但具体 API 是**插件 KV（DB 后端 `data_v4.db` 的 `preferences` 表）**，不是 `shared_preferences.json` | 代码里别照抄坊间指南 |

---

## 2. 系统全景

```
┌────────────── IM 平台（QQ via NapCat / Telegram ...）──────────────┐
│                                                                    │
│  ┌──────────────── AstrBot 进程（跨机对端） ────────────────────┐  │
│  │                                                              │  │
│  │  ①触发层   @filter.event_message_type(ALL) / command          │  │
│  │            ├─ 前缀判定、白名单、priority                      │  │
│  │            └─ should_call_llm(True) 阻止默认 LLM              │  │
│  │                          ↓                                    │  │
│  │  ②会话映射层  本地缓存 UMO → conversationKey                  │  │
│  │            （权威映射在 DSH 侧；本地只放最近 UMO 以便主动推送）│  │
│  │                          ↓                                    │  │
│  │  ③传输层  aiohttp：POST /message（幂等键）                    │  │
│  │           aiohttp：GET  /events（SSE，Last-Event-ID 续传）    │  │
│  │           aiohttp：POST /approval                             │  │
│  │                          ↕ HTTPS + Bearer token               │  │
│  │  ⑤输出格式化层  节流窗口合并 → 长度切分 → Markdown 降级        │  │
│  │           → event.plain_result() / await event.send()         │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
                               ↕
┌──────────────── DSH 进程（服务端）──────────────────────────────────┐
│  ③传输层   ctx.webServer.register({kind:'prefix', path:'/astrbot-relay'})│
│            自建 Bearer 鉴权 + 幂等表 + 环形缓冲                    │
│                          ↓                                          │
│  ④Agent 执行层  ctx.agents.create() → agent.followup()              │
│            host.on('session/event') → assistant/chunk → SSE text/delta│
│                                     → assistant/message, turn/end    │
│            host.on('approval/request')       → waterfall + 超时     │
│            映射持久化 state.json（原子写）                          │
└────────────────────────────────────────────────────────────────────┘
```

**注意层的归属变化**：原始设计把「会话映射层」和「传输层」都放在桥接核心，
但修正后**会话映射的权威在 DSH 侧**（只有它知道 `dshSessionId` 与生命周期），
AstrBot 侧只做键的转发与「最近 UMO」缓存（用于主动推送）。这是一个实质分工变化。

---

## 3. 逐层设计

### 第 1 层：触发层（AstrBot 侧）

**职责**：判断哪些 IM 消息交给 DSH。

**已核实的实现要点**：

- 用 `@filter.event_message_type(filter.EventMessageType.ALL)` 而非
  `@filter.command`：前者**群聊无需 @** 即可收到消息（过滤器通过就会
  `is_wake=True`），后者强制要求 `is_at_or_wake_command`。
- 前缀匹配在 handler 内自己做（`event.message_str`），不匹配就 `return`
  什么也不设——完全不干扰 AstrBot 默认 LLM 流水线。
- 命中后必须 `event.should_call_llm(True)`——**传 `True` 才是「禁止默认 LLM」**，
  参数语义与直觉相反。
- `event.stop_event()` 必须放在 `yield` **之后**；先 stop 再 yield 会让
  `RespondStage` 不执行，**消息发不出去**。
- `priority` 越大越先执行。多个过滤器是 AND 逻辑。

**三种策略**（原始设计的三选项，务实取舍）：

| 策略 | 实现 | v1 建议 |
|---|---|---|
| 指令前缀 | 前缀匹配 | ✅ **默认启用**，行为可预期、易调试 |
| 会话白名单 | `_conf_schema.json` 里配 `group_id`/`user_id` 列表 | ✅ 作为前缀策略之上的**附加过滤**（AND），而非替代 |
| AI 路由 | 用 AstrBot 的 LLM 判意图 | ❌ 一期不做：引入不确定性与额外 token 成本，且失败模式难解释 |

**失败模式**：前缀误命中（用户正常聊天恰好以此开头）→ 通过白名单 + 前缀尽量取
不常见字符串（默认建议 `/dsh `）。注意 AstrBot 本机 `wake_prefix=["/"]`，
前缀不要与之冲突。

### 第 2 层：会话映射层

**归属**：权威状态在 **DSH 侧**；AstrBot 侧无状态（除一个「最近 UMO」KV 项）。

**键**：UMO 原文（契约 §2.1）。

**策略**：`one-to-one` / `on-demand` / `daily` 三选一，配置项 `policy`。

**持久化**：DSH 侧 `statePath` 指向的 JSON，原子写（tmp + rename）。
**不使用** `ctx.storage`——本轮未核实该 API，不写进契约。

**失败模式**：
- state 文件损坏 → 启动时解析失败必须**响亮报错并拒绝启用**（不静默重建，
  否则会把所有 IM 会话重新挂到新 DSH 会话上，丢历史）。
- DSH 会话被用户在 Web UI 里归档/删除 → 插件调用 `agent.followup` 时的行为
  **未核实**，P1 必须实测并定义「自动重建 vs 报错」的取舍。

### 第 3 层：传输层

**选型：自建 host 插件路由 + SSE 下行**（理由见契约 §1 的决策记录表）。

**DSH 侧**：
- `ctx.webServer.register({ kind: 'prefix', path: '/astrbot-relay', handler })`
  ——**path 不要写尾斜杠**；返回 disposer；重复 `(kind, path)` 会抛错，
  必须 `try/catch` 并降级为 no-op，不能把 host 搞崩。
- **无内建 SSE helper**。照抄 `dsh-client-hmr/lib/index.js:114-158` 的写法：
  `res.writeHead(200, {...})` → `res.write(...)` → `res.on('close', ...)` 清理。
- 鉴权自建（Bearer + 定长比较），因为框架不提供。
- 幂等表 + 每会话有界队列 + 环形事件缓冲（契约 §3、§6）。

**AstrBot 侧**：
- `aiohttp`（**禁用 `requests`**，这是 AstrBot 的硬规范）。
- **顺序**：先建 SSE 连接 → 再 POST `/message`。反过来会丢掉开头几个 token
  （`text/delta` 是瞬时事件，无订阅者时永久丢失）。
- 禁止使用浏览器原生 `EventSource`（设不了 `Authorization` 头）。

**失败模式**：
- SSE 断线：按 `Last-Event-ID` 续传；缓冲区溢出收到 `gap` 帧 → 提示用户
  「部分流式内容丢失」而不是静默拼错。
- DSH 重启：IM 侧 `health` 轮询发现，期间消息进本地待发队列（有界），
  恢复后按幂等键重投。

### 第 4 层：Agent 执行层（DSH 侧）

**会话驱动**（已核实的一等入口，**不需要 spawn dsh 子进程**）：

```js
const handle = await ctx.agents.create({
  sessionId: brandString(`im-${randomUUID()}`),
  meta: { cwd: config.cwd },                    // 必须绝对路径
  agentOptions: { provider, model },
})
handle.agent.followup(createUserMessage({ content: [{ type:'text', text }], source: { kind:'user' } }))
await handle.agent.whenIdle()
await ctx.sessions.flush(handle.agent.session)
```

最小范例：`dsh-headless/lib/index.js:127-167`；含 resume 的范例：
`dsh-acp/lib/index.js:692-730`。

**事件监听**（两个层级，用途不同）：

| 用途 | 事件 | 特性 |
|---|---|---|
| 流式显示 | `host.on('session/event', (session, event) => ...)` 里的 `assistant/chunk` | 瞬时、逐 token；须按 `session !== agent.session` 过滤，chunk 在 `event.data.chunk` |
| 最终文本 / turn 边界 | `host.on('session/event', (session, event) => ...)` | 持久、一步一条，`assistant/message` / `turn/end` |

**必须自己过滤**：事件虽是 `Scoped<Agent>` 派发，但未打 tag 的根 ctx 监听者会
收到**所有** agent 的事件（`dsh-scope` 里 `if (tag === void 0) return true`）。
不按 `agent.id` 过滤就会串台到用户在 Web UI 里的会话。`dsh-acp` 就是这么做的。

**审批拦截**：

```js
host.on('approval/request', (request, next) => {
  const b = bridges.get(request.agent.id)
  if (!b) return next()
  return b.askApproval(request)   // Promise<'allowed-once'|'rejected'|'cancelled'>
})
```

范例：`dsh-acp/lib/index.js:1115-1138`。**自加超时**，超时 resolve `'rejected'`
（fail closed）。`req.signal` 的 abort → `'cancelled'` + 清定时器 + 清 pending 表。

**生命周期清理**：
- `ctx.on(...)` **本身**就注册为 effect（返回 disposer），**不需要**再包一层
  `ctx.effect`。
- 非 Cordis 管理的资源（定时器、socket）用 `ctx.effect(() => cleanup)`。
- 卸载收尾：`agent.cancel({kind:'user'})` → `await whenIdle()` →
  `sessions.flush()` → `dispose()`。顺序的正确性见契约 §9 未决 #1。

### 第 5 层：输出格式化层（AstrBot 侧）

三个子问题，全部有已核实的地基：

**(a) 长度切分 —— 必须自己写。**
- aiocqhttp **完全没有**切分逻辑【已证实】。
- 一个额外的坑：走 `yield event.plain_result()` 时，纯文本超过
  `forward_threshold`（本机配置 = 1500）会被 `ResultDecorateStage` 自动包成
  合并转发 `Node`；而 `await event.send(...)` **不会**。
- 因此策略是：**中间分片用 `await event.send()` 直接发出**（避开合并转发与
  转图），**最后一片用 `yield plain_result()`** 走正常结果链路。
  AstrBot 侧骨架已按此结构写好。
- 切分点优先取**句末标点/换行**（切点不落在未闭合的代码围栏内部），
  `flush_chars` 之上找不到边界时最多容忍到 `flush_hard_chars` 才硬切。

**(b) 流式节流。**
- IM 平台没有「编辑消息」的通用抽象（aiocqhttp 侧是按句分段发送），
  所以原始设计的「按时间窗口合并后更新消息」在 QQ 上退化为「按窗口分片发送」。
- 实现：`text/delta` 累积到一个 buffer，按 `throttleMs`（默认 2500）或
  达到 `flushChars`（默认 200）时 flush 一次；切点按 `_pick_cut` 回退到最近的
  句末标点（含换行），不会落在未闭合的代码围栏内，最多回退 16 个候选边界。
- 上限：`flushHardChars`（默认 0 = 自动取 `max(3 × flushChars, 600)`，
  再与 `chunkSize` 取小）是硬切上限——过了它必须有边界也好、没边界也好都得发，
  保证流式不被卡死；与 `chunkSize` 取小是自保，中间分片走 `event.send`
  不经过 AstrBot 的切分阶段，单条上限只能插件自己守。
- 安全阀：若 turn 结束时 buffer 非空，**强制 flush**，否则尾字丢失。

**(c) Markdown 降级。**
- QQ/aiocqhttp 侧**没有任何 Markdown 处理**，原样纯文本发出【已证实】。
- 两条路：`text`（纯文本，做最小降级：代码围栏→缩进、粗体标记去掉）或
  `card`（复用 AstrBot 的 t2i 把 Markdown 渲成图片卡）。
- 本机既有 connector 已经实现了 `text/auto/card` 三模式与分卡逻辑
  （`core/reply_render.py`），**可以直接搬**，不必重写。

---

## 4. 配置面

### AstrBot 侧（`_conf_schema.json`）

`bridge_url`、`bridge_token`(`secret`)、`trigger_prefix`、`allow_from`（白名单）、
`reply_in_private_only`、`timeout`、`throttle_ms`、`flush_chars`、`flush_hard_chars`、`chunk_size`、
`reply_render_mode`、`approval_enabled`、`health_interval_ms`、`retry_max_attempts`、
`ca_bundle_path`、`allow_insecure_http`。

### DSH 侧（Schemastery `Config`）

`port`/`pathPrefix`、`token`(required)、`statePath`、`cwd`(required, 绝对路径)、
`policy`、`idleTtlMs`、`maxQueuedPerConversation`、`idempotencyEntries`、
`idempotencyTtlMs`、`eventBufferSize`、`heartbeatMs`、`approvalTimeoutMs`、
`forwardReasoning`、`allowedTools`（审批白名单，可空=全部需要审批）。

**设计原则（DSH 官方约定）**：凡不同部署可能取不同值的参数都不许硬编码；
非法配置要在**插件加载时**失败，而不是运行期静默降级。

---

## 5. 分阶段实施计划

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| **P0** | 契约 + 设计 + 两侧骨架 | ✅ 本文档 + `BRIDGE-CONTRACT.md` + 两个插件目录 |
| **P1 打通** | DSH 侧：路由 + 鉴权 + `/health` + `/message` + `agents.create/followup/whenIdle` + SSE 推 `message/final`；AstrBot 侧：前缀触发 + 单次请求 + 整段回帖 | ✅ 已达成（P1 时点口径）：当时六端点全部有真实 handler、`BridgeTransport` 六方法全部实现；契约 §9 三件实测已结案。**v0.5.0 起为八端点 / 八方法，见下表 P7** |
| **P2 流式与审批** | `session/event` 的 `assistant/chunk` → `text/delta` 节流回帖；`approval/request` → 一次性 code → IM 回执 | ✅ 已达成：SSE 下行 + agent 事件转发 + 审批 waterfall（4 位一次性 code，超时 fail closed） |
| **P3 韧性** | 幂等表、环形缓冲 + `Last-Event-ID` 续传、429 背压、health 轮询、DSH 重启恢复 | 🚧 部分落地：幂等有界 LRU + TTL、环形缓冲与 `Last-Event-ID` 续传、429 背压、AstrBot 侧 health/重试退避已就位；DSH 重启恢复待验证 |
| **P4 呈现** | 长度切分、Markdown 降级/图片卡、图片与 attachment 回传（可搬 connector 的 `reply_render.py`） | QQ 上长回复可读、代码块可读 |
| **P5 控制面接管** | 见 §7.2 / §7.3：用管道式转发接管控制面，搬 10 条「可直接搬」项，补权限门与集成测试 | 能力总览表逐项覆盖；测试真正发 HTTP |
| **P6 退役** | 见 §7.2：前缀完全覆盖，移除 connector | 卸载 connector 不丢功能 |
| **P7 工作区** | 见契约 §13：`GET /workspaces`（清单，`workspaceRegistry.list()`）+ `POST /session/rebind`（改指），IM 侧 `/dsh workspaces`、`/dsh rebind <id>` | ✅ 已达成（v0.5.0）：八端点全部有真实 handler，`BridgeTransport` 八方法全部实现，`BRIDGE_VERSION` 升 `2` |

**P1 三件实测（均已结案）**：
1. `ctx.agents.create` 的模型选择装法已定并落地。
2. ~~`agent/assistant-stream` 在真实运行进程里能否收到~~ **已结案，当初的证伪是错的**：
   宿主 ≤ 0.1.2-rc.1 只有 `session/event` 的 `assistant/chunk`；**0.1.5-rc.2 起**
   （`dsh-agent-loop/lib/index.js:1031-1033` 的 `dispatch.emit('agent/assistant-stream', { frame })`）
   改走 `assistant-stream` 帧流。两侧都要收：旧事件保底、新事件取真源，见契约 §4.2。
3. 插件热装免重启生效。

**三项配置已全部接线**：`hmacMode`（契约 §5.2 请求体 HMAC 签名）、`policy` 的
`on-demand` / `daily` 轮转、`idleTtlMs` 空闲回收。`assertConfigIsUsable` 相应地从
「加载即抛错」降级为**参数校验**——`policy` 必须落在枚举内、`idleTtlMs` 必须是有限正数，
仍不静默降级。轮转与回收**只归档不删历史**。

---

## 6. 部署形态（跨机/容器）

你的选择是跨机/容器，**与本机现状不同**，因此下面是目标形态而非复述现状：

```
[IM 平台] ──(QQ 反向 WS)──> [AstrBot 容器]  ──(HTTPS + Bearer)──> [DSH 容器]
   NapCat                     :6185 WebUI          :3080 WebUI + /astrbot-relay/*
```

要点：

1. **只放通一个方向**：AstrBot 出站 → DSH 入站。DSH 不需要能访问 AstrBot。
   这正是契约 §0 把连接定为单向的原因。
2. **`bridge_url` 要写 DSH 的对外可达地址**，不是 `127.0.0.1:3080`。
3. **`/astrbot-relay` 路由必须与 Web UI 同端口**（`ctx.webServer.register` 挂在
   同一个 HTTP server 上）。若不想暴露 Web UI，用反向代理只放行 `/astrbot-relay/*`。
4. **反向代理必须关缓冲**：`proxy_buffering off;`（nginx）/ Traefik 的
   `buffering` 中间件，否则 SSE 会被攒成一坨，流式失效。`heartbeatMs` 兼作
   空闲超时探针。
5. **token 用容器 secret / 环境变量注入**，不进镜像、不进日志。DSH 侧
   Schemastery schema 可读环境变量（`!!js` 或配置层），AstrBot 侧靠插件配置页。
6. 若被迫在明文网络上跑，`allowInsecureHttp: true` 必须显式设置并会在启动时
   warning——不允许「静默降级」。

> **现状对照**：本机 AstrBot（`0.0.0.0:6185`，3 个 aiocqhttp 反向 WS：6199 /
> 10234 / 10235，NapCat 在 `Downloads\NapCat.Shell`）与 dsh（`127.0.0.1:3080`）
> 其实同机，且 AstrBot **当前未运行**。同机调试时把 `bridge_url` 指向
> `http://127.0.0.1:3080/astrbot-relay` 并临时开 `allowInsecureHttp` 即可。

---

## 7. 与既有 `astrbot_plugin_dsh_connector` 的关系 —— **决定：最终替代它**

> **用户决策（已定）**：新插件 `astrbot_plugin_dsh_relay` **最终替代**
> `astrbot_plugin_dsh_connector` v2.0.1，不是并存、不是 fork。

这条决策把目标从「桥接最小集」升级为「**功能对齐后接管**」，因此本设计的分阶段
计划延长到 P5/P6，并且多出一个硬约束：

> **替代的验收标准 = connector 的能力面被逐项覆盖或显式放弃。**
> 能力清点见 `docs/connector-surface.md`（验收基线）。

### 7.1 为什么不能"重写一份"了事

既有 connector 的实际体量：`main.py` 72KB + `core/` 6 个模块（约 40KB）+
`tests/test_dsh_connector.py` 21KB。它的能力面包含：多会话管理、8 步交互向导、
模型/Preset/推理强度/权限/时区切换、DSH Settings 读写、Skills/Subagents/Goals/
Workspaces 查询、图片与 attachment 回传、`text/auto/card` 三模式渲染与分卡、
LLM 工具集。

**这些能力里，真正的"资产"不是它的传输层（已失效），而是：**

| 资产 | 处置 |
|---|---|
| `core/reply_render.py`（Markdown 分卡、代码围栏保留、t2i 回退） | **直接搬**，P4 |
| `tests/test_dsh_connector.py`（回归基线） | **改造成新插件的测试**，逐条对照 |
| `core/dsh_client.py` 的方法清单与信封格式 | **作为控制面协议词典**；若能走廉价管道（见 §7.3）则可近乎原样复用 |
| `core/session_options.py` / `session_state.py`（每会话选项存储模型） | **搬设计，改存储键前缀**，避免与 connector 抢同一批 KV 键 |
| 传输层（`/api` 轮询 + `assistant/chunk` 流式） | **丢弃**，由新桥的 SSE 通道取代 |
| 8 步向导的交互流程 | **搬交互设计，改数据来源**（从 RPC 面改为桥的自有路由） |

### 7.2 迁移的阶段安排

| 阶段 | 内容 | 出口标准 |
|---|---|---|
| P1~P4 | 见 §5（数据面：打通 → 流式审批 → 韧性 → 呈现） | 桥接可用；connector 保持禁用，互不干扰 |
| **P5 控制面接管** | 按 `docs/connector-surface.md` 的分类逐项搬：控制面走**管道式转发**（§7.3，含强制方法白名单），呈现层等 10 条「可直接搬」项直接移植，并**补上 connector 缺失的权限门与集成测试** | 能力总览表逐项打勾；改造后的测试**真正发 HTTP** 而非假绿 |
| **P6 退役** | 新插件前缀完全覆盖 `/dsh ...`；从 profile 移除 connector；迁移 DB 里已有的会话绑定 KV（或明确宣告不迁移并给出用户操作指引） | 用户不再需要 connector；卸载它不丢功能 |

**P5 的硬前置（结论已定，见 §7.3）**：控制面走**管道式转发**——DSH 侧加一条自有鉴权
路由，进程内派发给既有 host RPC；AstrBot 侧改信封与方法名。全程不经过 `/api` 的
Host 栅栏与浏览器 cookie 鉴权，因此跨机部署下 P5 成立。

### 7.3 控制面的实现路径 —— **已定：管道式转发**

调研结论见 `docs/control-plane-transport.md`（含实机探针证据）：**可行**。
第三方 host 插件在进程内按名调用既有 host RPC 是**公开 API**，
DSH 侧约 100 行即可完成转发，**无需逐方法重做那 28 个能力**。

两条入口（均已核实存在）：

1. `ctx.connection.createSharedFetchHandler('/api')` → `.fetch(new Request(...))`
   ——与浏览器 `/api` **完全同构**：栅栏（`requestRejection`）只出现在 HTTP route
   handler 里，`createSharedFetchHandler` **不调用它**，因此进程内调用天然不过
   Host 栅栏与 cookie 鉴权。
2. `ctx.typertGateway.invoke({ namespace, method, args, signal })` / `.stream(...)`
   ——不经信封，直接抛业务错误；**流式端点只能用 `.stream`**
   （实机：`/api/workspace/follow` 走 invoke 会 `gateway/signature-invalid`）。

**但"只换 base_url"被实机推翻。** connector 的 33 个点号 endpoint
**33/33 全部 HTTP 404**：网关要求端点**恰好两段** `<namespace>/<method>`
（`claimsEndpoint` 强制 `split("/").length === 2`），载荷**恰好** `{args:{...}}`。
好消息是**业务字段与 connector 现在发送的字段逐字段一致**（实机已取到真实数据），
所以 AstrBot 侧的改动是机械的：改 `rpc()` 的拼装 + `goal_action` 的动态方法名
+ 一张 33 行映射表。

**三个要留意的点**：

- `host.describe`、`workspace.list`、`goals/blocked` 是**真实不存在**（不是写错），
  对应 C2 / C4 / C31 三项无替代端点，需要重新设计（建议：`host.describe` 的等价
  信息从 `session/list` 的 cwd 与 `/health` 取；`workspace.list` 走
  `workspaceRegistry.list()` 或 `workspace/follow` 首帧 baseline）。
- `session.history → session/page` 的结构对应已比对通过
  （`events→records`，条目仍是 `{type:'event',event:{type,seq,time,data}}`），
  但**必填 `throughSeq` 的语义未实测**，而 connector 的整个回复等待循环压在它上面
  → **P1 必须先实测**；`throughSeq` 可由 `session/list` 的 `projections.asOfSeq` 提供。
- `ctx.webServer.register({kind:'exact', path:'/api/...'})` 能**抢占**框架的 `/api`
  exact 路由（webserver 先查 exact 表再走 prefix）。能力上可用，但这是绕过框架
  安全边界的做法，**我们的转发路由不采用它**，而是挂在自己的 `pathPrefix` 下。

#### 7.3.1 一个必须正视的权限放大问题

管道式转发意味着**把整个 `/api` 面暴露给了 IM**：IM 侧能调的，就等于 Web UI 能调的
（`settings/mutate` 改 DSH 配置、`workspace/archiveSession` 归档会话……）。
再叠加 connector **原本就没有任何权限门**（§7.5 第 4 条）以及**群聊里任何人都可能
触发**（前缀命中即执行），这构成一条真实的提权路径。

因此 §7.3 的落地**必须**同时包含，缺一不可：

1. **方法白名单**：转发路由只放行显式列出的 `<namespace>/<method>`；
   写类方法（`settings/mutate`、`workspace/archiveSession` 等）默认**关闭**。
2. **AstrBot 侧权限门**：写类命令要求 `PermissionType.ADMIN`。
3. **审计**：每次转发记录 `<namespace>/<method>` + 发起者 UMO，可 grep。

### 7.4 迁移期共存规则（P1~P4 期间）

- **前缀不能撞**：connector 用 `/dsh setup`、`/dsh config`、`/dsh session new` 等；
  新插件默认前缀是 `/dsh `。两者同时启用会产生歧义，因此 P1~P4 期间
  **保持 connector 禁用**（它现在本来就是禁用状态），或把新插件前缀临时改成
  `/ds `。
- **KV 键不能撞**：connector 用的键形如
  `dsh_session:default:FriendMessage:1000000001`。新插件必须用自己的命名空间前缀
  （建议 `dsh_relay:`），否则会读到对方的绑定数据。
- **P6 的 KV 迁移**：DB 里已有历史绑定（`data_v4.db` 的 `preferences` 表，
  scope=`plugin`，scope_id=`konodiodaaaaa1/astrbot_plugin_dsh_connector`）。
  新插件的 scope_id 不同（author/name 变了），**键天然隔离**，
  所以是「显式迁移或让用户重新绑定」，不是自动继承。

---

### 7.5 connector 的实际状态（清点结论，决定 P5 的真实范围）

清点结果见 `docs/connector-surface.md`（79KB：45 行能力总览 + 29 条迁移归档，
`main.py` 1493 行全文通读，非抽样）。结论比预想严重：**它不是"个别功能失效"，
而是与已装 DSH 的 HTTP 协议整体不兼容。**

#### 四条最影响计划的发现

1. **协议整体不兼容（不只是流式）**：通用 `rpc()` 用「点号方法名 + 扁平载荷」，
   而当前网关要求端点**恰好两段** `<namespace>/<method>`、载荷**恰好**
   `{args:{...}}`。全插件的控制面都走这条错路；21 个子命令里只有
   `commands/execute` 的线上格式是对的。
   → **`core/dsh_client.py` 不能"原样复用"**，只能当方法名与语义的词典用。
2. **`/api` 有硬认证栅栏**：先过 Host 栅栏（非回环且不在 `trustedHosts` → 403），
   再要求本进程签名、绑定 authority 的 Cookie（否则 401）。插件全仓
   `cookie|token|Authorization` **零命中** → **同机也会 401**，跨机必然失效。
   → 契约 §1 把 `/api` 判为不可用，从"设计判断"升级为"实测结论"。
3. **13 类 RPC 名已漂移**：`session.history→session/page`、
   `session.models→session/modelCatalog`、`llm.providers→llm/listProviders`、
   `llm.models→llm/discoverModels`、`agentPreset.*→agentPresets.*`（复数）、
   `skill.list→skills/list`、`subagent.*→subagents.*`、`goal.*→goals.*`；
   而 `host.describe`、`workspace.list` 在 84 条描述符里**完全不存在**
   （C2 连接状态 / C4 八步向导 / C31 工作区列表**无替代端点**）。
   → 迁移需要一张"旧名 → 新名"映射表；缺失项要重新设计或列入放弃清单。
4. **整个插件只有 1 个命令注册点，且没有任何权限门**：
   `@filter.command("dsh", alias={"ds"})` 是唯一注册点，其余 20+ 子命令是
   手写字符串前缀分发；`permission_type` 全仓零命中。
   → **能唤醒会话的人就能删会话、写 DSH 设置。**
   替代版本必须补上权限模型——这是"替代"顺带修掉的安全缺陷，不是可选项。

#### 两条与迁移成本相关的补充

- **LLM 写权限开关名不副实**：`enable_llm_mutation_tools` 名义上管"修改 DSH 设置"，
  实际只摘掉 1 个工具（`set_dsh_setting`），另外 6 个 mutation 工具不受约束。
  替代时要么修正语义，要么改名。
- **测试基线有洞**：32 个测试（12+11+2+7）**没有一个真正发 HTTP**
  （`CaptureClient` 覆写了 `rpc`）→ 上面第 1/2/3 条协议不兼容**不会**被现有测试捕获。
  迁移的回归基线必须补集成测试，否则"改造后测试全绿"是**假绿**。

#### 迁移数量分布（29 条）

| 分类 | 条数 | 说明 |
|---|---|---|
| 必须重做 | 12（R1-R12） | 根因是**协议整体漂移**，不是个别方法：RPC 信封/端点、`/api` 认证、13 类方法名重映射、`host.describe` 替代方案、流式事件源、轮询收敛协议、多 step 收敛判定、附件解析、权限预设 schema 反解、Goal 读取、下发/等空闲、命令树宿主形态 |
| 可直接搬 | 10（P1-P10） | 卡片判定+分卡算法（围栏自闭合）、t2i 与回退、图片四分支管线+限额+临时文件、回复/模型行解析、settings 辅助、KV 存储模型、选项归一化、8 步向导状态机、4 个零散纯函数 |
| 可放弃 | 7（D1-D7） | headless 传输整套（3 个配置键）、Windows 子进程探测、旧单字段 KV 通道（死代码）、旧选项回退读、`_require_http` 守卫、`merge_replies` 版历史、两个死字段 |

#### 对 §7.2 工作量的修正（§7.3 调研已完成，结论确定）

- **管道式可行 → P5 = 接管道 + 补权限模型 + 搬 10 条「可直接搬」项。**
- 12 条「必须重做」的**性质变了**：从"逐方法在进程内重写"降级为
  「改信封 + 改方法名（33 行映射表）+ 处理 3 个真实不存在的方法」。
  仍然要做，但不再是最大成本项。
- C2 / C4 / C31 三项（`host.describe` / `workspace.list` / `goals/blocked`）
  在当前 DSH 上**无对应端点**，必须重新设计或列入放弃清单。
- **权限门与集成测试是新增必做项**（原 connector 两者皆无）。且因管道式转发会把
  整个 `/api` 面暴露给 IM，权限门从"应该做"升级为"**不做就是提权漏洞**"（§7.3.1）。

## 8. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 瞬时事件 `text/delta` 丢头（订阅时序） | 高 | 契约强制「先 SSE 后 POST」；P2 实测 |
| 多 agent 事件串台 | 高 | 强制按 `agent.id` 过滤；P1 实测（开两个会话并发） |
| 审批堵死 turn | 高 | 自加超时 + fail closed；P2 实测「不回复」路径 |
| 跨机 `/api` 鉴权不可用 | 已规避 | 已改为自建路由 |
| `assistant/chunk` 幻觉复现 | 已规避 | 契约里显式列出正确事件名 |
| SSE 经代理被缓冲 | 中 | 部署清单 §6.4 |
| 插件卸载残留（句柄/定时器/文件） | 中 | 全部走 `ctx.effect`；P1 实测 reload |
| `ctx.agents.create` 拿不到模型 | 中 | P1 三选一实测（§5） |
| 长度切分踩合并转发阈值（1500） | 低 | 中间分片走 `event.send()`，最后一片走 `yield` |
| 幂等表内存无界 | 低 | 有界 LRU + TTL |
| **控制面转发 = 提权路径**（管道式把整个 `/api` 面交给 IM，且群聊里任何人都可能触发） | **高** | 强制方法白名单 + AstrBot 侧 ADMIN 权限门 + 审计日志（§7.3.1）；不做就是漏洞 |
