#!/usr/bin/env python3
"""IM 侧**指令分发 / 审批链 / 问答链 / 卡片渲染**的假宿主集成测试。

与 `scripts/test-im-heartbeat.py` 同一套路（共用宿主 `scripts/_fake_astrbot.py`），
但覆盖的是另一大批接线：这批代码此前**只做过静态核对**，没有任何宿主替身跑过它。

为什么值得单独一批：心跳那一小块接线只被替身照了一次就照出两个真 P0
（见 CHANGELOG v0.8.7）。而这里的每一条路径都是用户真的会走到的：
`/dsh where|workspaces|rebind|fork|adopt|answer|approve|reject`、审批提示的送达、
问答的逐题补交、卡片渲染的「要么全成要么退回纯文本」。

⚠️ 走的是**被装饰的完整入口** `on_bridge_message`，而不是直接调 `_handle_xxx`：
前缀匹配、白名单、takeover 标记（`should_call_llm` / `stop_event`）本身就是要测的东西。

用法：python scripts/test-im-commands.py
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from _fake_astrbot import (  # noqa: E402
    LOGGER, UMO, UMO_PRIVATE, FakeEvent, drive, make_main, plugin_main,
    section, summary, test,
)

CONTRACT = plugin_main.contract


def turn_frames(*, deltas=(), final="", gap=None, extra=(), reason=None):
    """拼一串标准的 SSE 帧，**必定以 turn/end 收尾**。

    收尾是硬要求：`_consume_turn` 靠 `turn/end` 退出，少了它就会一直等到
    `request_timeout`（默认 600 秒）——测试会挂成「看起来卡住」而不是失败。
    """
    frames = [{"type": CONTRACT.EVENT_TURN_START, "turn": 1}]
    if gap is not None:
        frames.append({"type": CONTRACT.EVENT_GAP, "fromSeq": gap})
    for text in deltas:
        frames.append({"type": CONTRACT.EVENT_TEXT_DELTA, "text": text})
    frames.extend(extra)
    if final:
        frames.append({"type": CONTRACT.EVENT_MESSAGE_FINAL, "text": final})
    frames.append({
        "type": CONTRACT.EVENT_TURN_END,
        "reason": reason or {"kind": "ok"},
    })
    return frames


section("桩自身的正确性：假 transport 不能与真实 transport 漂移")


@test("13 个方法的名字与参数名与真实 BridgeTransport 逐一对齐")
def _() -> None:
    # 这条是**元测试**：桩写错了，上面所有用例都会给出看似合理的假结论。
    # 实际踩过：假 fork 写成了 `upto_turn`，真名是 `at_seq`，于是处理器的
    # `except Exception` 把 TypeError 吞掉、只回一句「分支失败」，
    # 测试看到的是「没有任何调用」——一个由桩自己造出来的假象。
    from _fake_astrbot import FakeTransport

    names = [
        "health", "where", "workspaces", "rebind", "fork", "adopt",
        "send_message", "events", "send_approval", "send_answer", "proactive", "aclose",
        "rpc",
    ]
    for name in names:
        real = inspect.signature(getattr(plugin_main.BridgeTransport, name))
        fake = inspect.signature(getattr(FakeTransport, name))
        strip = lambda sig: [(p.name, p.kind) for p in sig.parameters.values() if p.name != "self"]
        assert strip(real) == strip(fake), (
            f"{name} 的参数与真实传输不一致：\n  真 {strip(real)}\n  假 {strip(fake)}"
        )

        # 第二条：**必填性**（有没有默认值）也要对齐。只有名字对齐不够——
        # 实测把桩的 `sender: dict | None = None` 改成 `= {}`，所有用例照样全绿；
        # 真实 `rpc.args` 可省、桩却写成必填，也是这么静默漂了很久。
        # 类型注解**故意不比**：`dict` / `list` 省掉泛型参数不影响运行，不算漂移
        # （现存 `sender` / `answers` / `args` 三处就是这类，只记录不拦）。
        required = lambda sig: {
            p.name: p.default is inspect.Parameter.empty
            for p in sig.parameters.values() if p.name != "self"
        }
        assert required(real) == required(fake), (
            f"{name} 的必填性（有无默认值）与真实传输不一致："
            f"\n  真 {required(real)}\n  假 {required(fake)}"
        )


section("指令分发：前缀、白名单、接管标记")


@test("裸前缀 ⇒ 用法清单，并且显式禁止默认 LLM、停掉事件")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, FakeEvent(message_str="dsh"))
    assert event.yielded_text, event.yielded
    assert "where" in event.yielded_text[-1], event.yielded_text[-1]
    assert event.call_llm is True, "必须显式禁止默认 LLM（传 True 才是禁止）"
    assert event.stopped is True, "stop_event 必须在 yield 之后被调用"
    assert not t.called("send_message"), "裸前缀不该投给 agent"


@test("前缀不匹配 ⇒ 完全不插手（不设结果、不停事件、不召 LLM 判定）")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, FakeEvent(message_str="普通聊天，不带前缀"))
    assert event.yielded == [], event.yielded
    assert event.call_llm is None, "不匹配时不该碰 should_call_llm"
    assert event.stopped is False, "不匹配时不该 stop_event"
    assert t.calls == [], t.calls


@test("enable=false ⇒ 整个插件不响应")
def _() -> None:
    m, _c, t = make_main(enable=False)
    event = drive(m, FakeEvent(message_str="dsh where"))
    assert event.yielded == [] and t.calls == []


@test("白名单之外的会话不响应，且留下一条 info（静默失败比报错贵）")
def _() -> None:
    m, _c, t = make_main(allow_from=["other:GroupMessage:9"])
    before = len(LOGGER.lines)
    event = drive(m, FakeEvent(message_str="dsh where"))
    assert event.yielded == [] and t.calls == []
    assert LOGGER.has("info", "白名单外"), LOGGER.lines[before:]


@test("reply_in_private_only=true 时群聊不响应、私聊响应")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(reply_in_private_only=True)
    group = drive(m, FakeEvent(message_str="dsh where", umo=UMO, private=False))
    assert group.yielded == [] and t.calls == [], "群聊不该响应"
    m2, _c2, t2 = mod.make_main(reply_in_private_only=True)
    private = drive(m2, FakeEvent(message_str="dsh where", umo=UMO_PRIVATE, private=True))
    assert private.yielded, private.yielded
    assert t2.called("where"), t2.calls


@test("未知指令 ⇒ 当成对话内容投给 agent（不是报错）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(final="好的")
    event = drive(m, FakeEvent(message_str="dsh 帮我看看这段代码"))
    assert t.called("send_message"), t.calls
    assert t.called("send_message")[0]["text"] == "帮我看看这段代码", t.called("send_message")
    assert event.call_llm is True and event.stopped is True


section("六个只读/改指指令都真的路由到了对应端点")


@test("/dsh where 路由到 where，且不投给 agent")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    event = drive(m, FakeEvent(message_str="dsh where"))
    assert t.called("where"), t.calls
    assert not t.called("send_message"), "定位是只读诊断，不该投给 agent"
    assert event.call_llm is True and event.stopped is True
    assert event.yielded_text, event.yielded


@test("/dsh workspaces 路由到 workspaces")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.results["workspaces"] = {"items": [{"id": "w1", "title": "主工作区", "path": "C:/w"}],
                              "count": 1, "returned": 1}
    event = drive(m, FakeEvent(message_str="dsh workspaces"))
    assert t.called("workspaces"), t.calls
    assert any("主工作区" in text for text in event.yielded_text), event.yielded_text


@test("/dsh rebind <工作区 id> 路由到 rebind")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    drive(m, FakeEvent(message_str="dsh rebind w-123"))
    assert t.called("rebind"), t.calls
    assert t.called("rebind")[0]["workspace_id"] == "w-123", t.called("rebind")


@test("/dsh fork 路由到 fork，且不投给 agent")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    drive(m, FakeEvent(message_str="dsh fork"))
    assert t.called("fork"), t.calls
    assert not t.called("send_message")


@test("/dsh adopt <会话 id> 路由到 adopt")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    drive(m, FakeEvent(message_str="dsh adopt im-abc"))
    assert t.called("adopt"), t.calls
    assert t.called("adopt")[0]["session_id"] == "im-abc", t.called("adopt")


section("流式回帖与 turn/end 收敛")


@test("stream_enabled=false ⇒ 中间分片不刷（开关管的是流式，不是静音）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    # 与下方对照组**完全同参**，只差 stream_enabled：``flush_chars=1`` + 带句末标点的 delta。
    # 若沿用默认 flush_chars=200，``_pick_cut`` 会把这些短 delta 合法地攒住不发，
    # 于是「把 :1214 的开关判断整行删掉」也照样变绿——那是假绿，测不出开关失效。
    m, _c, t = mod.make_main(stream_enabled=False, flush_chars=1)
    t.frames = turn_frames(deltas=("第一部。", "第二部。"), final="权威最终文本")
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert event.sent_text == [], event.sent_text


@test("stream_enabled=false ⇒ 收敛回帖照发，关流式不许把问答变成哑巴")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(stream_enabled=False, flush_chars=1)
    t.frames = turn_frames(deltas=("第一部。", "第二部。"), final="权威最终文本")
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert event.yielded_text == ["权威最终文本"], event.all_text


@test("最终文本以 message/final 为准，绝不用 text/delta 拼")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(stream_enabled=False, flush_chars=1)
    t.frames = turn_frames(deltas=("第一部。", "第二部。"), final="权威最终文本")
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert event.all_text == ["权威最终文本"], event.all_text


@test("stream_enabled=false ⇒ 工具调用提示也一并停（它同属流式刷屏）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(stream_enabled=False)
    t.frames = turn_frames(
        extra=[{"type": CONTRACT.EVENT_TOOL_CALL, "name": "read_file"}],
        final="答案",
    )
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert not any("调用工具" in text for text in event.all_text), event.all_text
    assert event.yielded_text == ["答案"], event.all_text


@test("对照组：同一条路径在 stream_enabled=true 时确实会刷分片与工具提示")
def _() -> None:
    mod = __import__("_fake_astrbot")
    # ``flush_chars=1``：本层测的是「开关有没有拦住分片」，不是切句策略本身
    # （切句另有自己的用例）。默认 200 会让这几个短 delta 合法地攒着不发，
    # 断言就成了空的。
    m, _c, t = mod.make_main(flush_chars=1)
    t.frames = turn_frames(
        deltas=("第一部。", "第二部。"),
        extra=[{"type": CONTRACT.EVENT_TOOL_CALL, "name": "read_file"}],
        final="权威最终文本",
    )
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert event.sent_text[:2] == ["第一部。", "第二部。"], event.sent_text
    assert any("调用工具" in text for text in event.sent_text), event.sent_text


@test("turn/end 的 reason.kind=error 且尚无输出 ⇒ 如实报错")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = [
        {"type": CONTRACT.EVENT_TURN_START, "turn": 1},
        {"type": CONTRACT.EVENT_TURN_END,
         "reason": {"kind": "error", "error": {"message": "模型不可用"}}},
    ]
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert any("模型不可用" in text for text in event.all_text), event.all_text


@test("gap 帧 ⇒ 明确告知中间有内容丢失")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(gap=42, final="继续")
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert any("丢失" in text for text in event.all_text), event.all_text


@test("未知帧类型必须忽略（前向兼容，契约 §4）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(extra=[{"type": "未来新增的/东西", "x": 1}], final="正常")
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert event.all_text == ["正常"], event.all_text


@test("投递失败 ⇒ 回一句人话，而不是抛出去")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.errors["send_message"] = plugin_main.BridgeError("排队满", code=CONTRACT.ERROR_QUEUE_FULL)
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert any("排队" in text for text in event.all_text), event.all_text


@test("先连 SSE 再投递（顺序反了会丢开头几个 token）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(final="好")
    drive(m, FakeEvent(message_str="dsh 你好"))
    names = [name for name, _kwargs in t.calls]
    assert names.index("events") < names.index("send_message"), names


section("审批链：提示必须真的送到用户手上")


@test("处理器是**协程**不是异步生成器（调用点必须 await）")
def _() -> None:
    # v0.8.7 及以前的写法：两个处理器标注 AsyncIterator 却完全没有 yield，
    # 调用点却写 `async for` ⇒ TypeError: 'coroutine' object is not async iterable，
    # 整条 turn 中断、审批提示永远到不了用户。这条从两侧钉住形状：
    # 谁要是给处理器加了 yield 而没同步改调用点，这里立刻出声。
    for name in ("_on_approval_required", "_on_question_required"):
        fn = getattr(plugin_main.Main, name)
        assert not inspect.isasyncgenfunction(fn), (
            f"{name} 变成了异步生成器；请把 _consume_turn 里对应那行改回 async for"
        )
        assert inspect.iscoroutinefunction(fn), f"{name} 应当是协程"


@test("approval/required 帧 ⇒ 用户收到含验证码的提示，且本地表记下 code→callId")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(
        extra=[{"type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1",
                "code": "K7Q2", "toolName": "bash", "reason": "要跑 rm -rf"}],
        final="",
    )
    event = drive(m, FakeEvent(message_str="dsh 清理一下"))
    sent = "\n".join(event.all_text)
    assert "K7Q2" in sent, sent
    assert "bash" in sent, sent
    assert "rm -rf" in sent, sent
    assert (UMO, "K7Q2") in m._pending, m._pending


@test("approve 回执 ⇒ 发 allowed-once 且销号")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(extra=[{
        "type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1", "code": "K7Q2",
        "toolName": "bash"}])
    drive(m, FakeEvent(message_str="dsh 清理一下"))
    event = drive(m, FakeEvent(message_str="dsh approve K7Q2"))
    assert t.called("send_approval"), t.calls
    call = t.called("send_approval")[0]
    assert call["outcome"] == CONTRACT.APPROVAL_ALLOW_ONCE, call
    assert call["call_id"] == "im-1", call
    assert (UMO, "K7Q2") not in m._pending, "回执后必须销号"
    assert any("允许一次" in text for text in event.yielded_text), event.yielded_text


@test("reject 回执 ⇒ 发 rejected")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(extra=[{
        "type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1", "code": "K7Q2",
        "toolName": "bash"}])
    drive(m, FakeEvent(message_str="dsh 清理一下"))
    drive(m, FakeEvent(message_str="dsh reject K7Q2"))
    assert t.called("send_approval")[0]["outcome"] == CONTRACT.APPROVAL_REJECTED


@test("重复回执同一个 code ⇒ 提示已失效，不重复发给桥")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(extra=[{
        "type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1", "code": "K7Q2",
        "toolName": "bash"}])
    drive(m, FakeEvent(message_str="dsh 清理一下"))
    drive(m, FakeEvent(message_str="dsh approve K7Q2"))
    again = drive(m, FakeEvent(message_str="dsh approve K7Q2"))
    assert len(t.called("send_approval")) == 1, t.called("send_approval")
    assert any("失效" in text for text in again.yielded_text), again.yielded_text


@test("approval/resolved 帧 ⇒ 销号（用户在别处处理掉了）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main()
    t.frames = turn_frames(extra=[
        {"type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1", "code": "K7Q2",
         "toolName": "bash"},
        {"type": CONTRACT.EVENT_APPROVAL_RESOLVED, "callId": "im-1", "outcome": "rejected"},
    ])
    drive(m, FakeEvent(message_str="dsh 清理一下"))
    assert (UMO, "K7Q2") not in m._pending, m._pending


@test("approval_enabled=false ⇒ 不转达、不记表")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(approval_enabled=False)
    t.frames = turn_frames(extra=[{
        "type": CONTRACT.EVENT_APPROVAL_REQUIRED, "callId": "im-1", "code": "K7Q2",
        "toolName": "bash"}])
    event = drive(m, FakeEvent(message_str="dsh 清理一下"))
    assert m._pending == {}, m._pending
    assert not any("K7Q2" in text for text in event.all_text), event.all_text


section("问答链：逐题补交，答齐才碰网桥")


def _question_frames():
    return turn_frames(extra=[{
        "type": CONTRACT.EVENT_QUESTION_REQUIRED, "callId": "im-q-1", "expiresAt": 0,
        "questions": [
            {"id": "q1", "header": "选口味", "question": "要哪种？",
             "options": [{"label": "香草"}, {"label": "巧克力"}]},
            {"id": "q2", "header": "选份量", "question": "多大？",
             "options": [{"label": "小"}, {"label": "大"}]},
        ],
    }])


def _question_main(**overrides):
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(**overrides)
    t.frames = _question_frames()
    event = drive(m, FakeEvent(message_str="dsh 帮我点个冰淇淋"))
    text = "\n".join(event.all_text)
    # 从提示里把验证码抠出来：用户就是这么看到它的
    code = ""
    for line in text.splitlines():
        if "验证码" in line:
            code = line.split("：", 1)[-1].strip()
    assert code.isdigit() and len(code) == 4, f"没能从提示里取到验证码：{text}"
    return m, t, code, text


@test("question/required 帧 ⇒ 提示含两题与选项编号，并记表")
def _() -> None:
    m, _t, code, text = _question_main()
    assert "选口味" in text and "选份量" in text, text
    assert "[1] 香草" in text and "[2] 巧克力" in text, text
    assert "问题序号" in text, f"多题时应提示带问题序号：{text}"
    assert (UMO, code) in m._pending_answers, m._pending_answers


@test("多题中途作答 ⇒ 不碰网桥（少一次无谓的 400）")
def _() -> None:
    m, t, code, _text = _question_main()
    event = drive(m, FakeEvent(message_str=f"dsh answer {code} 1 2"))
    assert not t.called("send_answer"), t.called("send_answer")
    assert any("已记录" in text or "还剩" in text for text in event.yielded_text), \
        event.yielded_text


@test("答齐两题 ⇒ 发 answers，且形状是 {id, selected[]}")
def _() -> None:
    m, t, code, _text = _question_main()
    drive(m, FakeEvent(message_str=f"dsh answer {code} 1 2"))
    drive(m, FakeEvent(message_str=f"dsh answer {code} 2 1"))
    assert t.called("send_answer"), t.calls
    answers = t.called("send_answer")[0]["answers"]
    assert answers == [{"id": "q1", "selected": ["巧克力"]},
                       {"id": "q2", "selected": ["小"]}], answers


@test("自由文字作答落在 custom 上")
def _() -> None:
    m, t, code, _text = _question_main()
    drive(m, FakeEvent(message_str=f"dsh answer {code} 1 抹茶"))
    drive(m, FakeEvent(message_str=f"dsh answer {code} 2 超大杯"))
    answers = t.called("send_answer")[0]["answers"]
    assert answers == [{"id": "q1", "selected": [], "custom": "抹茶"},
                       {"id": "q2", "selected": [], "custom": "超大杯"}], answers


@test("无效验证码 ⇒ 明确提示，不碰网桥")
def _() -> None:
    m, t, _code, _text = _question_main()
    event = drive(m, FakeEvent(message_str="dsh answer 0000 1"))
    assert any("失效" in text for text in event.yielded_text), event.yielded_text
    assert not t.called("send_answer")


@test("questions_enabled=false ⇒ 不转达、不记表")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(questions_enabled=False)
    t.frames = _question_frames()
    event = drive(m, FakeEvent(message_str="dsh 帮我点个冰淇淋"))
    assert m._pending_answers == {}, m._pending_answers
    assert not any("验证码" in text for text in event.all_text), event.all_text


section("卡片渲染：要么全成，要么整条退回纯文本")


@test("card 模式 + 渲染成功 ⇒ 出图")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(reply_render_mode="card", chunk_size=5)
    t.frames = turn_frames(final="一二三四五六七八九十")

    async def fake_t2i(text, return_url=True):
        return f"http://img/{len(text)}"

    m.text_to_image = fake_t2i
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    images = [r for r in event.sent + event.yielded if r.kind == "image"]
    assert images, [r.kind for r in event.sent + event.yielded]


@test("card 模式 + 任一片失败 ⇒ **整条**退回纯文本（绝不半图半文）")
def _() -> None:
    mod = __import__("_fake_astrbot")
    m, _c, t = mod.make_main(reply_render_mode="card", chunk_size=5)
    t.frames = turn_frames(final="一二三四五六七八九十")
    calls = {"n": 0}

    async def flaky_t2i(text, return_url=True):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("t2i 超时")
        return "http://img/1"

    m.text_to_image = flaky_t2i
    event = drive(m, FakeEvent(message_str="dsh 你好"))
    assert not [r for r in event.sent + event.yielded if r.kind == "image"], "不该有半截图片"
    assert event.all_text, "必须整条退回纯文本"
    assert "".join(event.all_text) == "一二三四五六七八九十", event.all_text
    assert LOGGER.has("warn", "整条降级纯文本")


section("主动推送也认 reply_render_mode（配置键不能在一条路径上说谎）")


@test("card 模式：心跳播报以**图片**发出，而不是固定纯文本")
def _() -> None:
    m, c, _t = make_main(heartbeat_notify="fixed", reply_render_mode="card")
    m._touch_frame(UMO)
    m._bridge_ok = False
    m._bridge_error = "HTTP 503"

    async def fake_t2i(text, return_url=True):
        return f"http://img/{len(text)}"

    m.text_to_image = fake_t2i
    asyncio.run(m._evaluate_heartbeats())
    assert c.images, f"card 模式下应走图片：{c.messages}"
    assert c.sent == [], f"不该同时再发一份纯文本：{c.sent}"


@test("card 模式 + 任一片失败 ⇒ 主动推送**整条**退回纯文本（绝不半图半文）")
def _() -> None:
    # chunk_size=5 会把整条通知切成多片，专门盯「一片失败就全退」这条规则。
    m, c, _t = make_main(heartbeat_notify="fixed", reply_render_mode="card", chunk_size=5)

    async def flaky_t2i(text, return_url=True):
        raise RuntimeError("t2i 超时")

    m.text_to_image = flaky_t2i
    m._touch_frame(UMO)
    m._bridge_ok = False
    m._bridge_error = "HTTP 503"
    asyncio.run(m._evaluate_heartbeats())
    assert not c.images, f"不该有半截图片：{c.messages}"
    assert c.sent and "中断" in "".join(text for _umo, text in c.sent), c.sent


@test("默认 text 模式不受影响：推送仍是纯文本、不碰 t2i")
def _() -> None:
    m, c, _t = make_main(heartbeat_notify="fixed")

    async def boom(text, return_url=True):
        raise AssertionError("text 模式下不该调用 t2i")

    m.text_to_image = boom
    m._touch_frame(UMO)
    m._bridge_ok = False
    m._bridge_error = "HTTP 503"
    asyncio.run(m._evaluate_heartbeats())
    assert c.sent and "中断" in c.sent[-1][1], c.sent
    assert c.images == [], c.messages


@test("主动消息（取件）在 card 模式下同样出图")
def _() -> None:
    m, c, t = make_main(reply_render_mode="card")
    t.proactive_items = [{"id": 1, "conversation": UMO, "text": "我想到一件事", "at": 0}]
    t.proactive_cursor = 1

    async def fake_t2i(text, return_url=True):
        return f"http://img/{len(text)}"

    m.text_to_image = fake_t2i
    asyncio.run(m._poll_proactive())
    assert c.images and c.images[0][0] == UMO, c.messages
    assert c.sent == [], c.sent


@test("_image_chain 的分派与 event.image_result 逐字对应（http→fromURL，其余→fromFileSystem）")
def _() -> None:
    from _fake_astrbot import ImageStub

    http_chain = plugin_main._image_chain("http://x/y.png")
    assert isinstance(http_chain.chain[0], ImageStub), http_chain.chain[0]
    assert http_chain.chain[0].file == "http://x/y.png", http_chain.chain[0].file

    local_chain = plugin_main._image_chain("C:/tmp/a.png")
    assert local_chain.chain[0].file == "C:/tmp/a.png", local_chain.chain[0].file


@test("_image_chain 走的是 fromURL（它会对非 http 抛错），所以分派写错不会安静通过")
def _() -> None:
    from _fake_astrbot import ImageStub

    try:
        ImageStub.fromURL("C:/tmp/a.png")
    except Exception as exc:
        assert "not a valid url" in str(exc), exc
    else:
        raise AssertionError("桩的 fromURL 没有照抄真实实现的校验")


section("§11 /rpc：管理员门、本地预检与失败文案的映射")


#: 白名单里**没有必填参数**的端点：只想看「信封怎么回」时用它，
#: 免得每条断言都先被本地预检按「少了必填参数」拦下来。
_FREE_ENDPOINT = "settings/describe"
#: 有一条必填参数（``_request``）的端点：用来钉「参数原样透传」。
_ARG_ENDPOINT = "session/list"


def _admin_event(message: str, *, admin: bool = True) -> FakeEvent:
    return FakeEvent(message_str=message, admin=admin)


def _bridge_error(status, code, details=None):
    return plugin_main.BridgeError(
        "控制面调用失败", code=code, status=status, details=details
    )


@test("非管理员 ⇒ 明确拦下、不碰网桥，且不投给 agent")
def _() -> None:
    # 「拦下」和「静默拦下」是两回事：PermissionTypeFilter 那种做法会让用户
    # 只收到默认 LLM 的胡话，没人知道是权限问题，所以这条同时钉住三件事——
    # 有明白话、零转发、事件被接管。
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc session/list", admin=False))
    text = "\n".join(event.all_text)
    assert "只有管理员能用" in text, text
    assert "admins_id" in text, text
    assert t.called("rpc") == [], t.calls
    assert event.call_llm is True and event.stopped is True, (event.call_llm, event.stopped)


@test("管理员但没写 endpoint ⇒ 只给用法，不发盲请求")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc"))
    text = "\n".join(event.all_text)
    assert "要调哪个端点" in text, text
    assert "<endpoint> [json]" in text, text  # 用法得能照着抄
    assert t.called("rpc") == [], t.calls
    assert event.call_llm is True and event.stopped is True, (event.call_llm, event.stopped)


@test("参数不是合法 JSON ⇒ 原样带上解析错误，且不发请求")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event('dsh rpc session/list {"limit": }'))
    text = "\n".join(event.all_text)
    assert "不是合法 JSON" in text, text
    assert "sessionId" in text, text  # 例子得是真的能抄的写法
    assert t.called("rpc") == [], t.calls


@test("参数是 JSON 但不是对象（数组/字符串）⇒ 提示要花括号包起来")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc session/list [1, 2]"))
    text = "\n".join(event.all_text)
    assert "JSON 对象" in text, text
    assert t.called("rpc") == [], t.calls


# ── 本地预检：五类错要在**离用户最近的地方**讲成人话 ──────────────────
# 这五种在宿主那边会先撞三道门，回回来的只有笼统的 400/403，等于「请求没出
# 本机却长得像宿主回的错」，把排查往错方向带。所以下面每条都同时钉两件事：
# 文案要点到病因、且**零转发**。


@test("预检·名字拼错 ⇒ 直说宿主不认识，不转发")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc session/nope"))
    text = "\n".join(event.all_text)
    assert "本地拦下" in text, text
    assert "名字可能拼错" in text, text
    assert "session/nope" in text, text
    assert t.called("rpc") == [], t.calls


@test("预检·流式端点 ⇒ 点明 HTTP 调不动（而不是让它去撞宿主那道 403）")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc session/follow"))
    text = "\n".join(event.all_text)
    assert "流式端点" in text, text
    assert "本地拦下" in text, text
    assert t.called("rpc") == [], t.calls


@test("预检·有副作用的端点不在白名单 ⇒ 指向 allowedRpcMethods，不转发")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event('dsh rpc credentials/set {"_request": {}}'))
    text = "\n".join(event.all_text)
    assert "白名单" in text, text
    assert "allowedRpcMethods" in text, text
    assert t.called("rpc") == [], t.calls


@test("预检·缺必填参数 ⇒ 连「它认的是」一起给出来")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event("dsh rpc session/list"))
    text = "\n".join(event.all_text)
    assert "少了必填参数" in text, text
    assert "_request" in text, text
    assert t.called("rpc") == [], t.calls


@test("预检·多塞了参数 ⇒ 点名是哪个，别让它白跑一趟宿主")
def _() -> None:
    m, _c, t = make_main()
    event = drive(m, _admin_event('dsh rpc session/list {"_request": {}, "extra": 1}'))
    text = "\n".join(event.all_text)
    assert "不认这些参数" in text, text
    assert "extra" in text, text
    assert t.called("rpc") == [], t.calls


@test("成功 ⇒ endpoint 与 args 原样透传，且走的是 raw=True 那条路")
def _() -> None:
    # 两件事一起钉：maxsplit 的意义（args 里的空格切碎了就会变成「JSON 不合法」，
    # 而用户完全看不出是自己的参数被本端弄坏的），以及 ``raw=True``——
    # 少了它，业务失败会先被 ``_ensure_ok`` 抛掉，信封就再也见不到了。
    m, _c, t = make_main()
    t.results["rpc"] = {"ok": True, "value": {"items": ["a", "b"], "count": 2}}
    event = drive(
        m,
        _admin_event('dsh rpc session/list {"_request": {"kind": "list", "q": "a b"}}'),
    )
    calls = t.called("rpc")
    assert len(calls) == 1, t.calls
    assert calls[0]["endpoint"] == "session/list", calls[0]
    # 参数里的空格不能让 JSON 被切碎：q 那格空格得原样活到传输层，
    # 否则用户看到的会是「不是合法 JSON」，而病因在本端的切分上。
    assert calls[0]["args"] == {"_request": {"kind": "list", "q": "a b"}}, calls[0]
    assert calls[0]["raw"] is True, calls[0]
    text = "\n".join(event.all_text)
    assert "端点：session/list（成功）" in text, text
    assert '"count": 2' in text, text
    assert event.call_llm is True and event.stopped is True, (event.call_llm, event.stopped)


@test("业务失败但 HTTP 200 ⇒ 信封（含 error.code）照样摊开，抬头点出是哪一类")
def _() -> None:
    # 契约 §11.1：业务失败也是 200。这条正是 ``raw=True`` 存在的理由——
    # 默认那条路会把信封换成一句「失败」，用户连 code 都拿不到。
    m, _c, t = make_main()
    t.results["rpc"] = {
        "ok": False,
        "error": {"code": "gateway/cancelled", "message": "已取消"},
    }
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert "端点：settings/describe（失败：gateway/cancelled）" in text, text
    assert '"code": "gateway/cancelled"' in text, text
    assert "控制面调用失败" not in text, "业务失败不是传输失败，别套错前缀"
    assert len(t.called("rpc")) == 1, t.calls


@test("403 forbidden ⇒ 指向宿主白名单与 token，而不是含糊的失败")
def _() -> None:
    m, _c, t = make_main()
    t.errors["rpc"] = _bridge_error(403, CONTRACT.ERROR_FORBIDDEN)
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert "控制面调用被拒" in text, text
    assert "allowedRpcMethods" in text, text
    assert "hmac_mode" in text, text


@test("404 not_found ⇒ 先怀疑 bridge_url 指错了地方")
def _() -> None:
    m, _c, t = make_main()
    t.errors["rpc"] = _bridge_error(404, CONTRACT.ERROR_NOT_FOUND)
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert "控制面调用失败" in text, text
    assert "bridge_url" in text, text


@test("其余 BridgeError（500 等）⇒ 走统一失败前缀，不假装成功")
def _() -> None:
    m, _c, t = make_main()
    t.errors["rpc"] = _bridge_error(500, "internal")
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert "控制面调用失败" in text, text
    assert "（成功）" not in text, text


@test("传输层抛非 BridgeError ⇒ 同样只回一句人话，不外泄异常")
def _() -> None:
    m, _c, t = make_main()
    t.errors["rpc"] = RuntimeError("连不上桥接端")
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert "控制面调用失败" in text, text
    assert "连不上桥接端" in text, text


@test("超长返回 ⇒ 信封**完整**落进聊天窗，不再有「只显示前 N 字」这种截断")
def _() -> None:
    # 这条以前钉的是「截前 1200 字 + 一句说明」，配一个 _RPC_VALUE_CLIP_CHARS。
    # 常量删掉之后，判据反过来：**不许**截。理由是这个指令本来就是观景窗——
    # 信封被截过一次，用户拿去报障的那截刚好把 error.details 挡在外面。
    m, _c, t = make_main()
    big = "x" * 2000
    t.results["rpc"] = {"ok": True, "value": {"blob": big}}
    event = drive(m, _admin_event(f"dsh rpc {_FREE_ENDPOINT}"))
    text = "\n".join(event.all_text)
    assert big in text, "完整值必须整段落到聊天窗"
    assert "只显示前" not in text, text
    assert len(text) > len(big), (len(text), len(big))
    assert not hasattr(plugin_main, "_RPC_VALUE_CLIP_CHARS"), "常量删了就别再回来"


summary()
