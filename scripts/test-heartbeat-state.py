#!/usr/bin/env python3
"""``astrbot_plugin_dsh_relay/heartbeat_state.py`` 的单元测试（A 的判定与播报策略）。

该模块刻意不 import astrbot，所以不需要安装 AstrBot 就能跑。CI 会执行本脚本。

用法：python scripts/test-heartbeat-state.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# Windows 控制台默认 GBK，直接 print 对勾会 UnicodeEncodeError。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "astrbot_plugin_dsh_relay"))

import heartbeat_state as hb  # noqa: E402  （必须在 sys.path 调整之后导入）

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


MISS = 15000          # 15s 心跳 × 系数 1，便于算边界
NOW = 10_000_000


print("next_state")

s = hb.next_state


@test("探测失败 → 离线（优先于帧间隔判定）")
def _() -> None:
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=False,
             last_frame_at=NOW, frame_miss_ms=MISS) == hb.STATE_OFFLINE


@test("帧间隔在阈值内 → 在线（边界取闭区间）")
def _() -> None:
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW, frame_miss_ms=MISS) == hb.STATE_ONLINE
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW - MISS, frame_miss_ms=MISS) == hb.STATE_ONLINE


@test("超过一个阈值 → 可疑；超过两个 → 离线（滞回带）")
def _() -> None:
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW - MISS - 1, frame_miss_ms=MISS) == hb.STATE_SUSPECT
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW - MISS * 2, frame_miss_ms=MISS) == hb.STATE_SUSPECT
    assert s(state=hb.STATE_SUSPECT, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW - MISS * 2 - 1, frame_miss_ms=MISS) == hb.STATE_OFFLINE


@test("从未收到过帧时不立刻判离线（否则「先连 SSE」那一刻就误报）")
def _() -> None:
    assert s(state=hb.STATE_OFFLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=0, frame_miss_ms=MISS) == hb.STATE_ONLINE


@test("frame_miss_ms 为 0/负数时退化为 1，不除零不误判")
def _() -> None:
    assert s(state=hb.STATE_ONLINE, now_ms=NOW, probe_ok=True,
             last_frame_at=NOW, frame_miss_ms=0) == hb.STATE_ONLINE


print("\ntransition_kind")


@test("online / suspect → offline 记一次掉线")
def _() -> None:
    assert hb.transition_kind(hb.STATE_ONLINE, hb.STATE_OFFLINE) == hb.KIND_OFFLINE
    assert hb.transition_kind(hb.STATE_SUSPECT, hb.STATE_OFFLINE) == hb.KIND_OFFLINE


@test("offline → online 记一次恢复")
def _() -> None:
    assert hb.transition_kind(hb.STATE_OFFLINE, hb.STATE_ONLINE) == hb.KIND_RECOVERED


@test("抖动与原地不动都不算事件（suspect 就是为此存在的）")
def _() -> None:
    assert hb.transition_kind(hb.STATE_ONLINE, hb.STATE_SUSPECT) is None
    assert hb.transition_kind(hb.STATE_SUSPECT, hb.STATE_ONLINE) is None
    assert hb.transition_kind(hb.STATE_ONLINE, hb.STATE_ONLINE) is None
    assert hb.transition_kind(hb.STATE_OFFLINE, hb.STATE_OFFLINE) is None


print("\nshould_notify")


@test("off 策略永不播报（默认就是它）")
def _() -> None:
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode=hb.NOTIFY_OFF,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is False
    assert hb.should_notify(kind=hb.KIND_RECOVERED, mode=hb.NOTIFY_OFF,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is False


@test("fixed 策略掉线与恢复都播报")
def _() -> None:
    for kind in (hb.KIND_OFFLINE, hb.KIND_RECOVERED):
        assert hb.should_notify(kind=kind, mode=hb.NOTIFY_FIXED,
                                now_ms=NOW, last_notify_at=0, min_gap_ms=0) is True


@test("offline-only 只播掉线")
def _() -> None:
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode=hb.NOTIFY_OFFLINE_ONLY,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is True
    assert hb.should_notify(kind=hb.KIND_RECOVERED, mode=hb.NOTIFY_OFFLINE_ONLY,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is False


@test("agent 策略的触发集合与 fixed 相同（差别只在文案由谁组织）")
def _() -> None:
    for kind in (hb.KIND_OFFLINE, hb.KIND_RECOVERED):
        assert hb.should_notify(kind=kind, mode=hb.NOTIFY_AGENT,
                                now_ms=NOW, last_notify_at=0, min_gap_ms=0) is True


@test("kind 为 None 一律不播报")
def _() -> None:
    assert hb.should_notify(kind=None, mode=hb.NOTIFY_FIXED,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is False


@test("最小间隔拦住过密播报，但不拦第一次")
def _() -> None:
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode=hb.NOTIFY_FIXED,
                            now_ms=NOW, last_notify_at=NOW - 1000, min_gap_ms=600_000) is False
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode=hb.NOTIFY_FIXED,
                            now_ms=NOW, last_notify_at=NOW - 600_000, min_gap_ms=600_000) is True
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode=hb.NOTIFY_FIXED,
                            now_ms=NOW, last_notify_at=0, min_gap_ms=600_000) is True


@test("未知 mode 视为关闭（配置写错时不刷屏）")
def _() -> None:
    assert hb.should_notify(kind=hb.KIND_OFFLINE, mode="nonsense",
                            now_ms=NOW, last_notify_at=0, min_gap_ms=0) is False


print("\nformat_fixed_notice")


@test("掉线文案含原因与持续时长，且不含 Markdown 裸星号")
def _() -> None:
    text = hb.format_fixed_notice(hb.KIND_OFFLINE, conversation="c", error="HTTP 503",
                                  offline_ms=180_000)
    assert "中断" in text, text
    assert "HTTP 503" in text, text
    assert "约 3 分钟" in text, text
    assert "**" not in text, "IM 端不渲染 Markdown，不能出现裸星号"


@test("不足一分钟不显示时长（避免「约 0 分钟」）")
def _() -> None:
    assert "分钟" not in hb.format_fixed_notice(hb.KIND_OFFLINE, offline_ms=30_000)


@test("恢复文案")
def _() -> None:
    assert "恢复" in hb.format_fixed_notice(hb.KIND_RECOVERED)


@test("未知 kind 返回空串（调用方据此跳过发送，而不是把枚举名露给用户）")
def _() -> None:
    assert hb.format_fixed_notice("nonsense") == ""


print("\nframe_miss_ms_of")


@test("与服务端 heartbeatMs 的夹取口径一致（下限 1000）")
def _() -> None:
    assert hb.frame_miss_ms_of(15000, 3) == 45000
    assert hb.frame_miss_ms_of(100, 3) == 3000, "服务端会把间隔夹到 >=1000，阈值跟着走"
    assert hb.frame_miss_ms_of(15000, 0) == 15000, "系数非法退化为 1"
    assert hb.frame_miss_ms_of(0, 2) == 2000


print(f"\n通过 {_passed} 项，失败 {len(_failed)} 项")
if _failed:
    print(f"失败项：{'、'.join(_failed)}")
    sys.exit(1)
