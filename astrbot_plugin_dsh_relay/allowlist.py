"""AstrDsh Relay（星驿）· 白名单匹配（零依赖纯函数）。

为什么单独成模块而不是塞在 ``main.py`` 里：
  ``main.py`` 顶部就 ``import astrbot``，测试机装不上 AstrBot 时它连导入都过不去；
  这里零依赖，``scripts/test-allowlist.py`` 可以直接 import 做纯函数断言，
  于是「白名单填法」这件事终于有了可回归的闸门，而不是靠人肉发消息试。

────────────────────────────────────────────────────────────────────────
背景（v0.7.1 的真实故障，写下来免得再犯）：

``allow_from`` 的文档口径是「会话白名单（UMO 列表）」，于是共犯照直觉填了
纯 QQ 号 ``3430088565``；而真实 UMO 是 ``绫地宁宁:FriendMessage:3430088565``。
逐字比较判 False → 事件被**静默放行**给默认 LLM，表现是「``/dsh 测试`` 没反应」，
日志里一个字都没有。文档没写错，是**填法不匹配**——
但让用户为了加白名单去反查平台 id、消息类型名和 session_id 拼串，
本身就是设计缺陷。

所以这一版的判据是「**填什么都要能对上**」：宽松填（纯 QQ 号 / 群号）命中，
精确填（完整 UMO）仍然逐字兼容 v0.7.1 的老配置。

────────────────────────────────────────────────────────────────────────
语法（每一条 entry；关键字前缀不区分大小写，值本身区分大小写；
``*`` 匹配任意长度、``?`` 匹配单字符，均可出现在任何字段里）：

  ``*``                              全部会话 / 全部人
  纯数字（如 ``3430088565``）         发送者本人（私聊群聊都算）
  ``user:<qq>`` / ``qq:<qq>``         同上（显式写法）
  ``group:<群号>``                    该群的任何成员（取不到群号时不放行）
  ``group:<群号>@<qq>``               该群里的这个人（按群限定成员）
  ``umo:<platform>:<type>:<id>``      显式按完整 UMO 匹配
  其余含 ``:`` 的值                    按完整 UMO 匹配（v0.7.1 老配置逐字兼容）

例：
  ``["3430088565"]``                     共犯在哪都能用（群里也只有他）
  ``["group:123456@3430088565"]``        只许共犯在 123456 群里用
  ``["绫地宁宁:FriendMessage:*"]``       平台上任意人的私聊
  ``["绫地宁宁:GroupMessage:*"]``        平台上所有群
"""

from __future__ import annotations

import re

# 关键字前缀 → 语义。写在一处，解析与文档（``_conf_schema.json`` 的 hint、
# ``docs/DESIGN.md`` §4）共用同一份口径，改一处就要改另一处。
SENDER_PREFIXES = ("user:", "qq:", "u:")
GROUP_PREFIXES = ("group:", "grp:", "g:")
UMO_PREFIXES = ("umo:",)

_ANY = "*"


def tokens_of(
    *,
    umo: str = "",
    sender_id: str = "",
    group_id: str = "",
) -> dict[str, str]:
    """把一次事件的「实际形状」摊平成待匹配字段。

    ``platform`` / ``message_type`` 从 UMO 里切（契约已核实 UMO 形如
    ``{platform_id}:{MessageType}:{session_id}``），切不出来就是空串——
    空串不会匹配任何**非空**模式，所以解析失败只会「拒绝」，不会「误放行」。
    """
    parts = str(umo or "").split(":", 2)
    platform = parts[0] if len(parts) == 3 else ""
    message_type = parts[1] if len(parts) == 3 else ""
    session_id = parts[2] if len(parts) == 3 else ""
    return {
        "umo": str(umo or ""),
        "platform": platform,
        "message_type": message_type,
        "session_id": session_id,
        "sender": str(sender_id or ""),
        "group": str(group_id or ""),
    }


def entry_matches(entry: str, tokens: dict[str, str]) -> bool:
    """单条 entry 是否命中这次事件。空白 entry 一律不命中（防手滑多打个逗号）。"""
    text = str(entry or "").strip()
    if not text:
        return False
    if text == _ANY:
        return True

    low = text.lower()
    for prefix in UMO_PREFIXES:
        if low.startswith(prefix):
            pattern = text[len(prefix):].strip()
            # ``umo:*`` 与裸 ``*`` 同义，别让用户以为它比 ``*`` 弱。
            if pattern == _ANY:
                return True
            return _glob_match(pattern, tokens.get("umo", ""))

    for prefix in GROUP_PREFIXES:
        if low.startswith(prefix):
            rest = text[len(prefix):].strip()
            # 群号取不到（私聊 / 事件没带 group_id）时，``group:*`` 也**不**放行：
            # 用户的意图是「这个群」，而此刻根本不知道是哪个群，宽放等于漏闸。
            if not tokens.get("group"):
                return False
            if "@" in rest:
                group_pattern, _, sender_pattern = rest.partition("@")
                return _glob_match(
                    group_pattern.strip(), tokens.get("group", "")
                ) and _glob_match(sender_pattern.strip(), tokens.get("sender", ""))
            return _glob_match(rest, tokens.get("group", ""))

    for prefix in SENDER_PREFIXES:
        if low.startswith(prefix):
            rest = text[len(prefix):].strip()
            # 平台 id 恰好叫 ``user`` / ``qq`` / ``u`` 时，v0.7.1 的老配置
            # ``user:FriendMessage:123`` 会被误读成「发送者 FriendMessage:123」。
            # 这里补一道 UMO 回落，老配置照样能用。
            if ":" in rest:
                return _glob_match(rest, tokens.get("sender", "")) or _glob_match(
                    text, tokens.get("umo", "")
                )
            return _glob_match(rest, tokens.get("sender", ""))

    if ":" not in text:
        # 纯数字（以及 ``123*`` 这类局部通配）按发送者解释——
        # 这正是共犯当初的填法，必须能命中，否则这次适配白做。
        return _glob_match(text, tokens.get("sender", ""))

    # 含 ``:`` 且不带已知前缀：按完整 UMO 匹配，兼容 v0.7.1 既有配置。
    return _glob_match(text, tokens.get("umo", ""))


def any_match(entries, tokens: dict[str, str]) -> bool:
    """一组 entry（``allow_from``）里有没有命中的。

    非列表 / 空列表 → True（= 不限制）。这条口径与 v0.7.1 一致：
    「留空 = 全部允许」是用户在 UI 上清空配置后的直觉预期。
    """
    if not isinstance(entries, (list, tuple, set)) or not entries:
        return True
    return any(entry_matches(entry, tokens) for entry in entries)


def ids_match(entries, value: str) -> bool:
    """``allow_users`` 用的逐 ID 匹配（同样吃 ``*`` / ``?`` 通配）。

    空值不命中非空模式；取不到发送者 ID 时由调用方按拒绝处理。
    """
    if not isinstance(entries, (list, tuple, set)) or not entries:
        return True
    text = str(value or "")
    return any(_glob_match(str(entry or "").strip(), text) for entry in entries)


def _glob_match(pattern: str, value: str) -> bool:
    """``*`` / ``?`` 通配匹配；比较不区分大小写（QQ 号与群号都是数字，
    平台 id 大小写不稳，宁宽勿窄——真挡人的是「一条都没命中」）。"""
    pattern = str(pattern or "").strip()
    if not pattern:
        return False
    if pattern == _ANY:
        return True
    body = "".join(
        ".*" if ch == "*" else "." if ch == "?" else re.escape(ch)
        for ch in pattern
    )
    return re.fullmatch(body, value or "", re.IGNORECASE | re.DOTALL) is not None
