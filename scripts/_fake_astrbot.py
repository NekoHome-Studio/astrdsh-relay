"""星驿 · IM 侧测试共用的**假 AstrBot 宿主**。

被两个测试文件共用：

* ``scripts/test-im-heartbeat.py`` —— 心跳（A）与主动消息（B）的接线；
* ``scripts/test-im-commands.py`` —— 指令分发、审批链、问答链、卡片渲染。

为什么必须单独一个文件（而不是各写一份桩）：桩要**在 ``import main`` 之前**装好，
而两个测试都要用；各写一份必然漂移——本项目已经吃过一次「改一处、漏一处」的亏
（见 CHANGELOG v0.8.7 的两处 P0）。

⚠️ 本测试需要 **aiohttp**：它会 import 生产模块 ``main.py``，而后者顶部有
``import aiohttp``。aiohttp 是 ``astrbot_plugin_dsh_relay/requirements.txt`` 里声明的
普通 PyPI 依赖（**不是**宿主提供的 API），所以这里**不**用桩把它盖掉——盖掉就等于
放弃验证「main.py 的模块图真能导入」。缺失时直接失败并给出安装命令，**不静默跳过**：
静默跳过正是「本地全绿、CI 没跑」那类漂移的来源。
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
class LoggerStub:
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


class FilterStub:
    """任意属性都返回一个「能当装饰器用」的可调用对象。

    这样 main.py 以后加任何过滤器都不用回来改桩——桩一旦需要跟着生产代码改，
    它就不再是中立的替身了。
    """

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


class MessageChainStub:
    def __init__(self, chain=None, **_kwargs) -> None:
        self.chain = list(chain or [])

    def get_plain_text(self, with_other_comps_mark: bool = False) -> str:
        """与真实 ``MessageChain.get_plain_text()`` 同口径（只取 Plain 的 text）。"""
        del with_other_comps_mark
        return "".join(str(getattr(part, "text", "") or "") for part in self.chain)


class PlainStub:
    def __init__(self, text: str = "") -> None:
        self.text = text


class ImageStub:
    """与真实 ``Image`` 同形：``file`` 字段 + 两个 classmethod。

    ``fromURL`` 对非 http 输入**抛异常**——真实实现就是这么写的
    （``components.py`` 的 ``Image.fromURL``），照抄才能测出分派写错。
    """

    def __init__(self, file: str = "") -> None:
        self.file = file

    @staticmethod
    def fromURL(url: str) -> "ImageStub":
        if not str(url).startswith(("http://", "https://")):
            raise Exception("not a valid url")
        return ImageStub(file=str(url))

    @staticmethod
    def fromFileSystem(path) -> "ImageStub":
        return ImageStub(file=str(path))


class AstrMessageEventStub:
    """只在类型注解里出现（文件有 `from __future__ import annotations`，不会求值）。"""


class AstrBotConfigStub(dict):
    pass


class ContextStub:
    """假 Context：记录 ``send_message``，并提供可注入的 LLM provider。

    记录分两类：文本与图片。``sent`` 只返回**纯文本**那部分，这样既有的
    「按纯文本断言」的用例不会被图片消息污染；图片走 ``images``。
    """

    def __init__(self) -> None:
        #: (kind, umo, payload)，kind ∈ {"text", "image"}
        self.messages: list[tuple[str, str, str]] = []
        self.send_should_fail = False
        #: 由测试注入：``get_using_provider(umo)`` 的返回值。
        self.provider: object | None = None
        self.provider_error: Exception | None = None
        self.provider_calls: list[str] = []

    @property
    def sent(self) -> list[tuple[str, str]]:
        return [(umo, payload) for kind, umo, payload in self.messages if kind == "text"]

    @property
    def images(self) -> list[tuple[str, str]]:
        return [(umo, payload) for kind, umo, payload in self.messages if kind == "image"]

    async def send_message(self, umo: str, chain) -> bool:
        parts = list(getattr(chain, "chain", []))
        for part in parts:
            if isinstance(part, ImageStub):
                self.messages.append(("image", umo, str(getattr(part, "file", "") or "")))
        text = "".join(
            str(getattr(part, "text", "") or "") for part in parts if isinstance(part, PlainStub)
        )
        if text:
            self.messages.append(("text", umo, text))
        return not self.send_should_fail

    def get_using_provider(self, umo: str | None = None):
        self.provider_calls.append(str(umo or ""))
        if self.provider_error is not None:
            raise self.provider_error
        return self.provider


class StarStub:
    def __init__(self, context=None) -> None:
        self.context = context
        self.kv: dict[str, object] = {}

    async def put_kv_data(self, key: str, value: object) -> None:
        self.kv[key] = value

    async def get_kv_data(self, key: str, default=None):
        return self.kv.get(key, default)

    async def text_to_image(self, text: str, return_url: bool = True):
        """真实实现走外部 t2i 服务；这里由测试按需覆盖。"""
        raise RuntimeError("测试未提供 text_to_image")


LOGGER = LoggerStub()


def _install_stubs() -> None:
    astrbot = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")
    event = types.ModuleType("astrbot.api.event")
    components = types.ModuleType("astrbot.api.message_components")
    star = types.ModuleType("astrbot.api.star")

    api.AstrBotConfig = AstrBotConfigStub
    api.logger = LOGGER
    event.AstrMessageEvent = AstrMessageEventStub
    event.filter = FilterStub()
    event.MessageChain = MessageChainStub
    components.Plain = PlainStub
    components.Image = ImageStub
    star.Context = ContextStub
    star.Star = StarStub

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
UMO_PRIVATE = "default:FriendMessage:1000000002"


# ──────────────────────────────────────────────────────────────────────
# 2. 假 transport
# ──────────────────────────────────────────────────────────────────────
class FakeTransport:
    """记录调用、返回罐头数据，并可按需要抛错。

    刻意**不复刻 HTTP 细节**：这一层要测的是「IM 侧有没有正确接线」，
    真实传输已由 DSH 侧的假宿主（``scripts/test-*-chain.mjs``）覆盖。

    ⚠️ 但**方法名与参数名必须与真实 ``BridgeTransport`` 逐一对齐**，否则桩会骗人：
    第一版把 ``fork`` 写成了 ``upto_turn``，而真名是 ``at_seq``；于是处理器的
    ``except Exception`` 把 TypeError 吞掉、只回了一句「分支失败」，
    测试看到的是「没有任何调用」——一个由桩自己造出来的假象。
    ``test-im-commands.py`` 里有一条签名对齐的断言专门钉这件事。
    """

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.results: dict[str, object] = {}
        self.errors: dict[str, Exception] = {}

        self.health_result: dict[str, object] = {"bridgeVersion": 6, "heartbeatMs": 15000}
        self.health_error: Exception | None = None
        self.proactive_items: list[dict[str, object]] = []
        self.proactive_cursor = 0
        self.proactive_calls: list[int] = []
        self.closed = False

        #: ``events()`` 会按顺序吐出的帧；吐完就结束（pump 随之退出）。
        self.frames: list[object] = []
        #: 连接信号**故意不预置**：真实传输是在 SSE 握手完成时才 set 的，
        #: 而 `_handle_task` 正是靠「等这个信号」来保证「先连流、再投递」。
        #: 预置它会让 pump 任务来不及跑，于是测出来的调用顺序是假的。
        self.signal: asyncio.Event = asyncio.Event()
        self.events_started = 0

    # -- 记录 --
    def _record(self, name: str, **kwargs) -> None:
        self.calls.append((name, kwargs))

    def called(self, name: str) -> list[dict]:
        return [kwargs for called, kwargs in self.calls if called == name]

    def _maybe_raise(self, name: str):
        if name in self.errors:
            raise self.errors[name]
        return self.results.get(name)

    # -- 读类 --
    async def health(self) -> dict[str, object]:
        self._record("health")
        if self.health_error is not None:
            raise self.health_error
        return dict(self.health_result)

    async def where(self, *, conversation: str):
        self._record("where", conversation=conversation)
        return self._maybe_raise("where") or {
            "found": True, "conversation": conversation, "sessionId": "im-abc",
            "cwd": "C:/work", "source": "mapping",
        }

    async def workspaces(self, *, limit: int = 50):
        self._record("workspaces", limit=limit)
        return self._maybe_raise("workspaces") or {"items": [], "count": 0, "returned": 0}

    async def rebind(self, *, conversation: str, workspace_id: str):
        self._record("rebind", conversation=conversation, workspace_id=workspace_id)
        return self._maybe_raise("rebind") or {"ok": True, "sessionId": "im-new"}

    async def fork(self, *, conversation: str, at_seq: int | None = None):
        self._record("fork", conversation=conversation, at_seq=at_seq)
        return self._maybe_raise("fork") or {
            "ok": True, "sessionId": "im-child", "inheritedEventCount": 3,
        }

    async def adopt(self, *, conversation: str, session_id: str, workspace_id: str = ""):
        self._record("adopt", conversation=conversation, session_id=session_id,
                     workspace_id=workspace_id)
        return self._maybe_raise("adopt") or {"ok": True, "adopted": True}

    async def send_message(
        self, *, conversation: str, text: str, message_id: str,
        idempotency_key: str, sender: dict | None = None,
    ):
        self._record("send_message", conversation=conversation, text=text,
                     message_id=message_id, idempotency_key=idempotency_key, sender=sender)
        return self._maybe_raise("send_message") or {"ok": True, "duplicate": False}

    def connection_signal(self, conversation: str) -> asyncio.Event:
        self._record("connection_signal", conversation=conversation)
        return self.signal

    def last_event_id(self, conversation: str):
        self._record("last_event_id", conversation=conversation)
        return None

    async def events(self, *, conversation: str, last_event_id: int | None = None):
        # 关键：这里才 set 连接信号——与真实传输「SSE 握手完成才算连上」同口径。
        self._record("events", conversation=conversation, last_event_id=last_event_id)
        self.events_started += 1
        self.signal.set()
        for frame in self.frames:
            yield frame
        # 帧吐完就结束：pump 退出，队列里剩下的帧由 _consume_turn 继续消费。

    async def send_approval(self, *, conversation: str, call_id: str, outcome: str, code: str):
        self._record("send_approval", conversation=conversation, call_id=call_id,
                     outcome=outcome, code=code)
        return self._maybe_raise("send_approval") or {"ok": True}

    async def send_answer(self, *, conversation: str, call_id: str, answers: list):
        self._record("send_answer", conversation=conversation, call_id=call_id, answers=answers)
        return self._maybe_raise("send_answer") or {"ok": True}

    async def proactive(self, *, since: int = 0):
        self.proactive_calls.append(int(since))
        self._record("proactive", since=since)
        return {"ok": True, "cursor": self.proactive_cursor, "items": list(self.proactive_items)}

    async def aclose(self) -> None:
        self.closed = True


# ──────────────────────────────────────────────────────────────────────
# 3. 假事件
# ──────────────────────────────────────────────────────────────────────
class Result:
    """``event.plain_result()`` / ``image_result()`` 的替身。"""

    def __init__(self, kind: str, payload: str) -> None:
        self.kind = kind
        self.payload = payload

    def __repr__(self) -> str:  # pragma: no cover - 仅调试用
        return f"Result({self.kind}, {self.payload!r})"


class Sender:
    def __init__(self, user_id: str = "", nickname: str = "") -> None:
        self.user_id = user_id
        self.nickname = nickname


class MessageObj:
    def __init__(self, message_id: str = "m-1", sender: Sender | None = None, group_id: str = "") -> None:
        self.message_id = message_id
        self.sender = sender or Sender()
        self.group_id = group_id


class FakeEvent:
    """够用的 ``AstrMessageEvent`` 替身。

    只实现生产代码真的会碰的那几个成员；**故意不实现**其它属性，
    这样一旦生产代码开始依赖新 API，测试就会以 AttributeError 出声，
    而不是悄悄给出一个假值。
    """

    def __init__(
        self,
        message_str: str = "dsh 你好",
        umo: str = UMO,
        *,
        private: bool = False,
        group_id: str = "",
        user_id: str = "10001",
        nickname: str = "测试用户",
        message_id: str = "m-1",
    ) -> None:
        self.message_str = message_str
        self.unified_msg_origin = umo
        self.message_obj = MessageObj(
            message_id=message_id,
            sender=Sender(user_id=user_id, nickname=nickname),
            group_id=group_id,
        )
        self.private = private
        self.group_id = group_id
        #: ``event.send()`` 发出去的（流式分片、审批提示……）
        self.sent: list[Result] = []
        #: 调用方 ``yield`` 出去的（最终结果）
        self.yielded: list[Result] = []
        self.call_llm: bool | None = None
        self.stopped = False

    def plain_result(self, text: str) -> Result:
        return Result("text", text)

    def image_result(self, url: str) -> Result:
        return Result("image", url)

    async def send(self, result: Result) -> None:
        self.sent.append(result)

    def should_call_llm(self, value: bool) -> None:
        self.call_llm = value

    def stop_event(self) -> None:
        self.stopped = True

    def is_private_chat(self) -> bool:
        return self.private

    def get_group_id(self) -> str:
        return self.group_id

    # -- 便捷断言 --
    @property
    def sent_text(self) -> list[str]:
        return [r.payload for r in self.sent if r.kind == "text"]

    @property
    def yielded_text(self) -> list[str]:
        return [r.payload for r in self.yielded if r.kind == "text"]

    @property
    def all_text(self) -> list[str]:
        return self.sent_text + self.yielded_text


def schema_defaults() -> dict[str, object]:
    """从 ``_conf_schema.json`` 读**真实默认值**。

    刻意不在这里手抄一份默认值：手抄的那份一定会和 schema 漂移，
    而漂移的表现是「测试里 agent 模式的提示词是空的、生产里不空」这种
    只在测试里存在的假象（第一版就是这么写错的）。
    """
    import json

    raw = (PLUGIN_DIR / "_conf_schema.json").read_text(encoding="utf-8")
    spec = json.loads(raw)
    return {
        key: value.get("default")
        for key, value in spec.items()
        if isinstance(value, dict) and "default" in value
    }


#: 测试专用覆盖：只为「断言更好写」，不为复刻生产默认值。
_TEST_OVERRIDES: dict[str, object] = {
    "enable": True,
    "chunk_size": 0,        # 0 = 不切分，断言才能比整条文本
    "throttle_ms": 0,       # 关掉节流，流式分片立即出
    "trigger_prefix": "dsh ",
    "heartbeat_notify": "fixed",
    "heartbeat_notify_min_gap_ms": 0,
}


def make_main(**overrides):
    """造一个 ``Main``，并塞进假 transport。返回 ``(main, context, transport)``。"""
    config: dict[str, object] = schema_defaults()
    config.update(_TEST_OVERRIDES)
    config.update(overrides)
    context = ContextStub()
    instance = plugin_main.Main(context, config)
    transport = FakeTransport()
    instance._transport = transport
    return instance, context, transport


# ──────────────────────────────────────────────────────────────────────
# 4. 极简测试框架（两个测试文件共用，输出格式一致）
# ──────────────────────────────────────────────────────────────────────
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


def section(title: str) -> None:
    print(f"\n{title}")


def summary() -> None:
    print(f"\n通过 {_passed} 项，失败 {len(_failed)} 项")
    if _failed:
        print(f"失败项：{'、'.join(_failed)}")
        sys.exit(1)


def drain(agen) -> list:
    """把一个异步生成器跑到完，返回它 ``yield`` 出来的结果。"""
    async def run() -> list:
        out = []
        async for item in agen:
            out.append(item)
        return out

    return asyncio.run(run())


def drive(main_obj, event: FakeEvent, message: str | None = None) -> FakeEvent:
    """走**完整入口** ``on_bridge_message``（与真实框架同一条路径），返回事件本身。

    刻意从被装饰的入口进，而不是直接调 ``_handle_xxx``：指令分发本身
    （前缀匹配、白名单、takeover 标记）就是要测的东西之一。
    """
    if message is not None:
        event.message_str = message
    event.yielded = drain(main_obj.on_bridge_message(event))
    return event


__all__ = [
    "LOGGER", "PLUGIN_DIR", "ROOT", "UMO", "UMO_PRIVATE",
    "ContextStub", "FakeEvent", "FakeTransport", "Result",
    "drain", "drive", "hb", "make_main", "plugin_main", "re", "section", "summary", "test",
]
