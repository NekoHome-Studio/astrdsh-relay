# 审查请求：astrbot_plugin_dsh_relay v0.9.4（`stream_enabled=false` 语义定案）

发起人：Fangnai ／ 整理：绫地宁宁
日期：2026-09-27
仓库：`E:\0d00\astrdsh-relay`，实装副本：`E:\0d00\AstrBot\data\plugins\astrbot_plugin_dsh_relay`

---

## 一、请 dsh 审什么

一句话：**`stream_enabled=false` 的语义从「静音（连最终回答都不发）」改成「只关流式刷屏，收敛回帖照发」，代码与测试已同步落地，请审这个定调是否合理、有无遗漏的读点。**

`bridgeVersion` 仍为 `6`，契约常量表零变化——本次是插件自身行为口径的修正，不是桥接契约变更。若 dsh 认为这属于契约级语义，请指出应如何标注。

---

## 二、改了什么（v0.9.3 → v0.9.4）

### 1. 删除「静音早退」
原实装里存在一段：`stream_enabled=false` 时连 `message/final` 收敛出的最终回答也不落地、直接 `return`。
现替换为说明性注释（`main.py` 约 1270 行）：

> ★ `stream_enabled=false` 只关「流式刷屏」，**收敛回帖照发**。开关的名字是 `stream` 而不是 `mute`：关掉后中间分片与工具提示都不再发，但这一条最终回答必须落地——否则用户一关流式，`/dsh` 问答就变成哑巴，而他要的只是别再刷屏。

### 2. 删除启动时的 `stream_ok` 快照
原实现开头捕获 `stream_ok = bool(self._cfg("stream_enabled", True))`，导致一个已经在跑的 turn 无论中途怎么改配置都停不下来。
现在**唯一的权威读点**是：每个 delta 帧／每个工具调用帧上现场调用 `self._cfg("stream_enabled", True)`（`main.py` 约 1213、1230 行）。开头只保留不随开关变化的量（`throttle`、`flush_chars`、`hard_chars`、`im_limit`）。

### 3. `v0.9.3` 旧条目已标注推翻
`CHANGELOG.md` 中 v0.9.3 那两条「静音」口径条目后已加 **⚠️ v0.9.4 已推翻 / 已回退**，避免历史条目与现行为自相矛盾。

---

## 三、测试侧如何钉死新语义

`scripts/test-im-commands.py`（§11）新增／调整：

| 用例 | 断言 |
|---|---|
| `stream_enabled=false` ⇒ 中间分片不刷 | `event.sent_text == []` |
| `stream_enabled=false` ⇒ 收敛回帖照发 | `event.yielded_text == ["权威最终文本"]` |
| `stream_enabled=false` ⇒ 工具提示一并停 | 同属流式刷屏，`sent_text` 里无 `· 调用工具` |
| 对照组 `stream_enabled=true` | 分片与工具提示确实都会刷 |
| 「最终文本以 `message/final` 为准」 | 保留原用例，套上 `stream_enabled=False` 后通过 |

踩过的坑，供 dsh 复核断言有效性：
- **`flush_chars` 是流式断言的隐形变量**。默认 `200` 时短 delta 被 `_pick_cut` 合法攒着不发，断言会「假通过／假失败」。对照组必须 `make_main(flush_chars=1)`，且 delta 用带句末标点的 `"第一部。"` 保证有边界可切。本层测的是「开关拦不拦得住」，不是切句策略。
- **`sent_text` 与 `yielded_text` 是两条不同出口**：前者是主动 push（分片／工具提示），后者是收敛回帖。断言静音与否必须分清。
- `turn_frames` **必以 `turn/end` 收尾**，否则会等到 `request_timeout=600s`，表现为「卡住」而非失败。

---

## 四、证据（本次复跑，全绿）

解释器：`E:\0d00\AstrBot\.venv\Scripts\python.exe`，工作目录仓库根。

| 脚本 | 结果 |
|---|---|
| `test-allowlist.py` | rc=0，25 通过 / 0 失败 |
| `test-heartbeat-state.py` | rc=0，30 通过 / 0 失败 |
| `test-im-commands.py` | rc=0，**59 通过 / 0 失败** |
| `test-im-heartbeat.py` | rc=0，32 通过 / 0 失败 |
| `test-location-text.py` | rc=0，8 通过 / 0 失败 |

- `py_compile` 通过。
- 两份 `main.py` md5 一致：`d0339d391e5121755e8f2163f67dbe7a`，2718 行（实装副本与仓库副本已同步）；`rpc_allowlist.py` / `contract.py` / `metadata.yaml` / `README.md` 两份亦一致。
- 复现：`E:\0d00\AstrBot\.venv\Scripts\python.exe scripts\test-im-commands.py`（`PYTHONIOENCODING=utf-8` 取干净中文输出）。

---

## 五、想请 dsh 重点裁决的三点

1. **开关语义是否该写进契约文档**：`stream_enabled` 目前只活在插件配置与 `docs/` 说明里。若桥接侧（dsh）也依赖「关流式 = 静音」这一旧口径，需同步；请确认 dsh 侧无此假设。
2. **关流式时工具调用提示该不该保留**：现口径把「`· 调用工具 X`」也归入刷屏一并关掉。若 dsh 认为心跳／工具可见性是可用性刚需，应改为独立开关，请给结论。
3. **`throttle_ms` 在关流式时是否还应生效**：现实现里 `throttle` 照旧计算但不影响收敛回帖，属于无害开销；若认为该在关流式时直接跳过，请指出。

---

## 六、明确不要动的地方

- **守卫插件那两个 bug 已于今晚修完并测过，不要重复改**。本次审查范围仅限 `astrbot_plugin_dsh_relay` 的 `stream_enabled` 语义及其测试。
- `data\config\astrbot_plugin_dsh_relay_config.json` 是私聊绑 DSH 会话那份 relay 配置，非必要不要改。
- 端口占用：3080 = dsh web（前缀 `/astrbot-relay`）；6185 = AstrBot。

---

## 七、可选后续（等裁决）

- 文档口径统一：全库搜 `静音`、`stream_enabled`，把 README / `docs/` 里「关掉流式后连收敛回帖也不发」这类旧表述改成新语义。
- AstrBot 侧重载插件使 0.9.4 生效，实测 `stream_enabled=false` 下 `/dsh` 问答仍能收到最终回答。
- 清理：`main.py.bak-sync-20260927-134831` 等 `.bak-sync-*`、`scripts/__pycache__`。
