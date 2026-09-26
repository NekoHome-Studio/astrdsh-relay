"""星驿 · 连通性心跳的判定与播报策略（AstrBot 侧）。

**纯函数，不 import astrbot**，因此可在普通 Python 下单测
（见 ``scripts/test-heartbeat-state.py``，CI 会跑）。

设计依据 ``docs/PLAN-heartbeat.md`` §3。要点：

* 判定合成**两个信号**：``probe_ok``（``/health`` 探测，覆盖空闲期）与
  ``last_frame_at``（SSE 帧到达时刻，覆盖「HTTP 还通但 turn 卡死」）。
  用「任何帧」而不是「只认心跳帧」刷新——代理可能吞掉某一类帧，
  只有**完全**没有帧才说明链路死了；这也天然避开长 turn 的误判。
* 状态带**滞回**（online / suspect / offline 三态），``suspect`` 是抖动缓冲区，
  避免链路一抖就刷屏。
* 判定与播报**分开**：判定只产出状态，播报由 ``should_notify`` 按策略决定——
  这就是「由机器人选择是否回复」在 IM 侧的落点。
"""

from __future__ import annotations

#: 每对话在线态。
STATE_ONLINE = "online"
STATE_SUSPECT = "suspect"
STATE_OFFLINE = "offline"

#: 播报策略（对应配置项 ``heartbeat_notify``）。
NOTIFY_OFF = "off"
NOTIFY_FIXED = "fixed"
NOTIFY_AGENT = "agent"
NOTIFY_OFFLINE_ONLY = "offline-only"

#: 播报的两种事件。
KIND_OFFLINE = "offline"
KIND_RECOVERED = "recovered"

VALID_NOTIFY_MODES = frozenset({NOTIFY_OFF, NOTIFY_FIXED, NOTIFY_AGENT, NOTIFY_OFFLINE_ONLY})


def next_state(
    *,
    state: str,
    now_ms: int,
    probe_ok: bool,
    last_frame_at: int,
    frame_miss_ms: int,
) -> str:
    """算出该对话此刻应当处于哪个在线态。

    Args:
        state: 上一次的状态（仅用于日志/调用方参考；本函数是**无记忆**的纯判定）。
        now_ms: 当前毫秒时间戳。
        probe_ok: ``/health`` 探测是否成功。
        last_frame_at: 最后一次收到**任何** SSE 帧的毫秒时间戳；尚未收到过时传 0。
        frame_miss_ms: 帧间隔阈值（= ``heartbeatMs`` × 系数）。

    Returns:
        ``STATE_ONLINE`` / ``STATE_SUSPECT`` / ``STATE_OFFLINE``。

    判定顺序：**探测失败优先**——HTTP 层都不通了，再去比帧间隔没有意义。
    阈值取**闭区间**（``<=``）：恰好等于阈值算在线，避免边界抖动被判离线。
    """
    del state  # 无记忆判定：入参只作调用方上下文
    if not probe_ok:
        return STATE_OFFLINE
    threshold = max(1, int(frame_miss_ms))
    # 从未收到过帧（last_frame_at <= 0）时按「刚连上」处理：不立刻判离线，
    # 否则「先连 SSE」那一刻会因为还没有任何帧而瞬间报掉线。
    if int(last_frame_at) <= 0:
        return STATE_ONLINE
    elapsed = int(now_ms) - int(last_frame_at)
    if elapsed <= threshold:
        return STATE_ONLINE
    if elapsed <= threshold * 2:
        return STATE_SUSPECT
    return STATE_OFFLINE


def transition_kind(prev: str, cur: str) -> str | None:
    """两次状态之间是否构成一次**值得播报**的跃迁。

    * ``online`` / ``suspect`` → ``offline``：``KIND_OFFLINE``
    * ``offline`` → ``online``：``KIND_RECOVERED``
    * 其余（含 online ↔ suspect 的抖动、原地不动）返回 ``None``，不播报。
    """
    if cur == prev:
        return None
    if cur == STATE_OFFLINE and prev in (STATE_ONLINE, STATE_SUSPECT):
        return KIND_OFFLINE
    if prev == STATE_OFFLINE and cur == STATE_ONLINE:
        return KIND_RECOVERED
    return None


def should_notify(
    *,
    kind: str | None,
    mode: str,
    now_ms: int,
    last_notify_at: int,
    min_gap_ms: int,
) -> bool:
    """按策略决定这次跃迁要不要播报。

    ``min_gap_ms`` 是同一对话两次播报的最小间隔（防抖动刷屏）；
    ``last_notify_at`` 为 0（从未播报过）时必定通过——不能因为「刚启动」就把第一次掉线也吞掉。
    """
    if kind is None:
        return False
    if mode not in VALID_NOTIFY_MODES or mode == NOTIFY_OFF:
        return False
    if mode == NOTIFY_OFFLINE_ONLY and kind != KIND_OFFLINE:
        return False
    gap = max(0, int(min_gap_ms))
    if gap and int(last_notify_at) > 0 and int(now_ms) - int(last_notify_at) < gap:
        return False
    return True


def format_fixed_notice(
    kind: str,
    *,
    conversation: str = "",
    error: str = "",
    offline_ms: int = 0,
) -> str:
    """``fixed`` 策略下的固定文案。

    ⚠️ **不要写 Markdown 粗体（``**``）**：IM 端不做 Markdown 渲染，星号会原样露给用户。
    这是 v0.8.4 踩过一次的坑（见 CHANGELOG）。
    """
    if kind == KIND_OFFLINE:
        minutes = max(0, int(offline_ms)) // 60000
        suffix = f"，已持续约 {minutes} 分钟" if minutes >= 1 else ""
        reason = f"（{error}）" if error else ""
        return f"⚠️ 星驿：与 DSH 的连接中断{reason}{suffix}。此期间的指令会排队，恢复后继续。"
    if kind == KIND_RECOVERED:
        return "✅ 星驿：与 DSH 的连接已恢复。"
    # 未知 kind 返回空串：调用方据此跳过发送，而不是把内部枚举名露给用户。
    del conversation
    return ""


def frame_miss_ms_of(heartbeat_ms: int, factor: int) -> int:
    """由服务端心跳间隔与系数算出帧间隔阈值，两侧共用同一口径。

    与服务端 ``heartbeatMs`` 的夹取保持一致（下限 1000）：否则服务端把间隔压到 1 秒时，
    阈值会跟着缩到不可用的大小。
    """
    base = max(1000, int(heartbeat_ms or 0))
    return base * max(1, int(factor or 1))


# ──────────────────────────────────────────────────────────────────────
# agent 模式（由模型组织文案）
# ──────────────────────────────────────────────────────────────────────

#: ``render_agent_prompt`` 认得的占位符。未知占位符**原样保留**（便于发现写错）。
_AGENT_PROMPT_KEYS = ("kind", "kind_cn", "conversation", "error", "minutes")


def render_agent_prompt(
    template: str,
    *,
    kind: str,
    conversation: str = "",
    error: str = "",
    offline_ms: int = 0,
) -> str:
    """把提示词模板里的占位符替换成这次跃迁的事实。

    ⚠️ 这里**不做**「要不要播报」的判断——那是 ``should_notify`` 的职责，是确定性的。
    模型只负责**措辞**：让一句「链路断了」听起来像人说的话。把判定也交给模型，
    就会出现「它觉得这次不重要就不说了」，而连通性通知漏报的代价比措辞难看大得多。
    """
    minutes = max(0, int(offline_ms)) // 60000
    values = {
        "kind": str(kind or ""),
        "kind_cn": "中断" if kind == KIND_OFFLINE else "恢复",
        "conversation": str(conversation or ""),
        "error": str(error or ""),
        "minutes": str(minutes),
    }
    out = str(template or "")
    for key in _AGENT_PROMPT_KEYS:
        out = out.replace("{" + key + "}", values[key])
    return out


def sanitize_agent_notice(text: str, max_chars: int = 200) -> str:
    """把模型给的文案收紧成「IM 能安全显示的一段纯文本」。

    三件事，每件都有理由：

    1. **去掉 Markdown 标记**（``**`` / ``__`` / 反引号）：IM 端不渲染 Markdown，
       标记会原样露给用户。这个坑 v0.8.4 踩过一次（固定文案那时带了 ``**``）。
       只去这三个成对的标记，不当成通用 Markdown 清理器——那会开始猜内容。
    2. **压掉换行与连续空白**：连通性通知不该是多行报告；换行还会让某些平台
       把它拆成好几条消息。
    3. **截断**到 ``max_chars``：模型偶尔会写一大段，刷屏比不播报更糟。截断处补省略号。

    返回空串表示「这段不能用」，调用方据此退回固定文案（fail-closed）。
    """
    raw = str(text or "")
    for marker in ("**", "__", "`"):
        raw = raw.replace(marker, "")
    flat = " ".join(raw.split())
    limit = max(1, int(max_chars or 1))
    if len(flat) <= limit:
        return flat
    if limit == 1:
        return "…"
    return flat[: limit - 1].rstrip() + "…"
