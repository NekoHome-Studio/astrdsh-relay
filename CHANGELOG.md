# 更新日志

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
