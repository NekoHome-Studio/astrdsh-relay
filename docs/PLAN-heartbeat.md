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

## 2 关键前置决策：B 的出口 —— ⚠️ **实现期改了主意，本节保留原分析**

> **决策更新（实现期结论）**：本节原来推荐 **① 常连 SSE**，实施时**放弃了**，改用
> **③ 的有界版本**：每对话一个有界发件箱 + `GET /proactive?since=<全局游标>` 轮询
> （契约 §18）。放弃 ① 的两个理由是硬伤，不是偏好：
>
> 1. **`Last-Event-ID` 在多对话复用下失去意义**。`seq` 是**每对话**的（契约 §4），
>    一条流里混着多个对话的序号后，「我收到哪儿了」这个游标无法表达：要么退化成全局
>    环形缓冲（等于放弃重放），要么为每条流维护一张表。
> 2. **主动消息必须可重放，丢了就是丢了**。SSE 是瞬时的——没人在听时事件永久消失，
>    而主动消息恰恰是「用户当时可能不在」的场景，天生需要**存储转发**。
>
> 代价是延迟上限 = `proactive_poll_ms`（默认 5 秒），对「过一会儿主动说一句」够用。
> 下面三种出路的对比保留原样，作为当时的判断依据。

**问题**：现在 SSE 流是**按需**的（契约 §4.1：先连 SSE → 再投 `/message`，一轮结束就关）。而 B 的心跳发生在**没有任何 turn 在跑**的时候——此时 IM 侧没有流，DSH 侧的 `message/final` **没有出口**，主动回复会直接丢掉。

**三种出路：**

| 方案 | 做法 | 代价 | 评价 |
|---|---|---|---|
| ① 常连 SSE | IM 侧为「已绑定且启用主动」的对话维持长连接，断线指数退避重连 | 每对话一条 HTTP 长连接；服务端 `sseConnections` 常驻 | 不违反契约 §0 的**单向连接**原则；但见上方两条硬伤 → **已放弃** |
| ② 反向 webhook | DSH 主动 POST AstrBot 的插件 web API | 需要 AstrBot 入站可达 → **推翻 §0**，跨机/容器下要额外开洞 | 否 |
| **③ IM 侧轮询待发队列** | 新增 `GET /proactive?since=` + 每对话有界发件箱 | 延迟 = 轮询周期（默认 5s）；要新增队列与游标语义 | **✅ 最终采用** |

**① 的粒度**（原 §8 Q1）**已随 ① 一起作废**：

- ~~**每对话一条**~~：一个 QQ 号在 50 个群里就是 50 条长连接。
- ~~**每账号一条复用**~~：复用之后 `seq` 的每对话语义与 `Last-Event-ID` 无法共存（见上）。

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

反过来，A 与 B 在**实现上互相独立**（B 的 `online` 闸门取「IM 最近在轮询」，
不需要 IM 的每对话在线态）。所以实际上线的依赖是：

```
IM 侧轮询 /proactive ──┬─→ B 的回复有出口
                       └─→ B 的 online 闸门（「有人在听」的证据）
A（探测 + 见帧） ──── 独立，不需要 B
```

**实际实施顺序**（与最初计划不同，但每步仍可独立验收）：A（检测+播报）→
IM 侧轮询取件 → B（调度+哨兵）。两半可以分别上线：只有 A 时 B 不发，只有 B 时 A 不报。

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
| 双实例抢流 | 两个 AstrBot 连同一 DSH 对话 | 契约未覆盖；至少在文档声明「同一对话只应由一个 IM 实例消费」。**改用发件箱+轮询后风险降低**：不再是「两条常连流抢一个出口」，而是两个实例各自以**各自的游标**取件——两者会**重复投递**同一条主动消息（游标是全局的，ack 是各自的），但不会有流被抢死 |
| 长驻任务拖住卸载 | 忘记清理定时器/连接 | 全部走 `ctx.effect`；IM 侧随插件 reload 取消任务（现有 `terminate()` 已是这个口径）。⚠️ 见 §6.1：这里**真的漏过一次** |
| 心跳与 `idleTtlMs` 对撞 | 见 §4.1 第 2 条 | 口径 (b)：心跳只作用于活着的会话 |

### 6.1 实现期真的踩到的一个坑（值得记住的形状）

**「改一处、漏一处」的字段错位。** 新增的生命周期字段
（`_health_task` / `_hb_states` / `_hb_heartbeat_ms` / `_proactive_task` / `_proactive_cursor`）
被写进了 **`BridgeTransport.__init__`**，而读它们的是 **`Main`** 的方法。
Python 不做静态校验，`bridgeVersion` 检查、`py_compile`、静态复核**全都不会报错**；
真正暴露它的是「假 AstrBot 上下文」集成测试跑 `_touch_frame` 的那一行：

```
AttributeError: 'Main' object has no attribute '_hb_states'
```

而这个坑的**子集**（`_health_task`）已经**随 v0.8.6 发布出去了**：
`enable=false` 时 `initialize` 提前 `return`、从不创建该任务，于是 `terminate()` 的
`if self._health_task is not None` 就是一次 `AttributeError`——卸载插件即崩溃。

**同一族的第二处（方法而非字段）**：`proactive()` 被写进了 `Main`，而它内部调的是
`BridgeTransport._request`。它是一段**永不生效的死代码**——`_poll_proactive()` 走的是
`self._transport_or_create().proactive(...)`，于是测试全绿、运行时也不报错，
只有真去调 `Main.proactive()` 才会 `AttributeError`。它同时也让
「传输层十二方法」那句文档变成**假的**（移回 `BridgeTransport` 之后才是真的）。

教训不是「小心点」，而是**这类接线必须有一个真跑起来的宿主替身**，
且那个替身要有一条**泛化**的检查——不是逐个写死名字，而是从源码里抠出
`Main` 类体中所有 `self._xxx`，要求「刚 new 出来、还没 `initialize` 的实例上就都有」。
第二处正是这条泛化检查抓到的（`scripts/test-im-heartbeat.py`）；
纯逻辑单测永远测不到它。

---

## 7 对契约与版本的影响

**契约新增（已落地，实际形态见 §17/§18）：**

- §18 新增 `GET /proactive?since=<全局游标>`（**不是** `GET /events?all=1`——那个方案
  随 §2 的决策更新一起作废）；`since` 同时充当 ack，服务端据此 prune 每对话有界发件箱；
- §4 事件表**不变**：心跳轮不新增事件类型，其输出经哨兵筛选后走发件箱，
  不出现在下行通道里（§18.6）；
- §17/§18：A 的每对话在线态与播报策略、B 的八条闸门、哨兵约定与 `online` 闸门口径；
- §3.4 `/health` 响应新增 `heartbeatMs`（回传给 IM 侧算阈值，**两侧同源**才能对齐口径）。

**`bridgeVersion` 判断（按 §10 自己的口径）：**

- 新增端点 + 新增字段 → 照 §10 本来**不必**递增（老客户端不会去调，也不会坏）；
- 但**不升就会静默半死**：v5 的 IM 不会去调 `/proactive` → DSH 侧 `online` 闸门永不开
  → B 永远不触发，**且没有任何报错**。这条理由比 v2→v4 那三次「行为层约定」更硬：
  那三次是「客户端会看到时序变化」，这次是「客户端什么都看不到，功能像没装」。
- **结论：升 6**（已落地），理由写进契约 §10。代价照旧：v5 与 v6 不能混合部署。

---

## 8 待你定（**已按推荐默认值实施**，此处保留决策记录）

> 本节是实施前的开放问题清单。用户答复「开始吧」即按推荐默认值推进，
> 下面逐条标注**最终取值**；仍悬空的两条单独标出。

1. ~~**常连 SSE 的粒度**~~ → **作废**：改用有界发件箱 + 轮询（§2 决策更新）。
2. **`bridgeVersion` 升不升 6**？→ **升了**（契约 §10 已写入 v5→v6 依据）。
3. **A 的 `agent` 模式**要不要做？→ **v0.8.8 已做**。前置的「核实 AstrBot 的 LLM
   调用入口」在 v0.8.8 补齐（证据见 `docs/astrbot-side-capabilities.md` §3.6 与
   契约 §17.4.1）。四条实现约束写进了契约：**必须有超时**（这次调用挂在健康复检
   循环上，模型卡住等于探测器停摆）、取不到模型/抛错/超时/空**一律退回固定文案**、
   模型输出**先洗再发**（去 Markdown 标记、压成一行、截断）、提示词模板由配置给出。
   另外明确了分工：**要不要播报是确定性的**（`should_notify`），模型只负责措辞。
4. **在线态是否持久化**（入 `state.json`）？→ **不持久化**：它是运行时事实，
   重启即重置更干净。**但 `proactive_cursor` 必须持久化**（IM 侧 KV）——
   不持久化会导致插件重载后把发件箱里剩下的重发一遍（§18.1）。
5. **AstrBot 侧 LLM 调用 API 需核实** → **已核实**（v0.8.8）：
   `Context.get_using_provider(umo)`（`astrbot/core/star/context.py:425`）→
   `await Provider.text_chat(prompt=…, system_prompt=…)`（`provider.py:96`）→
   文本优先 `LLMResponse.result_chain.get_plain_text()`（`message_event_result.py:149`），
   `completion_text` 已过时只作兜底。当时那句「大概是 `context` 上的 provider 接口」
   猜对了方向，但**猜对不等于核实**——签名、空值语义（返回 `None` 而不是抛异常）、
   以及「没有内置超时」这三条都是读源码才知道的。
6. **B 的提示词是否要包含会话摘要**？带上「上次对话在聊什么」会显著提高心跳质量，
   但需要读历史（`sessionQuery` / 投影），成本与隐私都要权衡。首版建议**不带**。
7. **`proactive` 消息在 IM 侧是否要 @ 或加前缀**（如「（主动）」）？可配置，默认不加。

---

## 9 实测清单

1. **⚠️ 仍未做（B 的地基）**：插件来源的 `followup` 是否起一轮。构造
   `{kind:'plugin', plugin:'dsh-astrbot-relay', form:'notice', summary:'心跳'}`
   投进去，看是否产生 `turn/start` → `message/final` → `turn/end`。
   **本机没有活的 DSH 宿主，做不了**；契约 §18.8 已把这条写成显式的未实测项。
2. ~~**常连 SSE 的存活**~~ → **作废**（§2 决策更新：不再有常连流）。
   替代问题：`proactive_poll_ms` 默认 5 秒的轮询对 AstrBot 与 DSH 两侧的负载
   是否可忽略（预期可忽略：一条空响应的 GET），部署后观察。
3. ~~**`/health` 增加 `heartbeatMs` 是否会被版本闸门当成不兼容**~~ →
   **已核实无碍**：IM 侧 `BridgeTransport.health()` 只比对 `bridgeVersion`，
   新增字段会被忽略（§3.4）。
4. **A 的漏报率**：原顾虑是「长 turn 期间没有心跳帧」。读码后确认**不成立**：
   ①`_touch_frame` 在心跳帧的过滤**之前**调用（`main.py:1107` vs `1112`），
   任何帧都刷新；②turn 期间桥接端本来就有两条 15 秒心跳在跑
   （`index.js:830` 的每桥定时器与 `index.js:1630` 的 SSE 保活）。
   于是阈值（默认 45 秒）对长 turn 是安全的。**待实测**的只剩「代理把帧攒起来
   成串投递」这一种形态——滞回带就是为它留的。

---

## 10 测试计划（**已全部落地**）

> v0.8.8 追加：假宿主那两层现在是**两个文件**——`scripts/_fake_astrbot.py` 是共用宿主
> （桩 + 假 transport + 假事件），`test-im-heartbeat.py` 测心跳/主动消息，
> `test-im-commands.py` 测指令分发/审批/问答/卡片。后者里还有一条**元测试**：
> 逐一对齐假 transport 与真 `BridgeTransport` 的 12 个方法签名——
> 因为桩写错时，上面所有用例都会给出看似合理的假结论（真的踩过：假 `fork`
> 参数名写成 `upto_turn`、真名是 `at_seq`，于是处理器的 `except Exception`
> 把 TypeError 吞掉，测试看到的是「没有任何调用」）。

| 层 | 落地形态 |
|---|---|
| 纯函数（JS） | `dsh-astrbot-relay/lib/proactive.js` 零依赖；`scripts/test-proactive.mjs`（19 项：八条闸门、时段含跨零点与闭区间、哨兵整条匹配、有界发件箱、提示词占位符） |
| 纯函数（Py） | `astrbot_plugin_dsh_relay/heartbeat_state.py` 零依赖；`scripts/test-heartbeat-state.py`（20 项：三态滞回、跃迁、播报策略、最小间隔、文案不含裸星号） |
| 假宿主（JS） | `scripts/test-proactive-chain.mjs`（9 项）：真起 `ctx.effect` 定时器跑 `proactiveTick`，覆盖「IM 从未轮询 ⇒ online=false ⇒ 不发起」「插件来源而非用户来源」「哨兵 ⇒ 下行通道零痕迹」「有正文 ⇒ 入发件箱且 `since` ack 生效」「发件箱有界丢最旧」 |
| 假宿主（Py） | `scripts/test-im-heartbeat.py`（20 项）：桩掉 `astrbot.*`，真跑 `Main` 的 `_touch_frame` / `_evaluate_heartbeats` / `_health_loop` / `_poll_proactive`。**这一层才是接线层**——§6.1 那个 P0 就是它抓到的 |
| 契约闸门 | `scripts/check-contract-parity.mjs` 比对两侧常量副本（现为 `BRIDGE_VERSION=6`、12 事件、7 错误码、12 路由） |
| 端到端 | **待部署后手测**：掐掉 DSH 进程 → 观察 A 的播报；`proactiveHeartbeatMs` 设成极小值 → 观察 B 的哨兵抑制与配额 |
