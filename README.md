# AstrDsh Relay（星驿）— IM ↔ DSH 网桥

把 IM（QQ / Telegram 等，经 AstrBot）的消息桥接到 DeepSeek Harness 的 agent 会话，
并把流式输出与**敏感操作审批请求**带回聊天窗口。

| 名称 | 值 |
|---|---|
| 项目名 | **AstrDsh Relay** |
| 中文代号 | **星驿** |
| AstrBot 侧插件 | astrbot_plugin_dsh_relay |
| DSH 侧插件 | dsh-astrbot-relay |

> 当前 `main` 已打通 **P1 + P2 全链路**：IM 消息 → DSH agent 会话 → 流式回帖 + 审批转发。
> 契约预留的三项配置也已接线（`hmacMode` / `policy` 的 `on-demand`·`daily` 轮转 /
> `idleTtlMs` 空闲回收），轮转与回收**只归档不删历史**。
> v0.8.7 起另有**心跳**：IM 侧的连通性播报（A，固定文案或由对话模型组织措辞）与
> DSH 侧的自主心跳（B，默认关）。最新发布：`v0.9.0-alpha`。

## 交付物地图

| 文件 | 是什么 |
|---|---|
| `docs/BRIDGE-CONTRACT.md` | **接口契约 v6**。两侧唯一真相来源：拓扑、会话键、12 个端点（含 §13 工作区改指、§14 分支、§15 会话认领、§16 问答、§18 主动消息取件）、事件 schema、鉴权、幂等/重试/背压、错误模型、审批与问答流程、§17 心跳。 |
| `docs/DESIGN.md` | **五层设计（核实修正版）**。含「原始设计假设 vs 源码事实」的 12 条差异修正表、分阶段计划、跨机部署清单、风险登记。 |
| `docs/dsh-side-capabilities.md` | DSH 侧 API 核实报告（1590 行，逐条 `路径:行号` 证据）。 |
| `docs/astrbot-side-capabilities.md` | AstrBot 侧 API 核实报告（1889 行，逐条证据）。 |
| `docs/connector-surface.md` | 既有 connector 的**能力面清点**（替代方案的验收基线 + 迁移三分类）。 |
| `docs/control-plane-transport.md` | 控制面传输可行性调研：能否在进程内调用/转发 DSH host RPC（决定替代成本）。 |
| `.probe/probe-api.mjs` | 控制面调研的可复现**只读**探针脚本（自签 cookie 走 33 个 endpoint，验证点号写法全 404、斜杠写法 200）。 |
| `docs/evidence/` | 实跑固化证据（`dsh --profile web --dump-config` 的实际层组合输出）。 |
| `dsh-astrbot-relay/` | DSH 侧 host 插件（`package.json` / `cordis.patch.yml` / `lib/contract.js` / `lib/index.js` / `lib/proactive.js`，十二个端点全部落地）。 |
| `astrbot_plugin_dsh_relay/` | AstrBot 侧 Star 插件（`main.py` / `_conf_schema.json` / `metadata.yaml` / `contract.py` / `heartbeat_state.py`，传输层十二个方法全部实现）。 |
| `docs/RELEASING.md` | 发版流程：统一版本规则、tag 约定、产物形态与原因、CI 检查项。 |
| `docs/DEPLOY-CHECKLIST.md` | **部署与验证清单**：装包 → 逐条验证（数据面 / 心跳 A / 自主心跳 B / 审批 / 问答 / 呈现 / 跨机反代）→ 记录表 → 回滚。三处「未实测」的关闭凭据就是它的 §11。 |
| `scripts/package-release.mjs` | 打包脚本：校验 tag 与两侧版本 → 产出 tgz + zip + SHA256SUMS + 发布说明。 |
| `scripts/check-contract-parity.mjs` | 两侧契约常量一致性闸门（事件类型 / 错误码 / 路由 / 版本）。 |
| `.github/workflows/` | CI（语法 + 契约一致性 + 版本闸门 + 打包冒烟）与 Release（tag 触发自动发版）。 |
| `AstrBot插件开发指南总结.md` | 社区整理的 AstrBot 插件开发指南（参考资料，**非**本项目产出，部分条目与源码不符，见 DESIGN §1）。 |
| `新建 文本文档.txt` | DSH 官方插件开发教程文本（参考资料，非本项目产出）。 |

## 发布（Releases）

本项目采用**统一版本**：版本号在**三处**必须相等（根 `package.json`、
`dsh-astrbot-relay/package.json`、`astrbot_plugin_dsh_relay/metadata.yaml`），
一个 tag 同时发两个产物。

| 产物 | 装法 |
|---|---|
| `dsh-astrbot-relay-<v>.tgz` | `dsh plugin --profile web add ./dsh-astrbot-relay-<v>.tgz` |
| `astrbot_plugin_dsh_relay-<v>.zip` | 解压到 `AstrBot/data/plugins/` |

DSH 侧发**预打包 tgz** 而不是让人从 git 装，是因为 git 安装要靠包的 `prepare` 现场构建，
而 pnpm ≥10 默认拒绝运行 git 依赖的构建脚本、需要用户显式授权（等于允许该包在你机器上
执行安装期代码）。本包是纯 ESM JS、无构建步骤，所以走 tgz 可以让安装路径**完全不需要**
这项授权。

```powershell
node scripts/package-release.mjs --check   # 只校验版本与必需文件
node scripts/package-release.mjs           # 本地冒烟打包到 dist/
git tag v0.1.0 && git push origin v0.1.0   # 触发 Release workflow 自动发版
```

流程细节、产物形态的理由、CI 检查项见 `docs/RELEASING.md`。

> **`v0.3.0` 起是可运行实现**：`/health`、`/where`、`/conversations`、`/message`、
> `/events`（SSE 流式）、`/approval`、`/answer`（问答回执）、`/workspaces`、
> `/session/rebind`、`/session/fork`、`/session/adopt`、`/proactive`（主动消息取件）
> 十二个端点全部落地，AstrBot 侧 `BridgeTransport` 的 `health` / `where` /
> `workspaces` / `rebind` / `fork` / `adopt` / `send_message` / `events` /
> `send_approval` / `send_answer` / `proactive` / `aclose` 全部实现。
> 自动生成的发布说明会如实列出「已实现」与「未实现」；当前已无未实现项。

## 指令速查（AstrBot 侧）

前缀由 `trigger_prefix` 决定，默认 `dsh `（**不带斜杠**：AstrBot 会在事件进插件前
剥掉 wake_prefix `/`，所以配置写 `/dsh ` 会永远匹配不上、最后落到默认 LLM）。匹配按
**去尾空格**的基名判定，且两边各容忍一个前导 `/`，因此 `dsh`、`/dsh`、`dsh help` 与
`/dsh help` 落点相同、打出来的是同一份清单
（文案唯一来源：`main._usage_text`）。完整语义、接管行为与过滤顺序见
[`astrbot_plugin_dsh_relay/README.md`](astrbot_plugin_dsh_relay/README.md)。

| 指令 | 作用 |
|---|---|
| `/dsh <内容>` | 投给 DSH agent 并流式回帖 |
| `/dsh help` | 显示指令清单 |
| `/dsh where` | 定位本对话的工作区与 DSH 会话（只读，不投给 agent） |
| `/dsh workspaces` | 列出桥接端登记的工作区（只读，不投给 agent） |
| `/dsh rebind <工作区 id>` | 把本对话改指到指定工作区（新开会话，旧的不删） |
| `/dsh fork [轮次序号]` | 把本对话已完成的轮次前缀复制成新会话（旧的不动） |
| `/dsh adopt <会话 id> [工作区 id]` | 把本对话改指到一个已存在的会话（目标会话不动，也不建新会话） |
| `/dsh approve <验证码>` | 允许一次待审批操作 |
| `/dsh reject <验证码>` | 拒绝待审批操作 |

指令面**刻意只有这九条**（v0.8.0 口径）：`workspaces`（列工作区）与 `rebind`（改指）
随 v0.5.0 落地，`fork`（分支）随 v0.6.0 落地，`adopt`（认领已存在会话）随 v0.8.0
落地；`session`（切换）与 `settings` 这类入口
**仍不在本版**，也不在插件侧自行重造——宿主已有既有语义（换工作区是
`sessionController.create` 的 `workspaceId` 参数 + `workspace.attachSession`，分支是
`sessionController.fork` 的 `atSeq`），要用就直接进程内调，不另立一套。

## 三个决定性结论（都改变了原始设计）

1. **路线选 A**：AstrBot 侧普通 Star 插件，复用现有 IM 适配器。
   `Platform` 基类只有 `run()` / `meta()` 两个抽象方法，`send_by_session()`
   有默认实现（不实现不报错，但主动消息**静默发不出**）——所以根本不写 Platform。

2. **传输不用现成的 `/api` RPC 面**，改为自建 DSH host 插件 + 自有鉴权路由 + SSE。
   三条硬理由：`/api` 有 Host/Origin 栅栏 + 浏览器 cookie 鉴权（跨机非浏览器客户端
   接不进去）；该面只能轮询 `session.history`；**审批只能在进程内拦截**。

3. **流式文本随宿主版本有两个来源，DSH 侧插件两条都收**。≤ `0.1.2-rc.1` 走
   `session/event` 的 `assistant/chunk`（`chunk.type === 'text-delta'`，是活事件）；
   ≥ `0.1.5-rc.2` 宿主改发 `agent/assistant-stream` 的 `frame.chunk`（`dsh-agent-loop`
   的 `dispatch.emit` 点），与旧 `StreamChunk` **同形**，两侧收敛到同一个出口。
   早先「该事件不存在」的结论只对 `0.1.2-rc.1` 成立，已按新版宿主修订，见 DESIGN §P1。
   它是瞬时事件，**必须先连 SSE 再投消息**；最终文本取同源的 `assistant/message`。

## 预留配置（已接线）

契约里预留的三个配置项都已落地：`hmacMode`（§5.2 请求体 HMAC 签名）、`policy` 的
`on-demand` / `daily` 轮转、`idleTtlMs` 空闲回收。`assertConfigIsUsable` 对它们只做
**参数校验**（`policy` 必须落在枚举内、`idleTtlMs` 必须是有限正数），不再加载即抛错；
轮转与回收走 `workspaceRegistry.archiveSession`，**只归档不删历史**。

原 P1 的三件实测均已结案：第三方依赖可解析、`ctx.agents.create` 模型选择装法已定、
插件免重启生效；流式按宿主版本双协议收取（≤`0.1.2-rc.1` 的 `assistant/chunk` 与
≥`0.1.5-rc.2` 的 `agent/assistant-stream`），当初的「不存在」结论已按新版修订。

## 目标：**最终替代** `astrbot_plugin_dsh_connector`

用户已定：新插件 `astrbot_plugin_dsh_relay` **最终替代**既有的
`astrbot_plugin_dsh_connector` v2.0.1（本机当前禁用的那个），不是并存、不是 fork。

验收标准因此变成「**connector 的能力面被逐项覆盖或显式放弃**」：

- 能力清点（验收基线）：`docs/connector-surface.md`
- 迁移阶段与共存规则：`docs/DESIGN.md` §7（P5 控制面接管 / P6 退役）
- 迁移分三类：**可直接搬**（呈现层、选项存储模型、测试基线）/
  **必须重做**（依赖已删除的 `assistant/chunk`、依赖 `/api` 面的部分）/ **可放弃**
- 迁移分布：**必须重做 12 条 / 可直接搬 10 条 / 可放弃 7 条**

**决定性变量已收敛 → 管道式转发可行。** 第三方 host 插件在进程内按名调用既有
host RPC 是**公开 API**（`ctx.connection.createSharedFetchHandler('/api')`），
DSH 侧约 100 行即可转发，**不需要**逐方法重做那 28 个能力。但「AstrBot 侧只换
base_url」被**实机推翻**：connector 的 33 个点号 endpoint **33/33 全部 404**，
必须改成 `<namespace>/<method>` + `{args:{...}}`（业务字段却逐字段一致，所以改动
是机械的）。代价是**把整个 `/api` 面暴露给 IM**，因此强制方法白名单 + ADMIN
权限门成了必做项，不是加固项。结论见 `docs/control-plane-transport.md`，
落地要求见 `docs/DESIGN.md` §7.3 / §7.3.1。

## 许可证

GNU AGPL-3.0-or-later，全文见 [LICENSE](./LICENSE)。
Copyright (C) 2026 NekoHome-Studio。

本项目是网络服务侧的桥接组件。AGPL §13 对网络服务另有要求：以网络方式对外提供服务时，
须向使用者提供对应源码。
