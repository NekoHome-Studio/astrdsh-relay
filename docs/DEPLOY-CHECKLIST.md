# 星驿 · 部署与验证清单

> **适用范围**：`bridgeVersion = 6`（v0.8.7 起的任一侧版本均可，见 §1.1）。
> **这份文件要干什么**：把「装上去」和「证明它真的在工作」拆成可逐条打勾的步骤。
>
> **口径**（先说清楚，免得当成别的东西）：
>
> * 能给出**命令 + 期望输出**的，一律给到底；只能靠观察的，给出**判据**与**失败时看哪里**。
> * 本清单**不是**设计文档。拓扑与跨机理由见 `docs/DESIGN.md` §6；接口真相来源是
>   `docs/BRIDGE-CONTRACT.md`；两者冲突时以契约为准。
> * 第 5~9 节里有**三处至今未实测**的东西（§18.8 的 B 半地基、长 turn 的误报率、
>   部署侧的量级）。这次跑完请把结果填回 §11 的表，那是关闭它们的唯一凭据。
>
> **约定**：Windows 下 `curl` 是 `Invoke-WebRequest` 的别名，本文一律写 `curl.exe`。
> 示例里的 `$TOKEN` / `$BASE` 是占位符，别原样粘。

---

## 1. 前置检查（5 分钟，能省掉后面一半的排查）

### 1.1 两侧版本必须配对

| 本侧 | 要求 |
|---|---|
| AstrBot 插件 | `astrbot_plugin_dsh_relay` ≥ **0.8.9**（`card` 修复与审批/问答送达修复都在里面） |
| DSH 插件 | `dsh-astrbot-relay` ≥ **0.8.7** |

**`bridgeVersion` 必须两边都是 `6`。** IM 侧启动时会拿 `/health` 的
`bridgeVersion` 逐字比对，不匹配**拒绝启用**（不是降级）——这是刻意的：
v5 的 IM 不会去调 `/proactive`，于是 DSH 侧的 `online` 闸门永远不开、
自主心跳永不触发，**且没有任何报错**。

> 本版之后只有 IM 侧改动过（v0.8.8 / v0.8.9 都只动 IM），所以
> **v0.8.9 的 IM + v0.8.7 的 DSH 是合法组合**；反之桥接端更高也一样。

### 1.2 端口与网络方向

```
[IM 平台] ──(QQ 反向 WS)──> [AstrBot]  ──(HTTPS + Bearer)──> [DSH :3080]
```

* **只放通一个方向**：AstrBot 出站 → DSH 入站。DSH **不需要**能访问 AstrBot。
* `bridge_url` 要写 **DSH 的对外可达地址**（跨机时别写 `127.0.0.1`）。
* `/astrbot-relay/*` 与 DSH Web UI **同端口**（同一 HTTP server）。不想暴露 Web UI
  就用反向代理只放行 `/astrbot-relay/*`。

### 1.3 时钟（只在开 `hmacMode` 时重要）

签名对象是 `ts + "." + rawBody`，两侧时钟偏差必须小于 `signatureSkewMs`（默认 60000）。
跨机部署前对一下时间；容器里注意宿主时钟。

---

## 2. DSH 侧部署

### 2.1 装包

```powershell
dsh plugin --profile web add ./dsh-astrbot-relay-0.8.9.tgz
dsh --profile web --dump-config | Select-String -Pattern "dsh-astrbot-relay"
```

- [ ] `--dump-config` 里出现 `# == dsh-astrbot-relay` 层

预打包产物**无构建步骤**，因此不需要 `allowBuilds` 授权
（那条路径只在从 git 源码安装、要跑 `prepare` 时才出现）。

### 2.2 写配置

**`token` 与 `cwd` 都是 required，缺失会让插件加载即失败**——这是刻意的
（配置错误要响亮）。在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-astrbot-relay
  config:
    token: '<32 字节以上随机串>'
    cwd: '<绝对路径>'
```

> ⚠️ patch 是**按顶层 key 赋值**：写出的 `config:` 会**整体替换**整行 config，
> 不是逐字段合并。所以要么只写这两项（其余走 schema 默认值），
> 要么把要覆盖的都写上。

常用项（默认值已够用，按需改）：

| 键 | 默认 | 什么时候要动 |
|---|---|---|
| `pathPrefix` | `/astrbot-relay` | 与 `bridge_url` 的路径段一致；**不要写尾斜杠** |
| `heartbeatMs` | `15000` | SSE 保活 + **IM 侧算帧间隔阈值的基准**，两侧同口径 |
| `hmacMode` | `false` | 要请求体签名时开；**两侧必须同开**，否则一侧拒收 |
| `policy` | `one-to-one` | `one-to-one` / `on-demand` / `daily` 轮转 |
| `sessionTitleTemplate` | `星驿 · {platform}/{messageType}/{sessionId}` | 反向定位：让 DSH Web 的会话列表里认得出「哪条来自哪个群」 |
| `approvalTimeoutMs` | `120000` | 应与 IM 侧 `approval_timeout_ms` 一致或略大 |
| `questionTimeoutMs` | `300000` | 同上，对应 IM 侧 `question_timeout_ms` |
| `proactiveHeartbeatMs` | `0`（**关**） | 自主心跳。**默认关**，第 6 节才会动它 |

### 2.3 冒烟：直接问 `/health`

```powershell
curl.exe -s -H "Authorization: Bearer $TOKEN" "$BASE/astrbot-relay/health"
```

- [ ] 返回 `200`，且 `bridgeVersion` 是 `"6"`
- [ ] `pathPrefix` / `cwd` / `statePath` 与你配的一致
- [ ] 不带 `Authorization` 时返回 `401`（**`/health` 也要鉴权**，这是刻意的）

启动日志里应能看到挂载那一行：

```
<tag> mounted at /astrbot-relay (bridgeVersion=6)，…
```

> `dshVersion` **不在** `/health` 里（实现从未提供，契约已更正说明）。
> 需要时才去补，别先按它写脚本。

---

## 3. AstrBot 侧部署

### 3.1 装包

```powershell
Expand-Archive .\astrbot_plugin_dsh_relay-0.8.9.zip -DestinationPath <AstrBot 目录>\data\plugins\
```

然后在 AstrBot WebUI 的插件页启用。

### 3.2 填配置

必填两项：`bridge_url`、`bridge_token`。

```jsonc
{
  "bridge_url": "https://dsh.example.com/astrbot-relay",  // 跨机！不是 127.0.0.1
  "bridge_token": "<与 DSH 侧 token 逐字相同>"
}
```

明文 HTTP 的边界（**会拦，但不是配置加载即失败**——这点很容易误判）：

| 时机 | 行为 |
|---|---|
| 启动期 | 只**警告**：`[dsh_relay] bridge_url 为明文 HTTP（…）；仅本机回环可直接使用…` |
| 启动探测（`/health`） | **失败**。`_check_scheme()` 在每个请求里跑，探测拿到 `BridgeError` ⇒ `_bridge_ok=False` |
| 用户发消息时 | 回「桥接未就绪：…」，**不会**静默地把消息丢掉 |

回环地址（`127.0.0.1` / `localhost` / `::1`）视为受信，无需开关；其它地址要么上 HTTPS，
要么显式打开 `allow_insecure_http`（打开后启动时那条 warning 依旧会打印）。
同机调试走 `http://127.0.0.1:3080/astrbot-relay` 即可。

- [ ] 启动日志出现：`[dsh_relay] 桥接就绪：bridgeVersion=6 pathPrefix=… conversations=…`
- [ ] **没有**出现 `契约版本不匹配` / `桥接鉴权失败` / `桥接端没有这个端点`

三条启动期报错分别是三件不同的事，别混：

| 日志 | 意思 |
|---|---|
| `契约版本不匹配：本端 6，…` | 两侧版本号不一致，**必须同时升** |
| `桥接鉴权失败` | `bridge_token` 与 DSH 侧 `token` 不一致 |
| `桥接端没有这个端点` | `bridge_url` 的**路径段**写错了（漏了/多了 `/astrbot-relay`） |

---

## 4. 数据面验证（P1/P2：消息进得去、回得来）

在群里发（`trigger_prefix` 默认 `dsh `，`/dsh` 与 `dsh` 都能触发）：

| 步骤 | 期望 |
|---|---|
| `dsh help` | 回一份指令清单，且**不会**被 AstrBot 默认 LLM 再答一遍 |
| `dsh 你好` | 先看到流式分片（`stream_enabled=true` 时），最后一条是完整回复 |
| `dsh where` | 回本对话的会话键 / 工作区 / DSH 会话 id，**标注来源** |
| `dsh workspaces` | 列出桥接端登记的工作区（`count` 与 `returned` 分开报） |

- [ ] DSH Web UI 的会话列表里能看到标题形如 `星驿 · <platform>/<messageType>/<sessionId>`
      （这是「反向定位」的验收点：**标题真的写进了 DSH 会话**，不只是响应字段）

`dsh where` 里三个 id 各自是什么，排查时最常混：

| 字段 | 是什么 |
|---|---|
| 会话键 / `conversation` | IM 侧的 `unified_msg_origin`，形如 `default:GroupMessage:123456` |
| `sessionId` | DSH 会话 id（`im-…`），`/dsh adopt` 要的是这个 |
| 工作区 id | 目录登记的 id（UUID），`/dsh rebind` 要的是这个 |

---

## 5. 连通性心跳（A 半）验证

**这一半纯在 IM 侧闭环**，不需要 DSH 配合。先调成便于观察的值：

```jsonc
{
  "health_interval_ms": 5000,        // 默认 30000；调小只是为了让判定跑得勤
  "heartbeat_notify": "fixed",       // off(默认) / fixed / agent / offline-only
  "heartbeat_notify_min_gap_ms": 0,  // 关掉最小间隔，否则第二次播报会被拦
  "heartbeat_notify_targets": []
}
```

> ⚠️ **`health_interval_ms` 必须 > 0**：判定是由这条周期循环驱动的，
> 设 0 等于关掉探测，A 半的状态再也不会更新。

### 5.1 掉线播报

1. 先在群里发一条 `dsh 你好` —— 让该对话**建过档**（`_touch_frame` 才会记录它）。
2. 掐掉 DSH（停容器 / 关进程 / 或临时改 `bridge_url` 指向一个空端口）。
3. 等一个 `health_interval_ms`。

- [ ] IM 里收到：`⚠️ 星驿：与 DSH 的连接中断（<原因>）。此期间的指令会排队，恢复后继续。`
- [ ] AstrBot 日志有 `[dsh_relay] 心跳播报（offline）-> <umo>：已发送`
- [ ] 文案里**没有** `**`（IM 端不渲染 Markdown，星号会原样露出来）

### 5.2 恢复播报 —— **注意它有前提**

把 DSH 恢复，**然后从群里再发一条消息**。

- [ ] 收到 `✅ 星驿：与 DSH 的连接已恢复。`

> **为什么「恢复了却不自动播报」**：恢复的判据是「收到**新的一帧**」，
> 而帧只在下行通道上产生（一条消息触发的 turn，或服务端的 15 秒保活）。
> DSH 重启后如果**没人说话**，探测虽然通了，但「这条对话的下行通道好了没有」
> 仍未被证明——于是状态停在离线，**这是设计如此，不是漏报**。
> 两条判据的分工见契约 §17.1：探测证明「进程活着」，帧证明「这条流通了」。
> 只有前者就敢报「已恢复」，正是半开连接最会骗人的地方。

### 5.3 `agent` 模式（可选）

```jsonc
{ "heartbeat_notify": "agent" }
```

- [ ] 文案由对话模型组织（同样的跃迁，措辞每次可能不同）
- [ ] **把模型端点改坏再试一次**：应退回固定文案并 warn，**不能因此漏报**
      （`heartbeat_agent_timeout_ms` 默认 15000，超时也算「用不了」）
- [ ] 若 AstrBot 侧没有可用对话模型，日志应有一条
      `没有可用的对话模型…这条只警告一次`

---

## 6. 自主心跳（B 半）验证 —— ⚠️ **本次最关键的一节**

**契约 §18.8 至今把它列为「未实测」**：`agent.followup(plugin 来源)` 是否真能
起一轮 turn，本机没有活的 DSH 宿主可验。这一节就是来关掉它的。

### 6.1 先把闸门放到底

在 DSH profile 里临时改为（**测完务必改回 `proactiveHeartbeatMs: 0`**）：

```yaml
- id: dsh-astrbot-relay
  config:
    token: '<...>'
    cwd: '<...>'
    proactiveHeartbeatMs: 20000   # 扫描周期，最小夹到 1000
    proactiveMinIdleMs: 0         # 静默门槛清零，否则要等 30 分钟
    proactiveMaxPerDay: 0         # 0 = 不限配额
    proactiveWindow: []           # 空 = 不限时段
```

- [ ] DSH 日志：`自主心跳已启用：每 20000ms 扫描一次`
- [ ] IM 侧**保持在线**（`proactive_poll_ms` 默认 5000，别设 0）——
      这是 `online` 闸门的唯一依据：**IM 在轮询 = 有人在听**

### 6.2 核心判据：followup 到底起没起一轮

先在群里发一条 `dsh 你好`（`hasSession` 闸门要求该对话已有会话）。

- [ ] DSH 日志出现：`自主心跳：已向 <conversation> 发起一轮`

然后看**紧接着**发生什么，只有两种可能：

| 后续日志 | 含义 | 结论 |
|---|---|---|
| `自主心跳：已入发件箱 #N（<conversation>）` | 这一轮**真的跑了**且模型说了话 | ✅ §18.8 成立 |
| `自主心跳：这一轮选择沉默（<conversation>）` | 这一轮**真的跑了**且模型按哨兵闭嘴 | ✅ §18.8 成立 |
| 只有「已发起」，之后再无任何一条 | `followup` **没起一轮** | ❌ §18.8 不成立 |

- [ ] 上表中出现了前两种之一 → **把「§18.8 已实测成立」记进 §11**

失败时的排查方向（按可能性排序）：

1. 宿主是否**过滤了插件来源**的消息（`source.kind === 'plugin'`）——那就要看
   `dsh-agent` 的 followup 入参校验；
2. `bridge.agent` 是否还是活的（会话被回收/归档过）；
3. 本轮是否真的被 `turn/start` 起来了 —— 看 DSH 侧日志里有没有对应的 turn。

### 6.3 发件箱 → IM 的送达

- [ ] IM 日志：`[dsh_relay] 主动消息已发送 -> <umo>（N 字）`
- [ ] 群里真的出现了那句主动消息
- [ ] 再触发一次，且这次把 IM 侧 `proactive_enabled` 设为 `false`：
      **IM 不该发出任何消息**，但日志里仍能看到轮询在跑（那是 DSH 判断「有人听」的依据）

### 6.4 哨兵必须真的拦得住

把提示词改成**只会沉默**，用来确定性地测哨兵（比等模型自己决定可靠）：

```yaml
proactivePrompt: '只输出 {silent}'
```

- [ ] DSH 日志：`这一轮选择沉默`
- [ ] **群里什么也没有**（这是「哨兵泄漏」的唯一验收点）
- [ ] 改回默认提示词

### 6.5 静默与配额的闸门（可选，但很便宜）

| 试法 | 期望 |
|---|---|
| `proactiveMinIdleMs: 3600000`（1 小时） | 刚聊过之后**不会**发起；日志里没有「已发起」 |
| `proactiveMaxPerDay: 1` | 当天发起一次后不再发起 |
| `proactiveWindow: ["09:00","09:01"]`（当前不在窗口内） | 不发起 |
| 把 IM 侧插件**停用**（`enable=false`，或直接在插件页关掉） | 超过 `proactiveImAliveMs`（默认 180000）后**不发起**——这是防「白烧一次 LLM 且回复没人取」 |

> ⚠️ 停轮询要**停插件**，不能靠把 `proactive_poll_ms` 设成 0：
> 那个值在代码里被夹到 `max(1000, …)`，设 0 等于 1 秒轮询一次（比默认更勤）。
> 这条夹取是有意的——轮询是 `online` 闸门的唯一证据，不该允许被悄悄关掉。

---

## 7. 审批链验证（v0.8.8 修的 P0 就在这条路径上）

让 agent 做一件会触发审批的事（例如让它执行一条需要确认的命令）。

- [ ] IM 里收到 `需要你确认一项操作：` + 工具名 + 原因 + **4 位验证码**
      —— **这一步在 v0.8.7 及以前是走不通的**（提示压根发不出来），
      如果你是从旧版升上来的，这里就是升级的验收点
- [ ] `dsh approve <验证码>` → 回 `已提交：允许一次。`，且 DSH 侧那次操作继续跑
- [ ] 再来一次，用 `dsh reject <验证码>` → 回 `已提交：拒绝。`
- [ ] **重复回执同一个验证码** → `这个验证码已失效或不属于本会话。`（不会重复发给桥）
- [ ] 什么都不做，等过 `approvalTimeoutMs` → 回执时提示已超时（**fail closed**：按拒绝处理）

---

## 8. 问答链验证（同上，也是 v0.8.8 修的）

让 agent 用一个会提问的工具（`ask_user_question`）。

- [ ] IM 里收到 `DSH 想问你：` + 每题带编号、每个选项带 `[1] [2]` 编号 + 验证码
- [ ] **多题中途作答**（`dsh answer <验证码> 1 2`）→ 回「已记录…还剩 N 题」，
      且**没有**任何东西发给桥（这是刻意的：中途作答只落本地表）
- [ ] 答齐最后一题 → 回执发出，agent 继续
- [ ] 非数字作答（如 `dsh answer <验证码> 1 抹茶`）→ 作为**自由文字**提交
- [ ] 多选时用逗号（`1,3`）能提交多项

---

## 9. 呈现与韧性

### 9.1 `card` 模式（v0.8.9 修的）

```jsonc
{ "reply_render_mode": "card" }
```

- [ ] agent 回复变成图片卡
- [ ] **心跳播报与主动消息也变成图片卡** —— 这一步在 v0.8.9 以前是纯文本
- [ ] 把 t2i 弄坏后再触发一次，观察**整条退回纯文本**，绝不出现「半截图片 + 半截文字」。
      t2i 是 **AstrBot 的全局设置**（`Star.text_to_image` 沿用它当前的模板与端点），
      不是本插件的配置项——要去 AstrBot 侧改，别在这里找。

### 9.2 重连与幂等

- [ ] 长 turn 进行中掐断网络再恢复 → 流式续传（`Last-Event-ID`），不重复发送已发内容
- [ ] 同一条消息重复投递（网络重试）→ 回 `duplicate`，**不会**在 agent 侧多跑一轮

### 9.3 游标持久化（主动消息别重放）

- [ ] 触发一次自主心跳让它入发件箱，**先别让 IM 取走**（把 IM 侧插件停掉）
- [ ] 重启 AstrBot 插件（重载），恢复后观察：**不该**把发件箱里剩下的全部补发一遍
- [ ] AstrBot 的插件 KV 里能看到 `proactive_cursor` 在推进。
      4.26.7 的 KV 是 DB 后端（`data_v4.db` 的 `preferences` 表，scope_id 形如
      `<author>/<name>`；依据 `docs/astrbot-side-capabilities.md` §4.2 与本机实测的
      connector 记录）。**不持久化的后果**是：重载后首轮以 `since=0` 取件，
      而服务端只在 `since>0` 时才 prune —— 于是发件箱里剩下的会被**重发一遍**。

---

## 10. 跨机 / 反向代理专项

- [ ] **反向代理关缓冲**（`proxy_buffering off;` / Traefik 的 `buffering` 中间件）：
      不关的话 SSE 会被攒成一坨，表现为**回复一次性全出来**而不是流式
- [ ] 代理的空闲超时 > `heartbeatMs`（默认 15 秒），否则空闲连接会被中间设备掐掉
- [ ] 只放行 `/astrbot-relay/*`，Web UI 不外露
- [ ] `hmacMode` 若开启：两侧同开，且时钟偏差 < `signatureSkewMs`
- [ ] 用 HTTPS 时若自签：IM 侧 `ca_bundle_path` 指向 CA（**不支持**全局关校验）

---

## 11. 记录表（跑完请填回来）

三处「未实测」的关闭凭据就是这张表。**没跑的就写没跑**，别留空。

| # | 待关闭项 | 怎么算通过 | 结果 |
|---|---|---|---|
| 1 | 契约 **§18.8**：插件来源的 `followup` 是否起一轮（B 半地基） | §6.2 里出现「已入发件箱」或「选择沉默」 | ☐ 成立 / ☐ 不成立 / ☐ 未测 |
| 2 | **PLAN-v0.8.5 §5.3**：部署侧同步与定版 | §2~§4 全绿 | ☐ 通过 / ☐ 未测 |
| 3 | **A 半误报率**：长 turn（含长工具调用）期间会不会误判掉线 | §5.1 的前提下跑一次 > 2 分钟的工具调用，**不应**出现掉线播报 | ☐ 无误报 / ☐ 有误报 / ☐ 未测 |
| 4 | 主动消息的**量级**：5 秒轮询对两侧的负载 | §6.3 通过，且两侧 CPU/日志量无明显变化 | ☐ 可忽略 / ☐ 有影响 / ☐ 未测 |
| 5 | 代理缓冲下的流式 | §10 第一条 | ☐ 正常 / ☐ 失效 / ☐ 未测 |

**版本与日期**：IM 侧 `______`、DSH 侧 `______`、`bridgeVersion=______`、日期 `______`。

---

## 12. 回滚

1. `proactiveHeartbeatMs` 改回 `0`（**这是最该先做的一步**：它默认就是关的，
   开着才是异常状态）
2. 从 profile 的 `cordis.patch.yml`（或生成的 `cordis.yml`）里**去掉那一行 insert** ——
   这条不依赖任何 CLI，随时可用
3. 也可以走 CLI：`dsh plugin --profile web remove dsh-astrbot-relay`。
   ⚠️ `dsh plugin` 是个**透明的 pnpm 转发器**（`lib/bin.js` →
   `spawnSync('pnpm', args)` → reconcile `dsh.profile.bundles`），所以这是 pnpm 的
   `remove` 语义；本仓只核实过「命令存在 + 转发逻辑 + pnpm 在位」，
   **整条实跑没做过**（`docs/dsh-side-capabilities.md` §9 #1）。删不干净时回到第 2 步。
4. AstrBot 侧：插件页停用，或删 `data/plugins/astrbot_plugin_dsh_relay/`
5. **`state.json` 不用删**：它只是 IM 对话 ↔ DSH 会话的映射。
   回滚后重装会继续用同一批映射；真要重来才清。
6. `proactive_cursor`（AstrBot 插件 KV）也不用清：留着才不会重放旧消息。

---

## 13. 这份清单**不能**证明什么

写清楚，免得被打勾的表误导：

* **不证明 B 半在真实对话里「合适」**。它只证明「链路通了」。
  心跳该多久一次、要不要带会话摘要（PLAN §8 的 Q6）是策略问题，不是验证问题。
* **不证明权限面**。v1 的鉴权只有 Bearer + 可选 HMAC；P5 控制面（含权限门）
  尚未开工，`docs/DESIGN.md` §7.3 记着「不做就是提权漏洞」。
* **不覆盖多实例**。两个 AstrBot 连同一个 DSH 对话时，两者会以各自的游标取件、
  **重复投递**同一条主动消息（契约 §17 已声明这条限制）。
* **不验证版本升级路径**。跨 `bridgeVersion` 的升级永远要两侧同时换，
  不存在灰度窗口（契约 §10）。
