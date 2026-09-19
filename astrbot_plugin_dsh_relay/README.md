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

## 安装

把本目录整个拷到 AstrBot 的插件目录：

```powershell
Copy-Item -Recurse .\astrbot_plugin_dsh_relay "$env:USERPROFILE\Downloads\AstrBot-master\data\plugins\"
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
