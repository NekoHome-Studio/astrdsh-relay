# 更新日志

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
