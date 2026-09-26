# 更新日志

## v0.9.0-alpha — 2026-09-26

> **预发布（alpha）**：供**真机部署验证**使用。接口与行为在定版前仍可能变；
> 两侧仍需同一个 `bridgeVersion`（本版是 `6`）。
>
> 本版**合并了原计划的 v0.8.10**：那批改动（部署清单 + 两处表述更正）此前只进过
> 工作区，既未定版也无产物，因此条目在这里一并给出——与 v0.8.6 合并 v0.8.5 同一处理。
>
> **为什么写 `0.9.0-alpha` 而不是 `0.9.0alpha`**：发布流程用「tag 里有没有 `-`」判定
> 预发布（`.github/workflows/release.yml` 的 `prerelease: contains(tag, '-')`），
> 不带连字符会被发成**正式版**，而名字却写着 alpha——正是本项目一直在消灭的
> 「标签和事实不符」。另外按 semver 规范，预发布段必须由 `-` 引出
> （npm 自己容错，但严格解析器不会）。

### 文档

- **新增 `docs/DEPLOY-CHECKLIST.md`**：把「装上去」和「证明它真的在工作」拆成可逐条
  打勾的步骤——前置检查（版本配对 / 网络方向 / 时钟）→ DSH 侧 → AstrBot 侧 →
  数据面 → 心跳 A → **自主心跳 B** → 审批链 → 问答链 → 呈现与韧性 → 跨机反代 →
  记录表 → 回滚。其中：
  - 键名、日志串、鉴权形状、`/health` 字段**逐条对着代码核过**（不编）；
  - 三处至今未实测的东西给了**可判定**的操作与判据（契约 §18.8 的 B 半地基、
    长 turn 的误报率、5 秒轮询的量级），§11 那张表就是关闭它们的唯一凭据；
  - 记下一条容易误判的语义：**DSH 重启后「恢复」播报不会自动出现**，
    因为恢复的判据是「收到新的一帧」，而帧只在下行通道上产生。
    这是设计如此（探测证明进程活着、帧证明这条流通了），不是漏报；
  - 起草时我自己写错了两条并当场改掉：**停轮询不能靠 `proactive_poll_ms: 0`**
    （它在代码里被夹到 `max(1000, …)`，设 0 反而比默认更勤），要停就停插件；
    **明文 HTTP 的拒绝不是「配置加载即失败」**，而是启动期只 warn、
    第一个请求（启动探测 `/health`）才失败——`_check_scheme()` 是在 `_request()` 里跑的。

### 变更

- **契约 §3.4 的 `/health` 示例删掉 `dshVersion`**：实现**从未提供**该字段
  （`handleHealth` 里只有一行「需要从 host 服务读，未核实，故未实现」的注释）。
  示例就是别人会照抄的东西，不该展示不存在的字段；字段缺失本身有前向兼容规则兜着，
  不影响任何客户端。同处补上真实的响应字段（`pending` / `pathPrefix` / `statePath` /
  `policy` / `heartbeatMs` / `sessionTitleTemplate`）。
- **AstrBot 侧 `metadata.yaml` 的定位描述更正**（这是用户能在插件列表里看到的一句话）：
  原文写「与 `astrbot_plugin_dsh_connector` 的定位不同……会话/模型/Preset/Settings
  的管理面仍由 connector 负责」，读起来是**长期并存**；而项目决策是**最终替代**
  （`docs/DESIGN.md` §7）。现在写明「当前只做数据面、管理面**尚未**接管、目标是
  功能对齐后接管」。**元数据也是文档，同样不该和决策文档打架。**
- `README.md` 交付物地图补上部署清单；`docs/DESIGN.md` 风险登记里那处指向
  「部署清单 §6.4」的**悬空引用**改为指到新文件。

## v0.8.9 — 2026-09-26

> 收掉两笔遗留欠账，都是**文档/配置键在说谎**这一类（R1 的主题）。
> **`bridgeVersion` 仍为 `6`**：只动 IM 侧，两侧可以不同时升级。

### 修复

- **`reply_render_mode=card` 在主动推送上不生效**（v0.7.0 起就是如此）。
  此前只有 `_reply`（agent 回复）认这个键，而 `push_to_session` 固定发纯文本，
  于是把渲染模式改成 `card` 的用户会发现**心跳播报与主动消息仍是纯文本**——
  配置键在一条路径上说了谎，正是 R1「配置键不再说谎」要消灭的形状
  （`docs/ROADMAP-v0.7.md` §1）。现在对**所有**出站消息生效：回复、心跳播报、主动消息。
  判定与回退规则完全一致，由 `Main._card_urls` 共用（**任一片渲染失败就整条退回
  纯文本**，绝不出现半图半文——两处各写一份的话，这种最难查的形态迟早在其中一条路径上出现）。
  图片链的构造与 `event.image_result` **逐字对应**并已核实：`MessageEventResult.url_image`
  是 `Image.fromURL`、`file_image` 是 `Image.fromFileSystem`
  （`message_event_result.py:93-116`），分派判据就是「开头是不是 `http`」；
  `Main._image_chain` 照抄这条规则（`Image.fromURL` 对非 http **会抛异常**，
  所以分派写错会在推送时炸，而不是安静地发错东西）。

### 文档

- **`docs/ROADMAP-v0.7.md` 补做 v0.8.x 复核**：那张表是 v0.7 时代的快照，多处已落地
  但正文从未回改。新增 §1.1「v0.8.x 期间的进展」逐条标注现状，并在仍误导的两处
  （§2.1 `user-questions`「留二期」、§2.5 card 遗留）就地加过期标记。
  保留原文是有意的：留着才知道**当时为什么算欠账**，删掉就只剩结论。
  同时记下一句教训——§7.4 当年写「出图要另走 `Context.send_message` + `Image` 组件，**未验证**，
  故不动」，而这次一核实就发现规则很简单：**「未验证」是会过期的，它是一张欠条，不是一句结论**。
- 契约 §17.4 补一条：呈现方式对**所有**出站消息一致。
- `_conf_schema.json` 的 `reply_render_mode` 描述改为「呈现方式（回复与主动推送共用）」，
  并写明作用范围与回退规则——配置项的 hint 本身也不该说谎。

### 变更

- `scripts/test-im-commands.py` 增至 39 项（新增 6 项：推送走图片、任一片失败整条退回、
  `text` 模式不受影响且不碰 t2i、主动消息同样出图、`_image_chain` 的分派与桩的校验）。
  终验 `npm test` 共 **242 项**。

## v0.8.8 — 2026-09-26

> 心跳 `agent` 模式接线（v0.8.7 里唯一留空的功能位），外加一处**用户可见的严重缺陷**。
> **`bridgeVersion` 保持 `6`**：本版只动 IM 侧，两侧**可以**不同时升级
> （v0.8.7 的 DSH 侧配 v0.8.8 的 IM 侧是合法的）。

### 新增

- **心跳播报的 `agent` 模式**：由对话模型把「链路断了/恢复了」组织成一句人话，
  而不是固定文案。新增配置 `heartbeat_agent_prompt`（模板，含
  `{kind}` / `{kind_cn}` / `{conversation}` / `{error}` / `{minutes}`）、
  `heartbeat_agent_system_prompt`、`heartbeat_agent_max_chars`（200）、
  `heartbeat_agent_timeout_ms`（15000）。`heartbeat_notify` 的选项里补上 `agent`。
  **分工是刻意的**：要不要播报由 `should_notify` 确定性判定，模型只负责措辞——
  把判定也交给模型，就会出现「它觉得这次不重要就不说了」，而连通性漏报的代价
  远大于措辞难看。契约 §17.4.1 记录了入口证据与四条硬约束。
- AstrBot 的 LLM 入口**在源码里核实完毕**（此前只有「大概是 `context` 上的
  provider 接口」）：`Context.get_using_provider(umo)`（`astrbot/core/star/context.py:425`）
  → `await Provider.text_chat(prompt=…, system_prompt=…)`（`provider.py:96`）
  → 文本优先 `LLMResponse.result_chain.get_plain_text()`（`message_event_result.py:149`），
  `completion_text` 已被上游标为过时、只作兜底。三条只有读源码才知道的事：
  provider 取不到时返回 `None`（不抛异常）、`text_chat` **没有内置超时**、
  `should_call_llm` **不拦**插件自己发起的请求。证据写进
  `docs/astrbot-side-capabilities.md` §3.6。

### 修复

- **审批请求与问答请求根本到不了用户手上（v0.8.7 及以前一直如此）。**
  `_on_approval_required` / `_on_question_required` 标注为 `AsyncIterator` 却**完全没有
  `yield`**，因此它们是**协程**；而 `_consume_turn` 里的调用点写的是
  `async for result in self._on_...(...)`。实测报错：

  ```
  TypeError: 'async for' requires an object with __aiter__ method, got coroutine
  ```

  后果有两层：①审批/问答提示永远送不到用户；②这个异常从 `_consume_turn` 一路穿过
  `_handle_task` 与 `on_bridge_message`，**打断整条 turn 的回帖**。而审批 waterfall
  本身**没有超时**（契约 §7.2），于是 agent 会一直挂在等一个不可能到的答案上。
  修法：两个处理器签名改为 `-> None`，两处调用点改为 `await`；
  并加一条从两侧钉住形状的测试（`inspect.isasyncgenfunction` 必须为假），
  谁要是给处理器加了 `yield` 而没同步改调用点，立刻出声。
  **类型注解 `AsyncIterator` 不产生任何运行时保证**——这条已补进
  `docs/astrbot-side-capabilities.md` §3.7，别再拿注解当契约。
- `agent` 模式下若 `heartbeat_agent_prompt` 为空，**不把空提示词丢给模型**
  （那只会得到一句无关的话，还可能被发出去），按「用不了」处理并退回固定文案。

### 变更

- **假宿主拆成共用模块并扩到全量接线**：新增 `scripts/_fake_astrbot.py`
  （桩 + 假 transport + 假事件，两处共用）与 `scripts/test-im-commands.py`（33 项）。
  覆盖：指令分发（前缀匹配、白名单、`should_call_llm`/`stop_event` 接管标记）、
  六个 `/dsh` 指令的路由、流式回帖与 `turn/end` 收敛（`message/final` 权威、
  `gap` 提示、未知帧忽略、投递失败文案、**先连流再投递**的顺序）、
  审批链（提示送达、approve/reject、重复回执、`approval/resolved` 销号、
  `approval_enabled=false`）、问答链（逐题补交、答齐才碰网桥、自由文字落 `custom`、
  无效验证码）、卡片渲染（**任一片失败就整条退回纯文本**）。
- `scripts/test-im-heartbeat.py` 同期扩到 32 项（新增 agent 模式 10 项）。
- **假宿主的配置默认值改为从 `_conf_schema.json` 直接读**，不再手抄一份：
  手抄的那份必然漂移，而漂移的表现是「测试里提示词是空的、生产里不空」这种
  只在测试里存在的假象（第一版就是这么写错的）。
- 新增**元测试**：逐一对齐假 transport 与真 `BridgeTransport` 的 12 个方法签名。
  桩写错时上面所有用例都会给出看似合理的假结论——真的踩过一次：假 `fork` 的参数名
  写成 `upto_turn`（真名 `at_seq`），于是处理器的 `except Exception` 把 `TypeError`
  吞掉、只回一句「分支失败」，测试看到的是「没有任何调用」。
- 终验：`npm test` 共 **236 项**（此前 183 项）。

### 文档

- 契约 §17.4 改写 + 新增 §17.4.1（`agent` 模式的入口证据与四条硬约束）；
  `docs/astrbot-side-capabilities.md` 新增 §3.6（LLM 入口，逐条 `文件:行号`）与
  §3.7（异步生成器 vs 协程的形状陷阱）。
- `docs/PLAN-heartbeat.md` §8 的 Q3/Q5 结案，§10 补记两文件假宿主与元测试。

## v0.8.7 — 2026-09-26

> 心跳与主动消息。两半可以分别上线：只有 A 时 B 不发，只有 B 时 A 不报。
> 契约新增 **§17（连通性心跳）** 与 **§18（发件箱与主动消息）**。

### 新增

- **连通性心跳（A 半，纯在 IM 侧闭环）**：用**两条**判据维护每对话三态——
  ①`GET /health` 探测成功与否；②该对话最近一次收到**任何**下行帧的时刻。
  只做探测会漏掉「进程活着、这条流死了」（SSE 半开连接最常见的形态）；
  只看见帧会漏掉「一直没有任何帧的对话」。`online → suspect → offline` 带**滞回**
  （超过一个阈值判可疑、两个判掉线），`suspect` 就是防抖带、不给用户看。
  **从未见过帧的对话永不判离线**，新建档按在线——否则刚连上就会误报。
  刷新点只有一处（`_consume_turn` 入口、在心跳帧的过滤**之前**），所以新加帧类型
  不会漏刷新。阈值 `= max(1000, heartbeatMs) × heartbeat_frame_miss_factor`，
  其中 `heartbeatMs` 由 `/health` 回传（**两侧同源**，自写一个只会得到只有用户能发现的偏差）。
  跃迁时按 `heartbeat_notify` 播报：`off`（默认，只写日志）/ `fixed` / `offline-only`，
  另有 `heartbeat_notify_targets` 白名单与 `heartbeat_notify_min_gap_ms`（默认 600000，
  首次掉线不受限）。文案为固定文案（含原因与持续时长，**不含** Markdown 裸星号）。
- **自主心跳（B 半）**：DSH 侧按**八条闸门**（顺序即优先级：`disabled` / `no-session` /
  `offline` / `busy` / `pending` / `too-soon` / `outside-window` / `quota-exceeded`）
  决定是否发起一轮，由模型用**沉默哨兵** `[SILENT]`（整条等于才抑制，**不做子串匹配**）
  决定说不说。新增配置 `proactiveHeartbeatMs`（**默认 0 = 关闭**）、`proactiveMinIdleMs`
  （1800000）、`proactiveWindow`（空 = 不限，支持跨零点，边界闭区间）、`proactiveMaxPerDay`
  （4，0 = 不限）、`proactivePrompt`、`proactiveSilentSentinel`、`proactiveOutboxSize`（20）、
  `proactivePollMax`（50）、`proactiveImAliveMs`（180000）。
  三条硬约束：①`offline` 排在 `busy` **之前**（离线时既发不出去也没人听，先报更根本的原因）；
  ②**配额在「发起」时递增**，不在「入发件箱」时（这一轮无论说不说，LLM 的钱都花了）；
  ③用独立的 `proactiveLastAt`，**不碰** `records.lastActiveAt`（后者是空闲回收与跨日轮转的判据）。
- **有界发件箱 + `GET /proactive?since=<全局游标>` 轮询**（B 的出口）。
  `id` 全局自增，一次调用可跨对话取走；`since` **同时是 ack**，服务端据此 prune。
  IM 侧 `proactive_enabled=false` 只是**本地静音**：仍轮询、仍推进游标、只是不发送——
  否则恢复开关的一瞬间会把静音期间攒下的全部主动消息一次性补发，比不静音更糟。
  **游标持久化到插件 KV**：不持久化的话，重载后首轮以 `since=0` 取件（`since>0` 才 prune），
  发件箱里剩下的会被**重发一遍**。
- **`online` 闸门取「IM 最近在轮询」**，而不是在 DSH 侧同步 IM 的每对话在线态：
  IM 还在轮询就说明有人听得见；它没在轮询时发起心跳 = 白烧一次 LLM 调用且回复没人取。
  这条口径同时让两半**解耦**。
- 心跳轮的输出**不进正常下行通道**：`push()` 加了总闸门，`proactiveTurn` 非空时一律不发
  （审批与问答的推送显式带 `visibleDuringProactive: true` 放行）。否则 `[SILENT]`
  会以文本增量的形式先漏出去。

### 修复

- **`Main._health_task` 被定义在 `BridgeTransport.__init__`，而 `terminate()` 读的是 `Main`
  ——v0.8.6 发布版里就有的缺陷。** `enable=false` 时 `initialize()` 直接 `return`、
  从不创建该任务，于是卸载插件就是一次 `AttributeError`。本版新增的四个生命周期字段
  （`_hb_states` / `_hb_heartbeat_ms` / `_proactive_task` / `_proactive_cursor`）
  一开始也落在了同一个错地方，**任何一条消息都会崩**。
- **同一族的第二处：`proactive()` 方法被写进了 `Main`，而它内部调的是
  `BridgeTransport._request`。** 它是一段**永不生效的死代码**：`_poll_proactive()`
  走的是 `self._transport_or_create().proactive(...)`，因此测试全绿、运行时也不报错，
  只有真去调 `Main.proactive()` 才会 `AttributeError`。已移回 `BridgeTransport`
  （这才是「传输层十二方法」里第 11 个方法该在的地方——移之前那句文档是**假的**）。
- 这两处错位 `py_compile`、`bridgeVersion` 校验、静态复核**全都看不出来**——
  抓到它们的是新增的「假 AstrBot 上下文」集成测试（`scripts/test-im-heartbeat.py`）。
  其中第二条不是靠「多写一条断言」抓到的，而是那条**泛化**测试：从源码里抠出
  `Main` 类体中**所有** `self._xxx`，要求「刚 new 出来的实例上就都有」。
  纯逻辑单测永远测不到接线层，这是本版最该记住的一条。

### 变更

- **`bridgeVersion` 5 → 6**：新增 `/proactive` 路由与 `/health.heartbeatMs`。
  按「老客户端会不会坏」的口径两者都是纯增量，**不升版就会静默半死**——
  v5 的 IM 不会去调 `/proactive`，`online` 闸门于是永远不开，B 永远不触发，
  且没有任何报错。升版是为了把这种半死状态换成启动期的一条明确报错。
  **v5 与 v6 不能混合部署**，两侧必须同时升级。契约 §10 已写入依据。
- 路由 11 → **12** 条（`GET /proactive`）；事件类型仍为 12 个（心跳轮不新增事件类型）。
- 新增两道纯逻辑闸门与两道接线闸门，全部接进 `npm test`：
  `scripts/test-proactive.mjs`（19）、`scripts/test-heartbeat-state.py`（20）、
  `scripts/test-proactive-chain.mjs`（9，真起 `ctx.effect` 定时器跑 `proactiveTick`）、
  `scripts/test-im-heartbeat.py`（20，桩掉 `astrbot.*` 后真跑 `Main` 的方法）。
- 纯逻辑抽取沿用既有套路（零外部 import，因此**不装 dsh / AstrBot 依赖**即可单测）：
  `dsh-astrbot-relay/lib/proactive.js`、`astrbot_plugin_dsh_relay/heartbeat_state.py`。

### 文档

- 契约**补写 §16（用户问答通道）**：v0.8.6 的代码与 CHANGELOG 早已按「契约 §16」引用它，
  但那一章当时从未写下——是个**悬空引用**。本次补齐，并把 §7.3 里过时的
  「v1 不实现」改成指向 §16。同批补上 §4 事件表缺失的 `question/required` /
  `question/resolved` 两行（此前表里 10 行、常量表 12 个，对不上）。
- 契约新增 §17（连通性心跳）、§18（发件箱与主动消息），含 §18.8 的**未实测项**。
- `docs/PLAN-heartbeat.md` 记入**决策更新**：原推荐的「常连 SSE」在实现期被放弃，
  改用发件箱 + 轮询。两个硬伤：①`seq` 是**每对话**的，多对话复用后 `Last-Event-ID`
  无法表达「我收到哪儿了」；②SSE 是瞬时的，而主动消息天生需要**存储转发**
  （没人在听时丢了就是丢了）。§6.1 新增「实现期真的踩到的坑」。

### 未实测（诚实声明）

- **B 半的地基未验证**：`agent.followup(createUserMessage({source:{kind:'plugin',…}}))`
  是否真能起一轮 turn，本机没有活的 DSH 宿主可验（契约 §18.8）。若它不起作用，
  表现是「日志说发起了、但永远没有回复」，A 半不受影响。
- A 的**误报率**只在读码层面确认（长 turn 期间桥接端有两条 15 秒心跳在跑，
  且任何帧都刷新），未做真实代理环境的长跑验证。

## v0.8.6 — 2026-09-26

> 本版**合并了原计划的 v0.8.5**：那批改动（在途投递单 + 用户问答链）此前只进过 `main`，
> 既未定版也无产物，因此条目在这里一并给出。

### 新增

- **用户问答通道**（`ask_user_question`）：与审批**严格分离**的双通道。`bridge.questions`
  与 `bridge.approvals` 各存各的，`callId` 前缀不同（`im-q-` / `im-`）。新增下行事件
  `question/required` / `question/resolved`、新增端点 `POST /answer`（IM 代答）、新增配置
  `questionsEnabled`（默认 `true`）与 `questionTimeoutMs`（默认 `300000`）；IM 侧新增
  `/dsh answer <验证码>` 指令。契约 §16。
- **在途投递单（inflight ticket）**：把「一次已接受的投递」实体化，`queue` 的每一份额度
  都对应一张单子，由 `turn/end`（权威路径）或等待态超时（fail-closed 兜底）结算，
  `whenIdle` 退居兜底。新增配置 `waitTimeoutMs`（默认 `300000`；设 `0` 关闭超时兜底）。
- `/health` 新增 `pending[]`：把「在等一个可能不到来的答案」（`questions > 0` 且
  `stuckAt = 0`）与「闸门已放、但不保证 turn 真的闭合」（`stuckAt > 0`）分开列出。
  这两种状态在旧 `/health` 上长得一模一样，是当时最难判的一步。

### 修复

- **问答链在 `signal` 预中止时永久悬挂**（v0.8.5 引入）。`askQuestions` 里 abort 判定排在
  `bridge.questions.set(callId, …)` **之前**，而唯一结算出口 `finish` 的第一句是
  `if (!bridge.questions.has(callId)) return` —— 预中止时表里还没有这个 callId，
  于是 `finish` 直接早退，Promise 既不 resolve 也不 reject，turn 永久不闭合。
  **这比本版要修的队列死锁更糟**：那个至少能从 `409 agent_busy` 上看出症状，这个连痕迹都没有。
  修法：把「建表项 + 挂定时器」提到 signal 判定之前，并加 `announced` 标记，
  使从未对外宣告过的问答不再补发 `question/resolved` 孤儿帧。
  回归测试：`scripts/test-question-chain.mjs` 的「signal 已 abort → 立即 reject」。

### 变更

- **`bridgeVersion` 4 → 5**：`attaching` 的释放条件由「`whenIdle` 释放」改为「`turn/end`
  结算」，属**既有字段语义**变更，按契约 §10 必须递增。**v4 与 v5 不能混合部署**，
  两侧必须同时升级。
- 问答链的三个纯函数（`questionError` / `renderQuestion` / `normalizeAnswers`）抽到
  `lib/questions.js`：该模块零外部 import，于是能在**不安装 dsh 依赖**的前提下单测
  （与 `location.js` / `session-title.js` / `state.js` 同一套路）。行为零变化。
- 新增两道测试闸门并接进 `npm test`：`scripts/test-questions.mjs`、
  `scripts/test-question-chain.mjs`（后者用假宿主驱动 `apply()`，不需要真实 dsh 运行时）。

### 文档

- 契约 §14.1 注释更正 + 新增 §14.5：**`inheritedEventCount` 是继承前缀长度，不是副本的事件总数。**
  此前按「副本共 768 条 vs 报出 766，差 2」去对账，方向是错的：副本总数 = 继承数 + 子会话
  自有事件，而自有事件**至少**含宿主自动追加的一条 `session/end-seed` 标记
  （`@deepseek-ai/dsh-session/lib/types/index.js:468`），故差值 ≥ 1 属设计如此。
  要验的不变量是「**最后一条带 `inherited: true` 的标记，其 `seq` == `inheritedEventCount`**」——
  该式被 `dsh-session-persistence-jsonl/lib/worker.cjs:8795` 强制执行，违反会抛 `SessionFormatError`。
  纯文档改动，无行为面变化。

## v0.8.4 — 2026-09-22

### 修复

- **`/dsh rebind` 传进来会话 id 时，只回一句「桥接端没有这个工作区」，不告诉人该换哪条命令。**
  工作区 id 与会话 id 都是 UUID，肉眼分不出谁是谁；拿当下正在用的那条会话 id 去敲 `rebind`
  是必然会踩的坑，而 404 又恰好长成「你没敲错、只是敲了另一条命令」的形状——两个半区的
  命令名字又都是 `xxx <id>`，仅凭回显推不出下一步。现在加一层前缀判定
  `_looks_like_session_id`（`im-` / `session-`），命中时把话说到位：
  「…是会话 id，不是工作区 id。rebind 只收工作区、语义是新开一个会话；要切回这条既有会话
  请用：adopt im-…」；不命中时原文案一字不改。
  判定**只喂给提示语**，不参与任何写入决策——命中与否都还是那条 404，行为面零变化。
  实发 `/dsh rebind im-<会话 id>` 复验，回读文案符合预期。
- 提示语里漏网的 Markdown 裸星号（`语义是**新开**一个会话`）去掉：IM 端不做 Markdown 渲染，
  星号会原样露在用户眼前。全文件复查过一遍，`**` 只余注释与 docstring 里的，不再有面向用户的。

### 变更

- 统一版本：根 `package.json`、`dsh-astrbot-relay/package.json`、`astrbot_plugin_dsh_relay/metadata.yaml`
  三处 0.8.3 → 0.8.4。本版改动只在 AstrBot 侧（指令面文案），Node 侧代码未动。

## v0.8.3 — 2026-09-22

### 修复

- **DSH 侧 `POST /session/rebind` 对该桥接下的**所有**工作区恒返回 409 `agent_busy`**。
  报错文案是「工作区目录当前不可用（`[object Promise]`）」，括号里那截序列化残影就是元凶：
  `lib/index.js:1446` 写的是 `typeof workspace.status === 'function' ? workspace.status() : 'ok'`，
  而官方 `WorkspaceEntity.status()` 是 **async**（`@deepseek-ai/dsh-workspace/lib/types/entity.d.ts:73`
  签名 `status(): Promise<'ok' | 'missing-dir'>`，实现见 `lib/types/entity.js:114-123`）。漏掉 `await`
  拿到的是 Promise，它永不等于字符串 `'ok'`，于是 `:1447` 的 `status !== 'ok'` **恒真**，
  目录校验分支对小到「目录明明存在」的一切工作区都成立——`details.status` 序列化成 `{}` 也是同一个 Promise。
  这不是官方接口变更，是调用方漏 `await`。修复即补上 `await`（同文件再无第二处 `status()` / `stat()` 调用，
  `registry.get()` / `registry.list()` 经核对确为同步），并在该行留下「别把 await 删掉」的注释。
  影响面仅此一处：同一判定不复用于 `/health`、`/workspaces`、`/message`、SSE 回读。

### 文档


- 契约 / 设计 / 路线图 / 控制面 / 连接器面共六处「`session/page` 的 `throughSeq` 未实测」
  改写为**已实测结论**，并附宿主源码行号：它是 log 的闭区间上界；`-1` 合法（空窗口）、
  `-0` 被拒（`index.js:1565-1569`）；越界抛 `gateway/bad-request` "past cursor"
  （`:1378-1379`），`throughSeq >= 0` 时要求 `sourceLog[throughSeq].seq` 严格相等，否则
  `gateway/internal`（`:1381`）；`maxMessages` 缺省 50（`:1328`）；`hasMore = cut > 0`
  （`:1602-1624`）；返回体 `{records, hasMore}`。
- ROADMAP §3 两条状态同步为已收敛，「本切片未做」中的 `throughSeq` 实测移出待办。
- 这批文档改动本身是纯文档改动、无代码变更（当时真跑打包产物与 `v0.8.2` 发布资产尺寸一致，
  57722 / 60544 / 195 B），所以没有为它单独打 tag：它随本版一起发布。

## v0.8.2 — 2026-09-21

### 修复

- **DSH 侧子 fiber 的服务清单漏了 `sessionQuery`**：文件顶层的 `inject` 一直列着它，
  子 `ctx.inject([...])` 里却没有。运行期靠 `ctx.get` 沿父链回溯到本插件 fiber 才没出事，
  但这是「加载期正常、请求期才炸」的时序漂移。两处清单现已对齐，并在代码里写清理由：
  子 fiber 解析不到的服务正是靠顶层 `inject` 沿父链回溯。

### 变更

- 发布说明的契约版本改为从 `dsh-astrbot-relay/lib/contract.js` 读取，不再手写常量；
  正文补上 `/session/adopt` 与十个端点清单。
- 本版把 `v0.8.1` tag 之后落在 `main` 上的提交一并纳入发布产物。`v0.8.1` 的 tag 指向
  `4546f8d`，比当时的 `main` 落后一个提交——**已发布的 tag 不移动**，改号重发。

## v0.8.1 — 2026-09-21

### 变更

- **白名单并成一个洞：删除 `allow_users`**。v0.7.0 追加的「成员白名单」与 `allow_from`
  是同一件事——后者自 v0.7.2 起已按 entry 形状分派语义（纯数字按发送者、
  `group:` 按会话、完整 UMO 逐字），两项之间的 AND 在正常路径下永远冗余，
  只多出一个能填错、能互相打架的配置面。现在只留 `allow_from`。
- `_conf_schema.json` 删该项，`allow_from` 的 hint 改写为
  「纯数字 / group:群 / group:群@人 / 完整 UMO」，示例号码用假号。
- `main.py` 删 `_user_allowed` 及调用点，白名单只剩 `_session_allowed` 一道；
  `allowlist.py` 删 `ids_match()`，模块顶部注释同步改口径。

### 测试

- `scripts/test-allowlist.py`：25 项通过、0 失败；新增两道守卫断言，读
  `_conf_schema.json` 与 `main.py` 源码，防止 `allow_users` / `_user_allowed` 长回来。
- 原先「`?` 只吃一个字符」一项硬编码了真实号码位数，改为按 `ME` 变量推导。

### 兼容性

- `allow_users` 默认空 = 不限制人，未配置该项的部署行为完全不变。
- 配置过该项的部署：把条件并进 `allow_from`，纯数字 entry 即等价写法。
- 仓库内残留的真实 QQ 号已全部替换为编造号（文档与测试同批处理）。

## v0.8.0 — 2026-09-21

### 新增

- **`POST /session/adopt` 会话认领（契约 §15 整章）**：把某 IM 对话改指到一个**已存在**的
  会话 id。v3 的 `/session/fork` 只做了前半句——子会话建好、落档，随即 `dispose()`
  （§14.2 第 3 条），本对话的映射**仍旧指着源会话**；而 v3 的路由表里恰好没有「换映射」
  这一项：`/message` 的建会话分支被 `hadMapping` 锁死（有映射就只 `resume` 旧 id），
  `/session/rebind` 的入参是**工作区**、语义是 `create`（只会再造一个新会话）。
  v4 把 fork 从「只建不接管」补成整句。

- **`/dsh adopt <会话 id> [工作区 id]`**：AstrBot 侧 `BridgeTransport.adopt()`
  （`main.py` 446 行）、`_handle_adopt_command`（1340 行）与指令面同步落地；不给工作区
  就只换映射。`/dsh fork` 的输出末尾会直接给出可照抄的下一句，分支之后不必人工去翻
  `/dsh where`。

- **契约 §15.6 的幂等**：本对话本来就指着该会话时，返回 `200` + `adopted: false`，
  **什么都不做**（不拆 agent、不重写映射、不刷持久化），也不报错——IM 侧按「不用认领」
  回话。这是 v4 唯一一处幂等。

### 文档

- 契约文件补 §15 整章（动机、为什么不是 rebind、只做三件事、工作区为何校验包含关系、
  IM 侧指令、幂等与状态一致性），并把 §10 的版本协商补到 v3 → v4。
- adapter 契约为两侧常量表的**逐字副本**：`lib/contract.js` 与 `contract.py` 同步
  `BRIDGE_VERSION = "4"` / `ROUTE_ADOPT` / `COMMAND_ADOPT`，`check-contract-parity` 覆盖。
- `README.md`、`docs/RELEASING.md`、插件 `README.md`、`dsh-astrbot-relay/README.md`
  的端点面与指令面口径一并回填到**十个端点 / 九条指令**，并纠正长期存在的笔误
  `list_workspaces`（真实方法名是 `workspaces`）。

### 测试

- 端到端复验：`/dsh adopt im-f4655bb1-…` 在真实宿主上认领成功，`cwd` 取自目标会话
  存档头；重复调同一句命中幂等，回 `adopted: false`。
- 闸门全绿：`check-contract-parity` 输出 `BRIDGE_VERSION=4`、10 事件类型、7 错误码、
  10 路由；`check:py` 编译通过；`npm test` 全绿；`check:version` 0.8.0。

### 兼容性

- **`BRIDGE_VERSION` 由 `"3"` 升到 `"4"`。** §10 已写明这是「最像本该不升」的一次：
  新增路由对 v3 客户端同样是增量（它不会去调），按「老客户端会不会坏」的口径本可不升；
  仍然升的理由指向**能力语义**——v3 里「子会话可被接管」这句话在路由表上没有对应项，
  客户端若仍按 v3 理解，fork 之后就没有下一步可走。代价照旧：**v3 与 v4 不能混合部署**，
  升级与回滚都须两侧同时发布，不存在灰度窗口。
- 错误面**没有新增错误码**，用的全是既有那几个：字段缺失/类型不对 → 400 `unsupported`；
  目标会话不存在 → 404 `not_found`；`workspaceId` 未知 → 404 `not_found`；工作区存在但
  不含该会话、以及有投递或附着在途 → 409 `agent_busy`。会话不存在的判定**先于**工作区
  那两条（先答「你指的会话不存在」比先答「现在还不成」有用）。
- `cwd` 一律取自目标会话**存档头**，**不接受**请求参数指定；`workspaceId` 给了就必须
  真的包含该会话（`workspace.sessionIds.includes`），否则 409——「认领到某工作区」不许
  写成一句假话。
- 继承 v0.7.3 的 fork 空体修复（`inject` 六服务）；版本三处同步 **0.8.0**：根
  `package.json`、`dsh-astrbot-relay/package.json`、`astrbot_plugin_dsh_relay/metadata.yaml`。

## v0.7.3 — 2026-09-21

### 修复

- **`/session/fork` 返回 400 空体（真实故障修复）**：host 侧的服务集合是 **Proxy**，
  未在 `inject` 中声明的服务一旦被取值就**直接抛错**。`host.get('sessionQuery')`
  因此同时炸掉三处调用点：`/message`（约 1091/1093 行）与 `/session/rebind`
  （约 1493/1495 行）的读取位于 `try` 内，异常被**静默吞掉**，表现为「悄悄回退默认
  预设、日志里一个字都没有」；`/session/fork`（约 1659/1668 行）的读取位于 `try`
  之外，才把异常吐成 **400 空体**。三处表象不同，根因是同一个。

- 修复：`inject` 声明由**五服务改为六服务**，追加 `sessionQuery`。diff 只有这一行。

### 测试

- 端到端复验：宿主 `/health` 200，`/session/fork` 由 400 空体变为 **200**；
  存档头 `agentPreset` 在三处受益点都能真正读到。
- 闸门全绿：`node --check lib/index.js` 退出码 0；`check-contract-parity` 输出
  `BRIDGE_VERSION=3`、10 事件类型、7 错误码、9 路由；`npm test` 全绿
  （`test:allowlist` 26 项、`test:session-title` 15 项，0 失败）；`check:version` 0.7.3。

### 兼容性

- 端点面、`BRIDGE_VERSION`（仍为 `"3"`）、指令面、配置键均**无变化**。
- 版本三处同步 **0.7.3**：根 `package.json`、`dsh-astrbot-relay/package.json`、
  `astrbot_plugin_dsh_relay/metadata.yaml`。
- 发版卫生：工作区此前有 13 个文件呈 `w/crlf`（`lib/index.js` 自身是 LF），
  已按 `eol=lf` 用 `git checkout-index -a -f` 重写工作区，避免本地 dist 哈希与
  CI 产物对不上。

## v0.7.2 — 2026-09-20

### 修复

- **`allow_from` 填纯 QQ 号不再失配（真实故障修复）**：v0.7.1 的 `allow_from` 只做
  完整 UMO 逐字比较，照直觉填 `1234567890` 时与真实 UMO
  `绫地宁宁:FriendMessage:1234567890` 不相等 → 事件被**静默放行**给默认 LLM，
  表现是「`/dsh 测试` 没反应、日志里一个字都没有」。文档没写错，是**填法不匹配**；
  但让用户为加白名单去反查平台 id、消息类型名、session_id 再拼串本来就是设计缺陷，
  本版判据改为「**填什么都要能对上**」。

### 新增

- **`astrbot_plugin_dsh_relay/allowlist.py`**：零依赖纯函数白名单模块，`main.py` 与
  `scripts/test-allowlist.py` 共用同一份口径（`tokens_of` / `entry_matches` /
  `any_match` / `ids_match`）。语法（关键字前缀不区分大小写，值本身区分大小写，
  `*` 匹配任意长度、`?` 匹配单字符，均可出现在任何字段）：
  - `*` —— 全部放行；
  - **纯数字** —— 按**发送者**匹配（私聊群聊都算，v0.7.1 那条填法由此生效）；
  - `user:` / `qq:` / `u:` —— 同上，显式写法；
  - `group:` / `grp:` / `g:` —— 该群任何成员，支持 `group:<群号>@<qq>` 限定到人；
  - `umo:` —— 显式按完整 UMO；
  - 其余含 `:` 的值 —— 按完整 UMO 逐字匹配（**v0.7.1 老配置原样兼容**）；
  - 空白 entry 不命中；**空列表 = 全部允许**（沿用旧语义）。

### 修复（两处判据漏洞，先立测试才暴露）

- 群号取不到时 `group:*` **不再放行**：私聊不该被群规则收进来——宁拒绝，不宽放。
- 平台 id 恰好叫 `user` / `qq` / `u` 时，v0.7.1 老配置 `user:FriendMessage:1`
  会被误读成「发送者 `FriendMessage:1`」，补一道 UMO 回落。

### 测试

- 新增 `scripts/test-allowlist.py`（**26 项断言**）并接进 `npm test`
  （`test:allowlist`）。测试内写死现场复刻常量（平台 id `绫地宁宁`、私聊 UMO、
  QQ `1234567890`），故意不做美化，免得测不到真实形状。
- `check:py` 收录 `allowlist.py`；`npm test` 全绿：check:syntax → check:py →
  check:contract → test:location → test:location-text → test:allowlist 26 项 →
  test:session-title 15 项 → check:version 0.7.2。

### 兼容性

- 端点面、`BRIDGE_VERSION`（仍为 `"3"`）、指令面、配置键均**无变化**；
  `allow_users` 一并获得宽松填法（走 `ids_match`）。
- 版本三处同步 **0.7.2**：根 `package.json`、`dsh-astrbot-relay/package.json`、
  `astrbot_plugin_dsh_relay/metadata.yaml`。
- 被挡下时仍只记一行 `info`（只记 UMO/ID，不记消息内容），位置仍在**分发之前**，
  `help` / `where` / `approve|reject` 一个分支都不漏。

## v0.7.1 — 2026-09-20

### 新增

- **DSH 会话标题真正写进会话**：`sessionTitleTemplate` 渲染出的标题此前只出现在
  `/where`、`/conversations` 的**响应字段**里，DSH Web 的会话列表看不出「哪条来自哪个群」。
  现在由新增的 `lib/session-title.js` 就地写入（宿主 `session-title` 服务，
  `host.get` 取不到时回落 `ctx.get`）：`/message` 的建会话与复用分支、
  `/session/rebind` 改指之后，都在 `followup` **之前**写。
  - **写入即钉住**：写过的标题 supersede 宿主的自动生成标题与 LLM 自动起标题，
    此后只有显式 refresh 才解开——反向定位是硬需求，被自动改名等于把功能做没。
  - **`/fork` 的子会话不写**：fork 请求体没有 `conversation` 可反查，
    子会话此刻不属于任何对话，硬写只会落一条「看起来有来源」的无归属标题。
  - **写入失败绝不打断消息链路**：该模块只记日志、不抛错；服务缺席静默跳过，
    其余失败 `warn` 带 `reason` 与 `conversation`。
  - **长度口径**：按 UTF-8 截到 **80 字节**、按字符边界退让。默认模板前缀
    `星驿 · default/GroupMessage/` 占 **31 字节**（`·` = U+00B7，**2** 字节），
    留给平台/类型/会话 id 的只有 49 字节；中文每字 3 字节。

### 测试

- 新增 `scripts/test-session-title.mjs`（15 项断言）并接入 `npm test`
  （`test:session-title`）：覆盖正常写入、落盘结果优先、未知占位符原样保留、
  `{conversation}` 含冒号不切坏、超长照交不截、会话/服务缺席、
  `InvalidError` → `invalid-title`、not live 与抛非 `Error` → `rename-failed`、
  空参、字节长度与 80 上限。
- 该模块零依赖，**不装 dsh 依赖即可跑**。

### 兼容性

- 端点面、`BRIDGE_VERSION`（仍为 `"3"`）、指令面、配置键均**无变化**，
  新行为不影响既有会话映射；被钉住的标题属于新增副作用，可用显式 refresh 解除。

## v0.7.0 — 2026-09-20

### 新增

- **成员白名单 `allow_users`**：`allow_from` 判的是「哪个会话」，这一项判的是「哪个人」。
  两者同时填写时为 **AND**——既要在允许的会话里，也要是名单上的人。比对的是发送者
  `user_id`（QQ 号），私聊与群聊一律**按人**判；取不到发送者 ID 的消息按**拒绝**处理
  （白名单非空即用户已点名，此时「匿名」不该放行）。判定位置与 `allow_from`、
  `reply_in_private_only` 相同——**在分发之前**，`help` / `where` / `approve|reject`
  一个分支都不漏；被挡下时只记一行 `info` 日志，**只记 ID、不记消息内容**。
- **`health_interval_ms` 周期健康检查**：按间隔调 `transport.health()`，失败只把桥接标记为
  未就绪并写下原因，**下一条用户消息立刻带原因**（不是干等超时），恢复后自动转回就绪；
  `health_interval_ms=0` 即不建任务。`terminate` 里显式 cancel 并 `await asyncio.wait({task})`，
  不让常驻任务挂住插件卸载。
- **`reply_render_mode="card"`**：复用 AstrBot 基类现成的 `Star.text_to_image` 出图
  （沿用当前 t2i 模板与端点，**不自建渲染、不引入新依赖**）。**任一分片渲染失败或返回空
  URL，就丢弃全部已生成的图片、整条降级纯文本**并告警——t2i 是外部服务，半图半文比纯文本更糟。

### 变更

- 版本口径对齐：根 `package.json`、`dsh-astrbot-relay/package.json`、
  `astrbot_plugin_dsh_relay/metadata.yaml` 三处由 `0.6.2` 一并升到 `0.7.0`
  （发布脚本 `check:version` 三处一致才放行；文档此前已按 R1 落地口径更新，版本号却还停在
  上一版，本版把这个漂移修掉）。
- `docs/astrbot-side-capabilities.md` 新增 §3.6：`is_admin()` 判的是 **AstrBot 管理员**，
  aiocqhttp **不写** `event.role`，群管理员因此**不等于** AstrBot 管理员；要做群管级判定
  必须自读 `event.message_obj.group.group_admins`；`PermissionTypeFilter` 权限不足时
  是**静默不触发**（`stop_event()` 那行被注释掉了），自带权限门须自行补提示。
- `docs/DESIGN.md` 的配置清单与策略表补上成员白名单这一行（原表述只写了
  `group_id`/`user_id` 列表，实现里当时只有会话级 UMO）。

### 兼容性

- **端点面、`BRIDGE_VERSION`（仍为 `"3"`）、指令面均无变化**，v0.6.2 的用户换包即可升级，
  配置无需改动（新配置项 `allow_users` 默认空 = 不限制人，行为与升级前一致）。

## v0.6.2 — 2026-09-20

### 新增

- **契约预留的三项配置全部接线**，DSH 侧 `assertConfigIsUsable` 相应地从「加载即抛错」
  降级为**参数校验**（`policy` 必须落在 `one-to-one` / `on-demand` / `daily` 枚举内，
  `idleTtlMs` 必须是有限正数），仍然不静默降级：
  - `policy: on-demand` —— **空闲回收**。超过 `idleTtlMs` 无活动的会话被回收：先按
    `cancel → whenIdle → flush → dispose` 收尾桥接，再 `workspaceRegistry.archiveSession`
    归档，最后删映射并落盘；扫描间隔取 `max(1000, min(60000, idleTtlMs))`，定时器 `unref()`
    以免拦住进程退出，正在 attaching / 队列非空的会话视为在途跳过。
  - `policy: daily` —— **跨日轮转**。处理消息前比对本宿主**本地日期**（`createdAt` 与当前），
    跨日则归档旧会话再新建，判据用 `createdAt` 而不是 `lastActiveAt`（会话属于它被造出来的那天）。
  - `idleTtlMs` —— 空闲阈值（毫秒），仅 `on-demand` 使用。
  - `hmacMode` —— AstrBot 侧补齐**发送端**签名与 `hmac_mode` / `signature_skew_ms` 配置项
    （契约 §5.2：`ts + "." + rawBody` 的字节，一次编码、签名与发送共用同一份），
    DSH 侧的原文只读一次校验此前已在。
- **三条路径都只归档不删历史**：回收与轮转走 `workspaceRegistry.archiveSession`，
  归档失败（含工作区未知）只记 warn，不影响消息链路。

### 变更

- 文档口径同步：`docs/BRIDGE-CONTRACT.md` §2.3 的「插件内能力【未核实】」改为已接线，
  `docs/DESIGN.md`、`docs/RELEASING.md`、两份 README 与发版脚本里的
  「三项未实现 / 加载即失败」全部改为已实现。

## v0.6.1 — 2026-09-20

### 修复

- **产物与文档口径对齐**：v0.6.0 的 tag 与 Release 资产停在 `899df17`，三份 README 与
  `docs/RELEASING.md` 的「八端点 → 九端点」口径修正（`59fec85`）没进那一版产物，导致
  发出去的包与文档描述不完全同步。本版把该提交一并打进产物，重打 tgz / zip / SHA256SUMS，
  使 README 口径、Release 正文与校验和逐字节自洽。
- **端点面、指令面与 `BRIDGE_VERSION`（仍为 `"3"`）均无变化**：本版只是文档口径与产物的
  重新对齐，v0.6.0 的用户可以直接换包安装，不需要改配置。

## v0.6.0 — 2026-09-20

### 新增

- **一条 DSH 端点**：`POST /session/fork` —— 把某个对话**已完成的轮次前缀**复制成一个新会话，
  源会话全程**只读**。请求 `{ sessionId, atSeq? }`，`atSeq` 的取法照抄宿主
  `sessionController.fork`：给 `atSeq` 就取第一个 `seq >= atSeq` 的轮次结束边界，不给或超出
  最后一条就取最后一整轮，那一轮**尚未结束**则视为无边界、回 **409 `agent_busy`**。
  端点面因此由八条变九条，`BRIDGE_VERSION` 由 `"2"` 升到 `"3"`（**两侧必须配对**：v2 与 v3
  不能混合部署，AstrBot 侧启动校验不匹配即拒绝启用）。
- **一条 IM 指令**：`dsh fork [轮次序号]`；`BridgeTransport` 相应增加 `fork` 方法（共九方法）。
  指令面因此由七条变八条。服务端返回的 `message` 已含「分支失败：」这类前缀，IM 侧不再拼一次。
- **子会话有意与宿主官方路径有三处差异**，都在契约 §14.2 记着：① 无 `agentPresets` 装配时
  手搓 `setup`；② 工作区归属只认**直接包含**，不回溯祖先；③ 子会话不进 records、不建 bridge，
  `create` 一返回即 `dispose()`（dispose 只放租约，**不删持久化档**，新会话仍可被接管）。

### 修复

- **失败文案统一走 `_prefixed_failure`**：投递兜底异常、审批回执两处、`_delivery_failure_text`
  末行全部收口，不再出现「桥接调用失败：桥接调用失败：…」这种同一次失败看起来发生了两遍的提示。

### 文档

- 契约新增 §14（端点、错误表、与官方的三处有意差异、幂等与保活），§8 错误码表补上
  「分支时没有可切轮次、子会话挂载失败」，§10 版本协商补 v2 → v3 例外段。
- 三份 README 的口径统一为「九端点 / 九方法 / 八条指令（v0.6.0 口径）」；插件 README 里
  「对话中分叉仍未开」的历史说法随之删去。

## v0.5.0 — 2026-09-20

### 新增

- **两条 DSH 端点**，两侧契约 `BRIDGE_VERSION` 由 `"1"` 升到 `"2"`
  （**两侧必须配对**：v0.4.x 的 `"1"` 与本版不互通，AstrBot 侧启动时校验
  `GET /health` 的 `bridgeVersion`，不匹配即**拒绝启用**）：
  - `GET /workspaces?limit=N` —— 只读列出宿主 `workspaceRegistry.list()` 里登记的工作区
    （`id` / `path` / `title` / `sessionIds`）。该注册表**没有 RPC 端点**，只有进程内可取，
    故由这一个只读端点透出；装配被裁掉注册表时走 **500**，不静默返回空清单
    （「没有工作区」与「问不到工作区」对 IM 侧是两件事）。
  - `POST /session/rebind` —— 把某个对话**改指**到指定工作区：在目标目录新建会话并换掉映射，
    旧会话保留（它的目录没变，摘掉才是说谎）。走的是宿主自己的 `workspaceId` 建会话路径，
    即「既有语义的薄封装」，不做「就地改 cwd」——会话头里的 cwd 创建时定死。
- **两条 IM 指令**：`dsh workspaces`、`dsh rebind <工作区 id>`；`BridgeTransport` 相应增加
  `workspaces` / `rebind` 两个方法（共八方法）。指令面因此由五条变七条。
- 列表响应统一为 `{count, returned, limit, items}`：`count` 是总数、`returned` 是本次返回条数；
  `limit` 默认 50、上限 200。`conversations` 与 `workspaces` 同口径。

### 修复

- **错误映射收口，不再把正常失败路径报成 500**：目标目录不可用 → `409 agent_busy`；
  `attachSession` 抛错 → 同样 `409`。这两处收口到 409、**不回 400**（IM 侧把 400 一律判成
  调用方问题、不可重试），也**不新增 503**（会牵动 `ERROR_STATUS`、两侧常量、契约与 parity
  白名单）。
- **孤儿会话如实回报**：`create` 成功而 `attachSession` 失败时新会话**已经落盘**，响应里带上
  `sessionId` / `cwd` / `orphaned: true` / `released`，不假装什么都没发生。
- **改指后的收尾顺序**：`create` + `attach` 全部成功后才摘旧引用，再
  `cancel → whenIdle → flush → dispose`（`flush` 必须在 `dispose` 前，否则最后一段输出丢掉）。
- **失败文案去重**：`_prefixed_failure` 不再无脑拼前缀，避免「改指失败：改指失败：…」这种
  同一次失败看起来发生了两遍的提示；错误码仍留在末尾。

### 文档

- 契约新增 §13（两条端点、判定表、details 字段）与 §13.2 的收口说明；`docs/RELEASING.md`
  端点清单同步为八条。
- 三份 README 与 `docs/DESIGN.md` 的「六端点 / 六方法 / 五条指令」口径统一为
  「八端点 / 八方法 / 七条指令（v0.5.0 口径）」。
- `docs/connector-surface.md` §2.5 的「指令面刻意只有五条」属 v0.4.0 迁移基线的历史结论，
  保持原样，本版口径见插件 README。

## v0.4.1 — 2026-09-20

### 修复

- **zip 改由脚本自写归档器生成**。原先打包走的是外部归档器，其 `crc32` 实现
  有一处查表撞上 `const` 暂时性死区的问题，`npm test` 全绿而真打包在 zip 阶段崩掉。
  现在归档器内建在 `scripts/package-release.mjs`：256 项 `Int32Array` 查表、
  条目按路径排序、DOS 时间戳钉死 1980-01-01、权限统一 0644/0755、
  文件名标记 UTF-8、deflate level 9。**本版无功能与契约改动**，
  `BRIDGE_VERSION="1"`、五条指令、六个端点一律不变。

### 变更

- CI 的打包冒烟改为**跨 Node 版本对照**：Node 22 真打一遍存下 `SHA256SUMS`，
  切到 Node 24 再打一遍，两轮校验和必须逐字节相同，再 `sha256sum -c` 核对。
  这条闸门守的是 `docs/RELEASING.md` §4 那句承诺——本地 `dist` 的哈希与
  Release 资产完全相同；承诺一旦被破坏（换 Node 大版本、动归档器、改 `files`），
  CI 会当场失败。
- **本版资产与 `v0.4.0` 的 zip 字节不同**（43590 B 对 43343 B），
  tgz 与 `SHA256SUMS` 不变。原因是脚本换了归档器，不是包坏了；
  已发布的老版资产属历史产物，不再追改。

## v0.4.0 — 2026-09-20

### 变更

- **本版是口径收口版，不含功能改动**。范围最终收敛为一条总口径：**不重造 DSH 的既有语义**。
  能力面与 v0.3.5 完全一致——AstrBot 侧五条指令（`<内容>` / `help` / `where` /
  `approve` / `reject`），DSH 侧六个端点，两侧契约 `BRIDGE_VERSION="1"` 不变，
  没有新增命令、没有改动配置项、没有触碰传输层。
- 由此明确**不做**的三件事：不在插件侧自造"更换工作区"（宿主是
  `sessionController.create` 自带的 `workspaceId` 参数）、不重造"对话中分叉"
  （宿主是 `sessionController.fork({ sessionId, atSeq })`）、不发明工作区清单端点
  （`workspaceRegistry.list()` 进程内可取，RPC 面无此端点）。将来真要用，
  桥接端在 `inject` 里加 `sessionController` / `workspaceController` 直调即可，
  RPC 面返回 404 不等于能力不存在。

### 文档

- `docs/connector-surface.md` §2.5 加 **迁移裁决**：那份「HELP_TEXT 与实现的偏差」
  只对被替代的 `astrbot_plugin_dsh_connector` v2.0.1 成立，属旧插件自己的自文档债；
  relay 侧的指令清单只有 `contract.COMMAND_HELP` + `main._usage_text()` 一个生产来源，
  裸前缀与 `/dsh help` 读同一份文案，**结构上不会长出同类漂移**，故该条不构成迁移工作，
  只作历史留档。小节末写明复发条件：将来若把 `session` / `workspaces` / `settings`
  面搬过来，必须沿用同一清单常量，否则漂移会以另一种形式回来。
- 根 `README.md`、`astrbot_plugin_dsh_relay/README.md`：在指令速查表后写明指令面
  **刻意只有五条**，并列出上面那三条"宿主已有语义、插件不重造"的对应关系；
  两条发布安装路径的产物名同步为 `0.4.0`。

## v0.3.5 — 2026-09-19

### 修复

- AstrBot 侧：**裸 `/dsh` 不再静默无响应**。根因是配置里 `trigger_prefix` 实读为
  `/dsh `（含尾空格，长度 5），而用户只敲前缀时消息是 `/dsh`（长度 4），
  `raw.startswith(prefix)` 直接判不匹配后 `return`——恰好在最需要用法提示的时刻
  什么都不回。改为先 `strip()` 取基名再比，并加约束：基名之后必须紧跟空白或行尾，
  避免把 `/dshx ...` 这类别的插件的命令吞掉。

### 新增

- AstrBot 侧：`/dsh help`。与裸前缀**共用同一份清单**（`contract.COMMAND_HELP`
  + `main._usage_text`），两条入口一份文案，不给"文档里有、敲下去没反应"留分叉。
  清单里写明各子命令是否投给 agent，以及 `approve` / `reject` 属于前缀分发里的
  独立分支。

### 文档

- `astrbot_plugin_dsh_relay/README.md` 新增「指令用法」小节：五条指令各自的作用、
  前缀匹配规则、`approve` / `reject` 不被投递、白名单与私聊过滤先于分发、
  `/dsh where` 本地信息永远打印的取舍。
- 根 `README.md` 新增「指令速查（AstrBot 侧）」表并指向上面那节，
  `dsh-astrbot-relay/README.md` 新增「用户看到的指令在 AstrBot 侧」——
  明确 DSH 侧不注册聊天指令，要改指令面得改 AstrBot 侧。

## v0.3.4 — 2026-09-19

### 文档（仅文档，代码无变更）

- 修正流式事件的双协议口径：`agent/assistant-stream` 只在 `0.1.2-rc.1` 上全树 0 命中，
  `0.1.5-rc.2` 起宿主改发该事件。根 `README.md`、`dsh-astrbot-relay/README.md`、
  `docs/DESIGN.md` 里残留的「不存在 / 已证伪」无条件表述改为带版本范围的表述，
  并写明插件双协议并存、同形 chunk 收敛到同一出口（与契约 §4.2、v0.3.2 的修复对齐）。
- 两个子目录 README 的安装章节改为**发布产物**安装路径：DSH 侧取
  `dsh-astrbot-relay-<v>.tgz` 走 `dsh plugin add`（并说明从 git 安装要付构建授权的代价）、
  AstrBot 侧解压 `astrbot_plugin_dsh_relay-<v>.zip` 进 `data/plugins/`；
  此前写的是「在本目录的上一级执行」与写死本机路径的 `Copy-Item`。

## v0.3.3 — 2026-09-19

### 修复

- AstrBot 侧：超长代码围栏（含整条无换行的超长单行）改用逐行重排切分，每一片都自带闭合与重开围栏，收尾/重开标记先从上限里扣掉额度并独占一行；此前这类单元只会被硬切，导致一片渲染成没有收尾的代码块、另一片渲染成孤立反引号。
- AstrBot 侧：`_split_fence_unit` 文档化切分代价——切点落在代码行中间时会补一个换行让收尾标记独占一行，代码文本可能多出一个换行，属渲染必需代价，逻辑无其他变更。

### 变更

- 切分探针 `split_probe.py`：无损校验由按行逐字比对改为 `"".join(text.split())` 空白归一比对，并打印行内补换行数；此前按行比对会把「重排补出的换行」系统性误判为内容错位。

按版本记录面向使用者的变更。每个版本的发布说明与校验和由 Release workflow 生成，见 [GitHub Releases](https://github.com/NekoHome-Studio/astrdsh-relay/releases)。

## v0.3.2 — 2026-09-19

### 修复

- AstrBot 侧：流式回帖只按字符数硬切导致半句被劈开，改为优先落在句末标点/换行、不切进未闭合代码围栏，攒到上限才硬切兜底；回退候选上限 16 个边界。
- AstrBot 侧：中间分片走 `event.send` 不经 AstrBot 切分，故单条上限由插件自守：硬切阈值与候选切点都收敛到 `min(flush_hard_chars, chunk_size)`（`chunk_size=0` 表示不切分，此时不设上限）。
- relay：兼容 dsh ≥0.1.5-rc.2 的 `agent/assistant-stream` 事件，与旧 `session/event` 共用同一出口，不会双重投递。
- relay：按 `attemptId` 在 `start` 帧记下 `turn`/`step`，供后续 `chunk` 帧复用（新协议下 `chunk` 帧不携带这两个字段）。
- relay：`observeSession()` 的 `SessionObservation` 是租约，读完 header 后在 `finally` 释放，避免 pin 住 prepared 缓存条目。

### 变更

- 补记 `12fa753` 的实际范围：该提交除流式兼容外，还引入了 `agentPresets` 解析与预设挂载、`setup` 改 async、`meta.agentPreset` 写入（行为变更高于流式兼容，此前未写入提交信息）。
- relay 依赖版本对齐宿主：三个 `@deepseek-ai/dsh-*` 由精确 `0.1.2-rc.1` 改为 `^0.1.5-rc.2`，并补声明代码实际使用的 `dsh-agent-presets`、`dsh-session-query`。
- relay 依赖分类对齐官方：`dsh-agent`、`dsh-llm` 与可选能力 `dsh-agent-presets`、`dsh-session-query` 由 `dependencies` 移入 `peerDependencies`（后两者标 `peerDependenciesMeta.optional`），`dependencies` 只留 `dsh-brand`、`schemastery`——宿主能力不再被写成插件自带依赖，普通 npm 安装路径上也不会下载一份分叉副本。
- relay 依赖分类补漏：代码实际注入的 `agentDefaultModel` 对应补声明 `dsh-agent-default-model` 为 peer（与官方 `dsh-headless`、`dsh-api-session-controller` 一致）。
- 文档：`DESIGN.md` 与 `BRIDGE-CONTRACT.md` 同步事件来源随宿主版本分叉（§4.2）、切分点语义与 `flush_hard_chars` 上限。

## v0.3.1 — 2026-09-19

### 修复

- relay：修复同一 conversation 连投第二次起返回 HTTP 500（会话句柄未按 conversation 正确复用）。

### 变更

- AstrBot 侧插件补齐 metadata 的作者与仓库地址，两侧随包附 AGPL-3.0 LICENSE。

## v0.3.0 — 2026-09-19

### 新增

- 六个端点由骨架补齐为可运行实现，文档与发布说明如实列出三项未实现。
- P2 回程全链路：SSE 下行、agent 事件转发、审批。
- AstrBot 侧插件补齐星驿九处未实现。
- 双向定位：查工作区/会话，并在会话标题标注来源。

### 修复

- 修复 `handleMessage` 内未定义的裸变量（改用 `bridge.agent`）。
- 卸载期排空并 dispose 会话句柄。

### 变更

- 许可证由 MIT 换为 AGPL-3.0。

## v0.2.0 — 2026-09-18

- 双向定位：查工作区/会话，并在会话标题标注来源。
- 修正发布说明中产物与插件对应关系的张冠李戴。

## v0.1.0 — 2026-09-18

- 首个发布：统一版本、单 tag 双产物（AstrBot 插件 zip 与 dsh 插件 tgz）的发布基础设施。
