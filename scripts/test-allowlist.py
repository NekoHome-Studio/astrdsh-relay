#!/usr/bin/env python3
"""``astrbot_plugin_dsh_relay/allowlist.py`` 的单元测试。

为什么这个文件必须存在：v0.7.1 的白名单是**逐字比较**，共犯填了纯 QQ 号
``3430088565`` 而真实 UMO 是 ``绫地宁宁:FriendMessage:3430088565``，于是判定 False →
事件静默放行给默认 LLM，表现成「``/dsh 测试`` 没反应」且日志无痕。
那次是靠反查适配器源码 + 发消息试错才定位的——这套断言就是把「试错」变成「回归」。

该模块刻意不 import astrbot，所以不需要安装 AstrBot 就能跑。CI 会执行本脚本。

用法：python scripts/test-allowlist.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Windows 控制台默认是 GBK，直接 print 对勾会 UnicodeEncodeError。
# 显式切到 UTF-8，避免「测试还没跑就死在输出上」。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):  # 老解释器或被重定向时忽略
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "astrbot_plugin_dsh_relay"))

import allowlist  # noqa: E402  （必须在 sys.path 调整之后导入）

_passed = 0
_failed: list[str] = []


def test(name: str):
    def decorator(fn):
        global _passed
        try:
            fn()
            _passed += 1
            print(f"  \u2713 {name}")
        except AssertionError as exc:
            _failed.append(name)
            print(f"  \u2717 {name}\n      {exc}")
        return fn

    return decorator


# ── 现场复刻 ─────────────────────────────────────────────────────────
# 这两个常量就是 v0.7.1 故障现场的原值：平台 id「绫地宁宁」、私聊 UMO、
# 共犯的 QQ 号。改测试时别「顺手美化」成 default:GroupMessage:123456，
# 那样就测不到中文平台 id 与真实 ID 形状了。
PLATFORM = "绫地宁宁"
PRIVATE_UMO = f"{PLATFORM}:FriendMessage:3430088565"
GROUP_UMO = f"{PLATFORM}:GroupMessage:987654321"
ME = "3430088565"

private = allowlist.tokens_of(umo=PRIVATE_UMO, sender_id=ME, group_id="")
group = allowlist.tokens_of(umo=GROUP_UMO, sender_id=ME, group_id="987654321")


def _ok(entries, tokens) -> bool:
    return allowlist.any_match(entries, tokens)


print("tokens_of")


@test("UMO 切成 platform / message_type / session_id 三段")
def _() -> None:
    assert private["platform"] == PLATFORM, private
    assert private["message_type"] == "FriendMessage", private
    assert private["session_id"] == ME, private
    assert group["message_type"] == "GroupMessage", group
    assert group["session_id"] == "987654321", group


@test("session_id 里的额外冒号不丢（split 只切两刀）")
def _() -> None:
    t = allowlist.tokens_of(umo="p:GroupMessage:a:b", sender_id="x", group_id="a")
    assert t["session_id"] == "a:b", t


@test("UMO 不成三段时各字段为空串，而不是抛错或瞎猜")
def _() -> None:
    t = allowlist.tokens_of(umo="3430088565", sender_id=ME, group_id="")
    assert t["platform"] == "" and t["message_type"] == "" and t["session_id"] == "", t
    assert t["sender"] == ME, t


print("allow_from：共犯当初的填法必须命中")


@test("纯 QQ 号命中私聊（这就是 v0.7.1 挂掉的那条）")
def _() -> None:
    assert _ok([ME], private) is True


@test("纯 QQ 号在群里也按人命中")
def _() -> None:
    assert _ok([ME], group) is True


@test("纯 QQ 号命中不到别人")
def _() -> None:
    assert _ok([ME], allowlist.tokens_of(umo="p:FriendMessage:10000", sender_id="10000")) is False


@test("user: / qq: / u: 前缀与裸 QQ 号等价，且大小写不敏感")
def _() -> None:
    for entry in (f"user:{ME}", f"QQ:{ME}", f"U:{ME}"):
        assert _ok([entry], private) is True, entry


print("allow_from：群与「群里的某人」")


@test("group: / grp: / g: 命中该群全员")
def _() -> None:
    for entry in ("group:987654321", "grp:987654321", "G:987654321"):
        assert _ok([entry], group) is True, entry


@test("group: 不命中别的群，也不命中没有群号的事件")
def _() -> None:
    assert _ok(["group:111"], group) is False
    assert _ok(["group:987654321"], private) is False


@test("group:<群号>@<qq>：群与人都要对上")
def _() -> None:
    assert _ok(["group:987654321@3430088565"], group) is True
    assert _ok(["group:111@3430088565"], group) is False
    assert _ok(["group:987654321@999"], group) is False


print("allow_from：精确与兼容")


@test("完整 UMO 逐字命中（v0.7.1 老配置原样可用）")
def _() -> None:
    assert _ok([PRIVATE_UMO], private) is True
    assert _ok([PRIVATE_UMO], group) is False


@test("umo: 前缀是同一件事的显式写法")
def _() -> None:
    assert _ok([f"umo:{PRIVATE_UMO}"], private) is True
    assert _ok(["umo:*"], group) is True


@test("带冒号但无已知前缀的值按 UMO 比，不按发送者比")
def _() -> None:
    # 若这里被误当成发送者，「3430088565」就永远比不上带冒号的模式 → 静默失效
    assert _ok([f"{PLATFORM}:FriendMessage:*"], private) is True
    assert _ok([f"{PLATFORM}:GroupMessage:*"], group) is True


@test("平台 id 恰好叫 user/qq/u 时，老配置的 UMO 仍逐字命中")
def _() -> None:
    t = allowlist.tokens_of(umo="user:FriendMessage:1", sender_id="x", group_id="")
    # 若只按关键字前缀处理，会拿 "FriendMessage:1" 去比发送者 → 静默失效
    assert allowlist.entry_matches("user:FriendMessage:1", t) is True
    assert allowlist.entry_matches("qq:FriendMessage:1", t) is False


print("通配与边界")


@test("* 放行全部；umo:* 与它同义")
def _() -> None:
    assert _ok(["*"], private) is True and _ok(["*"], group) is True
    assert allowlist.entry_matches("  *  ", private) is True


@test("? 只吃一个字符")
def _() -> None:
    assert _ok(["343008856?"], private) is True
    assert _ok(["343008856??"], private) is False


@test("通配出现在中间：123*456 命中 123456")
def _() -> None:
    t = allowlist.tokens_of(umo="p:FriendMessage:123456", sender_id="123456")
    assert _ok(["123*456"], t) is True


@test("比较忽略大小写，但中文与数字要真对上")
def _() -> None:
    t = allowlist.tokens_of(umo="NENE:FriendMessage:1", sender_id="1")
    assert _ok(["nene:friendmessage:1"], t) is True
    assert _ok(["nene:friendmessage:1"], private) is False


@test("空白 entry 不命中（手滑多打的逗号不该变成全放行）")
def _() -> None:
    assert allowlist.entry_matches("", private) is False
    assert allowlist.entry_matches("   ", private) is False
    # 列表里只有空白 → 一条都不命中 → False（拒绝），而不是 True
    assert _ok([""], private) is False
    assert _ok(["", "  "], private) is False


@test("非空列表 + 全不命中 = 拒绝；空列表 / 非列表 = 全部允许")
def _() -> None:
    assert _ok([], private) is True
    assert _ok(None, private) is True
    assert _ok([ME, "other"], group) is True
    assert _ok(["other"], group) is False


@test("取不到发送者 ID 时不会误放行")
def _() -> None:
    anon = allowlist.tokens_of(umo="p:FriendMessage:", sender_id="", group_id="")
    assert _ok([ME], anon) is False   # 裸 QQ 号比不上空发送者
    assert _ok(["group:*"], anon) is False  # 群号空，group:* 也不放行（私聊不该被群规则放进来）
    assert _ok(["*"], anon) is True   # 用户显式全放行仍然生效


print("allow_users：ids_match")


@test("逐 ID 命中与未命中")
def _() -> None:
    assert allowlist.ids_match([ME], ME) is True
    assert allowlist.ids_match([ME, "1"], "1") is True
    assert allowlist.ids_match([ME], "999") is False


@test("ids_match 也吃通配，且空白 entry 不命中")
def _() -> None:
    assert allowlist.ids_match(["343*"], ME) is True
    assert allowlist.ids_match([""], ME) is False
    assert allowlist.ids_match([], ME) is True


@test("ids_match 对空值不命中非空模式")
def _() -> None:
    assert allowlist.ids_match([ME], "") is False
    assert allowlist.ids_match(["*"], "") is True


print("接口面")


@test("关键字常量与模块文档同源，改一处要改另一处")
def _() -> None:
    assert allowlist.SENDER_PREFIXES == ("user:", "qq:", "u:"), allowlist.SENDER_PREFIXES
    assert allowlist.GROUP_PREFIXES == ("group:", "grp:", "g:"), allowlist.GROUP_PREFIXES
    assert allowlist.UMO_PREFIXES == ("umo:",), allowlist.UMO_PREFIXES


@test("entry 是非字符串（YAML 里手填成数字）时不抛错")
def _() -> None:
    assert allowlist.entry_matches(3430088565, private) is True  # type: ignore[arg-type]
    assert _ok([3430088565], private) is True


print(f"\n{_passed} 项通过，{_failed.__len__()} 项失败")
if _failed:
    print("失败项：" + "、".join(_failed))
    sys.exit(1)
