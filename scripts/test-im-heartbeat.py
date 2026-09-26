#!/usr/bin/env python3
"""IM 侧心跳接线的**假 AstrBot 上下文**集成测试。

补上 `scripts/test-heartbeat-state.py` 之外的那一段：纯函数测过了，但
「帧刷新 → 探测接入 → 状态跃迁 → 按策略播报 → 主动发送」这条**接线**此前只做了
静态核查。这里用假 Context / 假 Transport 真跑 `Main` 的方法。

共用宿主见 `scripts/_fake_astrbot.py`（指令分发/审批/问答/卡片在
`scripts/test-im-commands.py`）。

用法：python scripts/test-im-heartbeat.py
"""

from __future__ import annotations

import asyncio
import contextlib
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fake_astrbot import (  # noqa: E402
    LOGGER, PLUGIN_DIR, UMO, MessageChainStub, PlainStub,
    hb, make_main, plugin_main, section, summary, test,
)


class FakeProvider:
    """假 AstrBot provider：只实现生产代码会用的那一个方法。

    形状按源码核实的结果来（v0.8.8）：
    ``await provider.text_chat(prompt=…) -> LLMResponse``，文本优先取
    ``result_chain.get_plain_text()``（``completion_text`` 已过时，仅兜底）。
    """

    def __init__(self, text: str = "", error: Exception | None = None, hang: bool = False) -> None:
        self.text = text
        self.error = error
        self.hang = hang
        self.prompts: list[str] = []
        self.system_prompts: list[str] = []

    async def text_chat(self, prompt: str | None = None, **kwargs):
        self.prompts.append(str(prompt or ""))
        self.system_prompts.append(str(kwargs.get("system_prompt") or ""))
        if self.hang:
            await asyncio.sleep(30)
        if self.error is not None:
            raise self.error
        return types.SimpleNamespace(
            result_chain=MessageChainStub(chain=[PlainStub(text=self.text)])
        )


section("A：帧刷新与在线态")

m, ctx, ft = make_main()
m._touch_frame(UMO)


@test("首次见帧即建档，且按在线处理（不能刚连上就判掉线）")
def _() -> None:
    entry = m._hb_states[UMO]
    assert entry["state"] == hb.STATE_ONLINE, entry
    assert entry["last_frame_at"] > 0, entry


@test("探测失败 → 落成离线，并按 fixed 策略播报带原因的文案")
def _() -> None:
    m._bridge_ok = False
    m._bridge_error = "HTTP 503"
    asyncio.run(m._evaluate_heartbeats())
    assert m._hb_states[UMO]["state"] == hb.STATE_OFFLINE
    assert ctx.sent, "应播报一次"
    assert ctx.sent[-1][0] == UMO
    assert "中断" in ctx.sent[-1][1], ctx.sent[-1][1]
    assert "HTTP 503" in ctx.sent[-1][1], ctx.sent[-1][1]


@test("恢复（探测成功 + 帧很新）→ 播报恢复")
def _() -> None:
    m._bridge_ok = True
    m._bridge_error = None
    m._touch_frame(UMO)
    asyncio.run(m._evaluate_heartbeats())
    assert m._hb_states[UMO]["state"] == hb.STATE_ONLINE
    assert "恢复" in ctx.sent[-1][1], ctx.sent[-1][1]


@test("帧间隔超阈（探测仍成功）也能判掉线——只靠 /health 抓不到这种")
def _() -> None:
    inst, c, _t = make_main()
    inst._touch_frame(UMO)
    inst._bridge_ok = True
    miss = hb.frame_miss_ms_of(15000, 3)
    inst._hb_states[UMO]["last_frame_at"] = plugin_main._now_ms() - miss * 3
    asyncio.run(inst._evaluate_heartbeats())
    assert inst._hb_states[UMO]["state"] == hb.STATE_OFFLINE
    assert c.sent and "中断" in c.sent[-1][1]


@test("off 策略永不播报，但状态照常推进")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="off")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    asyncio.run(inst._evaluate_heartbeats())
    assert inst._hb_states[UMO]["state"] == hb.STATE_OFFLINE
    assert c.sent == [], c.sent


@test("offline-only 只播掉线、不播恢复")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="offline-only")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    inst._bridge_ok = True
    inst._touch_frame(UMO)
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, "恢复不该再播报"


@test("白名单之外的对话不播报（但状态照常推进）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="fixed", heartbeat_notify_targets=["other:GroupMessage:1"])
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    asyncio.run(inst._evaluate_heartbeats())
    assert inst._hb_states[UMO]["state"] == hb.STATE_OFFLINE
    assert c.sent == [], c.sent


@test("最小间隔抑制第二次播报")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="fixed", heartbeat_notify_min_gap_ms=600_000)
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1
    # 恢复再掉线：第二次应当被最小间隔拦下
    inst._bridge_ok = True
    inst._touch_frame(UMO)
    asyncio.run(inst._evaluate_heartbeats())
    inst._bridge_ok = False
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, f"应被最小间隔拦下：{c.sent}"


@test("从未见过帧的对话（last_frame_at=0）不会被误判掉线")
def _() -> None:
    inst, c, _t = make_main()
    inst._hb_states[UMO] = {"state": hb.STATE_ONLINE, "last_frame_at": 0,
                            "last_notify_at": 0, "offline_since": 0}
    inst._bridge_ok = True
    asyncio.run(inst._evaluate_heartbeats())
    assert inst._hb_states[UMO]["state"] == hb.STATE_ONLINE
    assert c.sent == []


section("A：_health_loop 的接线（真跑循环）")

m2, ctx2, ft2 = make_main(health_interval_ms=1000)
m2._touch_frame(UMO)
ft2.health_error = RuntimeError("boom")


@test("健康复检失败会驱动一次判定（不必等第二个周期）")
def _() -> None:
    async def drive_loop() -> None:
        task = asyncio.create_task(m2._health_loop())
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(drive_loop())
    assert m2._bridge_ok is False
    assert m2._hb_states[UMO]["state"] == hb.STATE_OFFLINE, m2._hb_states[UMO]
    assert ctx2.sent and "中断" in ctx2.sent[-1][1], ctx2.sent
    assert LOGGER.has("warn", "健康复检失败")


@test("成功路径会把 /health 的 heartbeatMs 记下来（阈值同口径的前提）")
def _() -> None:
    inst, _c, t = make_main(health_interval_ms=1000)
    inst._touch_frame(UMO)
    t.health_result["heartbeatMs"] = 20000

    async def drive_loop() -> None:
        task = asyncio.create_task(inst._health_loop())
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(drive_loop())
    assert inst._hb_heartbeat_ms == 20000, inst._hb_heartbeat_ms


section("回归：生命周期字段必须挂在 Main 上")


@test("enable=false 时 initialize 直接 return，之后 terminate 不得崩溃")
def _() -> None:
    # 这条曾经真的崩过：_health_task 被写进 BridgeTransport.__init__，
    # 而 initialize 在 enable=false 时提前 return、从不创建该任务，
    # 于是 terminate 的 `if self._health_task is not None` 就是 AttributeError。
    inst, _c, _t = make_main(enable=False)
    asyncio.run(inst.initialize())
    asyncio.run(inst.terminate())
    assert LOGGER.has("info", "未启用")
    assert LOGGER.has("info", "terminated")


@test("Main.__init__ 之后，四个生命周期字段都已存在（不必等 initialize）")
def _() -> None:
    inst, _c, _t = make_main()
    for name in ("_health_task", "_proactive_task", "_proactive_cursor", "_hb_states", "_hb_heartbeat_ms"):
        assert hasattr(inst, name), f"Main 缺少 {name}"
    # 反面：传输层不该再挂这些，避免又一次「改一处、漏一处」
    transport = plugin_main.BridgeTransport({})
    for name in ("_health_task", "_proactive_task", "_proactive_cursor", "_hb_states"):
        assert not hasattr(transport, name), f"BridgeTransport 不该有 {name}"


@test("Main 里出现的**每一个** self._字段 在 __init__ 之后都已存在（通杀「字段挂错类」）")
def _() -> None:
    # 这条是上一条的泛化版：不写死名字，而是从源码里把 Main 类体中所有的
    # `self._xxx` 抠出来，逐个要求「刚 new 出来、还没 initialize 的实例上就有」。
    # 原来的 P0 正是「字段定义在 BridgeTransport.__init__、方法却挂在 Main 上」——
    # 那种错位编译器与任何静态门禁都看不出来，只有「拿一个刚构造的实例去摸一下」才现形。
    source = (PLUGIN_DIR / "main.py").read_text(encoding="utf-8")
    marker = "class Main(Star):"
    assert marker in source, "main.py 里找不到 Main 类，这条测试需要跟着重构"
    body = source[source.index(marker):]
    import re

    names = sorted(set(re.findall(r"self\.(_[A-Za-z_][A-Za-z0-9_]*)", body)))
    assert len(names) > 15, f"只抠出 {len(names)} 个字段，正则八成失效了"
    inst, _c, _t = make_main()
    missing = [name for name in names if not hasattr(inst, name)]
    assert not missing, f"这些字段在 Main.__init__ 里没定义（很可能被写到了别的类上）：{missing}"


@test("BridgeTransport 的十二个契约方法都在（README 与发布说明就是这么写的）")
def _() -> None:
    # 与「Main 字段挂错类」同源的另一种错位：方法写到了错误的类上。
    # 曾经 `proactive()` 就落在 `Main` 里、而它内部调的是 `BridgeTransport._request`
    # ——纯静态复核看不出来，只有「构造一个实例、逐个 getattr」才会现形。
    transport = plugin_main.BridgeTransport({})
    expected = [
        "health", "where", "workspaces", "rebind", "fork", "adopt",
        "send_message", "events", "send_approval", "send_answer", "proactive", "aclose",
    ]
    missing = [name for name in expected if not callable(getattr(transport, name, None))]
    assert not missing, f"BridgeTransport 缺少这些契约方法：{missing}"


section("B：主动消息的取件与发送")

m3, ctx3, ft3 = make_main()


@test("逐条推送并推进游标，且游标持久化到 KV")
def _() -> None:
    ft3.proactive_items = [
        {"id": 1, "conversation": UMO, "text": "我想到一件事", "at": 0},
        {"id": 2, "conversation": "default:FriendMessage:2", "text": "第二件", "at": 0},
    ]
    ft3.proactive_cursor = 2
    asyncio.run(m3._poll_proactive())
    assert ctx3.sent == [(UMO, "我想到一件事"), ("default:FriendMessage:2", "第二件")], ctx3.sent
    assert m3._proactive_cursor == 2
    assert m3.kv.get("proactive_cursor") == 2, m3.kv
    assert ft3.proactive_calls == [0]


@test("本地静音（proactive_enabled=false）：不发送，但游标照常推进")
def _() -> None:
    inst, c, t = make_main(proactive_enabled=False)
    t.proactive_items = [{"id": 5, "conversation": UMO, "text": "别发我", "at": 0}]
    t.proactive_cursor = 5
    asyncio.run(inst._poll_proactive())
    assert c.sent == [], c.sent
    assert inst._proactive_cursor == 5, "游标必须推进，否则恢复开关时会补发一堆旧的"


@test("空文本/空会话的条目被跳过，且不阻断后面的条目")
def _() -> None:
    inst, c, t = make_main()
    t.proactive_items = [
        {"id": 1, "conversation": "", "text": "没有会话", "at": 0},
        {"id": 2, "conversation": UMO, "text": "   ", "at": 0},
        {"id": 3, "conversation": UMO, "text": "这条该发", "at": 0},
        "不是对象",
    ]
    t.proactive_cursor = 3
    asyncio.run(inst._poll_proactive())
    assert c.sent == [(UMO, "这条该发")], c.sent


@test("前缀会被拼上")
def _() -> None:
    inst, c, t = make_main(proactive_prefix="（主动）")
    t.proactive_items = [{"id": 1, "conversation": UMO, "text": "正文", "at": 0}]
    t.proactive_cursor = 1
    asyncio.run(inst._poll_proactive())
    assert c.sent == [(UMO, "（主动）正文")], c.sent


@test("游标只前进不后退（服务端给了更小的 cursor 也不回退）")
def _() -> None:
    inst, _c, t = make_main()
    inst._proactive_cursor = 9
    t.proactive_cursor = 3
    asyncio.run(inst._poll_proactive())
    assert inst._proactive_cursor == 9, "回退会导致重复投递"
    assert t.proactive_calls == [9], "请求里要带当前游标（它同时是 ack）"


@test("_restore_proactive_cursor 从 KV 恢复")
def _() -> None:
    inst, _c, _t = make_main()
    inst.kv["proactive_cursor"] = 42
    asyncio.run(inst._restore_proactive_cursor())
    assert inst._proactive_cursor == 42, inst._proactive_cursor


@test("KV 读取抛错时不炸，按 0 起")
def _() -> None:
    inst, _c, _t = make_main()

    async def boom(_key, _default=None):
        raise RuntimeError("kv 坏了")

    inst.get_kv_data = boom  # type: ignore[assignment]
    asyncio.run(inst._restore_proactive_cursor())
    assert inst._proactive_cursor == 0
    assert LOGGER.has("warn", "读取主动消息游标失败")


section("C：心跳播报的 agent 模式（由模型组织文案）")


@test("agent 模式：用模型给的文案，而不是固定文案")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = FakeProvider("桥接断了，我先记着，回头补上。")
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    assert c.sent[-1][1] == "桥接断了，我先记着，回头补上。", c.sent[-1][1]


@test("agent 模式的提示词里带上了原因与时长（否则模型只能瞎编）")
def _() -> None:
    inst, _c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst._hb_states[UMO]["offline_since"] = plugin_main._now_ms() - 125_000
    provider = FakeProvider("嗯。")
    inst.context.provider = provider
    asyncio.run(inst._evaluate_heartbeats())
    prompt = provider.prompts[-1]
    assert UMO in prompt, prompt
    assert "HTTP 503" in prompt, prompt
    assert "2" in prompt, f"应含已持续分钟数：{prompt}"


@test("没有可用 provider ⇒ 退回固定文案（不能说就不说）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = None
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    assert "中断" in c.sent[-1][1], c.sent[-1][1]
    assert LOGGER.has("warn", "没有可用的对话模型")


@test("模型调用抛错 ⇒ 退回固定文案（连通性通知不能因为模型挂了就丢）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = FakeProvider(error=RuntimeError("模型超时"))
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    assert "中断" in c.sent[-1][1], c.sent[-1][1]
    assert LOGGER.has("warn", "调用失败")


@test("模型返回空串 ⇒ 退回固定文案")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = FakeProvider("   \n  ")
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    assert "中断" in c.sent[-1][1], c.sent[-1][1]


@test("模型输出里的 Markdown 裸星号会被清掉（IM 端不渲染 Markdown）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = FakeProvider("**注意**：桥接中断了。")
    asyncio.run(inst._evaluate_heartbeats())
    assert "**" not in c.sent[-1][1], c.sent[-1][1]
    assert c.sent[-1][1] == "注意：桥接中断了。", c.sent[-1][1]


@test("模型输出过长会被截断（防止一条通知刷满屏）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent", heartbeat_agent_max_chars=20)
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst.context.provider = FakeProvider("啊" * 100)
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent[-1][1]) <= 20, len(c.sent[-1][1])


@test("模板为空 ⇒ 退回固定文案（不能把空提示词丢给模型）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent", heartbeat_agent_prompt="")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    provider = FakeProvider("不该被用到")
    inst.context.provider = provider
    asyncio.run(inst._evaluate_heartbeats())
    assert provider.prompts == [], "空模板时不该调用模型"
    assert len(c.sent) == 1 and "中断" in c.sent[-1][1], c.sent
    assert LOGGER.has("warn", "heartbeat_agent_prompt 为空")


@test("agent 模式下 provider 不存在时不 panic，且只警告一次（不刷屏）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent")
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    before = len(LOGGER.lines)
    for _round in range(3):
        inst._touch_frame(UMO)
        asyncio.run(inst._evaluate_heartbeats())
    assert c.sent, "退回固定文案后仍必须播报"
    assert all("中断" in text or "恢复" in text for _umo, text in c.sent), c.sent
    warnings = [t for lv, t in LOGGER.lines[before:] if lv == "warn" and "没有可用的对话模型" in t]
    assert len(warnings) == 1, f"应只警告一次，实际 {len(warnings)} 次"


@test("模型调用卡住 ⇒ 超时后仍播报固定文案（不能把探测器本身拖停）")
def _() -> None:
    inst, c, _t = make_main(heartbeat_notify="agent", heartbeat_agent_timeout_ms=1000)
    inst._touch_frame(UMO)
    inst._bridge_ok = False
    inst._bridge_error = "HTTP 503"
    inst.context.provider = FakeProvider("慢", hang=True)
    asyncio.run(inst._evaluate_heartbeats())
    assert len(c.sent) == 1, c.sent
    assert "中断" in c.sent[-1][1], c.sent[-1][1]
    assert LOGGER.has("warn", "调用失败")


summary()
