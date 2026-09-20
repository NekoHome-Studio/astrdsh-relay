# astrbot_plugin_dsh_relay（星驿 · AstrBot 侧）

AstrBot 侧的 **IM ↔ DSH 网桥**。它把 IM 里的消息投递给 DeepSeek Harness，
并把流式输出与**敏感操作审批请求**带回聊天窗口。

- 接口契约：`../docs/BRIDGE-CONTRACT.md`（唯一真相来源）
- 设计说明：`../docs/DESIGN.md`
- API 证据：`../docs/astrbot-side-capabilities.md`

## 路线：Star 插件桥（不写 Platform 适配器）

已核实：`Platform` 基类只有 `run()` / `meta()` 两个抽象方法；`send_by_session()`
有默认实现（只上报指标）——**不实现不会报错，但主动消息会静默发不出**。
因此不新建平台适配器，直接复用 AstrBot 现有的 IM 适配器收发，
本插件只做「捕获 → 转发 → 回帖」。平台只从 `platform_cls_map` 实例化，
不注册 `type` 就完全不碰它。

## 当前状态

**是可运行实现。** `BridgeTransport` 的六个方法（`health` / `where` / `send_message` /
`events` / `send_approval` / `aclose`）全部落地，无 `NotImplementedError`。

| 部位 | 状态 |
|---|---|
| 插件契约（`metadata.yaml` / `_conf_schema.json` / `Star` 子类） | ✅ 就位 |
| 前缀触发 + 白名单 + 私聊过滤 | ✅ 就位 |
| **易错顺序**（`should_call_llm(True)`、`stop_event()` 在 `yield` 之后） | ✅ 已按源码事实固化 |
| 切分回帖结构（中间分片 `event.send()` / 最后一片 `yield`） | ✅ 已落地（段落 / 代码围栏感知切分） |
| 审批命令分支（`/dsh approve|reject <code>`） | ✅ 结构就位 |
| 契约常量（`contract.py`） | ✅ 就位 |
| `/dsh where` 定位命令 + 本地信息（会话键/桥接地址） | ✅ 就位 |
| 定位结果排版（`location_text.py`） | ✅ 就位（有单测） |
| HTTP + SSE 传输层（`BridgeTransport` 六方法） | ✅ 就位 |
| 流式节流回帖、幂等键复用、重试退避 | ✅ 就位 |
| 主动推送 `push_to_session` | ✅ 就位 |
| `_session_allowed` 白名单、`/dsh approve|reject` 一次性 code 回执 | ✅ 就位 |
| `/dsh help` 与裸 `/dsh` 共用的指令清单（`_usage_text`） | ✅ 就位 |
| 前缀匹配按去尾空格的基名判定，两边各容忍一个前导 `/`，基名后必须跟空白/行尾 | ✅ 就位 |

## 指令用法

前缀由配置项 `trigger_prefix` 决定，默认 `dsh `——**不带斜杠**。原因是 AstrBot 会在
事件进插件之前剥掉 wake_prefix（本机为 `/`）：群里敲 `/dsh xx` 时
`event.message_str` 已经是 `dsh xx`，配置若写成 `/dsh ` 就永远匹配不上，插件默默
`return`，而 `filter.event_message_type(ALL)` 让群聊里 `is_at_or_wake_command` 恒真，
默认 LLM 便接手作答（P0 的成因，判定见 `core/pipeline/process_stage/stage.py`）。

**匹配时不看尾空格**，且**两边各容忍一个前导 `/`**：配置 `dsh ` 时 `/dsh` 与 `dsh`
都能命中，裸敲前缀（后面什么都没有）也照样有反应；私聊或 wake_prefix 被改掉时原样
送来的 `/dsh xx` 同样命中。基名之后必须紧跟空白或行尾，`/dshx ...` 这类别的插件的
命令不会被吞。

| 指令 | 作用 |
|---|---|
| `dsh <内容>` | 投给 DSH 并流式回帖。命中后**接管本事件**（`should_call_llm(True)` + `stop_event()`），不会再被 AstrBot 默认 LLM 回一遍 |
| `dsh help` | 显示指令清单。与裸 `dsh` 是同一份文案（都出自 `main._usage_text`），不存在文档与实现对不上的第二条路径 |
| `dsh where` | 定位本对话的工作区与 DSH 会话。设计取舍见下 |
| `dsh approve <验证码>` | 允许**一次**待审批操作（一次性回执，不接受「是/否」这类转述） |
| `dsh reject <验证码>` | 拒绝待审批操作 |

（上表里每条写成 `/dsh ...` 也等价——前导斜杠被剥掉或被容忍，落点相同。）

四条约束：

- **`approve` / `reject` 不会被当成对话内容投给 agent** —— 它们在前缀分发里就被
  独立分支接走了，只有「没命中任何已知子命令」的文本才落到投递分支。
- **每条接管分支都显式 `should_call_llm(True)`**：`help` / `where` / `approve|reject`
  三条分支只 `stop_event()` 不够。handler 结束后 `star_request` 会 `clear_result()`，
  于是 `stage.py` 的 `(get_result() and not is_stopped()) or not get_result()` 仍然成立，
  默认 LLM 会再答一遍。
- **白名单与私聊过滤在分发之前**：`allow_from`（留空=不限制）与
  `reply_in_private_only` 先判，不通过就直接 `return`，不设结果、不发消息，
  完全不干扰 AstrBot 默认逻辑。
- **`/dsh where` 的本地那几行永远打印**：用户问「我在哪」时最需要的信息
  （会话键、桥接地址）本来就在本地，不该被一次网络往返的失败拖没——
  插件刚装、地址填错、桥接端没起，恰恰是最需要定位能力的时刻。远端失败只在
  结果末尾追加一行失败原因。

## 安装

取发布产物 `astrbot_plugin_dsh_relay-<v>.zip`（[GitHub Releases](https://github.com/NekoHome-Studio/astrdsh-relay/releases)），
解压进 AstrBot 的插件目录——归档顶层目录就是插件目录名，一步到位：

```powershell
Expand-Archive .\astrbot_plugin_dsh_relay-0.3.5.zip -DestinationPath <AstrBot>\data\plugins\
```

在克隆里开发时直接拷本目录也行（AstrBot 只认 `data/plugins/<目录名>/metadata.yaml`）：

```powershell
Copy-Item -Recurse .\astrbot_plugin_dsh_relay E:\0d00\AstrBot\data\plugins\
```

然后在 WebUI 插件页启用并填 `bridge_url` 与 `bridge_token`。
注意 **WebUI 保存配置 = 整插件 reload**，不是原地改内存。

## 动笔前必读的四条已核实约束

1. `filter` 必须从 `astrbot.api.event` 导入，避免与内置 `filter` 冲突。
2. `event.should_call_llm(True)` —— 传 `True` 才是**禁止**默认 LLM
   （判定是 `not event.call_llm`，语义与直觉相反）。
3. `event.stop_event()` 必须放在 `yield` **之后**。先 stop 再 yield 会让
   `RespondStage` 不执行，**消息发不出去**。
4. 回复分片：中间用 `await event.send(...)`（绕过 `ResultDecorateStage`，
   避免被自动包成合并转发），最后一片用 `yield event.plain_result(...)`。
   走 `yield` 时纯文本超过 `forward_threshold`（本机 = 1500）会被包成 `Node`。

## 三个易踩的环境事实

- **`unified_msg_origin`** 是会话键，格式 `{platform_id}:{MessageType}:{session_id}`
  （如 `default:GroupMessage:123456`）。不要自己拼 `platform:group:user` 三元组——
  私聊场景会把不同用户折叠，群聊场景会按用户分裂。
- **`raw_message` 不在 event 上**，在 `event.message_obj.raw_message`。
- **持久化**用插件 KV（DB 后端 `data_v4.db` 的 `preferences` 表，
  `await self.put_kv_data/get_kv_data`），**不是** `shared_preferences.json`。

## 与 `astrbot_plugin_dsh_connector` 的分工

本机已有 `astrbot_plugin_dsh_connector` v2.0.1（当前被禁用），定位是**控制面**
（会话/模型/Preset/Settings/Skills 管理）。本插件只做**数据面**（消息桥接 + 审批）。

它的传输层已部分失效（依赖已被删除的 `assistant/chunk`；走 `/api` 面无法跨机、
无法拦截审批），因此**不复用它做桥接**；但它的呈现层
（`core/reply_render.py` 的 `text/auto/card` 与分卡逻辑）可以在 P4 直接搬过来。
两者前缀不同（本插件默认 `/dsh `，connector 用 `/dsh setup` 等子命令），可共存。

## 参考范例（已核实路径）

| 目的 | 位置 |
|---|---|
| 同路线、成熟实现的发送三件套用法 | `AstrBot-master/data/plugins/astrbot_plugin_dsh_connector/main.py` |
| 已有 `/api` RPC 方法名与语义词典 | 同目录 `core/dsh_client.py` |
| Markdown/t2i 图片卡呈现（P4 可搬） | 同目录 `core/reply_render.py` |
