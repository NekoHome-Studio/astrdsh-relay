# PLAN v0.8.5 —— 在途投递单与问答链兜底

> 本文件是 `dsh-astrbot-relay/lib/index.js` 内注释所引用的落地依据。
> 目标版本：0.8.5（HEAD 基线 14859aa / 0.8.4）。
> bridgeVersion 变动见 §7。

## 1. 背景：一条审批链能自愈、一条问答链卡死

审计结论（详见 `relay_audit_round5.md`）：

- **审批链**：桥自己的答案器 `askApproval` 用 `setTimeout(..., approvalTimeoutMs=120000)` +
  `timer.unref()`；超时即 `resolve(REJECTED)`，宿主侧随即产生 `turn/end`，闸门随之释放。
  属**桥侧自带超时**，最坏情况是「答案被拒」，不会死锁。
- **问答链**：`ask_user_question` 的服务侧实现（`dsh-user-questions`）**自身零超时**，
  只能靠 `signal` 中断；`dsh-tool-ask-user` 的 `execute` 也只是把 `signal` 透传下去。
  一旦无人接管 `user-questions/request` waterfall，宿主 Promise 永久悬挂 →
  turn 34 永不闭合 → `whenIdle()` 永不 resolve →
  `queue` / `attaching` 永久为忙 → 后续 `/message` 一律 `409 agent_busy`。
  实测卡死逾 6.91 小时，且进程 `uptimeMs` 仍在递增，`/session/fork` 是唯一旁路（不改绑会话）。

一句话根因：**闸门的释放条件（turn 闭合）依赖于一条没有超时的等待链。**

## 2. 设计约束（不可越过的线）

1. 桥**不得**替宿主取消 turn。宿主 turn 仍活着时撤单，会把「对话卡住」升级成
   「进程里堆一批永不释放的 agent」——更糟。
2. 释放动作必须**幂等**且**单一出口**：同一份额度被两条路各放一次，
   就会让 `queue` 变负或让 `attaching` 提前放行、造出两个并发的 resume。
3. 超时必须 **fail-closed**（宁可不放，也绝不放两次）。
4. 答案**一次生效**：与审批通道一致，重复投递不得二次裁决。

## 3. 本版实现：在途投递单（inflight ticket）

把「一次已接受的投递」实体化为一张单子：

```
openInflight(bridge)                      // 闸门开 → 开单，queue += 1，挂超时
  ├── turn/end        → settleInflight(bridge, 'turn-end')   // 权威路径
  ├── whenIdle().finally() → settleInflight(bridge, 'idle')  // turn/end 没派到本桥时的兜底
  ├── waitTimeoutMs 到点   → settleInflight(bridge, 'timeout') // fail-closed 兜底
  └── 投递抛错        → settleInflight(bridge, 'error')       // 失败回滚
```

`settleInflight(bridge, reason)` 的语义：

- `bridge.inflight` 为空即直接返回 `false`（**幂等**，这就是「单一出口」的全部实现）；
- 清掉超时定时器，`bridge.queue -= 1`（下限 0），`bridge.attaching = false`；
- `reason === 'timeout'` 时额外写入 `bridge.stuckAt = Date.now()` 并 `log.warn`：
  意思是「闸门放了，但不保证 turn 真的闭合」。

关于 `stuckAt`：

- 它**只**参与 `sweepIdleSessions` 的在途判据
  （`bridge.attaching || bridge.queue > 0 || bridge.stuckAt`），
  挡住自动空闲回收，避免把还在跑的 turn 连 agent 一起拆掉；
- 它**不**参与 `/session/rebind` 与 `/session/adopt` 的闸门判据——
  恰恰相反，那两条显式路径现在能在超时解闸后走通，成为卡死会话的救回手段；
- 碰到任何一条 `turn/end`（哪怕是迟到的）即清零。

配置项 `waitTimeoutMs`：`Schema.number().default(300_000)`，单位毫秒；
设 `0` 表示关闭超时兜底（只剩 `turn/end` 与 `whenIdle` 两条释放路），供排障时使用。
它**不等于** `approvalTimeoutMs`（后者 120_000，管的是审批答案，不是投递闸门）。

## 4. 本版实现：问答通道（user-questions）

与审批通道**同构但不同表**：`bridge.questions` 与 `bridge.approvals` 各存各的，
二者的 `callId` 前缀不同（`im-q-` / `im-`），互不干扰。

```
host.on('user-questions/request')
  ├── bridgeByAgent(request.agent.id) 反查不到 → next()   // fail-open，不越权
  ├── config.questionsEnabled === false    → next()      // 行为退回「没装桥」
  └── askQuestions(bridge, request)
        ├── /answer（IM 代答）  → finish(answers, 'im')
        ├── signal abort        → finish(null, 'abort')   → reject ASK_ABORTED
        ├── questionTimeoutMs 到点 → finish(null, 'timeout') → reject ASK_ABORTED
        └── drainPending('retarget') → finish(null, 'retarget')
```

要点：

1. **出参形状**：回填 `{ answers: [{ id, selected: string[], custom? }] }`。
   `renderQuestion(item)` 只投影 `id / question / header / options[{label,description}] / multiSelect`，
   **剥掉**仅给 Web UI 用的 `detail` 与 `intent`（转发过去只会让 IM 侧多写无用分支）。
   入参的 `multi_select` 在本桥的载荷里写作 `multiSelect`（桥对 IM 的输出格式统一用驼峰）。
2. **超时结局是「抛错」而不是「撤销 turn」**：到点 `reject(questionError('ASK_ABORTED'))`，
   让它在宿主侧变成一次普通工具报错，agent 自己收尾 → `turn/end` → `settleInflight` 放闸。
   详见 §2 第 1 条：桥撤单只会把死锁升级成永不释放的 agent。
   错误码统一挂在 `error.code` 上（`ASK_ABORTED` / `EMPTY_QUESTIONS`），
   因为 waterfall 的 `next` 是 `() => Promise<...>`、**不接受参数**，想拒绝只能 throw。
3. **fail-closed 的答案筛**：`normalizeAnswers(list)` 逐条要求 `id` 非空且
   `selected` 或 `custom` 至少有一个；筛完一条不剩就当作「没答」，
   回 `400 UNSUPPORTED`，**绝不**把空数组当作「用户选了空」塞回工具。
4. **一次生效**：`/answer` 与审批同语义——已决议或已超时一概 `409`（`AGENT_BUSY`），
   未知对话 `404`，字段不全 `400`。幂等判据仍是 `bridge.questions.has(callId)`，
   所以 §3 的「先结算、再换表」在这里一字不改地适用。
5. **等待态可见**：`/health` 新增 `pending: [{ conversation, attaching, queue, approvals,
   questions, stuckAt }]`。「在等一个可能不到来的答案」= `questions > 0 且 stuckAt = 0`；
   「闸门已放但不保证 turn 闭合」= `stuckAt > 0`。甲项审计时这两种状态在旧 /health 上长得一模一样。
6. **配置**：`questionsEnabled`（默认 `true`）、`questionTimeoutMs`（默认 `300_000`）。
   关闭前者等于把这套答案器整体摘掉，行为与未装桥一致。
7. **改指/接管**：`/session/rebind`、`/session/adopt` 原先把 `bridge.approvals` 直接换成新 Map，
   现统一改为 `drainPending(bridge, 'retarget')` —— 先逐张结算（审批 `REJECTED`、问答 `null`），
   再换表。见 §3 与源码 `drainPending` 的注释。

## 5. 进度（本版剩余项）

1. ~~IM 侧 `main.py` 补 `user-questions` 处理~~ —— **已落地**。本版提交里已含
   `send_answer` / `_on_question_required` / `_issue_question_code` / `_handle_answer_command`，
   以及 `contract.py` 的 `ROUTE_ANSWER` / `COMMAND_ANSWER` / `EVENT_QUESTION_REQUIRED` /
   `EVENT_QUESTION_RESOLVED`（两侧由 `check-contract-parity.mjs` 对齐）。
   仍然有效的一条附注：`waitTimeoutMs` **刻意不同步**进 IM 侧 Schema——它是 DSH 侧插件配置
   （`index.js` 的 `Schema.number()`，消费者为 `openInflight`），IM 侧 `main.py` 无任何读取点，
   加进去就是死配置。
2. 测试：~~答案器正常路径、超时路径（`ASK_ABORTED`）、`drainPending` 路径~~ —— **已落地**，
   见 `scripts/test-questions.mjs`（15 项纯函数）与 `scripts/test-question-chain.mjs`
   （15 项：假宿主驱动 `apply()`，覆盖 `/answer` 校验阶梯、正常回执与一次生效、
   无效条目不被消费、超时、预中止与运行期 abort、`questionsEnabled=false` 交还框架、
   `bridgeByAgent` 反查不到 fail-open、`/session/adopt` 的 `drainPending`）。
   **IM 侧卡片渲染仍未覆盖**（AstrBot 侧，需另配无 astrbot 依赖的渲染模块）。
3. 部署侧同步与定版 —— **仍未做**。

## 6. 已结案：fork 的 `inheritedEventCount` 不是副本事件总数

原先记的「差 2」是把两个不同的量相减：`inheritedEventCount` 是**继承前缀长度**
（= 刀口在源日志里的下标），副本总数 = 继承数 + 子会话自有事件，而自有事件**至少**含
宿主必然追加的一条 `session/end-seed`
（`@deepseek-ai/dsh-session/lib/types/index.js:468-471`）。差值 ≥ 1 属设计如此。

要验的是这条不变量（被 codec 强制，违反即抛 `SessionFormatError`）：

> 最后一条带 `data.inherited === true` 的 `session/end-seed`，其 `seq` == 该会话的 `inheritedEventCount`。

依据 `dsh-session-persistence-jsonl/lib/worker.cjs:8795`。完整证据链见契约 §14.5。

## 7. 版本判断（已定：升 5，随 v0.8.6 发布）

- 新增 `user-questions` 等**增量可选端点**：依 `BRIDGE-CONTRACT.md` §10，单看这一项可维持 `bridgeVersion=4`；
- 但「`attaching` 由 whenIdle 释放」改为「由 turn/end 结算」**修改了既有字段语义**，
  按 §10「修改既有字段语义**必须**递增」→ **定为 `5`**。
  代价与前三次相同：**v4 与 v5 不能混合部署**，升级必须两侧同时发布，不存在灰度窗口。
