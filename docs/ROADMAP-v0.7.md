# AstrDsh Relay（星驿）· v0.7 待办清单

> 状态：**待办登记表，不是契约**。接口真相来源仍是 `docs/BRIDGE-CONTRACT.md`；
> 本文件只登记「还没做的事」+ 证据位置，落地后须回改契约与文档口径。
> 基线：`v0.6.2`（三项预留配置已接线，`npm test` 全绿）。
> 逐项证据均由源码实读得出（文件:行），未标【未核实】者可直接当事实使用。

---

## 0. 口径结论（先说没有的）

- `hmacMode` / `policy`（on-demand、daily）/ `idleTtlMs` **已接线，不再是待办**。
  README.md:12-14、docs/RELEASING.md:141-153、CHANGELOG.md:7、scripts/package-release.mjs:303 口径一致。
- DSH 侧 17 个配置键（`lib/index.js:79-114`）**全部有代码引用**，无空转键。
- AstrBot 侧 23 个配置键中**有 2 个是空转的**——见 §1，这是本次盘点唯一的「新缺陷」。

---

## 1. R1 · 空转的配置键 —— **已落地（v0.7.0，实施记录见 §7）**

（下面保留当初的盘点证据，落地后的现状列写在表内第三列右半边。）

两个键在 `_conf_schema.json` 里带默认值与选项，却在插件代码里**零引用**
（仅 `main.py:11-12` 的模块 docstring 自认「仍欠」）。

| 键 | schema 位置 | 代码状态 |
|---|---|---|
| `health_interval_ms`（默认 30000，0=关闭） | `_conf_schema.json:71-75` | 原先只在启动时校验一次 `/health` → **已改为周期任务 `Main._health_loop`** |
| `reply_render_mode`（`text`\|`card`） | `_conf_schema.json:105-111` | 原先无任何 t2i 实现 → **已落地 `Main._render_cards`（复用 `Star.text_to_image`）** |

为什么算缺陷：用户把 `reply_render_mode` 改成 `card`、把间隔改成 5000，
**插件既不生效也不报错**。这和本仓自己立的规矩（`index.js:123`
「配置错误要响亮：宁可加载失败，也不要运行期静默降级」、
`assertConfigIsUsable` 拒绝静默降级）直接冲突。

当初的两种收口，最终**都走了 (a)**（取证发现 t2i 可直接复用，不必自建，见 §7）：

- (a) 补实现：周期健康检查（连续失败即标记未就绪并把原因带给用户）+ `card` 渲染；✅ 本次
- (b) 撤下键：`card` 从 `options` 移除或在加载期显式抛错，间隔键删除或标注「预留」。✗ 未采用

---

## 2. R2 · 已声明但未实现（功能面）

1. **`user-questions` 转发**：契约 §5.3 / §9 #6 明确留二期。
   注意 `ERROR_NOT_IMPLEMENTED`（is `not_implemented` → 501）在两侧**已定义但全仓无人使用**
   （`contract.js:60,79`、`contract.py:75`）——即当前没有任何端点会返回 501。
   真做的时候要让未实现端点回 501，而不是让它掉成 404（`contract.js:67-69` 专门区分了这两件事）。
2. **写类控制面**：`settings/mutate`、`workspace/archiveSession` 默认关闭，仅白名单显式开启时可用（契约 §11.3）。
3. **P5 控制面整体未开**（契约 §11 标「v1.1 草案」）：目前 §12 只读；对话级 cwd 覆盖只能手改 `state.json`
   （DESIGN §7.2 记的现状），记录里的 `workspaceId` 已删除就是为它预留。
4. **P3 收尾**：DSH 重启恢复（`DESIGN.md:274` 记「待验证」）、插件卸载收尾顺序（`DESIGN.md:206-208`）。
5. **P4 收尾**：`card` 模式 —— **已落地**（§7），遗留仅「`push_to_session` 仍固定纯文本」。

---

## 3. R3 · 未实测 / 证据不足（契约 §11.4 列为阻塞项）

1. **`session/page` 的 `throughSeq` 语义**：是翻页上界还是起始 seq 未实跑；
   旧 connector 的 `_await_reply` 正压在这个调用上，属阻塞项。
2. **`sessionTitleTemplate` 应用到 DSH 会话** —— **已落地（v0.7.1，实施记录见 §8）**。
   原先标题只在 `/where`、`/conversations` 的**响应字段**里渲染
   （`location.js:66`、`location.js:245`、`index.js:1759-1767`），没写进 DSH 会话本身，
   后果是 DSH Web 的会话列表里看不出「哪条来自哪个群」。
   卡点「进程内有没有等价的标题写入 API」已解开：宿主有 `session-title` 服务，
   请求期 `host.get` 取不到时回落 `ctx.get`（`lib/session-title.js` 的 `titlesOf`）；
   三条口子的取舍见 §8。
3. **只有静态证据的项**：`fetch.register` 的 SSE、exact 路由抢占、进程内直调。
4. **契约 §9 残余**：`@deepseek-ai/schemastery` 第三方可解析性（**该条已结案：
   `dsh-astrbot-relay/lib/index.js:71-76` 的【未核实】注释已在本轮改掉**，
   与 `DESIGN.md:280-286` 的 P1 实测结论对齐）、新装插件免重启 HMR、
   `agents.create` 的 provider/model 三选一、DSH 会话被归档后 `agent.followup` 的行为。

---

## 4. R4 · 待共犯决策

契约 §9 #7：**是否把 `astrbot_plugin_dsh_connector` 的多会话管理、模型/preset 切换、
Settings、图片卡合并进本插件。** 这一步决定 R2-3（P5）的规模，也决定 P6（退役 connector）
能否开工——先定这个，再谈排期。

---

## 5. 建议切片

| 切片 | 内容 | 理由 |
|---|---|---|
| **v0.7.0** | R1（配置键不再说谎）✅ 已落地 + R3-1 `throughSeq` 实测 + 顺手修 `index.js:73` 过期注释 ✅ 已修 | 全是小改动，但堵住「配置无效」这一真实体感问题 |
| **v0.7.1** | R3-2 标题真正写进 DSH ✅ 已落地（实施记录见 §8） | 反向定位这一半从「看不见」变「看得见」；与 v0.7.0 分开只是因为 tag 已切，逻辑上是 R3 的收尾 |
| **v0.7.x** | R4 决策后按 P5 分片：控制面 `/rpc` + 权限门 + 集成测试 | 权限门在 P5 是「不做就是提权漏洞」（DESIGN §7.3.1） |
| **不排期** | 契约显式不做项：`user-questions` 转发、v1 暴露流式控制面端点（必须走 `ctx.typertGateway.stream`） | 设计取舍，不是欠账 |

---

## 6. 维护约定

- 本表每落地一项，同步删改：契约 §9 未决表、§11.4、`DESIGN.md` §8 风险登记、`CHANGELOG.md`。
- 契约顶部已声明：标【未核实】的条项**不得**在实现阶段当既成事实使用（`BRIDGE-CONTRACT.md:5`）。
- 复发检查手段（本次盘点用的）：全仓 grep `未实现|未核实|未实测|TODO|P1|P5|二期`，
  再对两侧 `_conf_schema.json` / `Config` 的每个键做「代码引用数为 0」扫描——
  §1 那两个键就是这样扫出来的，正则扫文本是扫不到的。

---

## 7. 落地记录 · R1（v0.7.0）

### 7.1 `health_interval_ms` 周期健康检查 —— 已落地

`astrbot_plugin_dsh_relay/main.py`：

- `Main.__init__`：新增 `self._health_task: asyncio.Task[None] | None`。
- `Main.initialize`：启动探测 + 版本协商成功后，
  `asyncio.create_task(self._health_loop(), name="dsh_relay.health")`；
  `health_interval_ms=0` 即不建任务（语义与 schema 描述一致）。
- 新增 `Main._health_loop()`：按间隔调 `transport.health()`；失败只置
  `_bridge_ok=False` 并写 `_bridge_error`（**下一条用户消息立刻带原因**，
  不是等超时），成功则自动恢复并打日志；`CancelledError` 一律向上抛。
- `Main.terminate`：**显式 cancel 并 `await asyncio.wait({task})`** 再置 None。
  用 `wait` 而非 `await task`，避免把子任务的取消与外层对插件的取消混在一条链路。
  **该函数 docstring 已整段重写**——原文「没有游离的任务」在加了常驻任务之后
  就是假话，这条承诺到此为止。

### 7.2 `reply_render_mode="card"` —— 已落地

- 渲染器复用的是 AstrBot 基类现成的 `Star.text_to_image(text, return_url=True)`
  （`astrbot/core/star/base.py:77-90`，内部走 `html_renderer.render_t2i`，
  实现在 `core/utils/t2i/renderer.py`）——**不自建渲染、不引入新依赖**。
- `Main._reply`：`card` 时先调 `Main._render_cards(event, chunks)`；
  返回 `None` 就整条落回原纯文本路径，其余分片发送策略（中间 `event.send()`、
  最后一片 `yield`）完全不变。
- 新增 `Main._render_cards`：逐片 `await self.text_to_image(...)` 后
  `event.image_result(url)`；**任一片异常或返回空 URL，就丢弃全部已生成的图片
  并整条降级纯文本**（warning 带「第 i/n 片」定位）。
  理由：t2i 是外部服务，半图半文比纯文本更糟。

### 7.3 文档与注释对齐

- `main.py` 头部「实现状态 / 仍欠」两段重写为 P1/P2/P4 全落地口径。
- `dsh-astrbot-relay/lib/index.js:71-76`：`@deepseek-ai/schemastery`
  的【未核实】改成已核实（本机 profile 已实测挂载生效）。

### 7.4 本切片**未**做（留给 v0.7.x，别当成已完成）

- `push_to_session` 仍固定纯文本：主动推送没有事件对象，
  出图要另走 `Context.send_message` + `Image` 组件，未验证，故不动。
- 健康检查失败目前**不**暂停投递，只把原因前置给用户——「自动停用」需要
  先定用户可见语义（是静默、还是每次回一句），留给共犯决策。

### 7.5 R1 收尾补记（v0.7.0 发布前同批）

- **`allow_users` 成员白名单：v0.7.0 引入，后经 §11 撤销（v0.8.1）**。当初的诉求是「只有这些人
  可以用」，即在会话白名单之外再按发送者收一道；落地位置与既有两道过滤一致
  （分发之前），AND 语义，取不到发送者 ID 时拒绝，被挡只记一行 `info`
  （只记 ID、不记内容）。但事后复盘：`allow_from` 本来就已按 entry 形状分派语义
  ——填纯数字就按发送者判——所谓「会话白名单」与「成员白名单」其实是同一件事，
  两项之间的 AND 在正常路径下永远冗余，只是多出一个能填错、能互相打架的配置面。
  故由 §11 只留 `allow_from` 一个洞，删掉该项与 `ids_match()`，口径回填到
  `docs/DESIGN.md` §3 策略表与 §4 配置清单；`scripts/test-allowlist.py` 增加两道
  守卫断言，防止 schema 或 `main.py` 里再长回来。
- **版本口径漂移修复**：R1 落地后 `package.json` / `dsh-astrbot-relay/package.json` /
  `metadata.yaml` 三处仍写 `0.6.2`，本批统一升到 `0.7.0`，`npm run check:version` 复验。
- **权限语义取证结论落文档**：`is_admin()` 只认 AstrBot 管理员（读写链路见
  `docs/astrbot-side-capabilities.md` §3.6）。**结论：插件做群管判定必须自读
  `group.group_admins`**，不复用 `is_admin()`。
- 7.4 的「健康检查失败是否暂停投递」仍未决策 —— 当前实现维持「只标记 + 下一条消息带
  原因」，不暂停。

---

## 8. 落地记录 · R3-2（v0.7.1）

### 8.1 实际接线（`dsh-astrbot-relay/lib/`）

- 新增 `lib/session-title.js`：`titlesOf(host, ctx)` 取宿主的 `session-title` 服务
  （`host.get` 取不到回落到 `ctx.get`）；`writeSessionTitle(bridge)` **只记日志、绝不抛错**——
  服务缺席静默跳过，其余失败 `warn` 并带 `reason` 与 `conversation`。
  理由：标题是「锦上添花」，为它把消息链路打断不划算。
- `index.js` 三处：

| 位置 | 行为 |
|---|---|
| `handleMessage` | live 复用分支与 create/resume 之后、`followup` **之前**写入 |
| `rebind` | 改指之后新会话**就地补写**（且**不抹**旧会话标题——旧标题仍是历史事实） |
| `fork`（`host.agents.create` 子会话） | **显式不写**，理由见 8.2 |

- 「提示超长」的比较基准改用 `result.rendered`（**交出去的原文**）而非落盘 title。
  原因写成注释了：dsh 侧永远截到限内，拿落盘 title 比会得到一段永不触发的死代码。

### 8.2 fork 路径不写标题（本轮拍板的取舍）

fork 请求体里**没有 `conversation` 可反查**，子会话此刻**不属于任何对话**，
硬写只会落一条无归属标题——比空标题更糟，因为它看起来像是有来源的。
所以：**不跟随父标题、不单独渲染**，等 IM 侧真正接管（`/message` 或 `/session/rebind`）
时由那两处自动补上。

### 8.3 写入语义：写入即钉住

一旦写过，标题就 supersede 宿主的自动生成标题与 LLM 自动起标题，此后**只有显式 refresh
才解开**。这是有意选的硬边——反向定位是这一半功能存在的唯一理由，
名字被自动改名等于把功能做没。

### 8.4 长度口径（改模板前必算）

- 渲染结果按 **UTF-8 截到 80 字节**，按字符边界退让，不切坏多字节字符。
- 默认模板前缀 `星驿 · default/GroupMessage/` 占 **31 字节**，留给平台/类型/会话 id 的只有
  **49 字节**。`·` 是 **U+00B7**，占 **2** 字节；U+30FB「・」与 U+2022「•」才是 3 字节。
- 中文每字 **3 字节**。
- ⚠ 本轮踩过：先前按「相似的中间点都是 3 字节」估算，结论是错的。
  这类断言必须让工具算真值（`node -e` 打印码位与 `Buffer.byteLength`）再写死。

### 8.5 测试与闸门（本轮实跑结果）

- 新增 `scripts/test-session-title.mjs`（**15 项断言**），已接进 `npm test`
  （`test:session-title`）。覆盖：正常写入 / 落盘结果优先 / `accepted` 带回 /
  未知占位符原样保留 / `{conversation}` 含冒号不切坏 / 超长照交不截 /
  会话缺席 `no-session` / 空白 `empty-title` / 服务缺席（4 种形态）`service-missing` /
  `InvalidError` 归 `invalid-title` / not live 与抛非 `Error` 归 `rename-failed` /
  空参不炸 / 字节长度与 80 上限。
- 闸门：`test:session-title` 首跑 13 通过 2 失败、次跑 **15 通过 0 失败**；
  `check-syntax` **10 个文件 0 失败**。
- 该模块**零依赖**，15 项断言不需要装 dsh 依赖即可跑——这是模块零依赖化的直接收益。

### 8.6 本切片未做

- 标题写入**不跟随** `sessionTitleTemplate` 的后续变更（改配置不会回改已钉住的会话），
  要改需手动重绑或等 refresh 通道。
- `push_to_session` 仍固定纯文本（沿用 §7.4 的结论）。

---

## 9. 落地记录 · v0.7.2（白名单增强）

### 9.1 起因与定性（沿用 v0.7.1 的结论）

- `/dsh 测试` 无任何反应、日志无痕的定性**不变**：`allow_from` 填的是纯 QQ 号
  `1234567890`，真实 UMO 是 `绫地宁宁:FriendMessage:1234567890`，逐字比较失败 →
  事件被静默放行给默认 LLM。
- UMO 结构取证：`aiocqhttp` 适配器按 `session.message_type` 判群聊，
  `abm.type` 取 `GROUP_MESSAGE` / `FRIEND_MESSAGE`，`abm.group_id = str(event.group_id)`，
  `abm.session_id` 群聊取 `group_id`、私聊取 `sender_id`；事件基类提供
  `get_session_id` / `get_group_id` / `get_sender_id` / `is_private_chat`。
  → 「平台 id : 消息类型 : 会话 id」三段式可切分，这是 `tokens_of` 的依据。
- 两条路线里选了**增强白名单**（v0.7.x 支持填纯 QQ 号与通配写法），
  而不是「文档里加粗『请填完整 UMO』」——后者把设计缺陷留给用户。

### 9.2 语法与判据

见 `CHANGELOG.md` v0.7.2「新增」段与 `allowlist.py` 顶部注释（唯一口径来源）。
接口定稿：`SENDER_PREFIXES` / `GROUP_PREFIXES` / `UMO_PREFIXES` / `tokens_of` /
`entry_matches` / `any_match`（供 `allow_from`）/ `_glob_match`。
（v0.7.3 起 `ids_match` 已删，白名单只剩 `allow_from` 一道。）

### 9.3 两处判据漏洞（先写测试才暴露）

- 群号取不到时 `group:*` 曾会放行 → 私聊会被群规则收进来。已改为**拒绝**：
  白名单的失败方向必须是「宁拒绝不宽放」。
- 平台 id 恰好叫 `user` / `qq` / `u` 时，v0.7.1 老配置 `user:FriendMessage:1`
  会被误读成「发送者 `FriendMessage:1`」→ 已补 UMO 回落。
- 教训：这两处都是「先立闸门再改代码」抓出来的，靠发消息试错抓不到。

### 9.4 接线与闸门

- `main.py`：`_session_allowed` 改为吃 `event`（走 `_tokens_of` + `any_match`），
  `_user_allowed` 走 `ids_match`；`_tokens_of` 为 classmethod，群号先
  `get_group_id` 后 `message_obj.group_id` 兜底，整体 `contextlib.suppress(Exception)` 包裹。
- 被挡必记一行 `info`（只记 UMO/ID，不记消息内容）。
- `check:py` 已收录 `allowlist.py`；`package.json` 已加 `test:allowlist` 并串进 `test` 链。

### 9.5 测试与闸门（本轮实跑结果）

- `scripts/test-allowlist.py`：**26 项断言**，含现场复刻常量，不美化。
- `npm test` 全绿（退出码 0）：check:syntax → check:py → check:contract →
  test:location → test:location-text → test:allowlist 26 项 → test:session-title 15 项 →
  check:version 0.7.2。
- 版本三处同步 0.7.2：根 `package.json`、`dsh-astrbot-relay/package.json`、
  `astrbot_plugin_dsh_relay/metadata.yaml`。

### 9.6 本切片未做

- `git push origin main --tags` **已执行**（2026-09-20）：`main` → `47e72d5`，`v0.7.1`/`v0.7.2` 两个 tag 已推送至 NekoHome-Studio/astrdsh-relay。
- 实装目录 `~/.dsh/plugins/dsh-astrbot-relay/lib/index.js` 与源码仓同名文件哈希一致（8C62A6AA…AF25），桥接端 `BRIDGE_VERSION='3'`；插件重载后的发消息实测仍未记录。
- 实装目录同步与插件重载后**发消息实测**（`/dsh 测试` 应从「落回 LLM」变为被插件接管）
  归入 R3 收尾验收；`allow_users` 重载验证同样待做（后因该项被删而作废，见 §11）。
- R4 控制面 `/rpc` 与权限门、R3-1 `throughSeq` 语义实测、`push_to_session` 富文本
  仍按原计划留在后续切片。
---

## 10. 落地记录 · v0.7.3（fork 空体 400 根因修复）

### 10.1 起因与定性

- 现象三条：`/session/fork` 返回 **400 空体**；`/message` 与 `/session/rebind`
  **不报错但悄悄回退默认预设**。
- 排查期先在 `lib/index.js` 里打过一轮 `__FORK_TRACE__` 插桩（四十八增五删），
  定位后**已完整回滚**：还原到 HEAD 版（98914B / sha256 `d4012856684f`），
  只保留有效的单点修复 → 98930B / sha256 前 12 位 `025bccd22704`，
  `__FORK_TRACE__` 与 `forkTrace` 计数均为 0。

### 10.2 根因（正式坐实）

- host 传给插件的服务集合是 **Proxy**：**未在 `inject` 里声明的服务，取值即抛**。
- `sessionQuery` 当时没在 `inject` 声明，于是三处调用点同时失败，
  差别只在 `try` 的位置：
  - `try` **内** → 异常被静默吞掉（`/message` 约 1091/1093 行、
    `/session/rebind` 约 1493/1495 行），表象是「无痕回退默认预设」；
  - `try` **外** → 异常冒到顶层（`/session/fork` 约 1659/1668 行），表象是 400 空体。
- 结论：**同一根因，三种表象**；修一行 `inject`，三处受益点同时恢复。

### 10.3 修复

- `dsh-astrbot-relay/lib/index.js` 第 69 行 `inject`：五服务 → **六服务**，追加
  `sessionQuery`。整份 diff 只有这一行，行号由原第 79 行前移到第 69 行。

### 10.4 闸门与实测（本轮实跑）

- `node --check lib/index.js`：退出码 0。
- `check-contract-parity`：`BRIDGE_VERSION=3`、10 事件类型、7 错误码、9 路由，退出码 0。
- `npm test` 全绿：`test:allowlist` 26 项、`test:session-title` 15 项，0 失败；
  `check:version` 报 0.7.3、必需文件齐全。
- 宿主在线：`/health` 200，`bridgeVersion` 3，`conversations` 1，
  `sessionTitleTemplate`「星驿 · {platform}/{messageType}/{sessionId}」。
  端点须带 `Authorization: Bearer <bridge_token>`，否则一律 401；
  前缀是 `/astrbot-relay`，不是裸根路径。
- 端到端：`/session/fork` 由 400 空体 → **200**。

### 10.5 本切片未做

- 新 fork 会话（`im-dc5070a4…`，未挂工作区故不在 `/workspaces` 列表中）
  能否被 `/message` 与 `/session/rebind` 接管，待实测。
- 前端 `reply_render_mode=card` 的渲染欠账仍在。
- 控制面 P5、user-questions 转发（二期）、`push_to_session` 富文本按原计划顺延。

## 11. 落地记录 · 白名单并成一洞（v0.8.1）

### 11.1 起因

`astrbot_plugin_dsh_relay_config.json` 里 `allow_from` 填了纯 QQ 号、`allow_users` 空着，
UI 上「成员白名单」一栏看着像无效。读码后确认不是 bug：v0.7.2 已让 `allow_from` 按
entry 形状分派语义（纯数字 = 发送者、`group:` = 会话、完整 UMO = 逐字），`allow_users`
是 v0.7.0 追加的第二道 AND，正常路径下永远冗余——设计重叠，不是缺功能。

### 11.2 处置：只留一个洞

- `_conf_schema.json`：删 `allow_users`；`allow_from` 的 hint 改写为
  「纯数字 / group:群 / group:群@人 / 完整 UMO」，示例号码一律用假号 `123456789`。
- `main.py`：删 `_user_allowed` 方法及 `on_bridge_message` 里的调用点与相关注释，
  白名单只剩 `_session_allowed` 一道；`_tokens_of` / `_sender_of` 保留（他处仍在用）。
- `allowlist.py`：删 `ids_match()`；模块顶部注释改写为「『会话白名单』与『成员白名单』
  是同一件事，所以只有一个 `allow_from`」。
- `scripts/test-allowlist.py`：删「allow_users：ids_match」整段，改为两道守卫断言
  ——读 `_conf_schema.json` 断言无 `allow_users` 键且 hint 不含该词；读 `main.py`
  断言源码不再出现 `allow_users` / `_user_allowed`。

### 11.3 测试与文档

- `python scripts/test-allowlist.py` → **25 项通过，0 项失败**。
  原先「`?` 只吃一个字符」一项硬编码了真号位数，已改为按 `ME` 变量推导
  （`ME[:-1] + "?"` / `ME[:-1] + "??"`），不再依赖具体号码形状。
- 仓库内真实 QQ 号清零：`CHANGELOG.md`、`docs/ROADMAP-v0.7.md`、`main.py`、
  `allowlist.py`、`scripts/test-allowlist.py` 中残留的十位真号统一替换为编造号
  `1234567890`（保持十位数，测试仍复刻真实形状）。
- 口径回填：`astrbot_plugin_dsh_relay/README.md` 的「白名单与私聊过滤」一条、
  `docs/DESIGN.md` §3 策略表与 §4 配置清单，均已去除「两个白名单 AND」的说法。

### 11.4 兼容性

`allow_users` 默认空 = 不限制人，因此从未配置该项的部署**行为完全不变**；
配置过该项的部署需把条件并进 `allow_from`（纯数字 entry 即等价写法）。
