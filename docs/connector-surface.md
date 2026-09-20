# astrbot_plugin_dsh_connector 能力面完整清点（迁移验收基线）

- **清点对象**：`C:\Users\<user>\Downloads\AstrBot-master\data\plugins\astrbot_plugin_dsh_connector`（v2.0.1，author konodiodaaaaa1，见 `metadata.yaml:8-10`）
- **清点方式**：`main.py` **全文分段通读**（1-340 / 341-680 / 681-1020 / 1021-1360 / 1361-1493，共 1493 行，无抽样）；`core/` 全部 6 个模块全文通读；`_conf_schema.json`、`metadata.yaml`、`README.md`、`CHANGELOG.md`、`requirements.txt`、`dsh_connector_helpers.py`、`tests/test_dsh_connector.py` 全文通读。
- **证据规则**：每条结论给出「文件 + 行号」。凡未在源码中查到的，一律进 §15「未找到证据清单」。
- **交叉验证对象**：已安装 DSH 产物 `C:\Users\<user>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai`（下称 `<DSHNPM>`），以及 AstrBot 源码 `C:\Users\<user>\Downloads\AstrBot-master`（下称 `<ASTROOT>`）。本报告对 DSH 侧的复核只用于回答「迁移是否会失效」，不重复 `docs/dsh-side-capabilities.md` 的 DSH 侧清点。
- **章节编号说明**：任务清单有 12 项，§2~§12 只有 11 节。为保证 12 项**一项不漏**，本报告用 §2~§13 承载 12 项，因此「迁移清单」顺延为 **§14**、「未找到证据清单」为 **§15**。§14.0 集中回答额外三问。

## 路径缩写表（每条缩写都绑定绝对路径）

| 缩写 | 绝对路径 |
|---|---|
| `<PLUGIN>` | `C:\Users\<user>\Downloads\AstrBot-master\data\plugins\astrbot_plugin_dsh_connector` |
| `<MAIN>` | `<PLUGIN>\main.py` |
| `<HELP>` | `<PLUGIN>\dsh_connector_helpers.py` |
| `<CLIENT>` | `<PLUGIN>\core\dsh_client.py` |
| `<STATE>` | `<PLUGIN>\core\session_state.py` |
| `<OPTS>` | `<PLUGIN>\core\session_options.py` |
| `<RENDER>` | `<PLUGIN>\core\reply_render.py` |
| `<CFG>` | `<PLUGIN>\core\config_service.py` |
| `<PRES>` | `<PLUGIN>\core\presentation.py` |
| `<INIT>` | `<PLUGIN>\core\__init__.py` |
| `<SCHEMA>` | `<PLUGIN>\_conf_schema.json` |
| `<TESTS>` | `<PLUGIN>\tests\test_dsh_connector.py` |
| `<META>` | `<PLUGIN>\metadata.yaml` |
| `<README>` | `<PLUGIN>\README.md` |
| `<CHANGELOG>` | `<PLUGIN>\CHANGELOG.md` |
| `<DSHNPM>` | `C:\Users\<user>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai` |
| `<ASTROOT>` | `C:\Users\<user>\Downloads\AstrBot-master` |

**逐文件规模（`read` 工具实际总行数）**

| 文件 | 行数 | 说明 |
|---|---|---|
| `<MAIN>` | 1493 | 唯一入口类 `Main(Star)` + 全部命令分发 + 19 个 LLM 工具 |
| `<CLIENT>` | 495 | RPC 客户端与轮询状态机 |
| `<TESTS>` | 496 | 32 个测试 |
| `<OPTS>` | 258 | 会话选项归一化 + 8 步向导状态机 |
| `<HELP>` | 127 | 纯解析辅助（回复文本/图片源/模型行） |
| `<STATE>` | 92 | KV 持久化 |
| `<RENDER>` | 69 | 卡片判定与分卡 |
| `<CFG>` | 56 | DSH settings 辅助 |
| `<PRES>` | 31 | 投影文本呈现 |
| `<INIT>` | 12 | 再导出 |

`requirements.txt` 仅一行：`aiohttp>=3.8`（`<PLUGIN>\requirements.txt:1`）。

---

## §1 能力总览表（验收基线）

难度口径：**易** = 纯逻辑/协议已对齐，几乎原样搬；**中** = 逻辑可搬但依赖形状或需重新验证；**难** = 依赖已变更/已删除的 DSH 协议面，必须重写。RPC 一栏写「插件当前调用的方法名」；`✗` 表示该方法名**不在**已安装 DSH 的 RPC 目录中（见 §6.3）。

| # | 能力 | 命令入口 | 依赖的 RPC | 难度 | 备注 |
|---|---|---|---|---|---|
| T1 | HTTP RPC 传输 | 全部（mode=http/auto） | `POST /api/<method>` | **难** | 信封/端点/载荷与已装 DSH 网关不符，且 **`/api` 有 401/403 认证栅栏**，插件无 cookie/token 逻辑（§6.3、§14.0-Q2） |
| T2 | headless 命令行传输 | 全部（mode=headless/auto 回退） | 无（`dsh --profile headless "<文本>"`） | 易（可弃） | 无会话状态、无多轮、无图片（`<MAIN>:229-257`） |
| C1 | 帮助 | `/dsh`、`/dsh help` | 无 | 易 | `<MAIN>:441-449`；HELP 文本 `<MAIN>:63-91` |
| C2 | 连接状态 | `/dsh status`、`/dsh ping`、`/dsh 状态` | `host.describe` ✗ | 中 | `<MAIN>:564-581`；`host.describe` 在已装目录中不存在 |
| C3 | 重置会话绑定 | `/dsh reset`、`new`、`重置`、`清空` | 无（仅删 KV） | 易 | `<MAIN>:1463-1466`；`<STATE>:37-40` |
| C4 | 8 步会话向导 | `/dsh setup`、`wizard`、`向导`、`会话配置` | `host.describe`✗ + `presets`✗ + `global_models`✗ + `workspaces`✗ + `permission_presets` | 中 | `<MAIN>:855-904`；向导纯逻辑在 `<OPTS>:96-258` |
| C5 | 会话选项查看/设置 | `/dsh config [...]` | 无 | 易 | `<MAIN>:788-825`；字段别名 `<OPTS>:22-34` |
| C6 | DSH 设置命名空间浏览 | `/dsh settings`、`/dsh setting get|schema` | `settings.describe` ✓ | 易 | `<MAIN>:906-961`；辅助 `<CFG>` 全文件 |
| C7 | DSH 设置写入 | `/dsh setting set|unset` | `settings.mutate` ✓ | 易 | `<MAIN>:947-959`，带 `expectedRevision` 乐观锁 |
| C8 | DSH 会话列表 | `/dsh sessions`、`session`、`会话`、`列表` | `session.list` ✓ | 易 | `<MAIN>:598-616`；呈现 `<PRES>:8-23` |
| C9 | 绑定已有会话 | `/dsh session switch <id>` | `session.list` ✓ | 易 | `<MAIN>:986-995`（精确匹配，不做前缀） |
| C10 | 建新会话 | `/dsh session new` | `session.create` ✓ + `session.selectModel` ✓ + `commands/execute` ✓ | 易 | `<MAIN>:981-984`、`827-853` |
| C11 | 会话重命名 | `/dsh session rename <标题>` | `session.rename` ✓ | 易 | `<MAIN>:997-1001` |
| C12 | 会话分叉 | `/dsh session fork [seq]` | `session.fork` ✓ | 易 | `<MAIN>:1002-1008`，分叉后自动改绑子会话 |
| C13 | 会话搜索 | `/dsh session search <kw>` | `session.search` ✓ | 易 | `<MAIN>:973-979` |
| C14 | 会话删除/归档 | `/dsh session delete [id]` | `session.list` ✓ + `session.cancel` ✓ + `workspace.archiveSession` ✓ | 易 | `<MAIN>:1013-1079`；需输入 `delete` 确认，30s 超时 |
| C15 | 历史回放 | `/dsh history [条数]` | `session.history` ✗（目录中为 `session.page`） | **难** | `<MAIN>:618-635`；默认 30，钳位 1..200 |
| C16 | 停止任务 | `/dsh stop`、`cancel`、`停止`、`取消` | `session.cancel` ✓ | 易 | `<MAIN>:637-646` |
| C17 | 模型目录查询 | `/dsh model`（无参） | `session.models` ✗（目录中为 `session.modelCatalog`） | **难** | `<MAIN>:656-664`；行归一化 `<HELP>:78-97` |
| C18 | 模型切换 | `/dsh model <provider/model> [effort]` | `session.selectModel` ✓ | 易 | `<MAIN>:665-684`，成功后写 KV 选项 |
| C19 | 推理强度 | `/dsh effort <值>` | `session.models` ✗ + `session.selectModel` ✓ | **难**（查询半） | `<MAIN>:688-697`（复用 `_model_command`） |
| C20 | 权限预设列表 | `/dsh permission`（无参） | `settings.describe` ✓（解析 schema refs） | 中 | `<MAIN>:702-706`；解析器 `<CLIENT>:296-316` |
| C21 | 权限预设应用 | `/dsh permission <预设>` | `commands/execute` ✓（`/permission <预设>`） | 中 | `<MAIN>:712-727`；会话创建时也会下发 `<MAIN>:199-205` |
| C22 | Preset 列表 | `/dsh preset list` | `agentPreset.list` ✗（目录中为 `agentPresets/list`） | **难** | `<MAIN>:737-743` |
| C23 | Preset 读取 | `/dsh preset read <名>` | `agentPreset.read` ✗（`agentPresets/read`） | **难** | `<MAIN>:744-749` |
| C24 | Preset 切到当前会话 | `/dsh preset select <名>` | `agentPreset.select` ✗（`agentPresets/select`） | **难** | `<MAIN>:750-765` |
| C25 | Preset 预存（下个会话） | `/dsh preset <名>` | 无（仅 KV） | 易 | `<MAIN>:766-773` |
| C26 | LLM 服务商 | `/dsh providers`、`provider`、`服务商` | `llm.providers` ✗（`llm/listProviders`） | **难** | `<MAIN>:1081-1094` |
| C27 | 全局模型目录 | `/dsh global-models`、`catalog`、`模型目录` | `llm.models` ✗（`llm/discoverModels`） | **难** | `<MAIN>:1096-1107` |
| C28 | Skills 列表 | `/dsh skills`、`skill`、`技能` | `skill.list` ✗（`skills/list`） | **难** | `<MAIN>:1109-1121` |
| C29 | 子代理列表 | `/dsh subagents`、`subagent`、`子代理` | `subagent.list` ✗（`subagents/list`） | **难** | `<MAIN>:1123-1139` |
| C30 | 中断子代理 | `/dsh subagents interrupt <childId>` | `subagent.interrupt` ✗（`subagents/interruptByParent`，参数不同） | **难** | `<MAIN>:1128-1130`；`<CLIENT>:357-364` 固定 `mode="continuable"` |
| C31 | 工作区列表 | `/dsh workspaces`、`workspace`、`工作区` | `workspace.list` ✗（目录中**无** workspace 列表方法） | **难** | `<MAIN>:1158-1162` |
| C32 | 工作区创建 | `/dsh workspaces create <path>` | `workspace.create` ✓ | 易 | `<MAIN>:1148-1151` |
| C33 | 工作区重命名 | `/dsh workspaces rename <id> <标题>` | `workspace.rename` ✓ | 易 | `<MAIN>:1152-1157` |
| C34 | Goal 查看 | `/dsh goal` | `session.history` ✗（读 projections.goal） | **难** | `<MAIN>:1172-1175`；取值 `<PRES>:26-31` |
| C35 | Goal 控制 | `/dsh goal create|pause|resume|complete|clear` | `goal.*` ✗（目录中为 `goals/*`） | **难** | `<MAIN>:1176-1186`；`<CLIENT>:381-404` |
| C36 | 队列操作 | `/dsh queue remove|steer|edit <msgId> [文本]` | `session.updateQueue` ✓ | 易 | `<MAIN>:1190-1207` |
| C37 | 插入执行中任务 | `/dsh steer <指令>`、`/dsh 插入 <指令>` | `session.prompt`（mode=steer）✓ | 易 | `<MAIN>:521-526` → `520-562` |
| C38 | **主任务下发与收敛** | `/dsh <任意文本>` | `session.prompt` ✓ + `session.history` ✗ 轮询 + `session.list` ✓ | **难** | `<MAIN>:520-562`；轮询状态机 `<CLIENT>:406-495` |
| C39 | 流式增量回传 | 同 C38（配置 `stream_replies`） | **`assistant/chunk`（已删除事件）** | **难** | `<MAIN>:294-326`；`<CLIENT>:459-472` |
| C40 | 图片/attachment 输出 | 同 C38 | `session.attachment` ✓ | 中 | 管线 `<HELP>:100-119`+`<CLIENT>:269-290`+`<MAIN>:339-394,424-434` |
| C41 | Markdown 卡片渲染 | 配置 `reply_render_mode` | 无（本地 AstrBot t2i） | 易 | `<MAIN>:396-422`+`<RENDER>` 全文件 |
| C42 | LLM 工具面（19 个） | `@filter.llm_tool` | 复用 C2/C8/C10/C16/C17/C18/C21/C24/C26/C28/C29/C31/C34/C35/C15 的 RPC | 中 | `<MAIN>:1211-1461`；开关 `enable_llm_tools`（19 个工具体内各自二次校验） |
| C43 | 按聊天隔离的会话绑定与选项 | 全部 | 无（AstrBot KV） | 易 | `<STATE>` 全文件；键格式 §7 |

---

## §2 命令树（清单项 1）

### 2.1 关键结构结论

**整个插件只注册了 1 个 AstrBot 命令**：`@filter.command("dsh", alias={"ds"})`（`<MAIN>:438`）。`/dsh` 之下**所有**子命令都不是 AstrBot 指令组/子指令，而是 `dsh()` 内部对 `event.message_str` 做字符串前缀匹配的手写分发树（`<MAIN>:441-526`）。`grep` 全仓 `@filter.` + `@session_waiter` 共 23 处，构成：**1 个 `@filter.command`**（438）、**1 个 `@filter.on_llm_request`**（1217）、**19 个 `@filter.llm_tool`**（1250,1258,1266,1274,1294,1326,1334,1342,1350,1355,1367,1384,1392,1400,1408,1422,1430,1438,1446）、**2 个 `@session_waiter`**（879 向导、1049 删除确认）。

- 命令名取自 `_command_remainder(event)`（`<MAIN>:1485-1493`）：AstrBot 已剥掉 wake_prefix（默认 `/`），故 `event.message_str` 形如 `dsh 帮我写代码`，按第一个空白切分取余下部分。
- **权限要求**：插件**没有任何** AstrBot 权限门。全仓检索 `permission_type` / `PermissionType` / `admin` **零命中**（唯一相关标识符只是 DSH 侧的 `permission` 配置命名空间，见 `<CLIENT>:296-316`）。即：谁能唤醒 AstrBot 的该会话，谁就能执行 `/dsh` 全部子命令（含删除会话、写 DSH 设置）。仅 LLM 工具面受 `enable_llm_tools` / `enable_llm_mutation_tools` 两个配置开关约束（`<MAIN>:1211-1215,1243-1248`）。

### 2.2 一级分发表（`<MAIN>:441-526`）

| 触发词（`lowered`，已 lower+strip） | 判定行 | 处理器 | 定义行 | 用户可见行为 |
|---|---|---|---|---|
| 空串 | 442 | 直接 yield | 443 | 打印 HELP_TEXT |
| `help` `帮助` `usage` `-h` `--help` `?` `？` | 447 | 直接 yield | 448 | 打印 HELP_TEXT |
| `status` `状态` `ping` | 450 | `_status_text()` | 451 / 564-581 | 模式、HTTP 连通性、provider/model/version、cwd；headless 时打印命令行 |
| `reset` `new` `重置` `清空` | 453 | `_reset_chat()` | 454 / 1463-1466 | 删除本聊天的会话绑定 KV（**不清除选项**，不清 DSH 侧会话） |
| `setup` `wizard` `向导` `会话配置` | 456 | `_setup_session()`（async generator） | 457 / 855-904 | 进入 8 步向导（§3） |
| `config` `配置` 或前缀 `config ` / `配置 ` | 460 | `_session_config_command()` | 461 / 788-825 | 查看/设置/清除「本聊天下个新会话」的选项 |
| `settings` `设置` | 463 | `_dsh_settings_command(..., "settings")` | 464 / 906-961 | 列出 DSH 设置命名空间 |
| 前缀 `setting ` / `设置 ` | 466 | `_dsh_settings_command(..., text)` | 467 / 906-961 | `get`/`schema`/`set`/`unset` |
| `sessions` `session` `会话` `列表` | 469 | `_sessions_text()` | 470 / 598-616 | 最多 20 条会话（id 前 16 位/运行态/标题/权限/上下文压力） |
| 前缀 `session ` 且第 2 词 ∈ {`delete`,`del`,`remove`,`删除`} | 472-474 | `_delete_session()` | 475 / 1013-1079 | 二次确认后归档删除 |
| 前缀 `session `（其它） | 472 | `_session_command()` | 478 / 963-1011 | list/search/new/switch/rename/fork |
| 前缀 `history` / `历史` | 480 | `_history_text()` | 481 / 618-635 | 合并最近 N 条 assistant 文本 |
| `stop` `cancel` `停止` `取消` | 483 | `_cancel()` | 484 / 637-646 | 请求取消当前会话任务 |
| 前缀 `model` / `模型` | 486 | `_model_command()` | 487 / 656-686 | 查询或切换模型 |
| 前缀 `effort` / `推理` | 489 | `_effort_command()` | 490 / 688-697 | 在当前模型上改推理强度 |
| 前缀 `permission` / `权限` | 492 | `_permission_command()` | 493 / 699-729 | 列出/应用 DSH 权限预设 |
| 前缀 `preset` / `预设` | 495 | `_preset_command()` | 496 / 731-775 | list/read/select/预存 |
| `providers` `provider` `服务商` | 498 | `_providers_text()` | 499 / 1081-1094 | 服务商、displayName、active、settings 定位 |
| `global-models` `catalog` `模型目录` | 501 | `_global_models_text()` | 502 / 1096-1107 | 全局模型目录（group/model） |
| 前缀 `skills` / `skill` / `技能` | 504 | `_skills_text()` | 505 / 1109-1121 | Skills 名/描述/是否可被模型调用 |
| 前缀 `subagents` / `subagent` / `子代理` | 507 | `_subagents_command()` | 508 / 1123-1139 | 子代理列表；`interrupt <id>` 分支 |
| 前缀 `workspaces` / `workspace` / `工作区` | 510 | `_workspaces_command()` | 511 / 1141-1164 | list/create/rename |
| 前缀 `goal` / `目标` | 513 | `_goal_command()` | 514 / 1166-1188 | show/create/pause/resume/complete/clear |
| 前缀 `queue` / `队列` | 516 | `_queue_command()` | 517 / 1190-1207 | remove/steer/edit 队列项 |
| 前缀 `steer ` / `插入 ` | 521-523 | 落到主任务路径，`prompt_mode="steer"`，`text` 改为余下文本 | 520-528 | 空文本时提示补指令（525） |
| **默认（其它任意文本）** | — | 主任务路径 | 528-562 | 见 2.4 |

### 2.3 二级子命令表

| 父命令 | 子动作（判定行） | 处理器/行为 |
|---|---|---|
| `config` | 无参（791） | 打印 `format_session_options` |
| `config` | `reset` / `clear-all`（794） | `state.clear_options` 并回显默认值（795-796） |
| `config` | `set <字段> <值>`（797-804） | 写 KV；`model` 需 `provider/model`（806-812）；`timezone` 归一化并校验（813-817）；`workspace`↔`cwd` 互斥（818-821） |
| `config` | `clear` / `unset <字段>`（797,804） | 置空；清 `model` 时连带清 `reasoning_effort`（811-812） |
| `session` | 无动作（965-966） | 打印用法 |
| `session` | `list` / `ls`（971） | 复用 `_sessions_text` |
| `session` | `search <kw>`（973-979） | `session.search` |
| `session` | `new`（981-984） | 用当前 KV 选项建会话并改绑 |
| `session` | `switch <id>`（986-995） | 精确匹配 sessionId 后改绑 |
| `session` | `rename <标题>`（997-1001） | `session.rename` |
| `session` | `fork [seq]`（1002-1008） | `session.fork`，改绑子会话 |
| `session` | `delete [id]`（1013-1079） | 精确/前缀匹配；运行中先 cancel；`workspace.archiveSession`；改绑时清 KV |
| `setting` | 无参/`list`/`ls`（914-915） | `format_namespaces` |
| `setting` | `schema <ns>`（920-926） | 打印命名空间 JSON Schema（上限 8000 字符） |
| `setting` | `get` / `读取 <ns> [path]`（927-939） | 打印整命名空间或点路径值（上限 6000 字符） |
| `setting` | `set <ns> <path> <JSON>`（947-950） | `settings.mutate` op=set，带 `expectedRevision` |
| `setting` | `unset <ns> <path>`（951-952） | `settings.mutate` op=unset |
| `preset` | 无动作/`list`/`ls`（733,737） | `agentPreset.list` |
| `preset` | `read <名>`（744-749） | `agentPreset.read`，截断输出 |
| `preset` | `select <名>`（750-765） | `agentPreset.select` + 写 KV |
| `preset` | `<名>`（其它，766-773） | 只写 KV，提示 `/dsh reset` 后生效 |
| `workspaces` | 无动作（1143,1158） | 列表 |
| `workspaces` | `create <path>`（1148-1151） | `workspace.create` |
| `workspaces` | `rename <id> <标题>`（1152-1157） | `workspace.rename`（按第一个空格切 id/标题） |
| `subagents` | 无动作（1131） | 列表 |
| `subagents` | `interrupt <childId>`（1128-1130） | `subagent.interrupt` |
| `goal` | 无动作/`show`（1168,1174） | 从 history projections 读 goal |
| `goal` | `create <目标>`（1176-1179） | `goal.create` |
| `goal` | `pause`/`resume`/`complete`/`clear`（1180-1181） | `goal.<action>` + `{id,revision}` |
| `queue` | 参数<3（1192-1193） | 用法提示 |
| `queue` | 动作非 remove/steer/edit（1195-1196） | 拒绝 |
| `queue` | `edit <id> <文本>`（1197-1198） | 必须带文本 |
| `model` | 无参（659-664） | 当前模型 + 最多 40 行可用模型（含推理档位） |
| `model` | `<provider/model> [effort]`（665-684） | 无 `/` 则报格式错（666）；成功后写 KV |
| `history` | 可选条数（620-625） | 默认 30，非法值报错，钳位 1..200 |
| `effort` | 恰好 2 词（690-691） | 否则用法提示；否则查当前模型再切 |
| `permission` | 无参（701-708） | 列出 DSH 报告的权限预设 |
| `permission` | `<预设>`（709-727） | `commands/execute` 下发 `/permission X` + 写 KV；回显命令文本 |

### 2.4 主任务路径（`<MAIN>:520-562`）—— 用户可见的关键行为

1. `prompt_mode` 默认 `queue`（520）；`steer` 前缀改 mode 并剥离前缀（521-526）。
2. 先 yield 一条「🤖 已向 DeepSeek Harness 发送指令…」（528）——**注意：这句先发，随后才是流式/最终回复**。
3. 流式开关 `_stream_replies_enabled()`（530,319-326）：
   - 开：`_stream_reply()` 边收边发，再用 `_unstreamed_text` 去掉与流式重复的尾巴（531-536）。
   - 关：`_run()` 一次拿完整回复（538）。
4. 异常分三类：`DshTimeout`→`⏱️`（539-541）；`DshError`→`❌`（542-544）；其它→日志 + `❌ 插件内部错误`（545-548）。
5. 组装 `_reply_chain`（550,424-434）：先文本（可渲染成卡片），再图片。
6. 空链处理：流式已发过则静默 return（551-553），否则发「（DeepSeek Harness 没有返回可呈现的内容）」（554）。
7. 文本按 `reply_chunk_size` 分片逐条 `plain_result`（556-560）；图片合并成一条 `chain_result`（561-562）。

### 2.5 HELP_TEXT 与实现的偏差（旧插件文档债 · 迁移裁决：不构成工作项）

> **v0.4.0 裁决**：以下四条**只对被替代的 `astrbot_plugin_dsh_connector` v2.0.1 成立**，
> 属它自己的自文档债。relay 侧结构上不会长出同类漂移，因此本条**不构成迁移工作**，
> 仅作历史留档。裁决依据见本节末「为什么 relay 侧不会复发」。

- `/dsh settings` 在 HELP 中出现**两次**：`<MAIN>:78` 与 `<MAIN>:86`。
- HELP **未列出**：`session new`、`config clear/unset`、`workspaces create/rename`、`subagents interrupt`、`goal` 的各子动作、`setting unset` 的完整形态、以及全部中文别名。这些在 README 中有部分（`<README>:40-52,62-84`）。
- HELP 列出 `provider`/`providers` 两种写法（74），实现同时接受二者（498）。
- 测试仅锁定了 HELP 里两行文本（`<TESTS>:26-30`）。

**为什么 relay 侧不会复发**（三条，均为现行代码事实）：

1. **清单只有一个生产来源**：`contract.COMMAND_HELP` + `main._usage_text()`，
   裸前缀与 `/dsh help` 两条入口读的是同一份文案（v0.3.5），
   不存在"HELP 常量与分支各写一遍"的机会——旧插件那两处重复正是这么来的。
2. **指令面刻意只有五条**（`<内容>` / `help` / `where` / `approve` / `reject`；
   v0.5.0 起为七条，新增 `workspaces` / `rebind`——此处描述的是 v0.4.0 基线），
   旧插件那批"HELP 未列出"的子命令面（`session` / `config` / `settings` /
   `workspaces` / `subagents` / `goal` 与全部中文别名）**不在 relay v0.4.0 内**，
   于是"清单列了但敲不动"与"敲得动但清单不列"两种漂移都无从产生。
3. **复发条件已写明**：将来若真把这些入口搬过来（该面涉及宿主 `sessionController` /
   `workspaceRegistry` 调用），必须沿用同一清单常量，否则本条会以另一种形式回来。

---

## §3 交互向导 `/dsh setup`（清单项 2）

### 3.1 编排（`<MAIN>:855-904`）

| 环节 | 行号 | 说明 |
|---|---|---|
| 模式前置检查 | 857 | `_require_http()`：headless 直接报错（583-585） |
| 一次性并发取数 | 859-864 | 同一 ClientSession 内顺序取 5 个 RPC：`host.describe`(860)、`agentPreset.list`(861)、`llm.models`(862)、`workspace.list`(863)、`permission_presets`(864，其内部再调 `settings.describe`) |
| 构造向导 | 865-872 | `SessionSetupWizard(host.cwd, presets, model_rows(models), 现有KV选项, workspaces, permission_presets)` |
| 失败 | 873-875 | 任一 `DshError` → `❌ {exc}`，向导不启动 |
| 首问 | 877 | `wizard.initial_prompt()` 以普通文本发出 |
| 等待循环 | 879-897 | `@session_waiter(timeout=120, record_history_chains=False)`；每步 `wizard.process(incoming.message_str)` |
| 取消 | 882-885 | `result.cancelled` → 回显提示并 `controller.stop()` |
| 确认 | 886-895 | `result.confirmed` → 先回显，再 `_save_session_options` + `_create_session_from_options` + 回显 sessionId；`DshError` 只提示失败 |
| 续等 | 896-897 | 非终态：回显下一步提示并 `controller.keep(timeout=120, reset_timeout=True)`（**每步重置 120s**） |
| 超时 | 899-902 | `TimeoutError` → 「DSH 会话配置超时，已退出。」 |
| 收尾 | 903-904 | `finally: event.stop_event()`（阻止事件继续冒泡） |

### 3.2 逐步骤（状态机在 `<OPTS>:96-258`）

| 步 | step 名 | 提示行 | 数据来源（RPC 结果） | 用户输入方式 | 暂存字段 | 备注 |
|---|---|---|---|---|---|---|
| 1/8 工作空间（仅有工作区时） | `workspace`（117） | 121-131 | `workspace.list` → `items[]`，过滤出有 `workspaceId` 的行（111-114） | 序号 / `0`=不指定 / 直接输 workspaceId（142-155） | `workspace_id`；非空时清 `working_directory`（156-157） | 无工作区时首步直接是「目录」，编号变为 1/7 |
| 1/7 工作目录（无工作区时） | `directory`（117） | 132-136 | `host.describe.cwd`（`<MAIN>:866`） | 直接输目录 / `0`=主机默认 / `取消` | `working_directory`；非 0 时清 `workspace_id`（177-180） | 空输入报错（174-175） |
| 2/8 工作目录（有工作区时） | `directory` | 159-164 | 同上 | 同上 | 同上 | 提示「回复 0 保留工作空间分配」 |
| 3/8 或 2/7 Agent Preset | `preset`（181） | 182-185 | `agentPreset.list` → `presets[]`（过滤有 `id` 的，109） | 序号 / `0`=DSH 默认 / 直接输 id（187-189） | `agent_preset` | — |
| 4/8 或 3/7 模型（Provider+模型） | `model`（190） | 191-194 | `llm.models` → `model_rows` 展平成 {provider, model, efforts} | 序号 / `0`=默认 / 直接输 `provider/model`（196-210） | `provider` + `model` + 暂存 `_efforts`（118,208-210） | 无 `/` 的裸输入报错（204-205） |
| 5/8 或 4/7 推理强度 | `effort`（211） | 212-215 | 上一步所选模型的 `reasoning.efforts[].id` | 序号 / `0`=模型默认 / 直接输值（217-219） | `reasoning_effort` | 档位来自所选模型，非全局 |
| 6/8 或 5/7 权限预设 | `permission`（220） | 221-230 | `permission_presets()`：解析 `settings.describe` 的 `permission` 命名空间 schema refs（`<CLIENT>:296-316`） | 序号 / `0`=默认 / 直接输名称（232-236） | `permission_preset` | DSH 未报告预设时提示直接输入（228） |
| 7/8 或 6/7 客户端时区 | `timezone`（237） | 238-243 | 无（代码内置选项 `1`=Asia/Shanghai、`2`=UTC） | 序号 / 任意 IANA `Area/Location`（245-250） | `client_time_zone` | 非法值回落 UTC 并报错（248-249）；归一化见 `<CLIENT>:38-50` |
| 8/8 或 7/7 确认 | `confirm`（251） | 253 | — | 仅 `y`（大小写不敏感）确认，其它任意输入=取消（255-257） | — | 确认文案先打印完整选项快照（253） |

- 取消词（任意步生效）：`cancel` `quit` `q` `取消` `退出`（`<OPTS>:168-169`）。
- 序号解析：`_choice()` 仅接受 1..count 的纯数字（138-140）；`0` 一律表示「用默认」。
- 选项归一化：`normalize_session_options`（`<OPTS>:50-63`）——workspace 优先于 cwd（57-58）；provider/model 必须成对，否则三个字段一起清空（59-62）；时区强制归一化（56）。
- 确认后的落库与建会话：先 `_save_session_options`（`<MAIN>:889`），再 `_create_session_from_options`（890 / 827-853），最后 `_save_session_id`（852），即**选项与绑定都写本聊天 KV**。
- 向导对象本身**不持久化**：中途重启/超时即丢；已写 KV 的选项保留。

---

## §4 LLM 工具面（清单项 3）

### 4.1 注册与可见性

| 机制 | 行号 | 说明 |
|---|---|---|
| 总开关 | 1211-1212 | `enable_llm_tools`（默认 false） |
| 写权限开关 | 1214-1215 | `enable_llm_mutation_tools`（默认 false），**必须**同时开 `enable_llm_tools` |
| 请求期裁剪 | 1217-1248 | `@filter.on_llm_request()`：`request.func_tool` 不存在则直接返回（1220-1221）；未开总开关 → 从工具表里 `remove_tool` 掉全部 19 个名字（1243-1246）；开了总开关但未开写开关 → 只摘掉 `dsh_connector_set_dsh_setting`（1247-1248） |
| 工具名清单 | 1222-1242 | 硬编码 **19 个**名字的 set，与下面注册的 19 个工具**一一对应、无冗余**（已逐名核对） |

> 每个工具体内**还有第二道**同名开关检查（如 1253-1255、1417-1419），因此即使 `on_llm_request` 未生效也不会越权。

### 4.2 工具表（19 个）

| # | 工具名 | 定义行 | 参数（签名） | 是否 mutation | 实际复用能力 | 关掉写开关后 |
|---|---|---|---|---|---|---|
| 1 | `dsh_connector_get_status` | 1250-1256 | 无 | 否 | C2 `_status_text` | 保留 |
| 2 | `dsh_connector_list_sessions` | 1258-1264 | 无 | 否 | C8 `_sessions_text` | 保留 |
| 3 | `dsh_connector_get_models` | 1266-1272 | 无 | 否 | C17 `_model_command("model")` | 保留 |
| 4 | `dsh_connector_send_prompt` | 1274-1292 | `prompt:string`, `steer:boolean=False` | **是**（会驱动 DSH 执行任务） | C38 `_run`（`steer` 时 mode=steer）；图片源以文本 URL 形式附在末尾（1288-1289） | 保留 |
| 5 | `dsh_connector_create_session` | 1294-1324 | `working_directory:string=""`, `agent_preset:string=""`, `workspace_id:string=""` | **是** | C10 `_create_session_from_options`；workspace 非空则清 cwd（1318-1320） | 保留 |
| 6 | `dsh_connector_set_model` | 1326-1332 | `provider:string`, `model:string`, `reasoning_effort:string=""` | **是** | C18 | 保留 |
| 7 | `dsh_connector_set_permission` | 1334-1340 | `preset:string` | **是** | C21 | 保留 |
| 8 | `dsh_connector_stop` | 1342-1348 | 无 | **是** | C16 `_cancel` | 保留 |
| 9 | `dsh_connector_get_config` | 1350-1353 | 无 | 否 | C5 + 连接自述（`_settings_text` 777-786）；**注意此工具没有做 `enable_llm_tools` 检查** | 保留 |
| 10 | `dsh_connector_search_sessions` | 1355-1365 | `query:string` | 否 | C13 | 保留 |
| 11 | `dsh_connector_get_dsh_settings` | 1367-1382 | `namespace:string=""`, `path:string=""`, `include_schema:boolean=False` | 否 | C6；三态拼命令（1379-1381） | 保留 |
| 12 | `dsh_connector_get_providers` | 1384-1390 | 无 | 否 | C26 | 保留 |
| 13 | `dsh_connector_list_skills` | 1392-1398 | 无 | 否 | C28 | 保留 |
| 14 | `dsh_connector_list_workspaces` | 1400-1406 | 无 | 否 | C31 `_workspaces_command("workspaces")` | 保留 |
| 15 | `dsh_connector_set_dsh_setting` | 1408-1420 | `namespace:string`, `path:string`, `value_json:string` | **是（唯一受写开关管制的）** | C7；检查的是 `_llm_mutations_available()`（1417-1419） | **被摘除** |
| 16 | `dsh_connector_list_presets` | 1422-1428 | 无 | 否 | C22 | 保留 |
| 17 | `dsh_connector_list_subagents` | 1430-1436 | 无 | 否 | C29 | 保留 |
| 18 | `dsh_connector_get_goal` | 1438-1444 | 无 | 否 | C34 | 保留 |
| 19 | `dsh_connector_manage_session` | 1446-1461 | `action:string`（switch/rename/fork/new 白名单 1458-1460）, `value:string=""` | **是** | C9/C11/C12/C10 | 保留 |

> **语义不一致点（迁移必须决定）**：`enable_llm_mutation_tools` 名义上是「允许 LLM 修改 DSH 设置」（`<SCHEMA>:8`），实际只拦住了第 15 个工具；`send_prompt`/`create_session`/`set_model`/`set_permission`/`stop`/`manage_session` 这 6 个同样是 mutation 的工具**不受写开关约束**。

---

## §5 配置项 `_conf_schema.json`（清单项 4）

**共 19 项，全部在代码中被真实读取；未发现弃用/未使用项。** 读取点均为 `self._cfg(<key>, <default>)`（`<MAIN>:113-115`，`config.get` 的 None 回落封装）。

| # | 键 | schema 行 | 类型/默认 | 语义 | 代码读取点 | 备注 |
|---|---|---|---|---|---|---|
| 1 | `mode` | 2 | string/http，可选 http/headless/auto | 连接方式 | `<MAIN>:119`（`mode` property，强制 lower） | `headless` 会禁用流式（324）与一切 HTTP 能力（583-585） |
| 2 | `http_base_url` | 3 | string/http://127.0.0.1:3080 | DSH Web API 地址 | `<MAIN>:126`、782（回显） | 拼 `/api/<method>`（`<CLIENT>:68,112`） |
| 3 | `command_timeout` | 4 | int/600 | 单次任务超时（秒） | `<MAIN>:127`（HTTP）、232（headless） | 同时用作 RPC 总超时与轮询 deadline（`<CLIENT>:74,432,448`） |
| 4 | `poll_interval` | 5 | float/1.0 | HTTP 轮询间隔 | `<MAIN>:128` | 轮询 history + 等空闲（`<CLIENT>:438,488`） |
| 5 | `stream_replies` | 6 | bool/true | 实时回传 `assistant/chunk` 增量 | `<MAIN>:323` | **依赖已删事件**；card 模式与 headless 下被忽略（321-326） |
| 6 | `enable_llm_tools` | 7 | bool/false | 注册 LLM 工具 | `<MAIN>:1212` | 同时决定 `on_llm_request` 是否摘工具（1243-1246） |
| 7 | `enable_llm_mutation_tools` | 8 | bool/false | 允许 LLM 写 DSH 设置 | `<MAIN>:1215` | 只作用于 `dsh_connector_set_dsh_setting`（1417-1419,1247-1248） |
| 8 | `max_reply_chars` | 9 | int/4000 | 文本回复截断上限（0=不限） | `<MAIN>:1469` | `_truncate`，追加「…（回复过长，已截断）」（1470-1472） |
| 9 | `reply_chunk_size` | 10 | int/2000 | 文本分片大小（0=不分片） | `<MAIN>:559` | `_chunk_text`（94-98） |
| 10 | `reply_render_mode` | 11 | string/text，可选 text/auto/card | 呈现方式 | `<MAIN>:321`、398 | 判定逻辑 `<RENDER>:16-27` |
| 11 | `card_min_chars` | 12 | int/120 | auto 模式出卡最小字符数 | `<MAIN>:400` | 传给 `should_render_card`（404）；`max(1,·)` 钳位 |
| 12 | `card_max_chars` | 13 | int/6000 | 单卡最大字符数 | `<MAIN>:401` | 传给分卡；再被 `max(500,·)` 钳位（`<RENDER>:35`） |
| 13 | `max_images_per_reply` | 14 | int/4 | 每次回复最多图片数 | `<MAIN>:429`、1289 | `max(0,·)`；LLM 工具另有一处同名读取 |
| 14 | `max_image_bytes` | 15 | int/5242880 | 单图最大字节（远程/data URL） | `<MAIN>:364`、385 | 下载时读 `max+1` 判断超限（375-378） |
| 15 | `image_download_timeout` | 16 | int/20 | 图片下载超时（秒） | `<MAIN>:365` | 仅远程 http(s) |
| 16 | `allow_remote_images` | 17 | bool/true | 是否渲染 http(s) 图片 | `<MAIN>:361` | 关闭时 http(s) 直接丢弃 |
| 17 | `dsh_command` | 18 | string/dsh | dsh 可执行路径 | `<MAIN>:123`（property） | 仅 headless（234） |
| 18 | `dsh_profile` | 19 | string/headless | dsh profile | `<MAIN>:230`、579 | 仅 headless |
| 19 | `dsh_extra_args` | 20 | string/"" | 追加命令行参数（shlex 切分） | `<MAIN>:231` | 切分失败 → `DshError`（237-239） |

**逐键判定结论**：无弃用键、无死键。存在的是**条件失效**：`stream_replies` 在 headless/card 下无效；`dsh_command`/`dsh_profile`/`dsh_extra_args` 在 http/auto（且 HTTP 可用）时无效；`enable_llm_mutation_tools` 的语义范围远小于其描述（§4.2 注）。

---

## §6 DSH RPC 调用点（清单项 5）

### 6.1 `main.py` 中的 RPC 调用点与用途

| # | 客户端方法（`<CLIENT>` 定义行） | `main.py` 调用行 | 用途 |
|---|---|---|---|
| 1 | `describe` → `host.describe`（141-142） | 175（惰性建会话时取主机 cwd）、570（状态查询）、839（建会话取默认 cwd）、860（向导取 host cwd） | 主机自述：provider/model/version/cwd |
| 2 | `list_sessions` → `session.list`（144-146） | 603（会话列表）、990（switch 精确匹配）、1023（delete 匹配/运行态） | 会话枚举 |
| 3 | `search_sessions` → `session.search`（148-149） | 977 | 关键词搜索 |
| 4 | `create_session` → `session.create`（151-166） | 176（首次使用时自动建）、840（向导/`session new`/LLM 工具） | 建会话；workspaceId 优先于 cwd（158-162） |
| 5 | `rename_session` → `session.rename`（168-169） | 1000 | 改标题 |
| 6 | `fork_session` → `session.fork`（171-178） | 1006 | 分叉（可指定 atSeq） |
| 7 | `prompt` → `session.prompt`（180-197） | 418（经 `run_prompt`） | 下发任务；`mode` 与 `clientTimeZone` 在此封装 |
| 8 | `cancel` → `session.cancel`（199-201） | 641（`/dsh stop`）、1062（删除运行中会话前先取消） | 停止当前任务 |
| 9 | `archive_session` → `workspace.archiveSession`（203-206） | 1063 | 从会话列表移除（DSH 保留日志） |
| 10 | `history_value`/`history` → `session.history`（208-222） | 629（`/dsh history`）、1172（`/dsh goal` 读最后 1 条取 projections）、428/452（客户端内部轮询，`<CLIENT>`） | 历史/投影读取 |
| 11 | `models` → `session.models`（224-226） | 651（`_models`，供 `model`/`effort` 共用） | 当前模型 + 可用档位 |
| 12 | `select_model` → `session.selectModel`（228-240） | 198（建会话后套用选项）、671（`/dsh model`/`effort`） | 切换 provider/model/effort |
| 13 | `update_queue` → `session.updateQueue`（242-257） | 1202 | 队列 remove/steer/edit |
| 14 | `attachment` → `session.attachment`（259-267） | 280（经 `resolve_reply_attachments`，被 `<CLIENT>:487,494` 调用） | 取附件字节转 data URL |
| 15 | `settings` → `settings.describe`（292-294） | 913 | 设置命名空间目录 + schema |
| 16 | `permission_presets`（296-316，内部调 `settings.describe`） | 705（`/dsh permission` 列表）、864（向导） | 从 schema refs 反解预设枚举 |
| 17 | `mutate_settings` → `settings.mutate`（318-328） | 953 | `setting set/unset`，带 `expectedRevision` |
| 18 | `providers` → `llm.providers`（330-331） | 1085 | 服务商清单 |
| 19 | `global_models` → `llm.models`（333-334） | 862（向导）、1100（`/dsh global-models`） | 全局模型目录 |
| 20 | `presets` → `agentPreset.list`（336-337） | 739（`preset list`）、861（向导） | Agent Preset 清单 |
| 21 | `select_preset` → `agentPreset.select`（339-346） | 756 | 切当前会话 preset |
| 22 | `read_preset` → `agentPreset.read`（348-349） | 748 | 读 preset 内容 |
| 23 | `skills` → `skill.list`（351-352） | 1113 | Skills 清单 |
| 24 | `subagents` → `subagent.list`（354-355） | 1131 | 子代理清单 |
| 25 | `interrupt_subagent` → `subagent.interrupt`（357-364） | 1129 | 中断子代理（固定 `mode="continuable"`） |
| 26 | `workspaces` → `workspace.list`（366-367） | 863（向导）、1158（列表） | 工作区清单 |
| 27 | `create_workspace` → `workspace.create`（369-370） | 1149 | 建工作区 |
| 28 | `rename_workspace` → `workspace.rename`（372-379） | 1156 | 改工作区标题 |
| 29 | `goal_action` → `goal.<action>`（381-404） | 1179（create）、1181（pause/resume/complete/clear，带 `{id,revision}`） | Goal 生命周期 |
| 30 | `execute_command` → **`commands/execute`**（93-139） | 201（建会话后下发 `/permission`）、712（`/dsh permission <预设>`） | 走 Typert 命令面执行斜杠命令 |
| 31 | `run_prompt`（406-425，编排 `session.list` 等空闲 → `_last_seq`(history) → `prompt` → `_await_reply`(history 轮询)） | 220（`_run_http` 唯一出口） | 单次任务的下发+收敛 |
| 32 | `_wait_idle`（431-439，轮询 `session.list` 看 `running`） | 经 `run_prompt`（416） | 队列模式下先等会话空闲 |
| 33 | `_await_reply`（441-495，轮询 `session.history`） | 经 `run_prompt`（425） | 收敛回复/流式增量/错误/超时 |
| 34 | `resolve_reply_attachments`（269-290） | `<CLIENT>:487,494` | 附件→data URL 后处理 |

### 6.2 传输层统一出口（`<MAIN>`）

| 通道 | 行号 | 说明 |
|---|---|---|
| `_run_http` | 209-227 | 每次调用新建 `aiohttp.ClientSession`；取/建会话 → 读选项 → `run_prompt` |
| `_run_headless` | 229-257 | `dsh --profile <p> [extra] <文本>`；超时 kill（245-251）；非 0 退出码抛错（255-256） |
| `_spawn` | 259-280 | Windows 下对无扩展名命令依次尝试 `.cmd`/`.exe`/`.bat`（263-265）；找不到时报「请设置 dsh_command」（276-279） |
| `_run` | 282-292 | mode 分派；`auto` 仅在 `DshConnectionError` 时回退 headless（288-291） |
| `_active_http_session` | 587-596 | 返回**未关闭**的 ClientSession，调用方必须在 `finally` 关闭（629-631,640-643,652-654,671-673,712-718,1112-1115,1126-1133,1170-1185,1200-1204） |

### 6.3 ⚠️ 与已安装 DSH 的 RPC 面比对（迁移关键）

**已安装 DSH 的真实 RPC 目录**（从 `<DSHNPM>\dsh-api-remotes\lib\client.js` 的 84 条远程描述符解析出的 `namespace.method`）：`agentPresets.{copy,deletePreset,list,read,select}`、`commands.{execute,list}`、`credentials.*`、`directoryPicker.*`、`dynamicCordisRunner.*`、`fileReferences.list`、`fileUploads.upload`、`goals.{clear,complete,create,edit,get,pause,resume}`、`llm.{discoverModels,listConfigurableProviders,listProviders}`、`messageFeedback.*`、`pluginInventory.list`、`session.{attachment,cancel,canOpenWorkspacePath,control,create,follow,fork,list,modelCatalog,openWorkspacePath,page,prompt,rename,search,selectModel,updateQueue}`、`sessionFeedback.record`、`settings.{canOpenAgentPresetDirectory,describe,mutate,openAgentPresetDirectory,openSettingsDocument,replace,update}`、`skills.list`、`subagents.{interruptByParent,list,prompt}`、`workspace.{archiveSession,create,delete,follow,insertBefore,insertSessionBefore,rename}`、`workspaceFiles.*`。

**逐名比对**（✓=存在；✗=插件所用名字在目录中不存在）：

| 插件调用名 | 已装 DSH 目录 | 判定 |
|---|---|---|
| `host.describe` | 无 `host.*` | ✗ |
| `session.list` / `session.search` / `session.create` / `session.rename` / `session.fork` / `session.prompt` / `session.cancel` | 同名 | ✓ |
| `session.history` | 无；有 `session.page` | ✗ |
| `session.models` | 无；有 `session.modelCatalog` | ✗ |
| `session.selectModel` / `session.updateQueue` / `session.attachment` | 同名 | ✓ |
| `workspace.archiveSession` / `workspace.create` / `workspace.rename` | 同名 | ✓ |
| `workspace.list` | **无任何 workspace 列表方法** | ✗ |
| `settings.describe` / `settings.mutate` | 同名 | ✓ |
| `llm.providers` / `llm.models` | 无；有 `llm.listProviders` / `llm.discoverModels` | ✗ |
| `agentPreset.list` / `agentPreset.read` / `agentPreset.select` | 无；有 `agentPresets.list` / `.read` / `.select`（**复数**） | ✗ |
| `skill.list` | 无；有 `skills.list` | ✗ |
| `subagent.list` / `subagent.interrupt` | 无；有 `subagents.list` / `subagents.interruptByParent`（**复数 + 不同参数**） | ✗ |
| `goal.create|pause|resume|complete|clear` | 无；有 `goals.*`（**复数**） | ✗ |
| `commands/execute` | `commands.execute`（端点写作 `commands/execute`） | ✓（**唯一线上格式正确的一处**） |

**两处更硬的协议事实**（`<DSHNPM>\dsh-api-gateway\lib\index.js`）：

1. `/api/<endpoint>` 的端点必须是 **`<namespace>/<method>` 两段斜杠形式**，且载荷必须是 **`{"args": {...}}`** 单键对象：
   - `dispatchRpc` 只特判 `$events/result`，其余全部走 `invokeRpc`（`:566-580`）→ `remoteRequest`（`:925-936`）：
     - `:926-928` `endpoint.split("/")` 必须**恰好 2 段**，否则抛 `invalid Remote endpoint`；
     - `:929` 载荷必须**恰好** `{args: <plain object>}`。
   - 而 `<CLIENT>:61-91` 的通用 `rpc()` 用的是**点号方法名 + 扁平载荷**（`url = /api/session.prompt`，`payload = {"sessionId":..., "content":...}`），只有 `execute_command`（`<CLIENT>:106-111`）用了斜杠端点 + `args` 包装。
2. `/api` 前缀路由**先过认证栅栏**（`<DSHNPM>\dsh-client-connection\lib\index.js:768-781`）：
   - `:772` `const rejection = connection.requestRejection(req);` → `:553-556` `isTrustedApiRequest`（`:201-215`，要求 Host 回环或受信，且 Origin 同源）不通过返回 **403**；通过后再要求 `browserAuth.isAuthenticated(request)`（`:431-441`：必须是本进程签名、绑定 authority、未过期的 **Cookie**），否则 **401**。
   - 插件全仓检索 `cookie`/`token`/`Authorization` **零命中**（仅 `<RENDER>:57,60,61` 的正则变量名叫 token），即插件**从不携带任何凭据**。

> 结论：把插件指向当前已安装 DSH 的 `http://127.0.0.1:3080`，会在 `/api` 前缀处先被 **401** 拦下；即使绕过认证，`<CLIENT>:61-91` 的所有点号方法调用也会在 `remoteRequest` 处因「端点段数≠2 / 载荷缺 args」失败。仅 `commands/execute` 的线上格式是对的。

---

## §7 KV 存储（清单项 6）

### 7.1 键格式与读写点

| 键模板（确切格式） | 值结构 | 写点 | 读点 | 删点 |
|---|---|---|---|---|
| `dsh_session:{chat_key}` | 字符串（DSH sessionId） | `<STATE>:35`（`put_kv_data`） | `<STATE>:23`（`get_kv_data`，默认 None） | `<STATE>:40`（`delete_kv_data`） |
| `dsh_session_options:{chat_key}` | **归一化后的字典对象**（8 个键，见 7.2），以 dict 原样交给 KV | `<STATE>:79`（`save_options`）、`:91`（`clear_options`） | `<STATE>:61` | 无（`clear_options` 只是**写入默认值**，不删记录） |
| `dsh_option:{key}:{chat_key}` | 字符串（单字段） | `<STATE>:53` | `<STATE>:46` | 无 |
| `dsh_option:agent_preset:{chat_key}` | 字符串（旧格式回退） | 无 | `<STATE>:68`（仅当 `dsh_session_options:*` 为空时） | 无 |

- **`chat_key` 的确切来源**：`_chat_key()`（`<MAIN>:133-135`）= `event.unified_msg_origin` → 否则 `event.session_id` → 否则 `str(event.get_sender_id())`。因此实际键形如 `dsh_session:default:FriendMessage:1000000001`（`unified_msg_origin` 的三段式）或退化形式。任务书给出的示例与 `unified_msg_origin` 形状一致，但**插件本身不构造该字符串**，只是把它当不透明键拼接——源码中无任何硬编码前缀样例可引证。
- `dsh_option:{key}:{chat_key}` 这条通道**生产代码从不写入**：`save_option`（`<STATE>:51-53`）与 `load_option`（`:42-49`）在 `<MAIN>` 中**零调用**（全仓 `grep load_option(|save_option(` 只命中定义处）→ 死代码 + 旧数据兼容读路径。

### 7.2 值结构（选项字典）

`<OPTS>:11-20` 定义 8 个字段：`workspace_id`、`working_directory`、`agent_preset`、`provider`、`model`、`reasoning_effort`、`permission_preset`、`client_time_zone`；`default_session_options()`（`<OPTS>:37-47`）给出默认值（时区默认 `normalize_client_time_zone()`，Windows 中文环境会映射为 `Asia/Shanghai`，见 `<CLIENT>:32-50`）。

### 7.3 进程内缓存模型（`<STATE>`）

| 缓存 | 定义行 | 行为 |
|---|---|---|
| `session_cache: dict[str,str]` | 14 | `load_session` 命中即返回（18-19）；`save_session` 先写缓存（33）；`clear_session` 先弹缓存（38） |
| `options_cache: dict[str,dict]` | 15 | `load_options` 命中返回**浅拷贝**（56-57）；`save_options`/`clear_options` 覆盖（77,89） |

- 持久化是**尽力而为**：`load_session` 无 `get_kv_data` 或异常均返回 None（20-25）；`_save_session_id` 捕获异常仅告警（`<MAIN>:140-144`）；`_clear_session_id` 静默吞掉（`<MAIN>:146-150`）。
- **`terminate()` 只清 `session_cache`，不清 `options_cache`**（`<MAIN>:1476` vs `<STATE>:15`）。
- 选项 → 会话的下发时机：`_configure_session_options`（`<MAIN>:186-205`）在建会话后立即 `selectModel` + `/permission`；`/dsh model`、`/dsh permission`、`/dsh preset select` 会**同时**改 DSH 会话与 KV 选项（675-683、719-723、760-764），即「当前会话」与「下个新会话」在这三处被绑定成同一份状态。

---

## §8 图片与 attachment 管线（清单项 7）

### 8.1 图片来源判定顺序（端到端）

| 阶段 | 位置 | 做的事 |
|---|---|---|
| ① 内容块解析 | `<HELP>:29-57` | 取 `event.data.message.content`（`data.content` 回退，38）；`type∈{text,markdown}` 且 `text` 为 str → 收文本，并用 `MARKDOWN_IMAGE_RE`（`<HELP>:10`，正则 `!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)`）抽 **markdown 链接**（48-51）；再对同一 block 调 `_collect_image_sources`（52） |
| ② 块级递归收集 | `<HELP>:100-119` | dict 含 `attachmentId` → 立即产出 `dsh-attachment:<id>` 并**停止下钻**（111-114）；str 且（`image_hint` 或前缀为 `data:image/`/`http://`/`https://`/`file://`）→ 收录（101-104）；list 递归（105-108）；dict 按键名递归，命中 `{url,uri,src,source,image,image_url,file,path,attachment,attachments}` 时打开 `image_hint`（115-119） |
| ③ 文本兜底重扫 | `<HELP>:54-56` | 拼接后的整段文本再跑一次 markdown 正则（与 ① 重复，去重后无害） |
| ④ 去重与顺序 | `<HELP>:122-127` | `_append_unique` 先去空白与 `<>`，保序去重 → 最终顺序 = **markdown 链接（文本内出现顺序）→ 块级 image/attachment（块顺序）**；`<TESTS>:32-41` 锁定了这个顺序 |
| ⑤ attachment 解析 | `<CLIENT>:269-290` | `dsh-attachment:` 前缀 → `session.attachment` RPC → `data:<mediaType>;base64,<data>`；单项失败**静默跳过**（281-282）；非 attachment 源保序去重（274-277） |
| ⑥ 下载/落盘 | `<MAIN>:339-382` | 按 scheme 分流（见 8.2） |
| ⑦ 组装消息 | `<MAIN>:424-434` | 文本先出，再 `reply.image_sources[:max_images_per_reply]`，成功者 `Image(file=image_path)`（433） |

### 8.2 `_download_image` 的分支顺序与限额（`<MAIN>:339-382`）

| 顺序 | 判定 | 行号 | 行为 |
|---|---|---|---|
| 1 | 空串 | 341-343 | 返回 None |
| 2 | `data:image/` 前缀 | 344-352 | 头/体分割 → base64 严格解码（`validate=True`）→ `_write_temp_image`；解码失败告警并返回 None（350-352） |
| 3 | `file:` scheme | 355-357 | 转本地路径，`is_file()` 才返回，否则 None |
| 4 | 无 scheme | 358-360 | 当本地路径处理，`is_file()` 才返回 |
| 5 | 非 http/https，或 `allow_remote_images` 为假 | 361-362 | 丢弃（None） |
| 6 | http(s) | 364-382 | `max_image_bytes`（364）、`image_download_timeout`（365）；HTTP≠200 → 告警丢弃（369-371）；content-type 非 `image/` → 丢弃（372-374）；`read(maximum+1)`（375）；超限告警丢弃（376-378）；异常（ClientError/TimeoutError/OSError）告警丢弃（380-382） |

### 8.3 临时文件与清理点

| 环节 | 行号 | 说明 |
|---|---|---|
| 创建 | 384-394 | `max_image_bytes` 二次校验（385-387）；`mimetypes.guess_extension(mime) or ".png"`（388）；`tempfile.mkstemp(prefix="astrbot-dsh-", suffix=...)`（389）；写入后登记到 `self._temp_media: set[Path]`（109 定义 / 393 登记） |
| **清理（唯一）** | `<MAIN>:1474-1482` | `terminate()` 逐个 `unlink(missing_ok=True)`，`OSError` 静默，最后 `clear()` |
| 缺口 | — | **没有**逐条回复后的清理；`_reply_chain` 每次调用都新增临时文件，直到插件禁用/卸载才统一删除。长跑实例会持续堆积临时文件 |

### 8.4 AstrBot `Image` 组件的构造方式

| 场景 | 代码 | 实际构造 |
|---|---|---|
| t2i 出卡（URL） | `<MAIN>:414-416` | `Image.fromURL(url)` → `<ASTROOT>\astrbot\core\message\components.py:511-514`：仅接受 `http(s)://`，返回 `Image(file=url)` |
| t2i 出卡（本地/其它） | `<MAIN>:414-418` | `Image.fromFileSystem(path)` → `components.py:517-519`：`Path.resolve()` 后转成 **file:// URI**（同时填 `path`） |
| DSH 图片/attachment | `<MAIN>:433` | `Image(file=image_path)`——直接传**裸 Windows 路径**（来自 `mkstemp`），**未经** `fromFileSystem` 归一化 |
| 文本 | `<MAIN>:405,421,560` | `Plain(text)` / `event.plain_result(...)` |
| 图片合并发送 | `<MAIN>:562` | `event.chain_result(image_parts)` |

> 迁移注意：`Image(file=<裸路径>)`（433）与 `Image.fromFileSystem`（517-519 转 `file://`）是两种不同约定；跨平台/新插件应统一走 `fromFileSystem`。

---

## §9 Markdown / 卡片渲染管线（清单项 8）

`<RENDER>` 全文仅 69 行，逐函数列出：

| 函数/常量 | 行号 | 行为 |
|---|---|---|
| `RENDER_MODES` | 8 | `("text","auto","card")` |
| `_RICH_MARKDOWN` | 9-12 | 多行正则，命中即视为「富 Markdown」：`^#{1,6}\s`（标题）、`^\s*(?:[-*+]\s|\d+[.)]\s)`（列表）、`^>\s`（引用）、`^\|.+\|\s*$`（表格行）、`` ``` ``/`~~~`（围栏）、`$$`（公式）、`![...](`（图片） |
| `_FENCE` | 13 | `^\s*(`{3,}|~{3,})(.*)$`，抓围栏 token 与信息串 |
| `normalize_reply_render_mode` | 16-18 | 非三者之一一律回落 `"text"`（大小写不敏感） |
| `should_render_card` | 21-27 | `card` → 只要 `markdown.strip()` 非空就出卡（23-24）；`text` → 永不出卡（26）；`auto` → `len(strip) >= max(1,minimum)` **或** `_RICH_MARKDOWN.search()` 命中（27）→ **出卡阈值 = 字符数阈值 OR 富 Markdown**，两者是「或」关系 |
| `split_markdown_for_cards` | 30-69 | 分卡算法（见下） |

**分卡算法逐行**（`<RENDER>:35-69`）：
1. 空文本 → `[]`（33-34）。
2. `limit = max(500, int(maximum_chars or 6000))`（35）——**下限 500 硬钳位**（配置 `card_max_chars` 也被 `<MAIN>:401` 先钳一次）。
3. 不超过 limit → 单卡原样返回（36-37）。
4. 按 `splitlines(keepends=True)` 逐行累积（44）；若追加该行会超限（`buffer and len(buffer)+len(line) > limit`，45）：
   - **在围栏内**：先把当前 buffer 收尾（`buffer.rstrip() + "\n" + close_fence`）成卡，然后**用起始围栏行重新开 buffer**（`buffer = opened_fence + "\n"`），使下一段代码块自动带上同一个开围栏（46-48）→ 这是「保留代码围栏完整」的核心手法；
   - **不在围栏内**：直接 flush 当前 buffer 并清空（50-51）。
5. 追加当前行后维护围栏状态（53-63）：未开则记 `opened_fence = line.rstrip()`、`close_fence = token[0] * len(token)`（58-60）；已开且字符相同且长度不短于关闭串 → 关闭（61-63）。
6. 收尾：buffer 非空时，若仍在围栏内则补一段关闭围栏（66-67），再作为最后一卡（68）。
7. 效果（`<TESTS>:141-147` 断言）：每张卡内 ``` 计数为偶数，即**每卡代码围栏自闭合**。

**三模式判定与调用链**（`<MAIN>:396-422`）：
- `mode = normalize_reply_render_mode(cfg("reply_render_mode","text"))`（398）；`card_min_chars`/`card_max_chars` 带 `max(1,·)`/`max(500,·)` 钳位（400-401），`TypeError/ValueError` 回落 `120/6000`（402-403）。
- `should_render_card(mode, text, minimum)` 为假 → `[Plain(text)]`（404-405）——即 text/auto 未达阈值都走纯文本。
- 出卡：逐卡 `await self.text_to_image(card_markdown)`（410）。该 API 来自 AstrBot：`<ASTROOT>\astrbot\core\star\base.py:77` `async def text_to_image(self, text, return_url=True) -> str`，内部走 `html_renderer.render_t2i(text, return_url=..., template_name=cfg["t2i_active_template"])`（`base.py:79-90`）→ 即**复用 AstrBot 当前的 t2i 模板/端点**（README `<README>:130` 亦如此声明）。
- t2i 返回空 → 主动抛 `RuntimeError`（411-412）；返回 http(s) → `Image.fromURL`，否则 `Image.fromFileSystem`（414-418）。
- **任何异常 → 记 warning 并整条回退为 `[Plain(text)]`（419-422）**——注意是整条文本回退，不是逐卡回退。
- `rendered or [Plain(text)]` 兜底（422）。
- **card 模式禁用流式**：`_stream_replies_enabled` 要求 `render_mode != "card"`（319-326），注释写明是为避免「流式 step 与最终 card 重复输出」（320），对应 `<CHANGELOG>:5`。

---

## §10 流式回复（清单项 9）

| 环节 | 行号 | 说明 |
|---|---|---|
| 开关判定 | `<MAIN>:319-326` | `stream_replies=True` **且** `mode != "headless"` **且** `reply_render_mode != "card"` |
| 驱动 | `<MAIN>:294-317` | `asyncio.Queue`（296，**无界、无背压**）；`on_chunk` 入队（299-300）；`_run` 作为 Task 启动（302）；`add_done_callback` 在结束时投 `None` 作为哨兵（303） |
| 首块等待 | `<MAIN>:305-307` | 阻塞等第一个元素；若直接是 `None`（任务已完成且无增量）→ 返回完整回复 + `""`，**完全不进入 send_streaming** |
| 发送 | `<MAIN>:309-316` | 生成器逐块 `MessageChain([Plain(current)])`；`await event.send_streaming(stream(), use_fallback=True)`（316） |
| 去重 | `<MAIN>:328-337` | `_unstreamed_text(reply_text, streamed_text)`：全等→空串（333-334）；前缀匹配→去掉已发部分并 lstrip 换行（335-336）；否则整段重发（337） |
| 调用点 | `<MAIN>:530-536` | 仅此一处；随后用去重结果重建 `DshReply`（533-536，图片源继承） |

**依赖 `assistant/chunk` 的确切代码位置**（`<CLIENT>:441-495` 的 `_await_reply`）：

- 轮询 `session.history`（452）取窗口内所有事件；
- `<CLIENT>:459` `if event_type == "assistant/chunk":`
- `<CLIENT>:460-462` 取 `seq`，再从 `event.data.chunk` 取 `chunk.text`，且**要求 `chunk.type == "text-delta"`**，否则 `chunk_text=None`；
- `<CLIENT>:463-469` 条件：`on_chunk` 存在 **且** 该 `seq` 未发送过（`emitted_chunk_sequences`，450 定义）**且** `chunk_text` 非空 str → 记录 seq 并回调；
- `<CLIENT>:470-472` 支持同步/异步回调（`inspect.isawaitable`）。
- 回归测试：`<TESTS>:229-255`（同一 seq 只发一次）；上层串流测试：`<TESTS>:390-420`。

### 平台降级路径（AstrBot 侧）

| 平台 | 位置 | `use_fallback=True` 时的行为 |
|---|---|---|
| aiocqhttp | `<ASTROOT>\astrbot\core\platform\sources\aiocqhttp\aiocqhttp_message_event.py:199-234` | 非 fallback 时整段缓冲合并后一次发（205-215）；**fallback=True 时按句子缓冲**：累积 `Plain` 文本，遇 `。？！~…` 就切句发送（217-226），非 Plain 组件单独发且 `sleep(1.5)` 限速（227-229），尾巴再发一次（231-233） |
| qq_official | `<ASTROOT>\astrbot\core\platform\sources\qqofficial\qqofficial_message_event.py:109-144` | 注释明写「流式输出仅支持消息列表私聊（C2C），其他消息源退化为普通发送」（110）；非 C2C 场景直接累积到 `send_buffer` 最后统一发（125-131）；C2C 走 `state=1/10` 分片协议（113-114,136-144） |
| 其它平台 | 各平台自己的 `send_streaming` 覆写（`<ASTROOT>` 内 `discord_platform_event.py:104`、`lark_event.py:938`、`line_event.py:249`、`mattermost_event.py:32`、`misskey_event.py:129`、`satori_event.py:185`、`dingtalk_event.py:31` 等） | 本次未逐行核实（列入 §15） |
| 插件自述 | `<README>:134` | 「QQ 官方私聊和 Telegram 会实时更新回复，aiocqhttp 会按句子分段发送。通过 `stream_replies` 可关闭」 |

---

## §11 多 step 回复收敛（清单项 10）

**为什么只取最后一个 `assistant/message`**（`<CHANGELOG>:6`：多 step 任务只使用最后一个已定稿的 `assistant/message` 作为最终回复；`<CHANGELOG>:5`：card 模式关闭实时增量以避免「流式 step + 最终 card」重复）。

**代码位置与判定逻辑**（`<CLIENT>:441-495`）：

1. 轮询窗口：每次 `session.history(max_messages=100)`（452）。
2. 逐事件扫描（454-480），只处理 `seq > baseline` 的事件（456-457；`baseline` 由 `_last_seq` 在发 prompt **之前**取，`<CLIENT>:417,427-429`，`max_messages=5`）。
3. `assistant/message` → **直接覆盖** `last_reply = assistant_reply(event)`（478）。注释 474-477 明确：DSH 每个 provider/tool step 会定稿一条 assistant message，**最后一条**才是本轮结果，早期的是中间步骤输出，不能并进最终卡片。
4. `turn/end` → 只记 `reason`（479-480），**不 break**；for 循环跑完后才判定（481-487）。
   - ⚠️ 因此在一个窗口内，若存在 `turn/end` **之后**的 `assistant/message`（同批返回），后者仍会覆盖 `last_reply`，再用已捕获的 `reason` 返回（487）。判定依据是**迭代顺序中的最后一条**，而非 `max(seq)` 或 `data.step`。
5. `reason.kind == "error"` → 抛 `DshError`（482-486）；否则 `return await self.resolve_reply_attachments(..., last_reply)`（487）。
6. **超时路径**（489-494）：若 `last_reply` 有内容，返回「正文 + `任务等待超时，DSH 可能仍在后台运行。`」并保留图片源；否则抛 `DshTimeout`（495）。

**与之对照的另一种收敛**：`merge_replies`（`<HELP>:60-75`）会把窗口内**所有** `assistant/message` 用 `\n` 拼接——它只被 `/dsh history` 使用（`<MAIN>:634`），主任务路径**不用**它。`/dsh goal` 则用 `history_value(max_messages=1)` 取最后一条的 projections（`<MAIN>:1172`）。

**回归测试**：`<TESTS>:257-283`（step1「step progress」+ step2「final answer」，断言结果为 `final answer`）。

---

## §12 卸载清理 `terminate()`（清单项 11）

`<MAIN>:1474-1482`：

| 动作 | 行号 | 说明 |
|---|---|---|
| 清会话缓存 | 1476 | `self._state.session_cache.clear()` |
| 删临时图片 | 1477-1481 | 遍历 `self._temp_media`，`unlink(missing_ok=True)`，`OSError` 静默 |
| 清集合 | 1482 | `self._temp_media.clear()` |

**资源面盘点**：

| 资源 | 是否存在 | 证据 |
|---|---|---|
| 后台任务（`asyncio.create_task`） | 有 1 处：流式包装任务（`<MAIN>:302`）。**`terminate()` 不取消它**，也无 `task.cancel()`/await；只在自身结束回调里投哨兵（303） | `<MAIN>:302-303,1474-1482` |
| 定时器/周期任务 | **无**（无 `asyncio.sleep` 循环、无 `ctx` 调度注册、无 `add_job`） | 全仓无相关调用；轮询 sleep 只在 `<CLIENT>:438,488` |
| 连接池 | **无**长期池：所有 `aiohttp.ClientSession` 都是按次创建/`async with`（`<MAIN>:217,569,590,602,704,738,833,859,912,976,1022,1060,1084,1099,1147` 等），`_active_http_session`（587-596）返回的会话由调用方 `finally` 关闭 | 同上 |
| 临时文件 | 有，仅 `terminate()` 统一清理（见上表）；**无逐次清理** | `<MAIN>:384-394,1477-1482` |
| 子进程 | headless 模式下按次创建（`<MAIN>:269-273`），超时分支 kill（246-250）；无常驻子进程 | — |
| KV 缓存 | `session_cache` 清了（1476）；**`options_cache` 未清**（`<STATE>:15`） | — |
| 事件/回调注册 | 无手动注册，全部依赖 AstrBot 装饰器 | — |
| `session_waiter` 等待器 | 由 AstrBot 管理；向导/删除流程各自 `finally: event.stop_event()`（`<MAIN>:903-904,1078-1079`） | — |

---

## §13 测试基线 `tests/test_dsh_connector.py`（清单项 12）

共 **32 个测试**，4 个测试类。该文件是迁移时的**回归清单**：每条一句说明。

**准备代码**：`sys.path.insert(0, parents[1])`（`<TESTS>:5`）；`CaptureClient` 覆写 `rpc` 记录 `(method,payload)` 并返回固定值（15-22）。

### `DshConnectorHelperTests`（25-147，12 个）

| 测试 | 行 | 覆盖行为 |
|---|---|---|
| `test_help_lists_session_delete_command` | 26-30 | HELP_TEXT 必须含 `/dsh help` 与 `/dsh session delete [id]` |
| `test_assistant_reply_keeps_text_and_distinct_images` | 32-41 | 文本保留 + markdown 链接与块级 url 两类图片按序去重收集 |
| `test_merge_replies_only_reads_new_assistant_events` | 43-49 | `merge_replies(after_seq)` 只合并新 seq 的 `assistant/message`，忽略 user 事件 |
| `test_assistant_reply_tags_native_dsh_attachments` | 51-56 | 含 `attachmentId` 的块转为 `dsh-attachment:<id>` |
| `test_model_rows_include_reasoning_efforts` | 58-60 | `session.models` 分组展平，含 `provider_name`/`name`/`efforts` |
| `test_settings_path_helpers_keep_json_types` | 62-68 | `namespace_map`/`dotted_path`/`parse_json_value`/`read_path` 保类型 |
| `test_session_setup_wizard_builds_per_chat_options` | 70-95 | 无工作区时 7 步全流程（目录→preset→model→effort→permission→tz→y）产出完整 8 字段选项 |
| `test_session_setup_lists_and_selects_live_workspace_and_permissions` | 97-123 | 有工作区时 8 步流程；工作区经 `workspaceId` 选中后 `working_directory` 必须为空 |
| `test_directory_and_workspace_options_are_mutually_exclusive` | 125-131 | 归一化时 workspace 取胜并清 cwd |
| `test_invalid_saved_timezone_falls_back_to_utc` | 133-135 | 存了「中国标准时间」→ 归一为 `Asia/Shanghai`（Windows 名称映射） |
| `test_explicit_iana_timezone_is_preserved` | 137-139 | `Asia/Shanghai`/`UTC` 原样保留 |
| `test_card_split_preserves_fenced_code_blocks` | 141-147 | 160 行代码块按 600 分多卡且每卡围栏自闭合；auto 模式遇围栏必出卡；text 模式永不出卡 |

### `DshClientPayloadTests`（150-331，11 个，`IsolatedAsyncioTestCase`）

| 测试 | 行 | 覆盖行为 |
|---|---|---|
| `test_execute_command_uses_typert_remote_wire` | 151-195 | `commands/execute` 的 URL/`method`/`payload={"args":{agentId,line}}` 线上格式，且 `kind:"error"` 才抛错 |
| `test_permission_presets_are_read_from_live_schema_shape` | 197-214 | 从 `settings.describe` 的 schema `refs`/`uid`/`union.list` 反解出权限枚举 |
| `test_create_session_prefers_workspace_id` | 216-222 | 同时给 cwd 与 workspaceId 时，载荷**只含** `workspaceId` |
| `test_archive_session_uses_dsh_workspace_api` | 224-227 | `workspace.archiveSession + {sessionId}` |
| `test_history_streams_each_new_text_delta_once` | 229-255 | `assistant/chunk` 的 `text-delta` 每 seq 只回调一次，终态取 `assistant/message` 文本 |
| `test_history_returns_only_last_assistant_message_from_multi_step_turn` | 257-283 | 多 step 只取最后一个 `assistant/message` |
| `test_prompt_uses_dsh_compatible_iana_time_zone` | 285-289 | `session.prompt` 载荷含归一化后的 `clientTimeZone` |
| `test_settings_mutation_uses_revision_and_path_operation` | 291-298 | `settings.mutate` 的 `{ns,ops:[{op,path,value}],expectedRevision}` |
| `test_queue_and_goal_payloads_follow_dsh_contract` | 300-311 | `session.updateQueue` 的 `action.kind/content`；`goal.pause` 的 `ref={id,revision}` |
| `test_attachment_payload_uses_owning_session` | 313-318 | `session.attachment` 用**所属** sessionId + attachmentId |
| `test_native_attachment_resolves_to_renderable_data_url` | 320-331 | attachment → `data:<mediaType>;base64,<data>` |

### `DshSessionStateTests`（334-372，2 个）

| 测试 | 行 | 覆盖行为 |
|---|---|---|
| `test_session_state_persists_and_reuses_chat_binding` | 335-354 | `save/load/clear_session` 走 KV，clear 后为 None |
| `test_session_options_are_isolated_by_chat` | 356-372 | 两个 chat 的 `working_directory` 互不污染 |

### `DshConnectorImageTests`（375-492，7 个）

| 测试 | 行 | 覆盖行为 |
|---|---|---|
| `test_card_mode_uses_only_completed_reply_path` | 376-388 | card 模式必须关闭流式；text 模式必须开启 |
| `test_stream_reply_forwards_dsh_chunks_to_astrbot` | 390-420 | `_stream_reply` 逐块交给 `send_streaming`，且 `use_fallback=True`；返回的 streamed 文本正确 |
| `test_streamed_final_text_is_not_sent_twice` | 422-427 | `_unstreamed_text` 全等→空、前缀→余量、其它→原文 |
| `test_card_mode_uses_astrbot_t2i_and_keeps_image_component` | 429-444 | card 模式经 `text_to_image` 出 `Image` 组件，且 `file` 为 t2i 返回的 URL |
| `test_card_mode_falls_back_to_plain_text_when_t2i_fails` | 446-457 | t2i 抛异常 → 回退 `Plain` 原文 |
| `test_data_url_becomes_an_astrbot_image_component` | 459-476 | data URL → 真实落地临时文件 → 第二个组件是 `Image` |
| `test_llm_setting_mutation_tool_has_separate_gate` | 478-492 | 只开 `enable_llm_tools` 时，`on_llm_request` 恰好摘掉 `dsh_connector_set_dsh_setting` |

**测试覆盖的空白（迁移时必须补）**：`dsh()` 一级/二级分发树、`_download_image` 的限额与失败分支、`terminate()` 的临时文件清理、向导超时/取消/非法输入路径、`session delete` 二次确认流程、任何真实 HTTP/网关集成、headless 模式、`_truncate`/`_chunk_text` 边界、19 个 LLM 工具中除写开关外的其余 18 个。**注意：没有任何测试会真正发出 HTTP 请求**，`CaptureClient` 一律覆写 `rpc`（`<TESTS>:20-22`），因此 §6.3 的协议不匹配不会被现有测试发现。

---

## §14 迁移清单（按三类归档）

### §14.0 三个前置结论（回答额外问题）

**Q1：哪些能力强依赖 `assistant/chunk` 事件？**（修订：该事件**并未被删除**，它在 `KNOWN_SESSION_EVENT_TYPES` 内，是活事件；见本小节末行的更正）
只有一条链路，但它是主路径之一：**`stream_replies` 实时增量回传**。链路为 `<MAIN>:294-326`（`_stream_reply`/`_stream_replies_enabled`）→ `<MAIN>:530-536`（主任务路径调用）→ `<CLIENT>:406-425`（`run_prompt(on_chunk=...)`）→ **`<CLIENT>:459-472`（`event_type == "assistant/chunk"` + `chunk.type == "text-delta"` + 按 seq 去重回调）** → `<CLIENT>:470-472`（回调）→ `<MAIN>:316`（`event.send_streaming`）。
已安装 DSH 中该事件**只作为 v0 老格式存在**：`<DSHNPM>\dsh-session-format-v0-to-v1\lib\index.js:37`（老格式 disposition 声明）、`<DSHNPM>\dsh-session-format-v1-to-v2\lib\index.js:6`（新版 retained 明确把 `assistant/chunk` 过滤掉）【**更正**：`assistant/chunk` 在 `dsh-session\lib\types\known-event-types.js` 的 51 项 `KNOWN_SESSION_EVENT_TYPES` 内，是活事件；此处过滤属 v0→v2 的存储格式迁移，不等于事件被删】、`:15`（`assistant/message` 新增 `stream` 成员）、`:10`（新增 `assistant/attempt`）、`:820`（报错文案直接写 "targets consumed assistant/chunk"）。
**迁移含义**：流式改挂 `session/event` → `assistant/chunk`（`chunk.type == "text-delta"`）即可，`assistant/chunk` **是活事件而非已删除**；`agent/assistant-stream` 在本机 0.1.2-rc.1 **不存在**（全树扫描证伪）。持久侧 `assistant/message` 的 `stream` 成员仍可用作完成判定。
其余能力（命令、选项、图片、卡片、KV）**都不依赖** `assistant/chunk`：`stream_replies=false`、headless、或 card 模式下该链路根本不进入。

**Q2：哪些能力强依赖 DSH 的 `/api` RPC 面（跨机部署会失效）？**
**除「本地 KV/渲染/图片落盘」外的全部能力**都强依赖 `/api`，因为它们要么走 `session.*`、要么走 `settings.*`、要么走 `commands/execute`。具体三档：
- **完全无法离开 `/api`**：C2/C4/C6-C35（会话、模型、权限、设置、Skills、Subagents、Goal、Workspaces、历史、队列、停止）与 C38/C39（主任务）——这些在 headless 模式下要么被 `_require_http()` 硬拒（`<MAIN>:583-585`），要么根本没有实现。
- **跨机额外失效点（即使 DSH 在别的机器上能连通）**：`/api` 前缀路由先做 `requestRejection`（`<DSHNPM>\dsh-client-connection\lib\index.js:768-781`）：非回环 Host 必须在 `trustedHosts` 内，否则 **403**（`:201-215`，`:553-556`）；通过后还要求**本进程签名、绑定 authority 的 Cookie**，否则 **401**（`:431-441`）。插件不发送任何凭据（全仓无 cookie/token 代码），所以**跨机部署时连认证都过不去**。
- **只依赖本机进程/IM 侧，不受跨机影响**：KV 会话绑定与选项（`<STATE>`）、Markdown 分卡与 t2i（`<RENDER>` + AstrBot `text_to_image`）、图片下载/落盘/临时文件（`<MAIN>:339-394,424-434`）、AstrBot 平台流式发送（`<MAIN>:316`）、headless 模式（`<MAIN>:229-280`）。
- **附注**：插件当前调用的 RPC 名有 13 类与已装 DSH 目录不符（§6.3），且 `host.describe`、`workspace.list` 在目录中**不存在**。这意味着「跨机」问题之外，**同机也会失效**——这是新插件必须首先解决的事。

**Q3：有没有能力无法在进程内有等价物（例如必须依赖浏览器侧行为）？**
**没有必须依赖浏览器侧行为的能力。** 逐项核验：
- 「浏览器侧合成事件」`assistant/live-chunk`（`docs/dsh-side-capabilities.md:26,882,1535`）本插件**从未使用**——它用的是 host 侧老事件 `assistant/chunk`（`<CLIENT>:459`）；当前 host 侧的等价物就是 `assistant/chunk` 本身（瞬时、含 `text-delta`，从 `session/event` 订阅），另有 `assistant/message` 的 `stream` 成员可作持久侧补充，均可进程内订阅。
- 附件：`session.attachment` 返回 base64（`<CLIENT>:283-289`）+ DSH 侧 `dsh-attachment` 存储可进程内直读，等价物存在。
- `settings` schema/写：`settings.describe`/`settings.mutate` 是 host RPC，进程内等价物也存在（`settings.update`/`settings.replace` 同样在目录中）。
- 唯一「无进程内等价物」的是**非 DSH 侧**的两件外部设施：① AstrBot 的 t2i 渲染（`<ASTROOT>\astrbot\core\star\base.py:77-90`，需要 AstrBot 的 HTML 渲染模板/端点）；② 各 IM 平台的流式发送语义（`qqofficial_message_event.py:109-131` 仅 C2C 支持真流式）。二者属于 IM/呈现层，不属于 DSH 能力面。

### §14.1 「必须重做」类（12 项）

| # | 条目 | 证据 | 重做要点 |
|---|---|---|---|
| R1 | HTTP RPC 信封与端点 | `<CLIENT>:61-91` vs `<DSHNPM>\dsh-api-gateway\lib\index.js:925-936` | 端点改 `<namespace>/<method>` 两段式；载荷改 `{args:{...}}` 单键 |
| R2 | `/api` 认证 | `<DSHNPM>\dsh-client-connection\lib\index.js:768-781,431-441,553-556`；插件全仓无凭据代码 | 需实现 token→cookie 交换（或走进程内 host 插件通道，彻底绕开 HTTP） |
| R3 | RPC 名重映射（13 类） | §6.3 比对表 | `session.history→session/page`；`session.models→session/modelCatalog`；`llm.providers→llm/listProviders`；`llm.models→llm/discoverModels`；`agentPreset.*→agentPresets.*`；`skill.list→skills/list`；`subagent.list→subagents/list`；`subagent.interrupt→subagents/interruptByParent`（参数不同）；`goal.*→goals.*`；`workspace.list→无对应（改走 workspace/follow 或新建）` |
| R4 | `host.describe` 取代方案 | `<MAIN>:175,570,839,860`；`<DSHNPM>\dsh-api-remotes\lib\client.js` 目录无 `host.*` | cwd/version/provider/model 需另找来源（session 投影 / settings / 进程内 service） |
| R5 | 流式事件源 | `<CLIENT>:459-472`；格式迁移证据见 Q1 | 保持 `assistant/chunk`，改从 `session/event` 订阅（瞬时）或读 `assistant/message.stream`（持久） |
| R6 | 历史/轮询收敛协议 | `<CLIENT>:441-495`（`session.history` 轮询 + `maxMessages`） | 换成 `session/page` 的窗口语义，或进程内事件订阅；需重新验证 `turn/end`、`assistant/attempt` |
| R7 | 多 step 收敛判定 | `<CLIENT>:473-478` | 需在当前事件面重证「最后一条即结果」，并明确 `turn/end` 与 `assistant/message` 的批内顺序假设（§11 第 4 点） |
| R8 | 附件解析链 | `<CLIENT>:269-290` + `<HELP>:100-119` | 保留思路，但需按当前 attachment 形状重验字段名与媒体类型 |
| R9 | 权限预设枚举反解 | `<CLIENT>:296-316`（依赖 schema `refs/uid/union.list` 内部形状） | 需按当前 `settings.describe` schema 形状重验（测试 `<TESTS>:197-214` 用的是伪造形状） |
| R10 | Goal 读取路径 | `<MAIN>:1172-1175` + `<PRES>:26-31`（依赖 history projections） | 改为 `goals/get` 或当前投影键 |
| R11 | 主任务下发/等待空闲 | `<CLIENT>:406-425,431-439`（轮询 `session.list.running`） | 换成进程内事件或 `session/control` 流 |
| R12 | 命令树宿主形态 | `<MAIN>:438-526`（单命令 + 手写前缀分发） | 建议改为 AstrBot 指令组/子命令，使权限与帮助可控（现无任何权限门） |

### §14.2 「可直接搬」类（10 项）

| # | 条目 | 证据 | 说明 |
|---|---|---|---|
| P1 | 卡片判定与分卡算法 | `<RENDER>` 全 69 行 | 纯 Markdown 逻辑，零 DSH 依赖；含围栏闭合算法 |
| P2 | t2i 出卡 + 失败回退 | `<MAIN>:396-422` | 依赖 AstrBot `text_to_image`（`base.py:77`），逻辑可原样保留 |
| P3 | 图片下载/落盘/限额 | `<MAIN>:339-394` | data URL / file / 本地 / http(s) 四分支 + 三项限额 + 临时文件 |
| P4 | 回复文本解析 | `<HELP>:29-75` | `assistant_reply`/`merge_replies` 的遍历与去重思想可搬（字段名需按 R8 重验） |
| P5 | 模型行归一化 | `<HELP>:78-97` | 注意 `provider_name`/`name` 两个字段生产代码未使用（§15 注 2） |
| P6 | settings 辅助 | `<CFG>` 全 56 行 | `namespace_map`/`dotted_path`/`read_path`/`parse_json_value`/`compact_json`/`format_namespaces` |
| P7 | KV 存储模型 | `<STATE>` 全 92 行 | 键模板与两级缓存；建议顺手删掉死代码并补 `options_cache` 清理 |
| P8 | 会话选项归一化 | `<OPTS>:11-86` | 8 字段 + 别名 + 互斥规则 + 时区归一化 |
| P9 | 8 步向导状态机 | `<OPTS>:89-258` | 纯函数式（`process()` + `SetupResult`），只依赖外部喂入的目录数据，可整体搬 |
| P10 | 零散纯函数 | `<MAIN>:94-98`（`_chunk_text`）、`:328-337`（`_unstreamed_text`）、`:1468-1472`（`_truncate`）、`:1485-1493`（`_command_remainder`） | 与协议无关 |

### §14.3 「可放弃」类（7 项）

| # | 条目 | 证据 | 放弃理由 |
|---|---|---|---|
| D1 | headless 传输整套 | `<MAIN>:229-280` + 配置 `dsh_command`/`dsh_profile`/`dsh_extra_args`（`<SCHEMA>:18-20`） | 新插件进程内运行，无会话状态/多轮/图片，纯负担 |
| D2 | Windows 子进程扩展名探测 | `<MAIN>:259-280` | 随 D1 一起废弃 |
| D3 | 旧单字段 KV 通道 | `<STATE>:42-53`（`load_option`/`save_option`，生产零调用） | 死代码 |
| D4 | 旧选项回退读 | `<STATE>:65-71`（`dsh_option:agent_preset:*`） | 一次性迁移可由新插件显式完成 |
| D5 | `_require_http()` 模式守卫 | `<MAIN>:583-585,588,600,703,735,830,857,910,969,1018,1083,1097,1145,1312` | 单进程形态下「模式」概念消失 |
| D6 | `merge_replies` 版历史文本 | `<MAIN>:634` + `<HELP>:60-75` | 若新插件直接从事件流渲染历史，可换更准确的呈现（当前是纯文本拼接） |
| D7 | `provider_name`/`name` 死字段 | `<HELP>:92,94` | 仅测试期望里出现（`<TESTS>:60`），生产无消费者 |

> **不宜放弃**（易被误判）：`enable_llm_mutation_tools` 这类写权限开关要保留但**扩大**到全部 mutation 工具（R12/§4.2 注）；`expectedRevision` 乐观锁（`<MAIN>:953-958`）要保留；`stream_replies` 与 `reply_render_mode` 的互斥（`<MAIN>:319-326`）要保留。

---

## §15 未找到证据清单

| # | 事项 | 检索范围与结果 |
|---|---|---|
| 1 | **权限门** | 全插件检索 `permission_type`/`PermissionType`/`admin` **零命中**。插件未声明任何 AstrBot 权限要求；`/dsh` 全部子命令（含删会话、写 DSH 设置）默认对所有能唤醒该会话的用户开放。**未能找到**任何证据表明存在细粒度权限控制 |
| 2 | `provider_name` / `name` 的消费者 | `<HELP>:92,94` 定义；全仓仅 `<TESTS>:60` 引用。**未找到**生产代码消费点（≠ 可立即删，测试期望绑定） |
| 3 | 逐条回复后的临时文件清理 | 全仓仅 `<MAIN>:1477-1482`（terminate）一处 `unlink`。**未找到**每条回复结束后的清理逻辑 |
| 4 | `options_cache` 的清理 | `<STATE>:15` 定义、`:72,77,89` 写入；`<MAIN>:1476` 只清 `session_cache`。**未找到** options 缓存的清理点 |
| 5 | `host.describe` 与 `workspace.list` 的当前实现 | 在 `<DSHNPM>\dsh-api-remotes\lib\client.js` 的 84 条描述符中**未找到** `host.*` 与 `workspace.list`（仅有 `workspace/{archiveSession,create,delete,follow,insertBefore,insertSessionBefore,rename}`）。这两种能力的当前替代端点**未定位到** |
| 6 | `session.history` / `session.models` / `llm.providers` / `llm.models` / `agentPreset.*` / `skill.list` / `subagent.*` / `goal.*`（单数）当前实现 | 同上目录中**未找到**这些名字；已定位到的（疑似）替代名见 §6.3。**未逐条验证**替代方法的参数 schema 兼容性 |
| 7 | 推送型订阅的使用 | 全仓检索 `remote.mux`/`websocket`/`ws://`/`wss://` **零命中**；DSH 目录中虽有 `session.follow`/`workspace.follow`/`session.control`，插件**未使用**。即：本插件**全部依赖轮询**，**未找到**任何推送/长连接证据 |
| 8 | 重试与限流 | 全仓**未找到** retry/backoff/rate-limit 逻辑；失败一律直接返回 `❌`/丢弃 |
| 9 | 非 aiocqhttp / qq_official 平台的流式降级细节 | 仅核实 `<ASTROOT>` 中这两个平台（§10），其余平台（discord/lark/line/mattermost/misskey/satori/dingtalk）的 `send_streaming` 覆写**未逐行核实** |
| 10 | `/dsh` 全量端到端实跑 | 本次为**静态代码考古**，未启动 AstrBot、未对 DSH 发起真实 RPC。所有「会失败/会 401」结论均基于两侧源码契约比对，**未做运行时验证** |
| 11 | `assistant/chunk` 曾经可用的 DSH 版本 | **未找到**本插件所针对的 DSH 版本号（`<META>:11` 只声明 `astrbot_version: ">=4.0.0"`，`<README>:9-13` 未写 DSH 版本）。因此「插件的点号+扁平载荷曾对某个 DSH 版本有效」这一假设**无法证实** |
| 12 | DSH `assistant/attempt` 的完整 payload | 仅确认存在与含 `stream` 成员（`<DSHNPM>\dsh-session-format-v1-to-v2\lib\index.js:10-14`），**未逐字段展开**（该清点属于 `docs/dsh-side-capabilities.md` 范围） |
| 13 | 语言/品牌无关的默认值语义 | `mode` 默认 `http`、`reply_render_mode` 默认 `text`、`enable_llm_tools` 默认 `false` 均取自 `<SCHEMA>`；**未找到**任何代码层面的默认值覆盖（如 `Main.__init__` 里改配置） |

---

### 附：本报告未做的事

- 未修改被清点插件的任何文件。
- 未对 DSH 或 AstrBot 发起真实请求（纯静态考古，见 §15 注 10）。
- 未重复 `docs/dsh-side-capabilities.md` / `docs/astrbot-side-capabilities.md` 已有的 DSH 侧与 AstrBot 侧全量 API 清点，仅取必要的交叉证据。
