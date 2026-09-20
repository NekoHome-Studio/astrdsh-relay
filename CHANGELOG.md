# 更新日志

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
