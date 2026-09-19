# dsh-astrbot-relay（星驿 · DSH 侧，骨架）

DeepSeek Harness 的 **IM 网桥 host 半边**。它把「IM 前端（AstrBot）发来的一条消息」
翻译成一次 DSH agent 会话执行，并把流式输出、工具事件与**审批请求**推回去。

- 接口契约：`../docs/BRIDGE-CONTRACT.md`（唯一真相来源）
- 设计说明：`../docs/DESIGN.md`
- API 证据：`../docs/dsh-side-capabilities.md`

## 当前状态

**这是骨架，不是可用实现。** 未实现的端点返回 `501 unsupported` 并带明确说明，
不会假装成功。

| 部位 | 状态 |
|---|---|
| 插件契约（`name` / `inject` / `Config` / `apply`） | ✅ 就位 |
| 配置校验（加载即失败，不静默降级） | ✅ 就位 |
| 路由注册 + 失败降级为 no-op + effect 清理 | ✅ 就位 |
| Bearer 鉴权（定长比较） | ✅ 就位 |
| 契约常量（`lib/contract.js`） | ✅ 就位 |
| `GET /health`（含 cwd/statePath 等定位诊断） | ✅ 就位 |
| `GET /where`、`GET /conversations`（定位，契约 §12） | ✅ 就位 |
| 会话标题渲染 + `state.json` 原子读写 | ✅ 就位 |
| `POST /message`、`GET /events`（SSE）、`POST /approval` | ⛔ TODO（P1/P2） |
| agent 会话驱动、事件转发、审批 waterfall、幂等/背压/环形缓冲 | ⛔ TODO |
| 映射的**写入**路径（建立/回收会话时落盘） | ⛔ TODO（P1；读取已就位） |

## 为什么不用现成的 `/api/<method>` RPC 面

见契约 §1 的决策记录表。三条硬理由：跨机场景下 `/api` 的 Host/Origin 栅栏 +
浏览器 cookie 鉴权接不进去；该面只能轮询 `session.history`；**审批只能在进程内
拦截**，`/api` 面根本够不着。

## 安装（P1 完成后执行，现在装着也无法工作）

```powershell
# 在本目录的上一级执行
dsh plugin --profile web add ./dsh-astrbot-relay
dsh --profile web --dump-config    # 应出现 "# == dsh-astrbot-relay" 层
```

> 注意：`--dump-config` 会**写** `%DSH_HOME%\profiles\web\cordis.yml`，
> 在只读沙箱下会 EPERM。

用户在 profile 的 `cordis.patch.yml` 里覆盖部署取值（token / cwd 必填）：

```yaml
- id: dsh-astrbot-relay
  config:
    token: '<32+ 字节随机串>'
    cwd: 'D:\AI\workspace'
    pathPrefix: '/astrbot-relay'
```

**patch 语义提醒**：patch 是按顶层 key 赋值，写出的 `config:` 会**整体替换**
整行 config（不是逐字段 merge）。上面必须写全部要保留的字段。

## 动笔前必读的三条已核实事实

1. `ctx.webServer.register` 注册的路由**没有任何鉴权**——框架的 token/cookie 栅栏
   只挂在 `dsh-client-connection` 自己的 `/api` 路由上。鉴权必须自己写。
2. `text/delta` 来自 `session/event` 的 `assistant/chunk`，是**瞬时**事件：没有订阅者时永久丢失。
   因此契约强制 IM 侧「先连 SSE，再 POST /message」。反过来会丢开头几个 token。
3. agent 事件虽是 `Scoped<Agent>` 派发，但**根 ctx 上未打 tag 的监听者会收到所有
   agent 的事件**。必须自己按 `agent.id` 过滤，否则会串台到用户在 Web UI 里的会话。

## 动笔前必须实测的三件事（契约 §9）

1. `@deepseek-ai/schemastery` 与 `@deepseek-ai/dsh-llm` 作为**第三方插件**的依赖
   能否解析（已核实的两个真实插件都不 import 运行时包；但构造 `UserMessage` 需要
   `createUserMessage`，它会 deep-freeze 消息，手写对象会绕过 freeze）。
2. `ctx.agents.create` 的模型选择装法：`installModelSelection` /
   `agentPresets.mount` / 自建 `agent/request` hook，三选一。
3. ~~`agent/assistant-stream` 在真实运行进程里能否收到~~ **已结案：该事件不存在**；
   以及新装插件是否免重启生效。

## 参考范例（照抄对象，全是已核实路径）

| 目的 | 文件 |
|---|---|
| 手写 SSE | `dsh-client-hmr/lib/index.js:114-158` |
| 最小会话驱动 | `dsh-headless/lib/index.js:127-167` |
| 含 resume 的会话驱动 | `dsh-acp/lib/index.js:692-730` |
| **审批转发（async 等外部回执）** | `dsh-acp/lib/index.js:1115-1138` |
| 真实第三方插件的两半形态 | `Downloads/harness/dsh-skin-market`（`lib/index.js:11` 的 `ctx.inject` 用法） |
