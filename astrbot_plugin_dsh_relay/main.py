"""AstrDsh Relay（星驿）· AstrBot 侧 IM ↔ DSH 网桥。

实现状态（P1/P2/P4 均已落地，P4 含 card 模式）：
  * ``BridgeTransport``：``/health``（版本协商）、``/where``、``/workspaces``
    （列出桥接端工作区）、``/session/rebind``（把对话改指到指定工作区）、
    ``/message``（幂等 + 重试 + 同会话串行）、``/events``（aiohttp 手读 SSE，
    Last-Event-ID 续传，heartbeat/gap 处理）、``/approval`` 全部实现。
  * ``Main``：先连 SSE 再投递的闭环、``code → callId`` 反查、
    ``text/delta`` 节流回帖、审批事件转达、主动推送 ``push_to_session``。
  * ``chunk_size`` 的语义化切分已落地（段落 / 代码围栏感知，见 ``_split_for_im``）。
  * ``health_interval_ms`` 周期健康检查已落地（0=关，仅启动时探测）；连续失败
    会把桥接标记为「未就绪」，用户侧直接看到原因而不是干等超时。
  * ``reply_render_mode="card"`` 已落地：复用 AstrBot 自带
    ``Star.text_to_image`` 出图（沿用当前 t2i 模板与端点），
    **渲染失败或超时即整条降级纯文本**并告警 —— t2i 是外部服务，
    不能让回帖整条丢失。

契约真相来源：``docs/BRIDGE-CONTRACT.md``
设计依据：      ``docs/DESIGN.md`` §3
API 证据：      ``docs/astrbot-side-capabilities.md``

────────────────────────────────────────────────────────────────────────
已核实、且**写错就会静默失败**的四条约束（不要"顺手改优雅"）：

1. ``filter`` 必须从 ``astrbot.api.event`` 导入，避免与内置 ``filter`` 冲突。
2. ``event.should_call_llm(True)`` —— 传 ``True`` 才是**禁止**默认 LLM
   （判定是 ``not event.call_llm``，参数语义与直觉相反）。**每一条接管分支都要调**：
   ``help`` / ``where`` / ``workspaces`` / ``rebind`` / ``approve|reject``
   也不例外 —— handler 结束后
   ``star_request`` 会 ``clear_result()``，只 ``stop_event()`` 仍会被默认 LLM 接手。
3. ``event.stop_event()`` 必须在 ``yield`` **之后**。先 stop 再 yield 会让
   ``RespondStage`` 不执行，**消息发不出去**。
4. 中间分片用 ``await event.send(...)``（绕过 ResultDecorateStage，避免被自动包成
   合并转发或转图），**最后一片**用 ``yield event.plain_result(...)`` 走正常结果链路。
   走 yield 时纯文本超过 ``forward_threshold``（本机 = 1500）会被包装成 Node。

已独立取证的 API 名（不再是推断）：
   ``event.is_private_chat()`` 确实存在（``_is_private_chat()`` 仍是薄封装，
   因为它顺带兜住判定抛异常的情形）；
   ``MessageChain`` 来自 ``astrbot.api.event``，``Plain`` 来自
   ``astrbot.api.message_components``，``astrbot.api`` 下**没有** ``message`` 属性；
   ``Context.send_message(session, chain) -> bool``，字符串会经
   ``MessageSesion.from_str`` 解析，非法即抛 ``ValueError``。
────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import random
import ssl
import time
import uuid
from typing import Any, AsyncIterator

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star

try:  # 包内导入（正常安装路径）
    from . import allowlist
    from . import contract
    from . import location_text
except ImportError:  # 直接以模块方式加载时的兜底，与同路线既有插件一致
    import allowlist  # type: ignore[no-redef]
    import contract  # type: ignore[no-redef]
    import location_text  # type: ignore[no-redef]


# ──────────────────────────────────────────────────────────────────────
# 传输层
# ──────────────────────────────────────────────────────────────────────

#: SSE 的 socket 读超时（秒）。服务端 heartbeatMs 默认 15000，
#: 留三倍余量：能穿透代理的空闲超时，又能在链路真死时把连接判掉。
_SSE_SOCK_READ_SECONDS = 45.0

#: SSE 重连退避（秒）：从 1 起指数增长并加抖动，上限 30（契约 §6.2 末条）。
#: SSE 重连**不算失败**，所以它不复用 /message 的重试次数。
_SSE_BACKOFF_BASE = 1.0
_SSE_BACKOFF_MAX = 30.0

#: 「先连 SSE」时额外给的握手宽限（秒）。
_CONNECT_GRACE_SECONDS = 5.0


class BridgeError(Exception):
    """桥接调用失败。

    ``retryable`` 是**传输层给出的重试建议**，调用方不必自己解析状态码：
    契约 §6.2 规定可重试的是连接错误、超时、502/503/504、429，不可重试的是
    400/401/403/404/409。唯一例外是 ``429 queue_full``：它虽在 §6.2 的
    可重试列表里，但 §6.3 说它是**背压**信号（带 ``retry-after``），
    盲目重试只会把队列踩得更满，所以本端把它标成不可重试、直接把「排队中」
    回给用户（见 ``send_message`` 与 ``Main._delivery_failure_text``）。
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = contract.ERROR_INTERNAL,
        status: int | None = None,
        retryable: bool = False,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.retryable = retryable
        self.details = details

    def __str__(self) -> str:
        head = str(self.args[0]) if self.args else "桥接调用失败"
        return f"{head}（{self.code}）" if self.code else head


def _prefixed_failure(prefix: str, message: Any) -> str:
    """给失败消息套前缀，但**不重复**。

    桥接端对同一次失败也会自己加前缀（``lib/index.js`` 的 ``改指失败：…``），
    无脑 ``f"{prefix}：{message}"`` 会拼出「改指失败：改指失败：…」，看起来
    像同一次失败发生了两遍。

    ``message`` 末尾由 ``BridgeError.__str__`` 补的错误码保持不动：那是用户
    唯一能拿来报给我们定位的线索。
    """
    text = str(message or "").strip() or "未知错误"
    head = f"{prefix}："
    return text if text.startswith(head) else f"{head}{text}"


def _looks_like_session_id(value: str) -> bool:
    """粗判一个 id 是不是**会话** id（DSH 侧建出来的都带 ``im-``/``session-`` 前缀）。

    只用来决定 404 时提示语指向哪一半命令：``rebind`` 收工作区、``adopt`` 收会话。
    两张纸长得几乎一样，敲错门却只换来一句「没有这个工作区」，用户会对着
    workspaces 清单发呆——判错最多让提示换一句，不参与任何写入决策。
    """
    head = (value or "").strip().lower()
    return head.startswith("im-") or head.startswith("session-")


class BridgeTransport:
    """HTTP + SSE 传输层。契约 §3。

    实现要点：

    * 网络库用 ``aiohttp``；**禁止 requests**（AstrBot 硬规范）。
    * ``/message`` 重试必须复用**同一个** ``Idempotency-Key``；换 key 重试等于
      多发一条消息，是 bug。契约 §6.2。幂等键由调用方生成一次后传进来，
      传输层**绝不**自己生成。
    * 建立顺序固定为：**先连 SSE，再 POST /message**。``text/delta`` 是 DSH 侧的
      瞬时事件，没有订阅者时永久丢失，反过来会丢开头几个 token。契约 §4.1。
      为此提供 ``connection_signal()``：生成器要等到第一次 ``__anext__`` 才握手，
      直接 await 它就等于在等第一帧（可能是 15 秒后的 heartbeat）。
    * SSE 禁止使用浏览器原生 EventSource（设不了 Authorization 头）；
      断线重连必须带 ``Last-Event-ID``。
    * 收到 ``429 queue_full`` 时**不重试**，直接把「排队中」回给用户。
    """

    def __init__(self, config: dict[str, Any]) -> None:
        self._config = config
        self._closed = False
        self._session: aiohttp.ClientSession | None = None
        self._connector: aiohttp.TCPConnector | None = None
        self._locks: dict[str, asyncio.Lock] = {}
        #: 周期健康检查的后台任务；``terminate`` 必须 cancel 掉它，
        #: 否则就是本插件唯一一处「游离任务」。
        self._health_task: asyncio.Task[None] | None = None
        self._signals: dict[str, asyncio.Event] = {}
        self._last_seq: dict[str, int] = {}

    # ---- 内部：配置与连接 --------------------------------------------

    @property
    def _base_url(self) -> str:
        return str(self._config.get("bridge_url") or "").rstrip("/")

    def _int(self, key: str, default: int) -> int:
        try:
            raw = self._config.get(key, default)
            return default if raw is None else int(raw)
        except (TypeError, ValueError):
            return default

    def _check_scheme(self) -> None:
        """地址合法性 + 明文 HTTP 的边界。循环回环地址视为受信，无需开关。"""
        url = self._base_url
        if not url:
            raise BridgeError("未配置 bridge_url", code=contract.ERROR_UNSUPPORTED)
        if url.startswith("https://"):
            return
        if not url.startswith("http://"):
            raise BridgeError(
                f"bridge_url 必须以 http(s):// 开头：{url}",
                code=contract.ERROR_UNSUPPORTED,
            )
        # 去掉 userinfo 与端口，再判断是否回环
        authority = url.split("://", 1)[1].split("/", 1)[0].rsplit("@", 1)[-1]
        host = authority.split(":", 1)[0].strip("[]").lower()
        if host in {"127.0.0.1", "localhost", "::1"}:
            return
        if not self._config.get("allow_insecure_http", False):
            raise BridgeError(
                f"bridge_url 指向非本机地址却使用明文 HTTP：{url}；"
                "确为受信内网时请打开 allow_insecure_http",
                code=contract.ERROR_UNSUPPORTED,
            )

    def _ssl_context(self) -> ssl.SSLContext | None:
        """自签证书走 ca_bundle_path；留空即系统信任库。

        **禁止**用 ``verify_ssl=False`` 全局关校验：那等于把 §5.3 的传输机密性
        整条抹掉。
        """
        path = str(self._config.get("ca_bundle_path") or "").strip()
        if path:
            return ssl.create_default_context(cafile=path)
        return None

    def _headers(
        self, *, json_body: bool = False, body_bytes: bytes | None = None
    ) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        token = str(self._config.get("bridge_token") or "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        if json_body:
            headers["Content-Type"] = "application/json"
        if body_bytes is not None:
            headers.update(self._signature_headers(token, body_bytes))
        return headers

    def _signature_headers(self, token: str, body_bytes: bytes) -> dict[str, str]:
        """契约 §5.2 的可选强化：对**实际发送的原始字节**做 HMAC-SHA256。

        签名对象是 ``ts + "." + rawBody``（UTF-8），``ts`` 为毫秒时间戳字符串，
        与 DSH 侧 ``verifySignature`` 逐字节一致。所以这里收的是已经编码好的
        ``body_bytes``，不是 dict——重新序列化一次就会因键序/空白而对不上。
        """
        if not self._config.get("hmac_mode", False):
            return {}
        if not token:
            raise BridgeError(
                "hmac_mode 已开启但未配置 bridge_token",
                code=contract.ERROR_UNSUPPORTED,
            )
        ts = str(int(time.time() * 1000))
        digest = hmac.new(
            token.encode("utf-8"), f"{ts}.".encode("utf-8") + body_bytes, hashlib.sha256
        ).hexdigest()
        return {
            "X-Bridge-Timestamp": ts,
            "X-Bridge-Signature": f"sha256={digest}",
        }

    def _timeout(
        self, *, total: float | None = None, sock_read: float | None = None
    ) -> aiohttp.ClientTimeout:
        return aiohttp.ClientTimeout(
            total=total,
            sock_connect=float(self._int("connect_timeout", 10)),
            sock_read=sock_read,
        )

    async def _ensure_session(self) -> aiohttp.ClientSession:
        if self._closed:
            raise BridgeError("传输层已关闭", code=contract.ERROR_INTERNAL)
        if self._session is None or self._session.closed:
            self._connector = aiohttp.TCPConnector(ssl=self._ssl_context())
            self._session = aiohttp.ClientSession(connector=self._connector)
        return self._session

    @staticmethod
    def _unpack(status: int, text: str) -> Any:
        """把响应拆成「成功体」或 ``BridgeError``。错误体形状见契约 §8。"""
        payload: Any = None
        if text:
            with contextlib.suppress(ValueError):
                payload = json.loads(text)
        if 200 <= status < 300:
            return payload if payload is not None else {}
        err = payload.get("error") if isinstance(payload, dict) else None
        err = err if isinstance(err, dict) else {}
        code = str(err.get("code") or f"http_{status}")
        message = str(err.get("message") or (text or "")[:200] or f"HTTP {status}")
        retryable = status in (429, 502, 503, 504) and code != contract.ERROR_QUEUE_FULL
        raise BridgeError(
            message,
            code=code,
            status=status,
            retryable=retryable,
            details=err.get("details"),
        )

    @staticmethod
    def _ensure_ok(info: Any, what: str) -> dict[str, Any]:
        """校验 200 响应体里的 ``ok``（契约 §11.1）。

        契约允许**成功状态码 + ``{ok: false, error}``** 这种表达法：只看状态码会把
        一次失败当成成功，然后拿着空的 ``sessionId`` 去拼给用户看。两种形状都要认，
        所以每个读响应体的方法都过这里。
        """
        if not isinstance(info, dict):
            raise BridgeError(f"{what}返回了意外结果")
        if info.get("ok") is False:
            err = info.get("error") if isinstance(info.get("error"), dict) else {}
            raise BridgeError(
                str(err.get("message") or f"{what}失败"),
                code=str(err.get("code") or contract.ERROR_INTERNAL),
                details=err.get("details"),
            )
        return info

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: Any = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        self._check_scheme()
        session = await self._ensure_session()
        # 手工编码成 bytes：契约 §5.2 的签名对象是**实际发出的原文**，而 aiohttp 的
        # ``json=`` 会自己再序列化一次，键序与分隔符都可能变，签名必然对不上。
        # 这里一次编码、签名和发送共用同一份字节。
        raw: bytes | None = None
        if body is not None:
            raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode(
                "utf-8"
            )
        merged = self._headers(json_body=body is not None, body_bytes=raw)
        if headers:
            merged.update(headers)
        url = self._base_url + path
        timeout = self._timeout(total=float(self._int("request_timeout", 600)))
        try:
            async with session.request(
                method, url, params=params, data=raw, headers=merged, timeout=timeout
            ) as resp:
                text = await resp.text()
            return self._unpack(resp.status, text)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise BridgeError(f"连接失败：{exc}", retryable=True) from exc

    # ---- §3.4 /health ------------------------------------------------

    async def health(self) -> dict[str, Any]:
        """``GET /health``；启动时校验 ``bridgeVersion``，不匹配则拒绝启用。"""
        info = self._ensure_ok(
            await self._request("GET", contract.ROUTE_HEALTH), "健康检查"
        )
        version = str(info.get("bridgeVersion") or "")
        if version != contract.BRIDGE_VERSION:
            raise BridgeError(
                f"契约版本不匹配：本端 {contract.BRIDGE_VERSION}，"
                f"桥接端 {version or '（缺失）'}；拒绝启用，不做猜测性降级",
                code="version_mismatch",
            )
        return info

    # ---- §12.1 /where ------------------------------------------------

    async def where(self, *, conversation: str) -> dict[str, Any]:
        """``GET /where``：定位该对话的工作区与 DSH 会话（契约 §12）。

        返回结构见契约 §12.1；排版已由 ``location_text.format_location`` 完成
        并有单测覆盖。
        """
        info = await self._request(
            "GET", contract.ROUTE_WHERE, params={"conversation": conversation}
        )
        return self._ensure_ok(info, "定位查询")

    # ---- §13.1 /workspaces -------------------------------------------

    async def workspaces(self, *, limit: int = 50) -> dict[str, Any]:
        """``GET /workspaces``：列出桥接端可见的工作区（契约 §13.1）。

        返回 ``{count, returned, limit, items}``；``items`` 每项是
        ``{id, path, title, sessionIds}``。这是**只读**调用，不改任何会话。
        """
        info = await self._request(
            "GET", contract.ROUTE_WORKSPACES, params={"limit": int(limit)}
        )
        return self._ensure_ok(info, "工作区列表")

    # ---- §13.2 /session/rebind ---------------------------------------

    async def rebind(self, *, conversation: str, workspace_id: str) -> dict[str, Any]:
        """``POST /session/rebind``：把该对话改指到指定工作区（契约 §13.2）。

        语义是**新开一个会话**并把它挂到目标工作区，旧会话不删不摘——
        它的 cwd 仍旧是原目录，假装它消失了才是说谎。
        """
        if not conversation or not workspace_id:
            raise BridgeError(
                "conversation 与 workspaceId 都必须是非空字符串",
                code=contract.ERROR_UNSUPPORTED,
            )
        info = await self._request(
            "POST",
            contract.ROUTE_REBIND,
            body={"conversation": conversation, "workspaceId": workspace_id},
        )
        return self._ensure_ok(info, "改指")

    # ---- §14 /session/fork -------------------------------------------

    async def fork(
        self, *, conversation: str, at_seq: int | None = None
    ) -> dict[str, Any]:
        """``POST /session/fork``：把本对话已完成的某一轮之前缀复制成新会话（契约 §14）。

        语义是**复制**，不是"切走"：源会话一条事件都不动，新会话只是「已建好并落
        了档」，要认领它得另发 ``/message``（或另做一次改指）。

        IM 侧手里只有会话键（UMO），而 §14.1 要的是 DSH 会话 id，所以先走一次
        ``/where`` 取 ``sessionId``：**不新开路由**，也不在 IM 侧拼会话 id。
        """
        if not conversation:
            raise BridgeError(
                "conversation 必须是非空字符串", code=contract.ERROR_UNSUPPORTED
            )
        if at_seq is not None and (
            isinstance(at_seq, bool) or not isinstance(at_seq, int) or at_seq < 0
        ):
            raise BridgeError("atSeq 必须是非负整数", code=contract.ERROR_UNSUPPORTED)

        location = await self.where(conversation=conversation)
        session_id = location.get("sessionId")
        if not isinstance(session_id, str) or not session_id.strip():
            # 「本对话还没和 DSH 会话建立映射」不是桥接端出错：没有会话，
            # 就没有可供复制的轮次前缀。契约 §12.1 允许 ``sessionId`` 为 null。
            raise BridgeError(
                "本对话还没有 DSH 会话，先发一条消息建立起映射再分支",
                code=contract.ERROR_NOT_FOUND,
            )

        body: dict[str, Any] = {"sessionId": session_id.strip()}
        if at_seq is not None:
            body["atSeq"] = at_seq
        info = await self._request("POST", contract.ROUTE_FORK, body=body)
        return self._ensure_ok(info, "分支")

    # ---- §15 /session/adopt ------------------------------------------

    async def adopt(
        self, *, conversation: str, session_id: str, workspace_id: str = ""
    ) -> dict[str, Any]:
        """``POST /session/adopt``：把本对话改指到一个**已存在**的会话（契约 §15）。

        与 ``rebind`` 的区别是骨头里的：rebind 收工作区、语义是**新建**一个会话；
        本方法收会话 id、语义是**换映射**，目标会话本体一个字节都不动。

        ``workspace_id`` 是可选的加签：给了就必须真包含该会话，否则桥接端回 409
        ——宁可当场报错，也不写出一条「看起来挂上了、其实没挂」的假账。
        """
        if not conversation or not session_id:
            raise BridgeError(
                "conversation 与 sessionId 都必须是非空字符串",
                code=contract.ERROR_UNSUPPORTED,
            )
        body: dict[str, Any] = {
            "conversation": conversation,
            "sessionId": session_id,
        }
        if workspace_id:
            body["workspaceId"] = workspace_id
        info = await self._request("POST", contract.ROUTE_ADOPT, body=body)
        return self._ensure_ok(info, "认领")

    # ---- §3.1 /message ----------------------------------------------

    @staticmethod
    def _split_conversation(conversation: str) -> tuple[str, str, str]:
        """会话键 ``{platform}:{messageType}:{session_id}`` → 三元组。"""
        parts = conversation.split(":")
        platform = parts[0] if parts else ""
        message_type = parts[1] if len(parts) > 1 else ""
        session_id = parts[2] if len(parts) > 2 else conversation
        return platform, message_type, session_id

    def _meta_of(self, conversation: str) -> dict[str, str]:
        platform, message_type, _ = self._split_conversation(conversation)
        return {"platform": platform, "messageType": message_type}

    def _lock(self, conversation: str) -> asyncio.Lock:
        lock = self._locks.get(conversation)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[conversation] = lock
        return lock

    async def send_message(
        self,
        *,
        conversation: str,
        text: str,
        message_id: str,
        idempotency_key: str,
        sender: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """``POST /message``。返回 ``{"accepted": bool, "duplicate": bool, ...}``。

        ``Idempotency-Key`` 由调用方生成一次并在重试间复用；传空即拒发——
        「每次重试新建一个键」正是契约 §6.2 点名的那类 bug，与其静默发出两条
        消息，不如在这里拦住。
        """
        if not idempotency_key:
            raise BridgeError(
                "缺少幂等键：Idempotency-Key 必须由调用方一次性生成并跨重试复用",
                code=contract.ERROR_UNSUPPORTED,
            )
        body = {
            "conversation": conversation,
            "text": text,
            "messageId": message_id,
            "sender": sender or {"id": "", "name": ""},
            "meta": self._meta_of(conversation),
        }
        attempts = max(1, self._int("retry_max_attempts", 5))
        max_delay = max(0.0, self._int("retry_max_delay_ms", 30000) / 1000.0)
        delay = 1.0
        # 同 conversation 串行投递：SSE 帧里没有消息 id，两路并发会互相串味。
        async with self._lock(conversation):
            for attempt in range(1, attempts + 1):
                try:
                    return await self._request(
                        "POST",
                        contract.ROUTE_MESSAGE,
                        body=body,
                        headers={"Idempotency-Key": idempotency_key},
                    )
                except BridgeError as exc:
                    if not exc.retryable or attempt >= attempts:
                        raise
                    sleep_for = min(delay, max_delay) * (0.5 + random.random())
                    logger.warning(
                        f"[dsh_relay] 投递失败（第 {attempt}/{attempts} 次）：{exc}；"
                        f"{sleep_for:.1f}s 后重试（复用同一幂等键）"
                    )
                    await asyncio.sleep(sleep_for)
                    delay = min(delay * 2.0, max_delay or delay * 2.0)
        raise BridgeError("投递失败：重试次数已用尽")

    # ---- §3.2 /events (SSE) ------------------------------------------

    def connection_signal(self, conversation: str) -> asyncio.Event:
        """该对话 SSE 的连接信号：握手成功置位，连接结束复位。

        「先连后投」需要一个**可等待的握手完成信号**——``events()`` 是生成器，
        它要等到第一次 ``__anext__`` 才会去建立连接，直接 await 它等于在等
        第一帧（可能长达 15 秒的 heartbeat）。调用方先拿到 Event，再起消费任务，
        然后等 Event，才是真正的「先连」。
        """
        signal = self._signals.get(conversation)
        if signal is None:
            signal = asyncio.Event()
            self._signals[conversation] = signal
        return signal

    def last_event_id(self, conversation: str) -> int | None:
        return self._last_seq.get(conversation)

    async def events(
        self, *, conversation: str, last_event_id: int | None = None
    ) -> AsyncIterator[dict[str, Any]]:
        """``GET /events``：SSE 下行通道，逐帧产出已解析的事件字典。

        断线自动重连并带 ``Last-Event-ID``（取最后一帧的 ``seq``），退避从 1s
        起指数增长加抖动、上限 30s。服务端环形缓冲重放 ``> seq`` 的帧，溢出时
        发 ``gap{fromSeq}`` —— 那一帧会照常产出，由 ``Main`` 告诉用户「有内容丢了」。
        """
        backoff = _SSE_BACKOFF_BASE
        while not self._closed:
            signal = self.connection_signal(conversation)
            received = False
            try:
                async for frame in self._stream_once(conversation, last_event_id):
                    received = True
                    seq = frame.get("seq")
                    if isinstance(seq, int):
                        last_event_id = seq
                        self._last_seq[conversation] = seq
                    yield frame
            except asyncio.CancelledError:
                raise
            except BridgeError as exc:
                # 鉴权/参数类错误重连一万次也不会变好：明确放弃，别再刷日志。
                if exc.status in (400, 401, 403, 404):
                    logger.warning(f"[dsh_relay] SSE 放弃重连：{exc}")
                    return
                logger.warning(f"[dsh_relay] SSE 断开：{exc}；{backoff:.1f}s 后重连")
            except Exception as exc:  # noqa: BLE001 - 单条流异常不得拖垮插件
                logger.warning(f"[dsh_relay] SSE 异常：{exc}；{backoff:.1f}s 后重连")
            finally:
                signal.clear()

            if self._closed:
                return
            if received:
                backoff = _SSE_BACKOFF_BASE  # 连上过就不算连续的失败
            if last_event_id is None:
                last_event_id = self._last_seq.get(conversation)
            await asyncio.sleep(backoff * (0.5 + random.random()))
            backoff = min(backoff * 2.0, _SSE_BACKOFF_MAX)

    async def _stream_once(
        self, conversation: str, last_event_id: int | None
    ) -> AsyncIterator[dict[str, Any]]:
        """一次 SSE 连接的完整读取。返回即代表这条连接结束了。"""
        self._check_scheme()
        session = await self._ensure_session()
        headers = self._headers()
        headers["Accept"] = "text/event-stream"
        if last_event_id is not None:
            headers["Last-Event-ID"] = str(last_event_id)
        timeout = self._timeout(total=None, sock_read=_SSE_SOCK_READ_SECONDS)
        data_lines: list[str] = []
        try:
            async with session.get(
                self._base_url + contract.ROUTE_EVENTS,
                params={"conversation": conversation},
                headers=headers,
                timeout=timeout,
                ssl=self._ssl_context(),
            ) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    self._unpack(resp.status, text)  # 必抛，除非 2xx
                    raise BridgeError(f"SSE 握手失败：HTTP {resp.status}")
                self.connection_signal(conversation).set()
                async for raw in resp.content:
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if not line:
                        frame = self._parse_sse(data_lines)
                        data_lines = []
                        if frame is not None:
                            yield frame
                        continue
                    if line.startswith(":"):
                        continue  # 注释帧（服务端连上先发 ": connected" 热身）
                    data_lines.append(line)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            raise BridgeError(f"SSE 连接中断：{exc}", retryable=True) from exc

    @staticmethod
    def _parse_sse(lines: list[str]) -> dict[str, Any] | None:
        """按 SSE 规范拼一个事件块。非 JSON 或空块一律忽略，不抛。"""
        if not lines:
            return None
        data: list[str] = []
        event_name = ""
        for line in lines:
            if line.startswith("data:"):
                data.append(line[5:].lstrip(" "))
            elif line.startswith("event:"):
                event_name = line[6:].strip()
            # ``id:`` / ``retry:`` 不解析：seq 字段已承担游标职责
        if not data:
            return None
        raw = "\n".join(data)
        try:
            frame = json.loads(raw)
        except ValueError:
            logger.warning(f"[dsh_relay] SSE 帧不是合法 JSON，已忽略：{raw[:120]}")
            return None
        if not isinstance(frame, dict):
            return None
        if event_name and not frame.get("type"):
            frame["type"] = event_name
        return frame

    # ---- §3.3 /approval ----------------------------------------------

    async def send_approval(
        self, *, conversation: str, call_id: str, outcome: str, code: str
    ) -> dict[str, Any]:
        """``POST /approval``。``outcome`` 必须在 contract.APPROVAL_OUTCOMES_ALLOWED 内。"""
        if outcome not in contract.APPROVAL_OUTCOMES_ALLOWED:
            raise BridgeError(
                f"不支持的审批结论：{outcome}", code=contract.ERROR_UNSUPPORTED
            )
        if not call_id:
            raise BridgeError(
                "缺少 callId：必须由本地 pending 表按 code 反查后再回执",
                code=contract.ERROR_UNSUPPORTED,
            )
        return await self._request(
            "POST",
            contract.ROUTE_APPROVAL,
            body={
                "conversation": conversation,
                "callId": call_id,
                "outcome": outcome,
                "code": code,
            },
        )

    async def aclose(self) -> None:
        """关闭连接池。由 ``Main.terminate`` 调用。"""
        self._closed = True
        session, self._session = self._session, None
        self._connector = None
        if session is not None and not session.closed:
            await session.close()


# ──────────────────────────────────────────────────────────────────────
# 插件主体
# ──────────────────────────────────────────────────────────────────────

class Main(Star):
    """IM → DSH 桥接插件。"""

    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)
        self.config = config
        self._transport: BridgeTransport | None = None
        self._bridge_ok: bool | None = None  # None=未探测
        self._bridge_error: str | None = None
        self._locks: dict[str, asyncio.Lock] = {}
        #: 待审批：``(会话键, code) -> {callId, outcome, deadline}``。
        #: 必须按 code 反查 callId —— IM 用户只能看到 code，看不到 callId。
        self._pending: dict[tuple[str, str], dict[str, Any]] = {}

    # ---- 生命周期 ----------------------------------------------------

    async def initialize(self) -> None:
        """启动探测：/health + 版本协商。不匹配就拒绝启用，不做猜测性降级。

        探测成功后再按 ``health_interval_ms`` 起周期复检（0 = 只做这一次）：
        桥接端重启、被防火墙掐断、版本被换掉，都不该等到用户发消息才发现。
        """
        if not self._cfg("enable", True):
            logger.info("[dsh_relay] 未启用（配置 enable=false）")
            return
        transport = self._transport_or_create()
        url = str(self._cfg("bridge_url", "") or "")
        if url.startswith("http://") and not self._cfg("allow_insecure_http", False):
            logger.warning(
                f"[dsh_relay] bridge_url 为明文 HTTP（{url}）；"
                "仅本机回环可直接使用，跨机请启用 HTTPS 或显式打开 allow_insecure_http"
            )
        # 复检任务先起：启动探测失败也得有人接管，否则「先开 AstrBot 后开 dsh」
        # 会把状态机变成单向熔断——桥接后来起来了，插件却永远停在未就绪。
        self._health_task = asyncio.create_task(
            self._health_loop(), name="dsh_relay.health"
        )
        try:
            info = await transport.health()
        except Exception as exc:  # noqa: BLE001 - 探测失败不得阻断插件加载
            self._bridge_ok = False
            self._bridge_error = str(exc)
            logger.warning(f"[dsh_relay] 启动探测失败：{exc}；已交由周期复检接管")
            return
        self._bridge_ok = True
        self._bridge_error = None
        logger.info(
            f"[dsh_relay] 桥接就绪：bridgeVersion={info.get('bridgeVersion')} "
            f"pathPrefix={info.get('pathPrefix')} conversations={info.get('conversations')}"
        )

    async def _health_loop(self) -> None:
        """按 ``health_interval_ms`` 周期调 ``/health``（内含版本协商）。

        与 ``_handle_task`` 同样的口径：失败不抛出、不重试，
        只把 ``_bridge_ok`` 置回 False 并把原因写进 ``_bridge_error``，
        让下一条用户消息「立刻带上原因」，而不是干等 request_timeout。
        恢复成功则自动回到就绪 —— 健康检查是状态机，不是单向熔断。
        """
        interval_ms = int(self._cfg("health_interval_ms", 30000) or 0)
        if interval_ms <= 0:
            logger.info("[dsh_relay] 周期健康检查已关闭（health_interval_ms<=0）")
            return
        interval = max(interval_ms, 1000) / 1000.0
        transport = self._transport_or_create()
        while True:
            try:
                info = await transport.health()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - 复检失败只影响就绪标记
                if self._bridge_ok is not False:
                    logger.warning(f"[dsh_relay] 健康复检失败：{exc}")
                self._bridge_ok = False
                self._bridge_error = str(exc)
            else:
                if self._bridge_ok is not True:
                    logger.info(
                        f"[dsh_relay] 桥接已恢复：bridgeVersion={info.get('bridgeVersion')}"
                    )
                self._bridge_ok = True
                self._bridge_error = None
            await asyncio.sleep(interval)

    # ---- 配置读取 ----------------------------------------------------

    def _cfg(self, key: str, default: Any = None) -> Any:
        """读配置。``AstrBotConfig`` 继承 dict，但缺失键与显式 None 都要回落默认值。"""
        if self.config is None:
            return default
        value = self.config.get(key) if hasattr(self.config, "get") else None
        return default if value is None else value

    def _transport_or_create(self) -> BridgeTransport:
        if self._transport is None:
            self._transport = BridgeTransport(dict(self.config or {}))
        return self._transport

    def _conversation_lock(self, umo: str) -> asyncio.Lock:
        lock = self._locks.get(umo)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[umo] = lock
        return lock

    # ---- 过滤器 ------------------------------------------------------

    # 用 event_message_type(ALL) 而非 command()：前者群聊无需 @ 即可收到消息
    # （过滤器通过就会 is_wake=True），后者强制要求 is_at_or_wake_command。
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_bridge_message(self, event: AstrMessageEvent):
        """前缀触发 + 审批命令的统一入口。"""
        if not self._cfg("enable", True):
            return

        # 匹配规则见 _match_prefix：这里踩过一次真 bug（配置里的尾空格让裸前缀落空）。
        raw = (event.message_str or "").strip()
        tail = _match_prefix(raw, str(self._cfg("trigger_prefix", "dsh ") or ""))
        if tail is None:
            return  # 不匹配：不设结果、不发消息，完全不干扰 AstrBot 默认逻辑

        if not self._session_allowed(event):
            return

        if self._cfg("reply_in_private_only", False) and not _is_private_chat(event):
            return

        prefix_base = str(self._cfg("trigger_prefix", "dsh ") or "").strip()
        command = tail.strip()
        # 裸前缀与 ``help`` 走同一份清单：少一个入口，就少一处会和实现漂移的文案。
        if not command or command.split(maxsplit=1)[0].lower() == contract.COMMAND_HELP:
            yield event.plain_result(_usage_text(prefix_base))
            # 三处「已接管」分支都必须显式禁止默认 LLM：handler 结束后
            # star_request 会 clear_result()，只剩 stop_event 的话
            # stage.py 的 `(get_result() and not is_stopped()) or not get_result()`
            # 仍成立 → 默认 LLM 会再答一遍。
            event.should_call_llm(True)
            event.stop_event()  # 必须在 yield 之后
            return

        head = command.split(maxsplit=1)[0].lower()

        # 定位：只读诊断，不投给 agent。
        if head == contract.COMMAND_WHERE:
            async for result in self._handle_where_command(event):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 工作区：只读清单，不投给 agent。
        if head == contract.COMMAND_WORKSPACES:
            async for result in self._handle_workspaces_command(event):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 改指工作区：改的是桥接端状态，正文不是对话内容，不能投给 agent。
        if head == contract.COMMAND_REBIND:
            async for result in self._handle_rebind_command(event, command):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 分支对话：改的是桥接端状态，正文不是对话内容，不能投给 agent。
        if head == contract.COMMAND_FORK:
            async for result in self._handle_fork_command(event, command):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 认领既有会话：同上，改的是桥接端状态，不投给 agent。
        if head == contract.COMMAND_ADOPT:
            async for result in self._handle_adopt_command(event, command):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 审批回执走独立分支：它不是对话内容，不能投给 agent。
        if head in (contract.APPROVAL_COMMAND_APPROVE, contract.APPROVAL_COMMAND_REJECT):
            async for result in self._handle_approval_command(event, command):
                yield result
            event.should_call_llm(True)
            event.stop_event()
            return

        # 命中后接管本事件：传 True 才是"禁止默认 LLM"
        event.should_call_llm(True)

        async for result in self._handle_task(event, command):
            yield result
        event.stop_event()

    # ---- 任务处理 ----------------------------------------------------

    async def _handle_task(self, event: AstrMessageEvent, prompt: str) -> AsyncIterator[Any]:
        """把一条 IM 消息投给 DSH 并把结果回帖。

        顺序是硬要求：**先连 SSE，再 POST /message**。``text/delta`` 是瞬时事件，
        没有订阅者时永久丢失，反着做会丢掉开头几个 token（契约 §4.1）。

        同 conversation 全程串行化：SSE 帧里没有消息 id，两路并发会把别人的
        token 混进这条回复里。
        """
        transport = self._transport_or_create()
        conversation = event.unified_msg_origin
        if self._bridge_ok is False and self._bridge_error:
            yield event.plain_result(f"桥接未就绪：{self._bridge_error}")
            return

        # ★ 幂等键只生成一次，重试复用它；换键重试等于又发一条消息（契约 §6.2）。
        idempotency_key = str(uuid.uuid4())

        async with self._conversation_lock(conversation):
            queue: asyncio.Queue = asyncio.Queue()
            signal = transport.connection_signal(conversation)

            async def pump() -> None:
                try:
                    async for frame in transport.events(conversation=conversation):
                        await queue.put(frame)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    await queue.put(exc)

            reader = asyncio.create_task(pump())
            try:
                deadline = float(self._cfg("connect_timeout", 10) or 10) + _CONNECT_GRACE_SECONDS
                try:
                    await asyncio.wait_for(signal.wait(), timeout=deadline)
                except asyncio.TimeoutError:
                    yield event.plain_result("桥接端事件流未在预期时间内建立，本次未投递。")
                    return

                try:
                    reply = await transport.send_message(
                        conversation=conversation,
                        text=prompt,
                        message_id=str(getattr(event.message_obj, "message_id", "") or ""),
                        idempotency_key=idempotency_key,
                        sender=self._sender_of(event),
                    )
                except BridgeError as exc:
                    logger.warning(f"[dsh_relay] 投递失败：{exc}")
                    yield event.plain_result(self._delivery_failure_text(exc))
                    return
                except Exception as exc:  # noqa: BLE001 - 单条消息失败不得影响插件
                    logger.warning(f"[dsh_relay] 投递失败：{exc}")
                    yield event.plain_result(_prefixed_failure("投递失败", exc))
                    return

                if reply.get("duplicate"):
                    logger.info("[dsh_relay] 命中幂等表：本次投递是重试的重放，未重复入队")

                async for result in self._consume_turn(event, queue):
                    yield result
            finally:
                reader.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await reader

    async def _consume_turn(
        self, event: AstrMessageEvent, queue: asyncio.Queue
    ) -> AsyncIterator[Any]:
        """消费 SSE 帧直到 ``turn/end``，并完成回帖。"""
        stream_ok = bool(self._cfg("stream_enabled", True))
        throttle = max(0.0, float(self._cfg("throttle_ms", 2500) or 0) / 1000.0)
        flush_chars = max(1, int(self._cfg("flush_chars", 200) or 1))
        # ``flush_hard_chars``：软阈值（flush_chars）之上找不到句子边界时，
        # 最多再容忍到这一长度才硬切。默认 3 倍软阈值、且不低于 600 字符。
        hard_chars = max(
            flush_chars,
            int(self._cfg("flush_hard_chars", 0) or 0) or max(flush_chars * 3, 600),
        )
        # 中间分片走 ``event.send``，不经过 AstrBot 自己的长度切分阶段，
        # 单条上限只能由这里自己守。硬切阈值向 ``chunk_size`` 收敛；
        # ``chunk_size=0`` 的语义是「不切分」，此时不设上限（也绝不缩成 1）。
        im_limit = int(self._cfg("chunk_size", 800) or 0)
        if im_limit > 0:
            hard_chars = min(hard_chars, im_limit)
        total = float(self._cfg("request_timeout", 600) or 600)
        deadline = time.monotonic() + max(30.0, total)

        final_text = ""
        emitted = ""
        pending = ""
        last_flush = time.monotonic()

        def due() -> bool:
            return bool(pending) and (
                len(pending) >= flush_chars
                or (throttle <= 0 or time.monotonic() - last_flush >= throttle)
            )

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                yield event.plain_result("等待桥接端回复超时。")
                return
            try:
                item = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                yield event.plain_result("等待桥接端回复超时。")
                return

            if isinstance(item, BaseException):
                logger.warning(f"[dsh_relay] 事件流中断：{item}")
                if not emitted and not final_text:
                    yield event.plain_result(f"事件流中断：{item}")
                    return
                break

            kind = str(item.get("type") or "")
            if kind not in contract.KNOWN_EVENT_TYPES:
                continue  # 未知类型必须忽略（前向兼容，契约 §4）

            if kind == contract.EVENT_HEARTBEAT:
                continue

            if kind == contract.EVENT_GAP:
                # 环形缓冲溢出：服务端只告诉我们从哪断的，丢的内容要不回来。
                await event.send(event.plain_result("（链路抖动，中间有内容丢失）"))
                continue

            if kind == contract.EVENT_TURN_START:
                continue

            if kind == contract.EVENT_TEXT_DELTA:
                pending += str(item.get("text") or "")
                if stream_ok and due():
                    cut = _pick_cut(pending, flush_chars, hard_chars)
                    if cut:
                        # 只发到句子边界，剩余部分留在 pending 里继续攒，
                        # 既不在句中断开，也不会破坏未闭合的代码围栏。
                        emitted += pending[:cut]
                        await event.send(event.plain_result(pending[:cut].rstrip("\n")))
                        pending = pending[cut:]
                        last_flush = time.monotonic()
                continue

            if kind == contract.EVENT_REASONING_DELTA:
                continue  # 思考过程不进 IM

            if kind == contract.EVENT_TOOL_CALL:
                name = str(item.get("name") or "?")
                await event.send(event.plain_result(f"· 调用工具 {name}"))
                continue

            if kind == contract.EVENT_APPROVAL_REQUIRED:
                async for result in self._on_approval_required(event, item):
                    yield result
                continue

            if kind == contract.EVENT_APPROVAL_RESOLVED:
                self._forget_call(str(item.get("callId") or ""))
                continue

            if kind == contract.EVENT_MESSAGE_FINAL:
                final_text = str(item.get("text") or "")
                continue

            if kind == contract.EVENT_TURN_END:
                reason = item.get("reason") or {}
                if str(reason.get("kind") or "") == "error":
                    err = reason.get("error") or {}
                    message = str(err.get("message") or err or "未知错误")
                    if not emitted and not final_text:
                        yield event.plain_result(f"DSH 报错：{message}")
                        return
                    logger.warning(f"[dsh_relay] turn 出错但已有输出：{message}")
                break

        # ---- 收敛回帖：最后一片走 yield，前面已由 event.send 发出 ----
        if final_text:
            tail = final_text[len(emitted):] if final_text.startswith(emitted) else final_text
        else:
            tail = pending
        if not tail:
            if emitted:
                return  # 流式已把内容全部发出，无需再补一条
            yield event.plain_result("（DSH 没有返回内容）")
            return
        async for result in self._reply(event, tail):
            yield result

    async def _on_approval_required(
        self, event: AstrMessageEvent, frame: dict[str, Any]
    ) -> AsyncIterator[Any]:
        """把审批请求转达给用户，并把 ``code → callId`` 记进本地表。"""
        if not self._cfg("approval_enabled", True):
            return
        code = str(frame.get("code") or "").strip()
        call_id = str(frame.get("callId") or "").strip()
        if not code or not call_id:
            logger.warning("[dsh_relay] 审批事件缺少 code/callId，已忽略")
            return

        timeout_ms = max(1000, int(self._cfg("approval_timeout_ms", 120000) or 120000))
        self._pending[(event.unified_msg_origin, code)] = {
            "callId": call_id,
            "deadline": time.monotonic() + timeout_ms / 1000.0,
        }

        prefix = str(self._cfg("trigger_prefix", "dsh ") or "").strip()
        lines = [
            "需要你确认一项操作：",
            f"· 工具：{frame.get('toolName') or '未知'}",
        ]
        reason = str(frame.get("reason") or "").strip()
        if reason:
            lines.append(f"· 原因：{reason}")
        expires_at = frame.get("expiresAt")
        if expires_at:
            lines.append(f"· 过期时间：{expires_at}")
        lines.append(f"· 验证码：{code}")
        lines.append(
            f"　允许一次：{prefix}{contract.APPROVAL_COMMAND_APPROVE} {code}　|　"
            f"拒绝：{prefix}{contract.APPROVAL_COMMAND_REJECT} {code}"
        )
        lines.append(f"（{timeout_ms // 1000} 秒内无回执则按拒绝处理）")
        await event.send(event.plain_result("\n".join(lines)))

    def _forget_call(self, call_id: str) -> None:
        if not call_id:
            return
        for key, record in list(self._pending.items()):
            if record.get("callId") == call_id:
                self._pending.pop(key, None)

    async def _handle_where_command(self, event: AstrMessageEvent) -> AsyncIterator[Any]:
        """``/dsh where`` —— 定位当前对话的工作区与 DSH 会话（契约 §12）。

        设计取舍：**本地那几行永远打印**。因为用户问「我在哪」时最需要的信息
        （会话键、桥接地址）本来就在本地，不该被一次网络往返的失败拖没——
        插件刚装、地址填错、桥接端没起，这些恰恰是最需要定位能力的时刻。
        """
        lines = location_text.format_where_header(
            event.unified_msg_origin,
            str(self._cfg("bridge_url", "") or ""),
        )
        try:
            info = await self._transport_or_create().where(
                conversation=event.unified_msg_origin
            )
        except Exception as exc:  # noqa: BLE001 - 定位失败不应影响插件
            logger.warning(f"[dsh_relay] 定位查询失败：{exc}")
            lines.append(f"· 桥接端查询失败：{exc}")
        else:
            lines.extend(location_text.format_location(info))

        yield event.plain_result("\n".join(lines))

    async def _handle_workspaces_command(
        self, event: AstrMessageEvent
    ) -> AsyncIterator[Any]:
        """``/dsh workspaces`` —— 列出桥接端登记的工作区（契约 §13.1）。

        与 ``where`` 同一取舍：**本地那行永远打印**。想换工作区时最需要的
        信息（当前会话键）本来就在本地，不该被一次网络往返的失败拖没。
        """
        lines = [
            f"会话键：{event.unified_msg_origin}",
            "星驿 · 桥接端工作区：",
        ]
        try:
            info = await self._transport_or_create().workspaces()
        except Exception as exc:  # noqa: BLE001 - 列表失败不应影响插件
            logger.warning(f"[dsh_relay] 工作区列表查询失败：{exc}")
            lines.append(f"· 查询失败：{exc}")
        else:
            items = info.get("items")
            if items is None:
                # 契约 §13.1 的成功体里一定有 items。缺了说明两侧版本对不上，
                # 这跟「登记了 0 个工作区」是两回事，不能用同一句提示糊过去。
                lines.append("· 桥接端没有给出工作区清单（两侧版本可能不一致）。")
            elif not isinstance(items, list):
                lines.append(f"· 工作区清单格式异常：{type(items).__name__}。")
            elif not items:
                lines.append("· 桥接端当前没有登记任何工作区。")
            else:
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    title = str(item.get("title") or "").strip() or "（无标题）"
                    path = str(item.get("path") or "").strip() or "（路径缺失）"
                    lines.append(f"· {title}")
                    lines.append(f"    id={item.get('id') or ''}　{path}")
                # count 是登记总数、returned 是本次给出的条数（桥接端默认截到 50）。
                # 只报 returned 会把「被截断」显示成「就这么多」，用户会以为
                # 目标工作区没登记，转头去查一个不存在的问题。
                shown = info.get("returned")
                shown = shown if isinstance(shown, int) else len(items)
                total = info.get("count")
                tail = (
                    f"共 {total} 个，这里列出 {shown} 个"
                    if isinstance(total, int) and total > shown
                    else f"共 {shown} 个"
                )
                lines.append(
                    f"　{tail}；"
                    f"用「{contract.COMMAND_REBIND} <id>」把本对话改指过去。"
                )

        yield event.plain_result("\n".join(lines))

    async def _handle_rebind_command(
        self, event: AstrMessageEvent, command: str
    ) -> AsyncIterator[Any]:
        """``/dsh rebind <workspaceId>`` —— 把本对话改指到指定工作区（契约 §13.2）。"""
        parts = command.split()
        if len(parts) < 2 or not parts[1].strip():
            yield event.plain_result(
                f"用法：{parts[0]} <工作区 id>（先用 "
                f"{contract.COMMAND_WORKSPACES} 查看可用 id）"
            )
            return
        workspace_id = parts[1].strip()

        try:
            info = await self._transport_or_create().rebind(
                conversation=event.unified_msg_origin,
                workspace_id=workspace_id,
            )
        except BridgeError as exc:
            if exc.status == 404:
                # 未知工作区：不是错误，是「你敲的 id 不在清单里」。
                # 但高频误用要当场点破：会话 id 与工作区 id 都是 UUID，肉眼
                # 分不出谁是谁，照着旧会话尾巴敲 rebind 是必然踩的坑。
                if _looks_like_session_id(workspace_id):
                    yield event.plain_result(
                        f"{workspace_id} 是会话 id，不是工作区 id。"
                        f"{contract.COMMAND_REBIND} 只收工作区、语义是新开一个会话；"
                        f"要切回这条既有会话请用："
                        f"{contract.COMMAND_ADOPT} {workspace_id}"
                    )
                else:
                    yield event.plain_result(
                        f"桥接端没有这个工作区：{workspace_id}。"
                        f"用 {contract.COMMAND_WORKSPACES} 看看有哪些。"
                    )
            elif exc.status == 409:
                yield event.plain_result("本对话还有任务在跑或正在投递，等这一步结束再改指。")
            else:
                yield event.plain_result(_prefixed_failure("改指失败", exc))
        except Exception as exc:  # noqa: BLE001 - 网络类失败同样只提示
            logger.warning(f"[dsh_relay] 改指失败：{exc}")
            yield event.plain_result(_prefixed_failure("改指失败", exc))
        else:
            previous = info.get("previousSessionId") or "（无）"
            lines = [
                "已改指到新工作区：",
                f"· 工作区　{workspace_id}",
                f"· 目录　　{info.get('cwd') or '（未知）'}",
                f"· 新会话　{info.get('sessionId') or '（未知）'}",
                f"· 旧会话　{previous}（保留，不删）",
                "下一条消息会投给新会话。",
            ]
            yield event.plain_result("\n".join(lines))

    async def _handle_fork_command(
        self, event: AstrMessageEvent, command: str
    ) -> AsyncIterator[Any]:
        """``/dsh fork [atSeq]`` —— 把本对话某个已完成轮次的前缀复制成新会话（契约 §14）。

        分支是**复制**：源会话一条事件不动，新会话只是「已建好、落了档、还没被接管」。
        所以要继续聊得用 ``/dsh adopt <子会话 id>`` 认领它，本对话的映射不会因此改变。
        """
        parts = command.split()
        at_seq: int | None = None
        if len(parts) >= 2 and parts[1].strip():
            text = parts[1].strip()
            # 只认十进制非负整数：``-1``/``1.5``/``1e3`` 在这里就该被挡住，
            # 而不是丢给桥接端去猜（契约 §14.1 要的是非负安全整数）。
            if not text.isdigit():
                yield event.plain_result(
                    f"轮次序号必须是非负整数：{text}。"
                    f"用法：{parts[0]} [轮次序号]（省略就取最后一轮已完成的边界）"
                )
                return
            at_seq = int(text)

        try:
            info = await self._transport_or_create().fork(
                conversation=event.unified_msg_origin,
                at_seq=at_seq,
            )
        except BridgeError as exc:
            # 本地那层「本对话还没有 DSH 会话」不带 status，只带 error_code，
            # 所以这里两个条件都要认，否则它会掉进「分支失败」的兜底文案。
            if exc.status == 404 or exc.code == contract.ERROR_NOT_FOUND:
                yield event.plain_result(
                    "本对话还没有 DSH 会话，先发一条消息建立起映射再分支。"
                )
            elif exc.status == 409:
                details = exc.details if isinstance(exc.details, dict) else {}
                if details.get("orphaned"):
                    # §14.1：挂载失败是**正常失败路径**，子会话已经回收，源会话没动过
                    yield event.plain_result(
                        _prefixed_failure(
                            "分支失败",
                            f"{exc}。子会话已释放、不留残留，本对话也没变，可以直接重试。",
                        )
                    )
                else:
                    yield event.plain_result(
                        _prefixed_failure(
                            "分支失败",
                            f"{exc}。等这一轮跑完，或换一个更早的轮次序号再试。",
                        )
                    )
            else:
                yield event.plain_result(_prefixed_failure("分支失败", exc))
        except Exception as exc:  # noqa: BLE001 - 网络类失败同样只提示
            logger.warning(f"[dsh_relay] 分支失败：{exc}")
            yield event.plain_result(_prefixed_failure("分支失败", exc))
        else:
            inherited = info.get("inheritedEventCount")
            lines = [
                "已从本对话分出新的子会话：",
                f"· 子会话　{info.get('sessionId') or '（未知）'}",
                f"· 源会话　{info.get('sourceSessionId') or '（未知）'}（保留，一字未动）",
                f"· 继承事件　{inherited if isinstance(inherited, int) else '（未知）'} 条",
                f"· 工作区　{info.get('workspaceId') or '（未挂载）'}",
                f"· 目录　　{info.get('cwd') or '（未知）'}",
                "子会话已落档、但还没被接管；本对话仍旧指着原来的会话。",
                f"要接着聊它：{parts[0]} adopt {info.get('sessionId') or '<子会话 id>'}",
            ]
            yield event.plain_result("\n".join(lines))

    async def _handle_adopt_command(
        self, event: AstrMessageEvent, command: str
    ) -> AsyncIterator[Any]:
        """``/dsh adopt <会话 id> [工作区 id]`` —— 把本对话改指到既有会话（契约 §15）。

        这是 ``/dsh fork`` 的后半句：fork 只把子会话**建好、落档**，映射还指着源会话；
        认领才是「本对话从此发给它」的那一步。与 ``rebind`` 的区别是骨头里的：rebind
        收工作区、语义是**新建**，本命令收会话 id、只是**换映射**，目标会话一条不动。
        """
        parts = command.split()
        if len(parts) < 2 or not parts[1].strip():
            yield event.plain_result(
                f"要认领哪个会话？用法：{parts[0]} <会话 id> [工作区 id]"
            )
            return
        session_id = parts[1].strip()
        # 工作区是可选加签：省略就不带这个字段，让桥接端只按会话 id 认领。
        workspace_id = parts[2].strip() if len(parts) >= 3 else ""

        try:
            info = await self._transport_or_create().adopt(
                conversation=event.unified_msg_origin,
                session_id=session_id,
                workspace_id=workspace_id,
            )
        except BridgeError as exc:
            details = exc.details if isinstance(exc.details, dict) else {}
            if exc.status == 404 or exc.code == contract.ERROR_NOT_FOUND:
                if details.get("workspaceId"):
                    yield event.plain_result(
                        f"没有这个工作区：{details.get('workspaceId')}。"
                        "先用 /dsh workspaces 看一眼，或干脆省掉工作区直接认领。"
                    )
                else:
                    yield event.plain_result(
                        f"档里没有会话 {session_id}：确认 id 没抄错，且它确实还在。"
                    )
            elif exc.status == 409:
                if details.get("workspaceId"):
                    # 给了加签、但那个工作区并不真包含这个会话：宁可当场拒绝，
                    # 也不写出一条「看起来挂上了、其实没挂」的假账（§15）。
                    yield event.plain_result(
                        _prefixed_failure(
                            "认领失败",
                            f"{exc}。换成真包含它的工作区，或省掉工作区 id 再试。",
                        )
                    )
                else:
                    yield event.plain_result(
                        _prefixed_failure(
                            "认领失败", f"{exc}。等这一轮跑完再认领。"
                        )
                    )
            else:
                yield event.plain_result(_prefixed_failure("认领失败", exc))
        except Exception as exc:  # noqa: BLE001 - 网络类失败同样只提示
            logger.warning(f"[dsh_relay] 认领失败：{exc}")
            yield event.plain_result(_prefixed_failure("认领失败", exc))
        else:
            previous = info.get("previousSessionId")
            if info.get("adopted") is False:
                yield event.plain_result(
                    f"本对话本来就指着 {info.get('sessionId') or session_id}，不用认领。"
                )
            else:
                lines = [
                    "已把本对话改指到这个会话：",
                    f"· 会话　　{info.get('sessionId') or session_id}",
                    f"· 原会话　{previous or '（原本没有映射）'}（档留存，没被删）",
                    f"· 工作区　{info.get('workspaceId') or '（未挂载）'}",
                    f"· 目录　　{info.get('cwd') or '（未知）'}",
                    "下一条消息就发给它。",
                ]
                yield event.plain_result("\n".join(lines))

    async def _handle_approval_command(
        self, event: AstrMessageEvent, command: str
    ) -> AsyncIterator[Any]:
        """``/dsh approve <code>`` / ``/dsh reject <code>``。契约 §7。"""
        parts = command.split()
        head = parts[0].lower()
        outcome = (
            contract.APPROVAL_ALLOW_ONCE
            if head == contract.APPROVAL_COMMAND_APPROVE
            else contract.APPROVAL_REJECTED
        )
        if outcome not in contract.APPROVAL_OUTCOMES_ALLOWED:  # 防御性：白名单兜底
            yield event.plain_result("不支持的审批结论。")
            return
        if len(parts) < 2 or not parts[1].strip():
            yield event.plain_result(f"用法：{head} <验证码>")
            return
        code = parts[1].strip()

        # IM 用户只看得见 code；callId 由本地表反查（契约 §7.2）
        key = (event.unified_msg_origin, code)
        record = self._pending.get(key)
        if record is None:
            yield event.plain_result("这个验证码已失效或不属于本会话。")
            return
        if time.monotonic() > float(record.get("deadline") or 0):
            self._pending.pop(key, None)
            yield event.plain_result("该审批已超时（按拒绝处理）。")
            return

        try:
            await self._transport_or_create().send_approval(
                conversation=event.unified_msg_origin,
                call_id=str(record.get("callId") or ""),
                outcome=outcome,
                code=code,
            )
        except BridgeError as exc:
            if exc.status == 409:
                # 幂等冲突：已决议或已超时，不是错误，提示即可
                self._pending.pop(key, None)
                yield event.plain_result("该审批已经被处理过了（已决议或已超时）。")
                return
            logger.warning(f"[dsh_relay] 审批回执失败：{exc}")
            yield event.plain_result(_prefixed_failure("审批回执失败", exc))
            return
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[dsh_relay] 审批回执失败：{exc}")
            yield event.plain_result(_prefixed_failure("审批回执失败", exc))
            return

        self._pending.pop(key, None)
        label = "允许一次" if outcome == contract.APPROVAL_ALLOW_ONCE else "拒绝"
        yield event.plain_result(f"已提交：{label}。")

    # ---- 回帖（结构已定型，P1 复用）----------------------------------

    async def _reply(self, event: AstrMessageEvent, text: str) -> AsyncIterator[Any]:
        """把 DSH 的文本回帖到同一会话。

        切分策略（契约 §9 未决 #5、设计 §3 第 5 层）：
          中间分片 ``await event.send()``；最后一片 ``yield plain_result()``。

        渲染策略：
          ``reply_render_mode="text"``（默认）逐片纯文本；
          ``="card"`` 先逐片出图，成功则整条走图片，
          **任一片失败就整条退回纯文本**（绝不半图半文）。
        """
        chunk_size = int(self._cfg("chunk_size", 800) or 0)
        chunks = _split_for_im(text, chunk_size)
        if not chunks:
            yield event.plain_result("（DSH 没有返回内容）")
            return
        if str(self._cfg("reply_render_mode", "text") or "text").strip().lower() == "card":
            cards = await self._render_cards(event, chunks)
            if cards is not None:
                for card in cards[:-1]:
                    await event.send(card)
                yield cards[-1]
                return
        for chunk in chunks[:-1]:
            await event.send(event.plain_result(chunk))
        yield event.plain_result(chunks[-1])

    async def _render_cards(
        self, event: AstrMessageEvent, chunks: list[str]
    ) -> list[Any] | None:
        """把每一片都渲染成卡片图；**有一片失败就整条放弃**（返回 None）。

        复用 ``Star.text_to_image``（沿当前 t2i 模板与端点），不自建渲染：
        t2i 是外部服务，可能超时、可能模板取不到，所以这里只负责
        「要么全成，要么交还给 ``_reply`` 走纯文本」——
        半截图片 + 半截文字会比纯文本更糟糕。
        """
        total = len(chunks)
        cards: list[Any] = []
        for index, chunk in enumerate(chunks, 1):
            try:
                url = await self.text_to_image(chunk, return_url=True)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"[dsh_relay] card 渲染失败（第 {index}/{total} 片）：{exc}；整条降级纯文本"
                )
                return None
            if not url:
                logger.warning(
                    f"[dsh_relay] card 渲染返回空 URL（第 {index}/{total} 片）；整条降级纯文本"
                )
                return None
            cards.append(event.image_result(url))
        return cards

    # ---- 辅助 --------------------------------------------------------

    def _session_allowed(self, event: AstrMessageEvent) -> bool:
        """会话白名单（``allow_from``）：空 = 全部允许。

        匹配交给 ``allowlist.any_match`` —— **宽松填**（纯 QQ 号、群号）与
        **精确填**（完整 UMO）都要能命中。这里以前只做逐字比较，于是填了纯 QQ 号
        ``1234567890`` 而真实 UMO 是 ``绫地宁宁:FriendMessage:1234567890``，
        判 False 后**静默放行**给默认 LLM，表现为「``/dsh 测试`` 没反应」、日志一个字
        都没有。所以现在：匹配放宽，**被挡下必记一行** ``info``（只记 UMO/ID，
        不记消息内容）——静默失败比报错贵得多。
        """
        allow = self._cfg("allow_from", []) or []
        if not isinstance(allow, (list, tuple, set)) or not allow:
            return True  # 空 = 全部允许
        if allowlist.any_match(allow, self._tokens_of(event)):
            return True
        umo = str(getattr(event, "unified_msg_origin", "") or "")
        logger.info(f"[dsh_relay] 白名单外的会话 {umo}，已忽略。")
        return False

    @classmethod
    def _tokens_of(cls, event: AstrMessageEvent) -> dict[str, str]:
        """把一次事件的「实际形状」摊平成 ``allowlist`` 的待匹配字段。

        ``platform`` / ``message_type`` / ``session_id`` 由 ``allowlist`` 从 UMO 里
        切（契约已核实 UMO 形如 ``{platform_id}:{MessageType}:{session_id}``），
        这里只补**发送者**与**群号**。群号取不到就是空串：空串匹配不上任何非空模式，
        于是解析失败只会「拒绝」，不会「误放行」。
        """
        group = ""
        getter = getattr(event, "get_group_id", None)
        if callable(getter):
            with contextlib.suppress(Exception):
                group = str(getter() or "")
        if not group:  # 兜底：事件没提供判定方法时，从 message_obj 上取兼容属性
            group = str(getattr(getattr(event, "message_obj", None), "group_id", "") or "")
        return allowlist.tokens_of(
            umo=str(getattr(event, "unified_msg_origin", "") or ""),
            sender_id=cls._sender_of(event)["id"],
            group_id=group,
        )

    @staticmethod
    def _sender_of(event: AstrMessageEvent) -> dict[str, str]:
        """契约 §3.1 的 ``sender``：从事件里取，取不到就是空串而不是伪造。"""
        obj = getattr(event, "message_obj", None)
        sender = getattr(obj, "sender", None)
        return {
            "id": str(getattr(sender, "user_id", "") or ""),
            "name": str(getattr(sender, "nickname", "") or ""),
        }

    @staticmethod
    def _delivery_failure_text(exc: BridgeError) -> str:
        """把错误码翻成用户看得懂的一句话。"""
        if exc.code == contract.ERROR_QUEUE_FULL:
            return "桥上排队已满，请稍后再发。"
        if exc.code == contract.ERROR_AGENT_BUSY:
            return "这个会话上一条还在处理中，等它回完再发吧。"
        if exc.status == 401:
            return "桥接鉴权失败：两侧 token 可能不一致。"
        if exc.status == 404:
            return "桥接端没有这个端点：检查 bridge_url 的 pathPrefix。"
        return _prefixed_failure("桥接调用失败", exc)

    async def push_to_session(self, umo: str, text: str) -> bool:
        """主动推送（不经事件）。

        与"回复当前事件"的区别（已核实）：
          * ``event.plain_result()`` 必须 yield，会走 ResultDecorateStage；
          * ``await event.send(...)`` 立即发出，绕过该阶段；
          * 主动推送用 ``await self.context.send_message(umo, chain)``。

        返回值即 ``Context.send_message`` 的布尔：``False`` 表示按
        ``platform.meta().id`` 没匹配到平台，消息其实**没发出去**。
        """
        from astrbot.api.event import MessageChain
        from astrbot.api.message_components import Plain

        chunk_size = int(self._cfg("chunk_size", 800) or 0)
        chunks = _split_for_im(text, chunk_size) or [text]
        sent = True
        for chunk in chunks:
            chain = MessageChain(chain=[Plain(text=chunk)])
            try:
                sent = await self.context.send_message(umo, chain) and sent
            except Exception as exc:  # noqa: BLE001 - 推送失败不得影响调用方
                logger.warning(f"[dsh_relay] 主动推送失败：{exc}")
                return False
        return sent

    async def terminate(self) -> None:
        """插件卸载：停掉后台任务，再释放连接池。

        本插件有**两处**后台协程，都必须在这里收干净：
          * SSE 读取任务：由 ``_handle_task`` 在同一次调用里创建，
            并在 ``finally`` 里 cancel + await，随事件生命周期自灭；
          * 周期健康检查：``initialize`` 里起的常驻任务，**必须显式 cancel**。
            它是全插件唯一的游离任务，漏掉就会在重载插件后继续跑，
            拿着已关闭的连接池去打 /health（历史上那句「没有游离的任务」
            的承诺到此为止，别再照抄）。
        """
        if self._health_task is not None:
            task, self._health_task = self._health_task, None
            task.cancel()
            # 用 wait 而不是 await task：await 会把子任务的取消
            # 与外层自己的取消混在一条链路里，容易把别人对插件的取消一起吞掉；
            # wait 只负责等它真的停下来。
            with contextlib.suppress(Exception):
                await asyncio.wait({task})
        self._pending.clear()
        if self._transport is not None:
            await self._transport.aclose()
            self._transport = None
        self._locks.clear()
        logger.info("[dsh_relay] terminated")


# ──────────────────────────────────────────────────────────────────────
# 纯函数
# ──────────────────────────────────────────────────────────────────────

def _match_prefix(raw: str, prefix: str) -> "str | None":
    """前缀匹配，返回**前缀之后的原文**（未 `strip`）；不匹配返回 `None`。

    比裸 `raw.startswith(prefix)` 多做三件事，三件都是踩出来的：

    1. 先把配置值的**尾空格**去掉再比。本机配置里 `trigger_prefix` 实读为
       `'/dsh '`（含尾空格，长度 5），而用户只敲前缀时消息是 `'/dsh'`（长度 4），
       `startswith` 会判不匹配、直接 `return` —— 恰好在最需要用法提示的那一刻
       什么都不回。
    2. 基名之后必须**紧跟空白或行尾**。否则 `/dshx ...` 这类别的插件的命令
       会被本插件吞掉（前缀族冲突）。
    3. **两边各容忍一个前导 `/`**（P0 的正解）。AstrBot 会在事件进插件之前剥掉
       wake_prefix（本机为 `/`），所以群里敲 `/dsh xx` 时 `event.message_str`
       实际是 `dsh xx` —— 此时配置写 `/dsh ` 就永远匹配不上，插件默默 `return`，
       而 `filter.event_message_type(ALL)` 让群聊里 `is_at_or_wake_command` 恒真，
       默认 LLM 便接手作答（`core/pipeline/process_stage/stage.py` 的判定式）。
       反过来，私聊或 wake_prefix 被改掉时又会原样送来 `/dsh xx`。因此配置
       `dsh `、用户敲 `/dsh xx`，与配置 `/dsh `、剥壳后送来 `dsh xx`，两种都要
       命中。
    """
    base = prefix.strip()
    if base.startswith("/"):
        base = base[1:]
    if not base:
        return None
    text = raw[1:] if raw.startswith("/") else raw
    if not text.startswith(base):
        return None
    tail = text[len(base):]
    if tail and not tail[:1].isspace():
        return None
    return tail


def _usage_text(base: str) -> str:
    """``/dsh help`` 与「裸前缀」共用的指令清单。

    ``base`` 是**去尾空格**后的前缀（如 ``/dsh``）。用配置里的原串会有两个问题：
    提示里会多出对不齐的空格，而且用户照抄时会把尾空格也一起抄进去。
    """
    rows = [
        (f"{base} <内容>", "投给 DSH 并流式回帖（本事件被接管，不走默认 LLM）"),
        (f"{base} {contract.COMMAND_HELP}", "显示本清单"),
        (
            f"{base} {contract.COMMAND_WHERE}",
            "定位本对话的工作区与 DSH 会话（只读，不投给 agent）",
        ),
        (
            f"{base} {contract.COMMAND_WORKSPACES}",
            "列出桥接端登记的工作区（只读，不投给 agent）",
        ),
        (
            f"{base} {contract.COMMAND_REBIND} <工作区 id>",
            "把本对话改指到指定工作区（新开一个会话，旧的不删）",
        ),
        (
            f"{base} {contract.COMMAND_FORK} [轮次序号]",
            "把本对话已完成的轮次前缀复制成新会话（旧的不动）",
        ),
        (
            f"{base} {contract.COMMAND_ADOPT} <会话 id> [工作区 id]",
            "把本对话改指到已有会话（不新建、不删旧的）",
        ),
        (
            f"{base} {contract.APPROVAL_COMMAND_APPROVE} <验证码>",
            "允许一次待审批操作",
        ),
        (
            f"{base} {contract.APPROVAL_COMMAND_REJECT} <验证码>",
            "拒绝待审批操作",
        ),
    ]
    width = max(len(cmd) for cmd, _ in rows)
    lines = ["星驿 · 可用指令（把 <内容> 换成你要说的话即可）："]
    lines.extend(f"  {cmd.ljust(width)}  {desc}" for cmd, desc in rows)
    return "\n".join(lines)


def _is_private_chat(event: AstrMessageEvent) -> bool:
    """私聊判定。

    ``event.is_private_chat()`` 已独立取证存在；UMO 格式已核实为
    ``{platform_id}:{MessageType}:{session_id}``，因此判定抛异常时回落到 UMO 解析。
    """
    checker = getattr(event, "is_private_chat", None)
    if callable(checker):
        try:
            return bool(checker())
        except Exception:  # noqa: BLE001 - 判定失败时按群聊处理（更保守：不响应）
            pass
    parts = str(getattr(event, "unified_msg_origin", "")).split(":")
    return len(parts) >= 2 and parts[1] == "FriendMessage"


def _fence_marker(line: str) -> str:
    """行首若是 ``` / ~~~ 围栏标记，返回该标记串；否则返回空串。"""
    stripped = line.lstrip(" 	")
    ch = stripped[:1]
    if ch not in ("`", "~"):
        return ""
    run = len(stripped) - len(stripped.lstrip(ch))
    return stripped[:run] if run >= 3 else ""


def _is_fence_close(line: str, marker: str) -> bool:
    """该行是否可以作为 ``marker`` 的收尾行（除标记与空白外没有别的字符）。"""
    stripped = line.rstrip("\r\n").lstrip(" 	")
    if len(stripped) < len(marker):
        return False
    return not stripped.strip(marker[0] + " 	")


_SENTENCE_ENDS = "\n。！？；!?;…"


def _fence_open_before(text: str, index: int) -> bool:
    """``text[:index]`` 是否停在未闭合的代码围栏内部。"""
    marker = ""
    for line in text[:index].splitlines():
        found = _fence_marker(line)
        if not found:
            continue
        if not marker:
            marker = found[0]
        elif found[0] == marker:
            marker = ""
    return bool(marker)


def _pick_cut(pending: str, soft: int, hard: int) -> int:
    """在 ``pending`` 里挑一个可发送的切点，返回下标（0 表示还不该发）。

    规则：优先切在句末标点 / 换行之后，并且切点不能落在未闭合的代码围栏内部；
    一直攒到 ``hard`` 仍找不到边界时才硬切。这样流式回帖不会从句子中间劈开。

    切点上限是 ``hard`` 本身：候选搜索的起点也压在 ``hard`` 上，否则一次超大
    ``delta`` 会把整段 pending 一次性放行（切点远超单条上限），那条路径就绕过
    调用方设的上限了。
    """
    soft = max(1, int(soft or 1))
    hard = max(soft, int(hard or soft))
    limit = len(pending)
    cap = min(limit, hard)  # 切点上限：硬阈值即单条自守上限

    cursor = cap
    for _ in range(16):  # 最多回退 16 个候选边界，避免病态长文本反复扫描
        end = max((pending.rfind(ch, 0, cursor) for ch in _SENTENCE_ENDS), default=-1) + 1
        if end < soft:
            break
        if not _fence_open_before(pending, end):
            return end
        cursor = end - 1

    if limit >= hard:
        cursor = cap
        for _ in range(16):
            line_end = pending.rfind("\n", 0, cursor) + 1
            if line_end < soft:
                break
            if not _fence_open_before(pending, line_end):
                return line_end
            cursor = line_end - 1
        return cap  # 实在没有边界：硬切到上限，保证流式不被卡死
    return 0


def _iter_units(text: str) -> list[str]:
    """切成不可再分的最小单元：整段代码围栏算一个单元，其余按行。"""
    lines = text.splitlines(keepends=True)
    units: list[str] = []
    i = 0
    while i < len(lines):
        marker = _fence_marker(lines[i])
        if not marker:
            units.append(lines[i])
            i += 1
            continue
        block = [lines[i]]
        i += 1
        while i < len(lines):
            block.append(lines[i])
            closing = _is_fence_close(lines[i], marker)
            i += 1
            if closing:
                break
        units.append("".join(block))
    return units


def _hard_split(block: str, size: int) -> list[str]:
    """单元自身就超过 ``size``：先按行装箱，单行仍超长才硬切。"""
    out: list[str] = []
    cur = ""
    for piece in block.splitlines(keepends=True):
        while len(piece) > size:
            if cur:
                out.append(cur)
                cur = ""
            out.append(piece[:size])
            piece = piece[size:]
        if cur and len(cur) + len(piece) > size:
            out.append(cur)
            cur = ""
        cur += piece
    if cur:
        out.append(cur)
    return out


def _split_fence_unit(block: str, size: int) -> list[str]:
    """超长代码围栏：逐行重排，每片自带闭合与重开的围栏标记。

    这是 ``_split_for_im`` 的退化路径：围栏本身装不进单条上限时，"不切开"
    已经做不到，退而求其次——**让每一片都是合法且自洽的代码块**，而不是把
    一片渲染成没有收尾的围栏、另一片渲染成孤立的反引号。收尾/重开标记占用
    的额度先从上限里扣掉，因此返回的每一片仍不超过 ``size``。

    唯一的内容代价：某片的切点若落在代码行中间，会补一个换行让收尾标记独占
    一行——代码文本因此可能多出一个换行，但少这一个换行就无法闭合渲染。
    """
    lines = block.splitlines(keepends=True)
    if not lines:
        return [block]
    open_line = lines[0]
    marker = _fence_marker(open_line)
    body = lines[1:]
    close_line = marker + "\n"
    if body and _is_fence_close(body[-1], marker):
        close_line = body[-1]
        body = body[:-1]
    # 预留 1 字节：切点可能落在行中间，此时收尾标记必须独占一行，
    # 否则 "xxxx```" 会与代码同行，渲染不出闭合效果。
    budget = size - len(open_line) - len(close_line) - 1
    if budget < 1:
        return _hard_split(block, size)  # 标记本身就超限：只能硬切
    pieces = []
    for piece in _hard_split("".join(body), budget):
        if piece and not piece.endswith("\n"):
            piece += "\n"
        pieces.append(open_line + piece + close_line)
    return pieces or [block]


def _split_for_im(text: str, size: int) -> list[str]:
    """按段落 / 代码围栏边界切分长文本。

    已核实：AstrBot **没有**通用切分工具，且 aiocqhttp 适配器完全没有长度切分
    逻辑，所以必须自己切。

    贪心装箱：整段代码围栏视为不可拆单元，普通内容按行累积，装不下才开新块，
    于是断点落在段落 / 列表项边界，反引号围栏也不会被从中间切开。仅当单元
    自身超过 ``size``（超长代码块或超长单行）才退化：代码块走
    ``_split_fence_unit``（补齐围栏），其余按行装箱 / 硬切。
    """
    if not text:
        return []
    size = int(size or 0)
    if size <= 0 or len(text) <= size:
        return [text]
    chunks: list[str] = []
    buf = ""
    for unit in _iter_units(text):
        if len(unit) > size:
            if buf:
                chunks.append(buf)
                buf = ""
            head = unit.splitlines()[0] if unit.splitlines() else ""
            if _fence_marker(head):
                chunks.extend(_split_fence_unit(unit, size))
            else:
                chunks.extend(_hard_split(unit, size))
            continue
        if buf and len(buf) + len(unit) > size:
            chunks.append(buf)
            buf = ""
        buf += unit
    if buf:
        chunks.append(buf)
    return chunks
