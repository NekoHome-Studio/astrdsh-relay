# 更新日志

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
