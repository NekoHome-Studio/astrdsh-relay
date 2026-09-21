"""AstrDsh Relay（星驿）：契约常量的机器可读副本（AstrBot 侧）。

唯一真相来源是 ``docs/BRIDGE-CONTRACT.md``。
本文件与 DSH 侧 ``dsh-astrbot-relay/lib/contract.js`` 必须逐字对应；
改动任一侧都要同步契约文档与另一侧。
"""

from __future__ import annotations

#: 契约版本。破坏性变更必须递增；/health 返回它，不匹配时拒绝启用。
#:
#: v2：新增 ``GET /workspaces`` 与 ``POST /session/rebind``（契约 §13）。
#:     对 v1 客户端而言是**增量**，但版本号仍递增——两侧的常量表是逐字对应的，
#:     让版本号忠实记录「这份常量表是哪一版」，比让客户端去猜差异更省事。
#:
#: v3：新增 ``POST /session/fork``（契约 §14）。同样只加了一条路由，
#:     **没有**新增错误码：DSH 侧的 ``session/fork-unavailable`` 与
#:     ``session/workspace-attach-failed`` 都落到既有的 ``agent_busy``（409），
#:     ``session/not-found`` 落到既有的 ``not_found``（404）——两者的共同语义是
#:     「请求本身没错，重试同一个请求也不会成功」，与 IM 侧的提示口径一致。
#:
#: v4：新增 ``POST /session/adopt``（契约 §15）。把某 IM 对话改指到一个**已存在**
#:     的会话 id——补上 v3 留下的缺口：``/session/fork`` 生出来的子会话此前只能
#:     被 ``/message`` 顺势接管，而 fork 之后本对话仍指着源会话，所以那句
#:     「另做一次改指」当时并无对应路由（rebind 的入参是工作区，语义是新建）。
#:     同样**没有**新增错误码：会话不存在→``not_found``（404），工作区不含该会话
#:     与「有投递在途」→``agent_busy``（409）。
BRIDGE_VERSION = "4"

#: 路由。契约 §3。相对 AstrBot 侧配置项 ``bridge_url``。
ROUTE_MESSAGE = "/message"
ROUTE_EVENTS = "/events"
ROUTE_APPROVAL = "/approval"
ROUTE_HEALTH = "/health"
#: 定位（契约 §12）：某对话 → 工作区 / DSH 会话。
ROUTE_WHERE = "/where"
ROUTE_CONVERSATIONS = "/conversations"
#: 列出宿主已登记的工作区（契约 §13.1）。
ROUTE_WORKSPACES = "/workspaces"
#: 把某 IM 对话改指到指定工作区（契约 §13.2）。
ROUTE_REBIND = "/session/rebind"
#: 从某对话的完整轮次边界分支出新对话（契约 §14）。
ROUTE_FORK = "/session/fork"
#: 把某对话改指到一个**已存在**的会话 id（契约 §15）。
ROUTE_ADOPT = "/session/adopt"

#: 下行事件类型。契约 §4。
EVENT_TURN_START = "turn/start"
EVENT_TEXT_DELTA = "text/delta"
EVENT_REASONING_DELTA = "reasoning/delta"
EVENT_TOOL_CALL = "tool/call"
EVENT_APPROVAL_REQUIRED = "approval/required"
EVENT_APPROVAL_RESOLVED = "approval/resolved"
EVENT_MESSAGE_FINAL = "message/final"
EVENT_TURN_END = "turn/end"
EVENT_HEARTBEAT = "heartbeat"
EVENT_GAP = "gap"

#: 未知事件类型必须被忽略（前向兼容），因此这里是"已知集合"而非白名单。
KNOWN_EVENT_TYPES = frozenset({
    EVENT_TURN_START,
    EVENT_TEXT_DELTA,
    EVENT_REASONING_DELTA,
    EVENT_TOOL_CALL,
    EVENT_APPROVAL_REQUIRED,
    EVENT_APPROVAL_RESOLVED,
    EVENT_MESSAGE_FINAL,
    EVENT_TURN_END,
    EVENT_HEARTBEAT,
    EVENT_GAP,
})

#: 统一错误码。契约 §8。
#: ``unsupported`` 与 ``not_implemented`` 是两件事，别混：
#:   - unsupported（400）：**请求**不合法（缺字段、类型错、Idempotency-Key 非 UUIDv4）。
#:   - not_implemented（501）：请求合法，但**网桥那一端还没做**。
#: 骨架阶段把两者混成 400，IM 侧会误以为是自己写错了参数，
#: 于是反复重试一个必然失败的请求。
ERROR_UNAUTHORIZED = "unauthorized"
ERROR_NOT_FOUND = "not_found"
ERROR_QUEUE_FULL = "queue_full"
ERROR_AGENT_BUSY = "agent_busy"
ERROR_UNSUPPORTED = "unsupported"
ERROR_NOT_IMPLEMENTED = "not_implemented"
ERROR_INTERNAL = "internal"

#: 可重试的错误码（含纯传输层失败）。契约 §6.2。
RETRYABLE_ERROR_CODES = frozenset({ERROR_INTERNAL})

#: IM 用户可接受的审批结论白名单。契约 §7.2 第 4 条。
#: DSH 侧完整枚举还有 ``cancelled`` / ``unavailable``，那两个是系统语义，
#: 不允许由 IM 用户触发。
APPROVAL_ALLOW_ONCE = "allowed-once"
APPROVAL_REJECTED = "rejected"
APPROVAL_OUTCOMES_ALLOWED = frozenset({APPROVAL_ALLOW_ONCE, APPROVAL_REJECTED})

#: 审批命令关键字。契约 §7.2 第 5 条：只接受明确命令，不接受"是/否"。
APPROVAL_COMMAND_APPROVE = "approve"
APPROVAL_COMMAND_REJECT = "reject"

#: 定位子命令。这是 **AstrBot 侧的 UX 词**，不是线上协议的一部分，
#: 因此只存在于本文件（DSH 侧那份契约副本里没有对应常量）。
COMMAND_WHERE = "where"

#: 帮助子命令。同 ``COMMAND_WHERE``，是 AstrBot 侧的 UX 词，不是线上协议的一部分；
#: 它与「裸前缀」共用同一份清单（`main._usage_text`），因此不存在"文档里有、
#: 敲下去没反应"的分叉。
COMMAND_HELP = "help"

#: 列出工作区的子命令。同 ``COMMAND_WHERE``，是 AstrBot 侧的 UX 词。
COMMAND_WORKSPACES = "workspaces"

#: 改指工作区的子命令。同 ``COMMAND_WHERE``，是 AstrBot 侧的 UX 词。
COMMAND_REBIND = "rebind"

#: 分支出新对话的子命令。同 ``COMMAND_WHERE``，是 AstrBot 侧的 UX 词。
COMMAND_FORK = "fork"

#: 认领既有会话的子命令。同 ``COMMAND_WHERE``，是 AstrBot 侧的 UX 词。
#: 它换的是**映射**（本对话从此指着那个会话），与 ``COMMAND_REBIND`` 换工作区、
#: ``COMMAND_FORK`` 造新会话都不是一回事，所以三个词各自独立，不互借。
COMMAND_ADOPT = "adopt"
