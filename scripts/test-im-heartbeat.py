#!/usr/bin/env python3
"""IM 侧心跳接线的**假 AstrBot 上下文**集成测试。

补上 `scripts/test-heartbeat-state.py` 之外的那段：纯函数测过了，但
「帧刷新 → 探测接入 → 状态跃迁 → 按策略播报 → 主动发送」这条**接线**此前只做了
静态核查。这里桩掉 `astrbot.*`，用假 Context / 假 Transport 真跑 `Main` 的方法。

桩的设计（与 JS 侧 `scripts/test-proactive-chain.mjs` 同一思路）：
* `filter` 做成**任意属性都返回装饰器**，于是不管 main.py 用了哪些过滤器都不用改桩；
* `logger` 与 `Context.send_message` 都**记录**调用，供断言；
* `Star` 提供 KV 读写（`_restore_proactive_cursor` 依赖它）。

用法：python scripts/test-im-heartbeat.py

⚠️ **与其他 Python 闸门不同，本测试需要一个真实依赖**：它会 import 生产模块
`main.py`，而 `main.py` 顶部有 `import aiohttp`。aiohttp 是
`astrbot_plugin_dsh_relay/requirements.txt` 里声明的普通 PyPI 依赖（**不是**
宿主提供的 API），所以这里**不**用桩把它盖掉——盖掉就等于放弃验证
「main.py 的模块图真能导入」这一条。缺失时直接失败并给出安装命令，
**不静默跳过**：静默跳过正是「本地全绿、CI 没跑」那类漂移的来源。
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import sys
import types
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_DIR = ROOT / "astrbot_plugin_dsh_relay"

try:
    import aiohttp  # noqa: F401
except ImportError:
    print("✗ 本测试需要 aiohttp（它会 import 生产模块 main.py，不能用桩掩盖这个导入）。")
    print("  安装：pip install -r astrbot_plugin_dsh_relay/requirements.txt")
    sys.exit(1)


# ──────────────────────────────────────────────────────────────────────
# 1. 桩掉 astrbot.*
# ──────────────────────────────────────────────────────────────────────
class _LoggerStub:
    def __init__(self) -> None:
        self.lines: list[tuple[str, str]] = []

    def info(self, message: object) -> None:
        self.lines.append(("info", str(message)))

    def warning(self, message: object) -> None:
        self.lines.append(("warn", str(message)))

    def error(self, message: object) -> None:
        self.lines.append(("error", str(message)))

    def has(self, level: str, needle: str) -> bool:
        return any(lv == level and needle in text for lv, text in self.lines)


class _FilterStub:
    """任意属性都返回一个「能当装饰器用」的可调用对象。"""

    EventMessageType = types.SimpleNamespace(ALL="all", PRIVATE_MESSAGE="private", GROUP_MESSAGE="group")
    PlatformAdapterType = types.SimpleNamespace(ALL=0)
    PermissionType = types.SimpleNamespace(ADMIN="admin")

    def __getattr__(self, _name: str):
        def decorator(*args, **kwargs):
            if len(args) == 1 and callable(args[0]) and not kwargs:
                return args[0]

            def wrap(fn):
                return fn

            return wrap

        return decorator


class _MessageChainStub:
    def __init__(self, chain=None, **_kwargs) -> None:
        self.chain = list(chain or [])


class _PlainStub:
    def __init__(self, text: str = "") -> None:
        self.text = text


class _AstrMessageEventStub:
    """只在类型注解里出现（文件有 `from __future__ import annotations`，不会求值）。"""


class _AstrBotConfigStub(dict):
    pass


class _ContextStub:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []
        self.send_should_fail = False

    async def send_message(self, umo: str, chain) -> bool:
        text = "".join(getattr(part, "text", "") for part in getattr(chain, "chain", []))
        self.sent.append((umo, text))
        return not self.send_should_fail


class _StarStub:
    def __init__(self, context=None) -> None:
        self.context = context
        self.kv: dict[str, object] = {}

    async def put_kv_data(self, key: str, value: object) -> None:
        self.kv[key] = value

    async def get_kv_data(self, key: str, default=None):
        return self.kv.get(key, default)


LOGGER = _LoggerStub()


def _install_stubs() -> None:
    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    event = types.ModuleType("astrbot.api.event")
    components = types.ModuleType("astrbot.api.message_components")
    star = types.ModuleType("astrbot.api.star")

    api.AstrBotConfig = _AstrBotConfigStub
    api.logger = LOGGER
    event.AstrMessageEvent = _AstrMessageEventStub
    event.filter = _FilterStub()
    event.MessageChain = _MessageChainStub
    components.Plain = _PlainStub
    star.Context = _ContextStub
    star.Star = _StarStub

    astrbot.api = api
    sys.modules.update({
        "astrbot": astrbot,
        "astrbot.api": api,
        "astrbot.api.event": event,
        "astrbot.api.message_components": components,
        "astrbot.api.star": star,
    })


_install_stubs()
sys.path.insert(0, str(PLUGIN_DIR))

import heartbeat_state as hb  # noqa: E402
import main as plugin_main  # noqa: E402

UMO = "default:GroupMessage:1000000001"


# ──────────────────────────────────────────────────────────────────────
# 2. 假 transport 与 Main 工厂
# ──────────────────────────────────────────────────────────────────────
class FakeTransport:
    def __init__(self) -> None:
        self.health_result: dict[str, object] = {"bridgeVersion": 6, "heartbeatMs": 15000}
        self.health_error: Exception | None = None
        self.proactive_items: list[dict[str, object]] = []
        self.proactive_cursor = 0
        self.proactive_calls: list[int] = []
        self.closed = False

    async def health(self) -> dict[str, object]:
        if self.health_error is not None:
            raise self.health_error
        return dict(self.health_result)

    async def proactive(self, *, since: int = 0) -> dict[str, object]:
        self.proactive_calls.append(int(since))
        return {"ok": True, "cursor": self.proactive_cursor, "items": list(self.proactive_items)}

    async def aclose(self) -> None:
        self.closed = True


def make_main(**overrides):
    config = {
        "enable": True,
        "chunk_size": 0,                       # 0 = 不切分，断言更直接
        "heartbeat_notify": "fixed",
        "heartbeat_frame_miss_factor": 3,
        "heartbeat_notify_min_gap_ms": 0,
        "heartbeat_notify_targets": [],
        "proactive_enabled": True,
        "proactive_poll_ms": 5000,
        "proactive_prefix": "",
    }
    config.update(overrides)
    context = _ContextStub()
    instance = plugin_main.Main(context, config)
    transport = FakeTransport()
    instance._transport = transport
    return instance, context, transport


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


print("A：帧刷新与在线态")

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


print("\nA：_health_loop 的接线（真跑循环）")

m2, ctx2, ft2 = make_main(health_interval_ms=1000)
m2._touch_frame(UMO)
ft2.health_error = RuntimeError("boom")


@test("健康复检失败会驱动一次判定（不必等第二个周期）")
def _() -> None:
    async def drive() -> None:
        task = asyncio.create_task(m2._health_loop())
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(drive())
    assert m2._bridge_ok is False
    assert m2._hb_states[UMO]["state"] == hb.STATE_OFFLINE, m2._hb_states[UMO]
    assert ctx2.sent and "中断" in ctx2.sent[-1][1], ctx2.sent
    assert LOGGER.has("warn", "健康复检失败")


@test("成功路径会把 /health 的 heartbeatMs 记下来（阈值同口径的前提）")
def _() -> None:
    inst, _c, t = make_main(health_interval_ms=1000)
    inst._touch_frame(UMO)
    t.health_result["heartbeatMs"] = 20000

    async def drive() -> None:
        task = asyncio.create_task(inst._health_loop())
        await asyncio.sleep(0.1)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    asyncio.run(drive())
    assert inst._hb_heartbeat_ms == 20000, inst._hb_heartbeat_ms


print("\n回归：生命周期字段必须挂在 Main 上")


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


print("\nB：主动消息的取件与发送")

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


print(f"\n通过 {_passed} 项，失败 {len(_failed)} 项")
if _failed:
    print(f"失败项：{'、'.join(_failed)}")
    sys.exit(1)
