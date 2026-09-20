# AstrDsh Relay（星驿）接口契约 v1（草案 / 冻结候选）

> 状态：**设计冻结候选**。所有标记 `【已证实】` 的条项来自两侧源码实读（证据见
> `docs/astrbot-side-capabilities.md`、`docs/dsh-side-capabilities.md`）；
> 标记 `【未核实】` 的条项**不得**在实现阶段当作既成事实使用。
>
> 本文档是 AstrBot 侧与 DSH 侧的**唯一接口真相来源**。两侧骨架代码中的任何字段
> 与此冲突，以本文档为准。

---

## 0. 角色与命名

| 角色 | 实体 | 说明 |
|---|---|---|
| **IM 侧（Agent）** | AstrBot Star 插件 `astrbot_plugin_dsh_relay` | 客户端。发起所有连接。 |
| **DSH 侧（Server）** | DSH host 插件 `dsh-astrbot-relay` | 服务端。拥有会话与审批。 |
| **conversation** | 一个 IM 会话线程（群/私聊/话题） | 由 AstrBot `unified_msg_origin` 唯一标识。 |

**连接方向是单向的：IM 侧 → DSH 侧。** DSH 侧永不主动拨号回 AstrBot。
这条约束是为了让跨机/容器部署只需要放通一个方向的入站端口，NAT 后也能工作。
所有「DSH 主动推送」（流式文本、工具事件、审批请求、任务完成通知）都复用
IM 侧已建立的那条 SSE 下行通道，不需要第二条连接。

---

## 1. 决策记录：为什么不用现成的 `/api/<method>` RPC 面

DSH Web 已经暴露了一条 RPC 面，本机既有的 `astrbot_plugin_dsh_connector` v2.0.1
就在用它。我们没有采用，理由如下（均为实读证据，非偏好）：

| # | 事实 | 后果 |
|---|---|---|
| 1 | `/api` 请求先过 **Host/Origin 栅栏**：Host 必须是 loopback 或配置里显式列出的 `trustedHosts` authority【已证实】 | 跨机部署需要维护 `trustedHosts`，且容器内 Host 头常与配置不一致 |
| 2 | `/api` 的浏览器鉴权是 **进程启动 token → 签名 cookie**（`BrowserAuth`：root URL query token 换 authority-bound cookie）【已证实】 | 非浏览器客户端没有一等公民的 Bearer/API-Key 路径，只能模仿浏览器握手，脆弱 |
| 3 | 现有 connector 的流式实现依赖 `assistant/chunk`【已证实：`core/dsh_client.py:459`】 | 该事件名在当前 DSH 版本**已被删除**（v0 遗留），流式路径实际已失效 |
| 4 | 该面只能**轮询** `session.history` 取结果【已证实：`dsh_client.py:441-495`】 | 延迟 = `poll_interval`；不是推模型 |
| 5 | **审批无法通过该面拦截**【已证实：审批是进程内 waterfall】 | 设计第 4 层（审批转发）在这一路线上**不可能实现** |

**结论**：写一个自有路由的 DSH host 插件。它的 4 个理由里第 5 条是硬约束，
其余 4 条是收益。既有 connector 的价值降级为：**RPC 方法名与语义的参考词典**
（`session.create` / `session.prompt` / `session.history` / `workspace.archiveSession`
等），以及**同机 MVP 的兜底通道**。

---

## 2. 会话标识与映射

### 2.1 键的选择

**使用 AstrBot 的 `unified_msg_origin`（UMO）作为 conversation key 原文。**

- 格式【已证实】：`{platform_id}:{MessageType}:{session_id}`，
  例如 `default:FriendMessage:1000000001`、`default:GroupMessage:123456`。
- **不采用**原始设计里的 `platform:group:user` 三元组。理由：UMO 已经内建了
  私聊/群聊区分，而三元组在私聊场景下 `group_id` 为空、会把同一用户的不同私聊
  折叠到一起；群聊场景下把 `user_id` 放进 key 会让同一群内每个用户各拿一个
  DSH 会话，与「一个 IM 对话 ↔ 一个 DSH Session」的语义相反。

### 2.2 映射状态（DSH 侧持有，权威）

```jsonc
{
  "conversation": "default:GroupMessage:123456",  // UMO 原文
  "dshSessionId": "im-3f9a1c7e-...",              // 由 DSH 侧生成
  "createdAt": 1700000000000,
  "lastActiveAt": 1700000000000,
  "policy": "one-to-one",                          // one-to-one | on-demand | daily
  "seq": 42                                        // 该会话已发出的最大事件序号
}
```

- **持久化位置**：DSH 侧插件的 `statePath` 配置项指向的 JSON 文件（默认
  `<DSH_HOME>/astrbot-relay/state.json`）。**不使用** `ctx.storage`——该 API 本轮
  未核实，不写进契约。
- 写入必须原子（临时文件 + rename），避免崩溃留下半截 JSON。

### 2.3 轮转策略

契约只规定**行为**，不规定默认值（默认值属实现配置）：

| policy | 行为 |
|---|---|
| `one-to-one` | 一个 conversation 固定一个 DSH 会话，长期保持。 |
| `on-demand` | 首次触发创建；`idleTtlMs` 内无活动则回收（归档，不删除历史）。 |
| `daily` | 按 DSH 服务器本地日期轮转，跨日新建。 |

回收/轮转时的 DSH 会话走 `workspace.archiveSession`【已证实存在于 RPC 面，
插件内对应能力【未核实】】，保留历史日志。

---

## 3. 传输协议

基址由 IM 侧配置项 `bridge_url` 给出（如 `https://dsh.example.com/astrbot-relay`）。
下述路径均相对该基址。

**通用要求**：所有端点都要求鉴权（见 §5）。请求与响应体一律 `application/json;
charset=utf-8`。未知字段必须忽略（前向兼容）；未知的 `type` 值也必须忽略。

### 3.1 `POST /message` — 投递一条 IM 用户消息

请求：

```jsonc
{
  "conversation": "default:GroupMessage:123456",
  "text": "帮我看下这个报错",
  "messageId": "1000000001-8821",     // IM 侧消息 id，仅用于日志与去重辅助
  "sender": { "id": "1000000001", "name": "user" },
  "meta": { "platform": "aiocqhttp", "messageType": "GroupMessage" }
}
```

必填请求头：

| 头 | 说明 |
|---|---|
| `Authorization` | `Bearer <token>` |
| `Idempotency-Key` | **必填**，UUIDv4。同 key 重复请求不得造成第二次投递。 |

响应 `202 Accepted`：

```jsonc
{ "accepted": true, "conversation": "...", "queueDepth": 1, "duplicate": false }
```

- `duplicate: true` 表示命中幂等表，本次未投递。
- 若该 conversation 队列已满 → `429`（见 §6.3）。
- 若 DSH 侧尚无该 conversation 的映射，**由服务端按 `policy` 创建**，
  IM 侧不负责建会话。

### 3.2 `GET /events?conversation=<umo>` — SSE 下行通道

- `Content-Type: text/event-stream`；每条消息以空行结尾【已证实这是 SSE 的硬要求】。
- 连接建立后服务端立即发一帧 `: connected` 注释行作为热身。
- **断线重连**：SSE 标准 `Last-Event-ID` 请求头。客户端重连时必须携带最后收到的
  `seq`；服务端从环形缓冲重放 `> seq` 的事件。缓冲区大小由
  `eventBufferSize` 配置（默认 512），溢出时最旧的丢弃并发送一帧
  `{"type":"gap","fromSeq":N}` 告知客户端存在空洞。
- 每帧：

```jsonc
{ "seq": 43, "ts": 1700000000123, "type": "text/delta", "text": "好的，" }
```

- 服务端周期性发送 `{"type":"heartbeat"}`（间隔 `heartbeatMs`，默认 15000），
  用于穿透中间代理的空闲超时并让 IM 侧判断链路是否存活。
- IM 侧**禁止**使用浏览器原生 `EventSource`（无法设置 `Authorization` 头）。
  用 `aiohttp` 手动读流。

### 3.3 `POST /approval` — 回执一个待审批请求

请求：

```jsonc
{
  "conversation": "default:GroupMessage:123456",
  "callId": "call_9f2a",
  "outcome": "allowed-once",     // allowed-once | rejected
  "code": "K7Q2"                 // 见 §7，必须与 approval/required 下发的 code 一致
}
```

响应 `200`：`{ "ok": true }`；`409` 表示该 `callId` 已决议或已超时（幂等冲突，
不视为错误，IM 侧只提示用户）。

### 3.4 `GET /health` — 存活与版本协商

```jsonc
{
  "ok": true,
  "bridgeVersion": "2",
  "dshVersion": "0.1.5-rc.2",
  "uptimeMs": 123456,
  "conversations": 3
}
```

IM 侧启动时与周期性（`healthIntervalMs`）调用。`bridgeVersion` 不匹配时
**拒绝启用桥接并明确报错**，不做猜测性降级。

---

## 4. 事件类型清单（下行，`/events`）

| `type` | 载荷 | DSH 侧来源【已证实】 |
|---|---|---|
| `turn/start` | `turn` | `session/event` → `turn/start` |
| `text/delta` | `text` | `session/event` → `event.data.chunk.type === 'text-delta'` |
| `reasoning/delta` | `text` | 同上 → `'reasoning-delta'`（受 `forwardReasoning` 配置控制，默认关） |
| `tool/call` | `callId`, `name`, `argsPreview` | `session/event` → `'tool-call-delta'` 聚合后 |
| `approval/required` | `callId`, `code`, `toolName`, `reason`, `expiresAt` | `approval/request` waterfall |
| `approval/resolved` | `callId`, `outcome` | 同上，决议后回填 |
| `message/final` | `text` | `session/event` → `assistant/message`（**权威最终文本**） |
| `turn/end` | `reason: { kind, error? }` | `session/event` → `turn/end` |
| `heartbeat` | — | 插件自建定时器 |
| `gap` | `fromSeq` | 环形缓冲溢出时 |

### 4.1 三条实现约束（来自核实结论，写错就废）

1. **`text/delta` 是瞬时事件，不属于会话历史。** 它由 `session/event` 的
   `assistant/chunk` 发出，进程内可见；一旦没有订阅者就永久丢失。因此 `/events` **必须在投递消息
   之前建立**，否则开头几个 token 会丢。IM 侧的顺序固定为：先连 SSE → 再 POST
   `/message`。
2. **事件是 `Scoped<Agent>` 派发，但未打 tag 的根 ctx 监听者会收到所有 agent 的
   事件**【已证实：`dsh-scope` 的 `if (tag === void 0) return true`】。DSH 侧插件
   **必须**自己在回调里按 `agent.id` / `session.id` 过滤到本插件创建的会话，
   否则会串台到用户自己在 Web UI 里的会话。
3. **`reasoning/delta` 与 `tool-call-delta` 不含在 `assistant/message` 里**，
   最终文本一律以 `message/final` 为准；`text/delta` 只用于「边跑边显示」，
   不得作为最终回复拼接（多 step 任务会重复叠加）。

### 4.2 事件来源随宿主版本分叉（双侧都要收）

| 宿主版本 | `text/delta`、`reasoning/delta`、`tool/call` 的真源 |
|---|---|
| ≤ `0.1.2-rc.1` | `session/event` 的 `assistant/chunk`（`chunk` 挂在事件上） |
| ≥ `0.1.5-rc.2` | `agent/assistant-stream` 的 `frame.type === 'chunk'`（`frame.chunk`，同形） |

- 两侧是**同一个 chunk 形状**，DSH 侧插件必须收敛到一个出口（本仓库为
  `forwardAssistantChunk`），不得为两条链路各写一份 switch。
- **`turn` / `step` 只在 `start` 帧上**（`frame.type === 'start'` 带
  `{ attemptId, turn, step }`；`chunk`/`end` 帧不带，见
  `dsh-agent/lib/types/runtime-types.d.ts` 的 `AssistantStreamFrame`）。
  因此收到 `start` 帧时必须按 `attemptId` 记下归属，`chunk` 帧再用它；
  否则新宿主下 `step` 恒为 `undefined`。
- 该事件的派发 scope 是 `Scoped<Agent>`：根 ctx 上未打 tag 的监听者会收到
  **所有** agent 的帧，必须按 `agent.id` 过滤（同 §4.1 第 2 条）。

---

## 5. 鉴权与安全

目标部署是**跨机/容器**，因此本节的每一项都是必需项，不是加固项。

### 5.1 传输

- 默认要求 **HTTPS**。明文 HTTP 仅在配置显式设置 `allowInsecureHttp: true`
  时允许，且启动时打印 warning。
- 契约不规定证书校验的绕过方式；如需自签证书，由 IM 侧配置
  `caBundlePath` 指定 CA，**不允许**全局关闭校验。

### 5.2 凭据

- 共享密钥（`token`）：至少 32 字节随机值，两侧配置文件各自持有，**不进日志**。
  IM 侧对应 `_conf_schema.json` 中 `"secret": true`（只做界面遮罩，不是加密）。
- 校验方式：`Authorization: Bearer <token>`，DSH 侧**定长比较**（timing-safe），
  失败一律 `401`，且**不区分**「token 错」与「token 缺失」的响应体。
- 可选强化 `authMode: "hmac"`：额外要求
  `X-Bridge-Signature: sha256=<hmac_sha256(token, ts + "." + rawBody)>` 与
  `X-Bridge-Timestamp`，服务端拒绝偏离本地时钟超过 `signatureSkewMs`
  （默认 60000）的请求。**v1 默认只用 Bearer**，HMAC 留作配置开关。

### 5.3 威胁模型（明确写下来的部分）

| 威胁 | 对策 |
|---|---|
| 网络嗅探 | HTTPS；token 不入日志 |
| 重放 `/message` | `Idempotency-Key` + 幂等表 |
| 重放 `/approval` | `code` 一次性 + `callId` 决议后失效 + 短 TTL |
| 伪造审批（第三方冒充群成员） | 审批 `code` 只发给**发起该 turn 的 conversation**，且要求回执来自**同一 conversation**；`outcome` 只接受白名单值 |
| 恶意 DSH 输出注入 IM 指令 | IM 侧发送前**不做**任何指令解析；输出一律当纯文本 |
| 拒绝服务（刷消息） | 每 conversation 有界队列 + `429`（§6.3） |
| 越权触碰用户自己的 DSH 会话 | 插件只操作自己创建的 `agent` 句柄，按 `agent.id` 过滤；不提供任何「按 sessionId 任意操作」的端点 |

**明确的非目标**：本文档不提供多租户隔离。一个 token 对应一套 IM→DSH 的信任域，
不同 IM 群共享同一个 token。需要隔离时部署两套。

---

## 6. 幂等、重试与背压

### 6.1 幂等

- `/message` 的 `Idempotency-Key` 是**强制**的。服务端维护有界 LRU
  （`idempotencyEntries`，默认 512 条，TTL `idempotencyTtlMs`，默认 10 分钟）：
  命中则原样返回首次的 `202` 响应体并置 `duplicate: true`。
- 幂等表**只覆盖 `/message`**。`/approval` 的重复提交由「已决议」语义吸收
  （`409`）。

### 6.2 重试

- IM 侧对 `/message` 的重试**必须复用同一个 `Idempotency-Key`**；换 key 重试
  等于第二条消息，是 bug。
- 可重试：连接错误、超时、`502/503/504`、`429`。
- 不可重试：`400/401/403/404/409`（含 `/approval` 的 `409`）。
- 退避：指数退避 + 抖动，上限 `retryMaxDelayMs`（默认 30000），总次数
  `retryMaxAttempts`（默认 5）。
- **SSE 重连不算失败**：按 §3.2 带 `Last-Event-ID` 续传，退避从 1s 起。

### 6.3 背压

- DSH 侧每 conversation 一个**有界**队列（`maxQueuedPerConversation`，默认 4）。
- 队满时 `/message` 返回 `429` + `Retry-After`，响应体
  `{"error":{"code":"queue_full","message":"..."}}`。
- IM 侧收到 `429` 时**必须**立即回一句「排队中，请稍候」并**不重试**
  （重试只会加剧拥塞）；由用户后续消息触发新的尝试。
- 另有一条硬闸：`agent.followup` 在 turn 运行中投递是排队的，但 IM 侧仍需保证
  同一 conversation 同时只有一个在途 `/message`（客户端侧串行化），避免依赖
  服务端队列语义。

---

## 7. 审批契约（设计第 4 层的落地形态）

### 7.1 流程

```
DSH 内 agent 触发敏感工具
  → 插件收到 'approval/request' waterfall（签名 (req, next) => Promise<Outcome>）【已证实】
  → 插件生成 4 位一次性 code，记入 pending 表（含 callId / expiresAt / 期望 conversation）
  → 通过该 conversation 的 SSE 发 approval/required
  → IM 侧向用户展示：「需要审批：<toolName> <reason>，回复 /dsh approve <code> 或 /dsh reject <code>」
  → 用户回复 → IM 侧 POST /approval
  → 插件校验 code + conversation + 未过期 + 未决议 → resolve waterfall
  → SSE 发 approval/resolved
```

### 7.2 硬性约束

1. **必须自加超时**。审批服务自身**没有任何超时**【已证实】；唯一的取消来源是
   `req.signal`。没有 IM 回执就会**永久堵住该 turn**。超时后 resolve
   `'rejected'`（fail closed，不是 `'cancelled'`——`'cancelled'` 语义是用户/上游
   取消，会被误当成正常中止）。超时值 `approvalTimeoutMs`，默认 120000。
2. **`req.signal` 的 abort 必须转成 `'cancelled'`**，并清理 pending 表与定时器，
   否则泄漏。
3. **审计约束**：`approval/asked` 与 `approval/decided` 会话事件必须包在
   **已开启的 turn** 内，否则 DSH 直接抛错【已证实】。这意味着审批**不能**在
   turn 之外（例如插件自发的后台动作）发起。
4. **`outcome` 白名单**：`allowed-once` / `rejected`。DSH 侧完整枚举是
   `allowed-once | rejected | cancelled | unavailable`，但网桥**只暴露前两个**给
   IM，其余两个是系统语义，不应由 IM 用户触发。
5. **只接受同 conversation + 明确命令**。不接受纯粹的「是/否」自然语言
   （易被同群他人误触发）。这是原始设计里一次性验证码思路的保留。

### 7.3 提问（`user-questions/request`）

同为 waterfall，返回 `AskUserQuestionAnswer`【已证实签名】。v1 **不实现**，
原因：交互式多选题在 IM 里的降级形态需要单独设计（编号回复、多轮澄清），
且不是用户原始五层设计的必需项。列入 §9 未决。

---

## 8. 错误模型

统一响应体：

```jsonc
{ "error": { "code": "queue_full", "message": "会话队列已满", "details": {...} } }
```

| code | HTTP | 含义 | IM 侧行为 |
|---|---|---|---|
| `unauthorized` | 401 | token 缺失/错误 | 不重试，明确报错到日志，桥接置为不可用 |
| `not_found` | 404 | conversation 无映射（且 policy 不允许自动建） | 提示用户先触发一次会话建立 |
| `queue_full` | 429 | 队列满 | 回「排队中」，不重试 |
| `agent_busy` | 409 | 同 conversation 已有在途 turn；或改指时目录不可用、挂载失败（§13.2） | 提示「正在处理上一条」；环境故障则提示稍后再试 |
| `unsupported` | 400 | 未知 `type` / 不支持的字段组合 | 记日志，回执给用户 |
| `not_implemented` | 501 | 请求**合法**，但网桥这一端还没实现（骨架端点） | 不回重试，直接告诉用户「该功能尚未实现」，并在桥接问题清单里留痕 |
| `internal` | 500 | DSH 内部错误 | 可重试一次，然后向用户报错 |

> `unsupported` 与 `not_implemented` **不是同一件事，禁止混用**：
> 前者是「你发的东西我不认」（调用方的问题），后者是「你发的东西没问题，
> 只是我还没做」（实现方的问题）。骨架阶段把未实现端点回成 400，
> 会让 IM 侧误以为是自己参数写错，于是反复重试一个必然失败的请求。
> 未实现的端点必须**如实失败**，不许返回假成功。

**错误必须响亮**（沿用 DSH 的设计原则）：配置非法时 DSH 侧插件**加载即失败**
（Schemastery `required()`），而不是运行期静默降级。

---

## 9. 未决问题（实现前必须收敛）

| # | 问题 | 影响 | 收敛方式 |
|---|---|---|---|
| 1 | DSH 侧插件卸载时的收尾顺序：`agent.cancel({kind:'user'})` → `await agent.whenIdle()` → `ctx.sessions.flush()` → `dispose()` 是否在所有中断路径下都安全？ | 卸载残留可能丢消息 | 在真实 DSH 上实测（P1） |
| 2 | `ctx.agents.create` 需要 `agentOptions: {provider, model}`，而模型选择是否需要插件自己安装（`installModelSelection` / `agentPresets.mount` / 自建 `agent/request` hook 三条路）**未实测对比** | 不装则可能拿不到默认模型 | P1 实测三选一 |
| 3 | 新装插件是否免重启生效（HMR）**未验证** | 影响部署流程 | P1 实测 |
| 4 | SSE 经反向代理（nginx/traefik）时的缓冲与超时行为 | 跨机部署的常见坑 | 部署时验证 `proxy_buffering off` + `heartbeatMs` |
| 5 | 消息长度上限按目标平台取值：aiocqhttp 无任何切分【已证实】，且走 `yield` 时纯文本 > 1500 会被自动包成合并转发 `Node` | 影响第 5 层切分策略 | 按目标平台写死默认值 + 配置覆盖 |
| 6 | 是否实现 `user-questions/request` 转发 | 功能完整性 | 二期决定 |
| 7 | 是否把 `astrbot_plugin_dsh_connector` 的能力（多会话管理、模型/preset 切换、Settings、图片卡）合并进新插件，还是新插件只做桥接最小集 | 工作量差异巨大 | 需要你决策（见 DESIGN.md §7） |

---

## 10. 版本协商

- 契约版本号 `bridgeVersion = "2"`，随每次破坏性变更递增。
- `/health` 返回 `bridgeVersion`；IM 侧启动时校验，不等则拒绝启用。
- 契约内新增**可选**字段不递增版本（归入前向兼容规则）；新增事件 `type`
  不递增（客户端忽略未知 `type`）；修改既有字段语义**必须**递增。
- **v1 → v2 是刻意的例外。** §13 新增的两条路由对 v1 客户端而言确实是增量
  （它不会去调，也就不会看见），按上面那条本可不动版本号。这里仍然递增，
  理由是版本号的**职责**：它标记的是「这份常量表是哪一版」，而不是
  「老客户端会不会坏」。两侧常量表是逐字对应的副本（`lib/contract.js` /
  `contract.py`），让版本号忠实地记录常量表版本，比让读日志的人去猜
  「为什么都是 v1、能力却不一样」更省事。
- 这个选择的代价要写明白：**v1 与 v2 不能混合部署**。桥接端升到 v2 后，
  仍是 v1 的 IM 侧会在启动校验时**拒绝启用**（§3.4），因此升级必须两侧同时
  发布，**不存在灰度窗口**；回滚同理。

---

## 11. 控制面转发（v1.1 草案）

> **数据面**（§3）与**控制面**（本节）是两条独立通道：数据面服务于
> 「一条 IM 消息 → 一次 agent 执行」；控制面服务于 connector 原有的管理能力
> （会话 / 模型 / Preset / 权限 / Settings / Skills / Subagents / Goals /
> Workspaces）。本节是 P5 的契约。
>
> 背景与可行性证据：`docs/control-plane-transport.md`；
> 落地要求与权限模型：`docs/DESIGN.md` §7.3 / §7.3.1。

### 11.1 端点

`POST /rpc`

```jsonc
{ "endpoint": "session/list", "args": { "_request": {} } }
```

必填请求头同 §5（`Authorization: Bearer <token>`）。响应**直接返回 DSH 网关的
`result` 对象**，与浏览器 `/api` 逐字段同构：

```jsonc
{ "ok": true, "value": { "items": [ /* ... */ ] } }
```

- 业务失败：`{"ok": false, "error": {...}}`，HTTP 仍为 **200**（与 DSH 网关行为一致，
  IM 侧必须判 `ok` 而不是只看状态码）。
- 鉴权失败：按 §8 统一错误体返回 `401`。
- `endpoint` 不在白名单：按 §8 返回 `403` + `code: "forbidden"`（**新增错误码**）。

### 11.2 为什么是"转发"而不是"逐方法重建"

DSH 侧在进程内通过 `ctx.connection.createSharedFetchHandler('/api')` 把请求派发给
既有 host RPC，好处是：

- 不必为 28 个能力各写一条类型化路由；
- DSH 升级导致的签名漂移只需改 AstrBot 侧的映射表；
- IM 侧与 Web UI 看到的是**同一份真相**，不会出现两套语义。

端点的线上形状是 **`<namespace>/<method>`（恰好两段）**，载荷是 **`{args:{...}}`**
（`claimsEndpoint` 强制 `split("/").length === 2`）。**点号写法（`session.list`）
在当前 DSH 上 33/33 全部 404**，不得使用。

### 11.3 三条硬约束

1. **方法白名单是强制的，不是加固。** 转发等于把整个 `/api` 面交给 IM；
   没有白名单就是提权路径。写类方法（`settings/mutate`、`workspace/archiveSession`
   等）默认**关闭**，按需显式开启。
2. **流式控制面端点必须走 `ctx.typertGateway.stream(...)`**，不能走
   `createSharedFetchHandler` 的 `fetch`（实机：`/api/workspace/follow` 经 invoke
   会 `gateway/signature-invalid`）。**v1 不暴露任何流式控制面端点。**
3. **`host.describe` / `workspace.list` / `goals/blocked` 不存在**（实机 404，
   是真实缺失而非拼写错误），**不得写入白名单**。等价信息按 `DESIGN.md` §7.3 的
   替代方案获取。

### 11.4 尚未实测（P1 阻塞项）

- **`session/page` 的必填 `throughSeq` 语义未实测**，而 connector 的整个回复等待
  循环压在 `session/history` 上 → **P1 必须先实测一次**。候选来源：
  `session/list` 的 `projections.asOfSeq`。
- 进程内直调、`fetch.register` 的 SSE、exact 路由抢占目前**只有静态证据**
  （需装插件并重启 harness 才能实跑）。
---

## 12. 定位与来源标注（v1.1 草案）

> 回答两个问题：**这个 IM 对话落在哪个工作区**、**它对应哪个 DSH 会话**；
> 并提供反向抓手——**DSH 会话标题里带来源**，便于在 DSH Web UI 的会话列表里
> 认出「哪条来自哪个群」。
>
> 本节的读路径**不依赖任何未核实的 DSH API**，因此已经是可用的实现；
> 只有「标题的应用」与「对话级覆盖的写入」留给 P1 / P5。

### 12.1 `GET /where?conversation=<umo>`

请求头同 §5。响应 `200`：

```jsonc
{
  "conversation": "default:GroupMessage:1000000001",
  "found": true,                                       // 是否已有映射记录
  "sessionId": "im-3f9a1c7e-...",                      // 无则 null
  "title": "星驿 · default/GroupMessage/1000000001",    // 反向定位用：DSH 会话标题
  "cwd": "D:\\AI\\workspace",
  "source": "conversation",                            // conversation | global | none
  "policy": "one-to-one",
  "createdAt": 1700000000000,
  "lastActiveAt": 1700000000000,
  "seq": 42,
  "statePath": "C:\\Users\\<user>\\.dsh\\astrbot-relay\\state.json"
}
```

两条硬要求：

1. **`found: false` 时仍要作答。** 会话还没建立映射时，`cwd` 与 `source` 依然要给出——
   它回答的是「**将会**落在哪」，而这正是排查时最想知道的事。
2. **`source` 必须如实反映来源。** 用户要能区分「这个目录是给本对话单独配的，
   还是全局默认」；混作一谈会让「为什么这个群跑在别的目录」变得无法解释。

`conversation` 缺失 → `400` + `unsupported`。

### 12.2 `GET /conversations?limit=N`

列出已知映射。`limit` 默认 50、上限 200；超出即**钳制**（不报错），
返回体里带 `limit` 说明实际生效值：

```jsonc
{ "count": 2, "returned": 2, "limit": 50, "items": [ /* 同 §12.1 的结构 */ ] }
```

### 12.3 工作目录的解析顺序

**对话级覆盖 → 全局配置 → 无。**

| 命中 | `source` |
|---|---|
| 记录里有 `cwd` | `conversation` |
| 否则用插件全局 `cwd` | `global` |
| 两处都没有 | `none`（由调用方决定是否报错；本版只如实呈现） |

对话级覆盖存放在 `state.json` 的记录里（`cwd`）。
**写入路径留给 P5 控制面**——在权限模型（§7.3.1）就位之前不开写面。
因此 §12 在当前版本是**只读**的：要按对话区分目录，可以直接人工编辑 `state.json`。

> `source` 必须与**最终生效的 `cwd`** 同源：先定 `cwd`，再据此定 `source`。
> 否则会出现「说来源是对话级、给出的却是全局目录」这种自相矛盾的诊断。
> （历史字段 `workspaceId` 已删除，见 §12.5.1。）

### 12.4 反向定位：DSH 会话标题

会话标题由配置项 `sessionTitleTemplate` 渲染，占位符：

`{platform}` `{messageType}` `{sessionId}` `{conversation}`

默认值 `星驿 · {platform}/{messageType}/{sessionId}`，例如
`星驿 · default/GroupMessage/1000000001`。用户在 DSH Web UI 的会话列表里
按这个标题就能认出对应哪个群。

- **未知占位符原样保留**（不替换成空串），让配置写错看得见，而不是静默产出空标题。
- 标题为空等于定位失效，因此配置校验把「空模板 / 渲染结果为空」当**加载期错误**。
- 标题的**应用**（在 `agents.create` 时写入，或事后重命名）属于 P1：
  进程内等价 API 尚未核实，见 §11.4。

### 12.5 `state.json`

```jsonc
{
  "version": 1,
  "conversations": {
    "default:GroupMessage:1000000001": {
      "dshSessionId": "im-...", "cwd": null,
      "policy": "one-to-one", "createdAt": 0, "lastActiveAt": 0, "seq": 0
    }
  }
}
```

#### 12.5.1 两套命名空间（**读之前先看这一条**）

同一件东西——「这个 IM 会话绑定的那个 DSH 会话」——在**两个地方用了两个名字**，
这是有意的，不是改了一半的过渡态：

| 位置 | 字段名 | 理由 |
|---|---|---|
| `state.json` 持久化记录 | `dshSessionId` | 它**就是** DSH 侧的会话 id，名字必须自证其身份，避免被误当成 IM 侧的 `sessionId` |
| `GET /where` 响应 | `sessionId` | 面向 IM 的 UX 字段，AstrBot 侧 `location_text.py` 已在读它，**改动会让两侧发布节奏互相绑架** |
| `POST /events` 等协议体 | `sessionId` | 线上协议字段，见 §2.2 |

- 桥接端在 `resolveLocation()` 做**显式转译**：读 `record.dshSessionId`，答 `sessionId`。
  这个转译点是全仓唯一允许出现「两个名字同框」的地方。
- 读入侧兼容旧名：`dshSessionIdOf()` 接受 `dshSessionId ?? sessionId`，
  因此**旧 state.json 可以原样加载**；但写出**一律只用 `dshSessionId`**，
  旧名不会被写回，属于单向兼容。
- 已被删除的字段：`workspaceId`。它从未被任何写路径赋值，永远是 `null`，
  属于「协议里长得像有、实际恒空」的坑，读它的人会以为存在工作区概念。
  AstrBot 侧对应的恒空分支已一并删除。

- 默认路径 `<DSH_HOME>/astrbot-relay/state.json`；`statePath` 可覆盖，**必须是绝对路径**。
- **原子写**：写同目录临时文件再 `rename`（直接覆写在崩溃时会留下半截 JSON，
  而那正好会触发下面这条「拒绝加载」）。
- **解析失败必须响亮失败**：坏 JSON / `version` 不符 / 结构不对 → 插件**加载即失败**，
  **绝不静默重建**。静默重建会把所有 IM 会话重新挂到新 DSH 会话上，丢掉历史。
- `version` 不符一律拒绝，不做迁移猜测。
- 记录按会话键**排序**写出，使人编辑与 `git diff` 稳定。

### 12.6 鉴权口径的更正：`/health` 也要求鉴权

§3 的「所有端点都要求鉴权」在本版**包括 `/health`**。
骨架早期把 `/health` 做成了裸端点，现予更正——它现在返回 `cwd`、`statePath`、
`sessionTitleTemplate` 这类本机部署信息，裸奔等于把这些细节送给任何能连到端口的人。
`/health` 的定位诊断字段：`pathPrefix`、`cwd`、`statePath`、`stateExisted`、
`policy`、`sessionTitleTemplate`、`conversations`（映射条数）。

---

## 13. 工作区改指（v2 新增）

`/dsh workspaces` 与 `/dsh rebind <id>` 对应的两条路由。设计口径与 §12 一致：**能力交给
DSH 既有语义**（`sessionController.create({ workspaceId })` 建会话 + `workspace.attachSession()`
挂载），桥接端只做「查清单」与「换映射」，不自己重造一套工作区概念。

### 13.1 `GET /workspaces?limit=N`

列出宿主 `workspaceRegistry` 里已登记的工作区，供 IM 侧挑「改指」的目标。

```jsonc
{
  "count": 3, "returned": 3, "limit": 50,
  "items": [
    { "id": "ws-...", "path": "D:\\AI\\workspace", "title": "默认", "sessionIds": ["..."] }
  ]
}
```

硬要求：

1. **`count` 是总数，`returned` 是本页条数。** 没截断时两者相等，正是这点让写错的一方长期
   不显形。IM 侧要提示总数（如「共 N 个」）必须用 `count`；用 `returned` 会在工作区超过
   `limit` 时说少话，而用户按这个数「找第 N 个」时会得到「桥接端没有这个工作区」。
2. **不静默返回空清单。** 注册表缺席或 `list()` 抛错一律 `500` + `internal`。
   「没有登记任何工作区」与「问不到工作区」对 IM 侧是完全不同的两件事：前者用户该去 DSH 里
   建一个，后者用户该去查桥接端状态。合并成一句空清单，会让人按错误的方向排查半天。
3. `limit` 默认 50、上限 200，超出即**钳制**（不报错），返回体带实际生效的 `limit`；读法与
   §12.2 逐字一致——两个列表端点若在截断口径上分叉，就成了只能靠人记住的差异。
4. **只暴露公开读取面**：`id` / `path` / `title` / `sessionIds`。实体内部私有记录属官方实现
   细节，抄进来等于给自己埋一个「升级即断」的点。

IM 侧只依赖 `count` / `returned` / `items[].{id,title,path}`；`items[].sessionIds` 是宿主的
内部账，IM 侧**不解释、不校验、不依赖**。新增字段照 §10 前向兼容。

> 安全面提醒：本端点向任何持 token 者暴露宿主**绝对路径**、标题与全部 `sessionIds`
> （含并非本插件创建的会话），暴露面比 §12.1 的 `/where` 更大。§5.3 的威胁模型须按这一条
> 重新审视；token 的持有面就是本端点的信任边界。

### 13.2 `POST /session/rebind`

把某个 IM 对话**改指**到另一个工作区：为它新建一个落在目标目录的 DSH 会话，再把映射换过去。

请求（本版无 `Idempotency-Key`，见 §13.3 第 3 条）：

```jsonc
{ "conversation": "default:GroupMessage:1000000001", "workspaceId": "ws-..." }
```

响应 `200`：

```jsonc
{
  "ok": true,
  "conversation": "default:GroupMessage:1000000001",
  "workspaceId": "ws-...",
  "sessionId": "im-3f9a1c7e-...",
  "cwd": "D:\\AI\\workspace",
  "previousSessionId": "im-9b2d..."
}
```

**为什么必须换会话 id、不能就地改 cwd**：会话头里的 `cwd` 在创建时定死，官方唯一允许的
路径是「建会话 → `attachSession`」，而 `attachSession` 要求
`readSessionHeader(sessionId).cwd === record.path`——没有任何一条路能改已存在的会话。
建会话与挂载的顺序照抄官方 `sessionController.create`
（`dsh-api-session-controller/lib/index.js:548-600`）：`workspaceId` 与 `cwd` 互斥 → 查注册表
→ 先 `create` → 成功后再 `attachSession`。

**旧会话不删也不摘。** 它的 `cwd` 仍是原目录，从原工作区里摘掉它才是说谎（官方
`attachSession` 的四条校验正是按 cwd 认账的）。`previousSessionId` 回显出来，就是为了让用户
还找得回去。改指后 `state.json` 记录里只有新的 `dshSessionId` 与 `cwd`；`workspaceId`
**不落盘**（§12.5.1），因此 `/where` 的 `source` 仍是 `conversation`。

错误判定顺序（**先存在性、后忙**，实现须按此序）：

| 序 | 条件 | 状态 | code |
|---|---|---|---|
| 1 | `conversation` / `workspaceId` 缺失或不是非空字符串 | 400 | `unsupported` |
| 2 | 注册表不可用（宿主未提供 `get()`） | 500 | `internal` |
| 3 | `workspaceId` 不在清单里 | 404 | `not_found` |
| 4 | 目标目录不可用（登记项 `status() !== "ok"`） | 409 | `agent_busy` |
| 5 | 本对话有在途投递或任务在跑 | 409 | `agent_busy` |
| 6 | 建会话失败（`agents.create` 抛错，新会话尚未落盘） | 500 | `internal` |
| 7 | 会话已建、挂到工作区失败（`attachSession` 抛错） | 409 | `agent_busy` |
| 8 | 其余 | 500 | `internal` |

> **第 4、7 行收口到 `409`，不回 `400`**（本版实现即如此）。口径与 §8 一致：目录不可用
> 与挂载失败都是**服务端侧的环境故障**，回 `400` 会被 IM 侧判成不可重试（`_unpack` 只看
> 状态码就置 `retryable=False`），可恢复的故障于是永远不会被重试。
>
> **没有新增 `503`** 是权衡结果：`ERROR_STATUS` 表里 `409` 只挂着 `agent_busy` 一个码，
> 新增 `503` 要同改两侧常量、本契约与 parity 白名单，而 IM 侧对 `409` 的动作（提示用户
> 稍后再试）本来就正确——为一次环境故障扩一条状态码，收益不抵成本。
>
> 两行的 `details` 也一并给定：第 4 行带 `{conversation, workspaceId, status}`（`status` 是
> 登记项自报的目录状态）；第 7 行带 `{conversation, workspaceId, sessionId, cwd,
> orphaned: true, released}`——`sessionId` 是**新会话**的 id，`orphaned` 恒为 `true`，
> `released` 记录 `handle.dispose()` 是否成功。**孤儿会话必须回报**：`create` 成功即已落盘，
> 悄悄吞掉 `sessionId` 会让用户以为那个会话不存在，而它在宿主账本里确实存在。

- **`404` 与两个 `409` 的先后是有意的**：`id` 敲错、同时又有任务在跑时，只会得到 `404`。
  先答「你敲的 id 不存在」比先答「正忙、待会儿再试」有用得多。
- 路由按 **path 精确匹配**，两条新端点都不校验 HTTP 方法：`GET /session/rebind` 会走字段
  校验回 `400`，而不是 `405`。契约**未定义**方法不匹配的行为，实现方不要依赖它。

### 13.3 幂等、保活与状态一致性

1. **SSE 保活**：改指期间既有的 `/events` 流**不中断**，心跳照常；IM 侧不因一次改指而重连。
   改指要花掉一次建会话的时间，心跳是「另一端还活着」的唯一证据。
2. **与在途 turn 的并发**：竞争时以 `409 agent_busy` 优雅降级——不抢占、不打断正在生成的
   回答。`bridge.attaching || queue > 0` 的检查与置位之间没有 `await`，因而原子；
   所有早退分支都在置位之前，`finally` 里统一释放 `attaching`。
3. **本版没有幂等键**：`/session/rebind` 没有 `Idempotency-Key` 保护（§5.3 的威胁模型目前
   只覆盖 `/message` 与 `/approval`）。后果是：超时或响应丢失时服务端可能**已经成功**，
   客户端却报「改指失败」，重试会再建一个会话、留下孤儿。在补上幂等键之前，客户端的重试
   要求是：**先 `GET /where` 对账，再决定是否重试**。
4. **`persistRecords()` 失败只 warn，不改变响应**。后果比 `/message` 侧同类问题更重：内存
   已换新会话、磁盘仍是旧的，重启后映射回退，而旧 agent 已经拆了——「改指成功」在重启后
   不成立。本版如实记为**已知缺口**：将来要么在响应里带 `persisted:false`，要么让持久化
   失败直接回 `500`。
5. **改指到「当前已经是」的工作区**：本版**没有 no-op 检测**（不比较当前工作区），会静默
   轮换 `sessionId` 并丢上下文，而用户以为无事发生。将来应在服务端做 no-op（回原
   `sessionId`）或回 `409`。

### 13.4 IM 侧指令

| 指令 | 行为 |
|---|---|
| `/dsh workspaces` | 调 §13.1，打印清单与「共 N 个」（用 `count`） |
| `/dsh rebind <工作区 id>` | 调 §13.2，把本对话改指过去 |

两条都属「只读/一次性」，正文不是对话内容，因此与 §12 的 `where` 同规格：接管本事件、
禁止默认 LLM（`should_call_llm(True)` + `stop_event()`，且 `yield` 必须在 `stop_event`
之前）。本地那行（会话键）**永远先打印**，清单查询失败也不影响它——想换工作区时最需要的
信息本来就在本地。

**服务端给出的 `message` 已是完整句子**（含「改指失败：」前缀），IM 侧**不得**再拼一次
前缀，否则用户会看到「改指失败：改指失败：…（internal）」。同理，`200` 响应体里的 `ok`
也要看：§11.1 已确立「`200` + `{ok:false,error}`」这一表达法，只看 HTTP 状态码会把将来
用该表达法报出的失败当成成功。
