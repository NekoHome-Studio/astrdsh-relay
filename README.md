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
> 仅剩三项配置项未实现（`hmacMode` / 非 `one-to-one` 的 `policy` 轮转 / `idleTtlMs`），
> 命中时**加载即失败**，不会静默降级。最新发布：`v0.3.3`。

## 交付物地图

| 文件 | 是什么 |
|---|---|
| `docs/BRIDGE-CONTRACT.md` | **接口契约 v1**。两侧唯一真相来源：拓扑、会话键、4 个端点、事件 schema、鉴权、幂等/重试/背压、错误模型、审批流程。 |
| `docs/DESIGN.md` | **五层设计（核实修正版）**。含「原始设计假设 vs 源码事实」的 12 条差异修正表、分阶段计划、跨机部署清单、风险登记。 |
| `docs/dsh-side-capabilities.md` | DSH 侧 API 核实报告（1590 行，逐条 `路径:行号` 证据）。 |
| `docs/astrbot-side-capabilities.md` | AstrBot 侧 API 核实报告（1889 行，逐条证据）。 |
| `docs/connector-surface.md` | 既有 connector 的**能力面清点**（替代方案的验收基线 + 迁移三分类）。 |
| `docs/control-plane-transport.md` | 控制面传输可行性调研：能否在进程内调用/转发 DSH host RPC（决定替代成本）。 |
| `.probe/probe-api.mjs` | 控制面调研的可复现**只读**探针脚本（自签 cookie 走 33 个 endpoint，验证点号写法全 404、斜杠写法 200）。 |
| `docs/evidence/` | 实跑固化证据（`dsh --profile web --dump-config` 的实际层组合输出）。 |
| `dsh-astrbot-relay/` | DSH 侧 host 插件（`package.json` / `cordis.patch.yml` / `lib/contract.js` / `lib/index.js`，六个端点全部落地）。 |
| `astrbot_plugin_dsh_relay/` | AstrBot 侧 Star 插件（`main.py` / `_conf_schema.json` / `metadata.yaml` / `contract.py`，传输层六个方法全部实现）。 |
| `docs/RELEASING.md` | 发版流程：统一版本规则、tag 约定、产物形态与原因、CI 检查项。 |
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
> `/events`（SSE 流式）、`/approval` 六个端点全部落地，AstrBot 侧 `BridgeTransport`
> 的 `health` / `where` / `send_message` / `events` / `send_approval` / `aclose` 全部实现。
> 自动生成的发布说明会如实列出「已实现」与「三项未实现（加载即失败）」。
## 三个决定性结论（都改变了原始设计）

1. **路线选 A**：AstrBot 侧普通 Star 插件，复用现有 IM 适配器。
   `Platform` 基类只有 `run()` / `meta()` 两个抽象方法，`send_by_session()`
   有默认实现（不实现不报错，但主动消息**静默发不出**）——所以根本不写 Platform。

2. **传输不用现成的 `/api` RPC 面**，改为自建 DSH host 插件 + 自有鉴权路由 + SSE。
   三条硬理由：`/api` 有 Host/Origin 栅栏 + 浏览器 cookie 鉴权（跨机非浏览器客户端
   接不进去）；该面只能轮询 `session.history`；**审批只能在进程内拦截**。

3. **流式唯一正确的路是 `session/event` 上的 `assistant/chunk`**。它是活事件；
   真正不存在的是 `agent/assistant-stream`（全树 724 个 JS 扫描 0 命中，已证伪）。
   它是瞬时事件，**必须先连 SSE 再投消息**；最终文本取同源的 `assistant/message`。

## 尚未实现（刻意响亮失败）

契约里预留的三个配置项还没做，命中时 `assertConfigIsUsable` **加载即抛错**，
宁可装不上也不静默降级：`hmacMode`、非 `one-to-one` 的 `policy`（轮转策略）、`idleTtlMs`。

原 P1 的三件实测均已结案：第三方依赖可解析、`ctx.agents.create` 模型选择装法已定、
插件免重启生效；`agent/assistant-stream` 确认不存在，流式走 `session/event` 的 `assistant/chunk`。

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
