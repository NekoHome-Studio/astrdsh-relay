# PLAN —— 心跳检测与自主唤醒（A + B）

> 状态：**方案稿，未写任何代码**。所有行号对 `astrdsh-relay@v0.8.6`（远端 main）实测取得。
> 本文只描述**打算怎么做**；待 §8 的 7 项定下来、§9 的 4 项实测通过后再接线，不预先承诺形态。

---

## 0 先厘清：现有的心跳是什么，缺的是什么

**已有（不要重造）：**

| 能力 | 位置 | 说明 |
|---|---|---|
| SSE 连接保活心跳 | `dsh-astrbot-relay/lib/index.js:1440-1448` | 每条 SSE 连接一个 `setInterval`，写 `event: heartbeat`，`unref()`；失败即 `closeSse('heartbeat-failed')` |
| 会话级广播心跳 | `dsh-astrbot-relay/lib/index.js:781-790` | 每 `heartbeatMs` 往该对话推一条 `{type:'heartbeat'}`，**ephemeral**（不占 seq、不入缓冲） |
| 间隔配置 | `lib/index.js:88`（`heartbeatMs`，默认 15000，下限 1000）、`lib/index.js:787`、`:1447` | 两侧夹 `Math.max(1000, …)` |
| IM 侧**跳过**心跳帧 | `astrbot_plugin_dsh_relay/main.py:1086-1087` | `if kind == EVENT_HEARTBEAT: continue` —— 只当保活噪音丢掉，**不做任何判定** |
| IM 侧健康探测状态机 | `main.py:773-806`（启动）与 `:808-839`（`_health_loop`） | `_bridge_ok` / `_bridge_error` 两态，按 `health_interval_ms`（默认 30000，0=关）周期调 `/health`；**失败与恢复都只写日志** |

**所以 A 的需求不是「加心跳」，而是三件缺的东西：**

1. **判定后没有任何播报** —— 状态机在跑，但用户永远不知道桥接掉了（`main.py:828-838` 只有 `logger.warning/info`）。
2. **没有「机器人选择说不说」这一层** —— 目前只有「写日志」一个出口，没有「沉默 / 固定文案 / 交给 LLM 决定」的策略。
3. **心跳帧没有参与判定** —— 一次 turn 进行中若桥接端卡死，`/health` 探测仍可能通（HTTP 线程活着），而 SSE 已经不再来帧；只有把**帧间隔**纳入判定才抓得到。

**B 完全不存在**：DSH 侧没有任何「主动发起一轮」的定时器，IM 侧也没有「不经事件而主动发消息」的路径被用于此。

---

## 1 需求拆解：「由机器人选择是否回复」在 A 与 B 里不是同一件事

| | A 连通性检测 | B 自主唤醒 |
|---|---|---|
| 触发者 | DSH 不可达 / 恢复 | DSH 侧定时器到期 |
| 谁「回复」 | 机器人**要不要把这件事告诉群** | 机器人**要不要说话** |
| 默认倾向 | 沉默（避免刷屏） | 沉默（`[SILENT]` 哨兵） |
| 决策者 | 插件按策略：固定文案 / 交给 LLM 组织 / 沉默 | agent 自己在那一轮里决定 |
| 失败代价 | 无事发生（最多用户不知道掉线） | **白烧一次 LLM 调用** |

**这张表决定了实现位置**：A 的决策在 IM 侧（因为它才知道用户是谁、群在哪）；B 的决策在 **DSH 侧**（因为只有它能拦在 `message/final` 出门之前，让哨兵不出现在群里）。

---

## 2 关键前置决策：B 需要「常连 SSE」，而这是本方案最大的架构改动

**问题**：现在 SSE 流是**按需**的（契约 §4.1：先连 SSE → 再投 `/message`，一轮结束就关）。而 B 的心跳发生在**没有任何 turn 在跑**的时候——此时 IM 侧没有流，DSH 侧的 `message/final` **没有出口**，主动回复会直接丢掉。

**三种出路：**

| 方案 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **① 常连 SSE（推荐）** | IM 侧为「已绑定且启用主动」的对话维持长连接，断线指数退避重连 | 每对话一条 HTTP 长连接；服务端 `sseConnections` 常驻 | 不违反契约 §0 的**单向连接**原则；顺带让 A 的帧判定在空闲期也有效 |
| ② 反向 webhook | DSH 主动 POST AstrBot 的插件 web API | 需要 AstrBot 入站可达 → **推翻 §0**，跨机/容器下要额外开洞 | 否 |
| ③ IM 侧轮询待发队列 | 新增 `GET /pending?conversation=` | 延迟 = 轮询周期；且要新增队列与游标语义 | 备选，作为 ① 不可用时的降级 |

**① 的粒度还要再定一次**（见 §8 Q1）：

- **每对话一条**：契约现成（`/events?conversation=<umo>`），改动最小；但一个 QQ 号在 50 个群里就是 50 条长连接。
- **每账号一条复用**：新增 `GET /events?all=1`（或 `?platform=`），帧里带 `conversation` 字段供分发。连接数从 O(对话) 降到 O(账号)，但契约要加一条端点与一种帧形状。

> 我倾向 **每账号一条复用**（真实部署里群数量远大于账号数），但它需要契约新增端点 → 影响 §10 版本判断（见 §7）。

---

## 3 A 方案：连通性检测 + 可配置播报

### 3.1 检测层（在现有状态机上扩展，不新建循环）

把「桥接端是否活着」从**两个独立信号**合成一个每对话状态：

| 信号 | 来源 | 覆盖的场景 |
|---|---|---|
| `probe` | 现有 `_health_loop` 的 `_bridge_ok`（`main.py:808-839`） | 空闲期：DSH 进程挂了、端口不通、版本被换 |
| `frames` | SSE 帧到达时刻（心跳帧 **或**任何数据帧都算） | 进行中：HTTP 还通但 turn 卡死、代理掐了流 |

判定规则（每对话）：

```
lastFrameAt        ← 任何一帧到达时刷新（含 heartbeat / text-delta / message-final）
online             ⇔ _bridge_ok 且 (无活动流 或 now - lastFrameAt <= frameMissMs)
frameMissMs        = heartbeatMs × frameMissFactor   （默认 3；下限取 max(1000, …) 同样的夹取）
候补判定            : 连续 probeMissCount 次探测失败 → offline（即使 _bridge_ok 还是旧的 True）
```

**为什么用「任何帧」而不是「只认心跳帧」**：代理/平台可能吞掉某一类帧；只有当**完全**没有帧到达时才说明链路死了。这也天然避开「长 turn 里没有心跳」的误判（心跳是独立定时器，长 turn 期间照发——`index.js:1440` 与 `:781` 都与 turn 无关）。

### 3.2 状态机（每对话，带滞回）

```
online ──(超时/probe 连续失败)──> suspect ──(再超一个窗口)──> offline
   ↑                                                            │
   └──────────────────(任一帧到达 / probe 成功)──────────────────┘
```

- **滞回**：`suspect → offline` 需要**再**经历一个 `frameMissMs`，避免抖动刷屏。
- **恢复也要播报**（可关）：`offline → online` 是一次独立事件，用户更关心的是「好了没」。
- 状态与 `lastFrameAt` 存**内存**（进程重启即重置）；是否入 `state.json` → §8 Q4。

### 3.3 播报层（这就是「由机器人选择是否回复」的落点）

新增配置 `heartbeat_notify`，四选一：

| 值 | 行为 |
|---|---|
| `off`（默认） | 什么都不发，只写日志（与现在等价） |
| `fixed` | 按状态发固定文案（掉线 / 恢复各一句），不调 LLM |
| `agent` | **把状态交给 LLM，由它决定说不说、说什么** —— 契约上「由机器人选择」 |
| `offline-only` | 只在掉线时用 `fixed` 播报，恢复不播 |

`agent` 模式的实现要点：

1. 组装一段**系统侧上下文**（不是用户消息）：桥接状态、持续时长、影响的对话、最后一次错误摘要；
2. 走 AstrBot 的 LLM 入口拿一段文本；**该入口的确切 API 需要核实**（见 §8 Q5）——
   这里我不写「大概是 `context.get_using_provider()`」，因为本项目一贯要求 API 有 `路径:行号` 证据；
3. 用一个**哨兵约定**让模型可以保持沉默：约定「只输出 `[SILENT]` 即不发言」，命中即丢弃；
4. 播报发送走 `await self.context.send_message(umo, chain)`（AstrBot 侧已验证的主动推送 API，
   见 `core/star/context.py:507-541`），**不是** `event.send()`——A 的场景里根本没有 `AstrMessageEvent`。

### 3.4 A 的配置面（IM 侧 `_conf_schema.json`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `health_interval_ms` | int | 30000 | **已存在**，探测周期（0=关） |
| `heartbeat_frame_miss_factor` | int | 3 | 帧间隔阈值 = `heartbeatMs` × 本值 |
| `heartbeat_notify` | string | `off` | `off` / `fixed` / `agent` / `offline-only` |
| `heartbeat_notify_targets` | list | `[]` | 空 = 所有已绑定对话；否则 UMO 白名单 |
| `heartbeat_notify_min_gap_ms` | int | 600000 | 同一对话两次播报的最小间隔（防抖动刷屏） |
| `heartbeat_silent_sentinel` | string | `[SILENT]` | `agent` 模式下表示「不发言」的哨兵 |

> `heartbeatMs` 本身是 **DSH 侧**配置；IM 侧要拿到它才能算阈值 → 由 `/health` 回传即可（现有响应已含
> `pathPrefix` / `cwd` 等诊断字段，加一个 `heartbeatMs` 是同性质的增量，不破坏契约）。

---

## 4 B 方案：自主心跳唤醒（agent 自己决定说不说）

### 4.1 调度闸门（DSH 侧，每对话一个定时器）

心跳**只在全部条件成立时**才发起一轮，否则跳过并记录跳过原因（便于排查「为什么它不说话」）：

```
1. proactiveHeartbeatMs > 0            （默认 0 = 关）
2. 该对话已绑定（records 里有 dshSessionId）且 **有 live agent**
3. 该对话在线（A 的判定）—— 见 §5 的 A×B 耦合
4. 当前空闲：!attaching && queue === 0 && !stuckAt
5. 没有待答：approvals.size === 0 && questions.size === 0
6. 静默够久：now - lastActiveAt >= proactiveMinIdleMs
7. 在允许时段内：proactiveWindow（如 ["09:00","23:00"]，空 = 不限）
8. 当日配额未用完：proactiveMaxPerDay
```

**第 2 条与空闲回收的冲突（必须显式处理）**：`sweepIdleSessions` 会把久未活动的会话
**归档并把映射摘掉**（`lib/index.js` 的回收分支）。也就是说「一直没人说话的群」会被回收，
而心跳又要求「有 live agent」——两者直接对撞。三种口径，我建议 **(b)**：

| 口径 | 行为 |
|---|---|
| (a) 心跳复活会话 | 到期就 resume/新建会话 → **半夜自己开新会话**，上下文全丢，不可接受 |
| (b) **心跳只对活着的会话**（推荐） | 会话被回收后心跳自然停摆；等用户再说一句话，会话重建、心跳恢复 |
| (c) 心跳阻止回收 | 给有心跳的对话豁免 `idleTtlMs` → 会话永不回收，资源泄漏 |

### 4.2 投递：怎么把「心跳」交给 agent

用 `agent.followup(createUserMessage(...))` 起一轮（与 `/message` 同一条路），关键在 **`source`**：
这不是用户说的话，必须标成插件来源，否则模型会以为「用户刚刚说了这句话」。

已核实的类型（`@deepseek-ai/dsh-llm/lib/types/message.d.ts:94-104`）：

```ts
plugin: { kind: 'plugin'; plugin: string } & ContextFormed
// ContextFormed 的变体含 { form: 'notice'; summary: string }（同文件 :81-89）
```

所以载荷形如：

```js
createUserMessage({
  content: [{ type: 'text', text: renderProactivePrompt(config) }],
  source: { kind: 'plugin', plugin: 'dsh-astrbot-relay', form: 'notice', summary: '心跳' },
})
```

> **【需实测】** `followup` 接受插件来源的 `UserMessage` 后**是否会真的起一轮**、以及
> `form:'notice'` 的事件在会话日志里长什么样。这是 B 的第一个实测项（见 §9）。

### 4.3 「由机器人选择是否回复」= 哨兵抑制

心跳提示词（可配置，`proactivePrompt`）里写死约定：

> 这是一次定时心跳，不是用户消息。若此刻没有值得主动告知群里的事，**只输出 `[SILENT]`**；
> 若确有必要说话，就直接说，输出会原样发到群里。

DSH 侧的抑制点：收集该轮的 `message/final` →

```
若 trim(final) === proactiveSilentSentinel（默认 '[SILENT]'）或为空
   → 不发任何帧给 IM（群里零痕迹），日志记一条「心跳沉默」
否则
   → 以 { type: 'message/final', proactive: true } 推给该对话的流
```

**为什么抑制放在 DSH 侧而不是 IM 侧**：哨兵要是发到 IM，AstrBot 侧就得为「这条要不要发」再写一遍
判定，而且哨兵有泄漏到群里的风险（任何一处判断漏了就露字）。放在出门之前，IM 侧拿到的帧天然是
「该发的」。

**帧标记 `proactive: true` 是必需的**：IM 侧同时存在两条消费路径——
`/message` 的那条按 callId/回合消费，常连流那条负责主动消息。没有标记，主动回复会被
「正在等回复的那条任务」误当成自己的结果。

### 4.4 IM 侧的主动发送路径

- 常连流的消费循环遇到 `message/final && proactive === true` → `await self.context.send_message(umo, chain)`；
- 主动消息**不做流式**（首版只发 final）：减少半截话刷屏，也避免与 `/events` 的节流逻辑纠缠；
- 长度仍走现有的切分/渲染（`_pick_cut` 与卡片渲染那套），保持与普通回复一致；
- 失败不影响流：发送异常只记日志。

### 4.5 B 的配置面

**DSH 侧**（`lib/index.js` 的 `Schema`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `proactiveHeartbeatMs` | 0 | 0 = 关；下限同 `heartbeatMs` 的夹取 |
| `proactiveMinIdleMs` | 1800000 | 静默多久才允许心跳 |
| `proactiveWindow` | `[]` | 允许时段（本地时区），空 = 不限 |
| `proactiveMaxPerDay` | 4 | 每对话每日配额 |
| `proactivePrompt` | 见 §4.3 | 心跳提示词 |
| `proactiveSilentSentinel` | `[SILENT]` | 沉默哨兵 |

**IM 侧**：`proactive_enabled`（本地总开关，便于一键静音）、`always_stream`（常连开关）、
`stream_reconnect_max_ms`。**注意**：真正的调度器在 DSH 侧，IM 侧的开关是「消费端静音」，
两者语义要在文档里写清，避免「两边都开一半」的困惑。

---

## 5 A × B 的耦合：B 必须依赖 A

B 的第 3 条闸门（「该对话在线」）不是可选优化，而是**防浪费的必需品**：
IM 侧没在听的时候发起心跳，等于白烧一次 LLM 调用，而且回复会丢。

反过来，A 也需要 B 之外的一个前提：**常连 SSE**（§2）。所以三者的依赖是：

```
常连 SSE  ──┬─→ A 的帧判定在空闲期也有效
            └─→ B 的回复有出口
A 的在线态 ────→ B 的调度闸门
```

**建议实施顺序**：常连 SSE → A（检测+播报）→ B（调度+哨兵）。每一步都能独立验收。

---

## 6 失败模式与防护

| 风险 | 场景 | 防护 |
|---|---|---|
| A 误判掉线 | 代理缓冲导致心跳成串到达 | 用「任何帧」刷新 + `frameMissFactor ≥ 3` + 滞回 |
| A 刷屏 | 链路抖动反复 online/offline | `heartbeat_notify_min_gap_ms` + 滞回 + 恢复播报可关 |
| A 骚扰无关群 | 全局状态却发到每个群 | `heartbeat_notify_targets` 白名单；默认空=全部，但**默认 `off`** |
| B 白烧 token | IM 侧没在听 / 会话已回收 | 第 2、3 条闸门；`proactiveHeartbeatMs` 默认 **0（关）** |
| B 半夜吵人 | 全天候触发 | `proactiveWindow` + `proactiveMinIdleMs` + 每日配额 |
| B 自我循环 | agent 的回复又算作「活动」，触发下一轮 | 配额 + `proactiveMinIdleMs` 从**最后一次活动**起算（含主动回复）；且心跳轮**不**重置静默计时以外的东西 |
| 哨兵泄漏 | agent 输出了 `[SILENT]` 却被发出去 | 抑制在 DSH 侧、**整条等于**哨兵才抑制（不做子串匹配） |
| 双实例抢流 | 两个 AstrBot 连同一 DSH 对话 | 契约未覆盖；至少在文档声明「同一对话只应由一个 IM 实例消费」，必要时 DSH 侧对同对话的第二条常连流拒绝或旁路 |
| 常连流拖住卸载 | 忘记清理定时器/连接 | 全部走 `ctx.effect`；IM 侧随插件 reload 取消任务（现有 `terminate()` 已是这个口径） |
| 心跳与 `idleTtlMs` 对撞 | 见 §4.1 第 2 条 | 口径 (b)：心跳只作用于活着的会话 |

---

## 7 对契约与版本的影响

**契约新增：**

- §3 新增（若采用每账号复用）：`GET /events?all=1` 与「帧带 `conversation`」的形状；
- §4 事件表新增或扩展：`message/final` 增加可选 `proactive: true`（**增量字段，前向兼容**）；
  `heartbeat` 语义不改（仍为 ephemeral 保活）；
- §12/新章：A 的每对话在线态、B 的调度闸门与哨兵约定；
- §3.4 `/health` 响应新增 `heartbeatMs`（回传给 IM 侧算阈值）。

**`bridgeVersion` 判断（按 §10 自己的口径）：**

- 新增可选端点 + 可选字段 → 照 §10 本来**不必**递增；
- 但这次同时改了**行为约定**：SSE 流从「按需短连」变成「可常连」、DSH 侧会**主动**发起轮次
  ——这正是 v2→v3、v3→v4 两次升版的同类理由（「写不进常量表、光比对字段看不出来」的行为层约定）。
- **我的建议：升 6**，并把理由写进 §10。代价照旧：v5 与 v6 不能混合部署。

---

## 8 待你定（按影响排序）

1. **常连 SSE 的粒度**：每对话一条（改动最小）还是每账号一条复用（连接数 O(账号)，需新增端点）？我倾向后者。
2. **`bridgeVersion` 升不升 6**？我倾向升。
3. **A 的 `agent` 模式**要不要做？要做的话我需要先核实 AstrBot 的 LLM 调用入口（见 Q5）。
   首版也可以只做 `off` / `fixed` / `offline-only`，把 `agent` 留到下一版。
4. **在线态是否持久化**（入 `state.json`）？倾向不入：它是运行时事实，重启即重置更干净。
5. **AstrBot 侧 LLM 调用 API 需核实**：`agent` 模式要拿一段由模型组织的文案，
   我需要读源码确认入口（大概是 `context` 上的 provider 接口），**不接受「大概是」**。
6. **B 的提示词是否要包含会话摘要**？带上「上次对话在聊什么」会显著提高心跳质量，
   但需要读历史（`sessionQuery` / 投影），成本与隐私都要权衡。首版建议**不带**。
7. **`proactive` 消息在 IM 侧是否要 @ 或加前缀**（如「（主动）」）？可配置，默认不加。

---

## 9 实测清单（写代码之前必须先做的）

1. **插件来源的 `followup` 是否起一轮**：构造 `{kind:'plugin', plugin:'dsh-astrbot-relay', form:'notice', summary:'心跳'}`
   投进去，看是否产生 `turn/start` → `message/final` → `turn/end`（B 的地基）。
2. **常连 SSE 的存活**：一条空闲流能被 DSH 保持多久（心跳是否足以穿透常见代理），
   以及 `sseConnections` 常驻对卸载收尾有无影响。
3. **`/health` 增加 `heartbeatMs` 字段**是否会被 IM 侧的版本闸门当成不兼容（当前只看 `bridgeVersion`，应无碍）。
4. **A 的漏报率**：在一次真实长 turn（含长工具调用）中确认心跳照常到达（`index.js:1440` 与 turn 无关，
   预期安全，但要实测确认代理没把并发写弄乱）。

---

## 10 测试计划（按本项目既有套路）

| 层 | 做法 |
|---|---|
| 纯函数 | A 的状态机（`online/suspect/offline` + 滞回 + 最小间隔）与 B 的调度判定（八条闸门）各自抽成**零依赖模块**，配 `scripts/test-*.mjs`——与 `location.js` / `questions.js` 同套路，**不需要装 dsh / AstrBot 依赖** |
| 假宿主 | 用 `scripts/test-question-chain.mjs` 已有的那套假 ctx/host（桩包 + 捕获路由与监听器），验证：心跳帧驱动的在线态、哨兵抑制、`proactive:true` 帧只在主动轮出现、A×B 耦合闸门 |
| IM 侧 | A 的播报策略（四个取值 × 掉线/恢复）与常连流重连退避，同样拆成无 astrbot 依赖的模块 + Python 单测（照 `location_text.py` / `allowlist.py`） |
| 契约闸门 | 新增的配置键/事件名进 `check-contract-parity.mjs` 的比对面（两侧副本必须逐字对应） |
| 端到端 | 部署后：手动掐掉 DSH 进程 → 观察 A 的播报；把 `proactiveHeartbeatMs` 设为极小值 → 观察 B 的哨兵抑制与配额 |
