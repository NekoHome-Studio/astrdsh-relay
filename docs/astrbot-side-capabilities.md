# AstrBot 侧网桥能力核实报告（源码考古 / API 契约，供 AstrDsh Relay 星驿使用）

- **核实对象**：`C:\Users\<user>\Downloads\AstrBot-master`（`astrbot/__init__.py` → `__version__ = "4.26.7"`；`pyproject.toml` → `version = "4.26.7"`）
- **交叉验证目录**：`C:\Users\<user>\Downloads\AstrBot-v4.26.7-dashboard` —— **只含前端构建产物 `dist/`（index.html + assets + t2i），没有任何 Python 源码**，因此**不能**用于交叉验证后端 API。版本差异交叉验证 = **无法进行**（两边都是 4.26.7，且后者无后端源码）。
- **证据规则**：本报告所有结论均给出「文件绝对路径:行号 + 代码片段」。凡未在源码中查到者，一律列入文末「未找到证据 / 不确定」清单。
- **重要**：文中出现的 QQ 号、群号、token、API key 等敏感值**已被刻意省略**，只保留端口、ID 名称、结构等非敏感事实。
- 核查用的一次性脚本 `_probe_db.py` 已在收尾时删除。

---

## 0. 结论摘要

### 0.1 路线 A vs 路线 B：**选路线 A（Star 插件桥）**

| 维度 | 路线 A：Star 插件桥 | 路线 B：反向 Platform 适配器 |
|---|---|---|
| 是否需要新建 Platform 适配器 | **不需要**（源码证实：平台适配器来自 `platform_cls_map`，路线 A 完全不碰它） | 必须继承 `Platform` 并 `@register_platform_adapter` |
| 复用现有平台连接 | 完全复用（本机 3 个 aiocqhttp 反向 WS 实例已在跑） | 需要自己实现连接/收发/重连/会话映射 |
| 发回 IM | `yield event.plain_result(...)` 或 `await event.send(MessageChain([...]))` | 必须自己实现 `send_by_session()`，否则 `Context.send_message()` 静默失败 |
| 主动推送（异步任务完成后） | `await self.context.send_message(umo, chain)`（一行） | 由业务插件承担，仍需 AstrBot 侧发起 |
| 本机现状 | **已有一个可运行的同路线实现**：`data/plugins/astrbot_plugin_dsh_connector`（v2.0.1），历史会话数据证明它真的跑通过 | 本机无任何插件型 Platform 适配器 |
| 工作量 | 小（本任务要求的骨架 ≈ 100 行） | 大（且要处理 NapCat 重连、群/私聊路由、`unique_session` 导致的 session_id 变形等） |

**理由（全部有源码依据）**：
1. 路线 A 的「收」由现有适配器完成：`AiocqhttpAdapter.handle_msg()` → `Platform.commit_event()` → 事件队列（`aiocqhttp_platform_adapter.py:509-510`、`platform.py:147-149`）。
2. 路线 A 的「发」有两条官方通道：`event.send()`（当前事件）与 `Context.send_message(umo, chain)`（任意会话，含异步任务）。后者内部就是对 `Platform.send_by_session()` 的分发（`context.py:534-537`），也就是说**路线 A 白嫖了路线 B 必须自己写的东西**。
3. 反向推送还有一条**零插件**通道：AstrBot 内建 HTTP Open API `POST /api/v1/im/messages`（`dashboard/api/open_api.py:299-311`）。DSH 可直接调用它把消息推进任意会话，连插件都不需要。

### 0.2 路线 A 的「需要做 / 不需要做」清单

| 项 | 结论 | 依据 |
|---|---|---|
| 新建 Platform 子类 | **不需要** | `platform/manager.py:212-218`：只有 `platform_config["type"]` 命中 `platform_cls_map` 的适配器才会被实例化；路线 A 不注册任何 `type` |
| 处理 IM 连接/鉴权/重连 | **不需要**，由 aiocqhttp/telegram 适配器负责 | `aiocqhttp_platform_adapter.py:30-107`、`:427-445` |
| 捕获消息 | **需要**：`@filter.event_message_type(...)` 或 `@filter.command(...)` | `core/star/filter/event_message_type.py:24-33`、`core/star/filter/command.py:191-220` |
| 发回 IM | **需要**：`yield event.plain_result(text)`（推荐，走装饰器）或 `await event.send(MessageChain(...))` | `astr_message_event.py:396-398`、`:475-492`；`pipeline/respond/stage.py:169-224` |
| 主动推送 | **需要一行**：`await self.context.send_message(event.unified_msg_origin, chain)` | `core/star/context.py:507-541` |
| 长度切分 | **需要自己做**（AstrBot 无通用切分工具；aiocqhttp 无长度切分） | 见 §2 |
| 持久化 | **推荐**：`self.put_kv_data / get_kv_data`（继承自 `Star`） | `core/star/base.py:19`、`core/utils/plugin_kv_store.py:9-28` |

### 0.3 路线 B 的「需要做」清单

| 项 | 结论 | 依据 |
|---|---|---|
| 继承 `Platform`（`abc.ABC`） | **需要**，且**必须恰好实现 2 个抽象方法**：`run()`、`meta()`；`send_by_session()` **不是** 抽象方法 | `platform.py:38`、`:121-124`、`:129-132`、`:134-145` |
| 构造函数签名 | **必须**是 `__init__(self, platform_config, platform_settings, event_queue)`（3 个位置参数） | `platform/manager.py:218`（与 `Platform.__init__(self, config, event_queue)` 的 2 参数签名不同！） |
| 注册 | `@register_platform_adapter(adapter_name, desc, ...)` | `platform/register.py:11-63` |
| 事件入队 | `self.commit_event(self.create_event(abm))` | `platform.py:147-165`、`aiocqhttp_platform_adapter.py:509-510` |
| metadata.yaml | 必需字段 `name/desc/version/author`；`astrbot_version` 可选但会被校验 | `star/updator.py:13-14`、`:114-150`；`star/star_manager.py:666-697` |

---

## 1. 逐条问题的证据

### 1.1 路线 A：是否完全不需要新建 Platform 适配器

**已证实：不需要。** 平台适配器的实例化路径只有一条，且只认 `platform_cls_map`：

`C:\Users\<user>\Downloads\AstrBot-master\astrbot\core\platform\manager.py:212-227`
```python
        if platform_config["type"] not in platform_cls_map:
            logger.error(
                f"Platform adapter not found: {platform_config['type']}({platform_config['id']}).",
            )
            return
        cls_type = platform_cls_map[platform_config["type"]]
        inst: Platform = cls_type(platform_config, self.settings, self.event_queue)
        self._inst_map[platform_config["id"]] = {
            "inst": inst,
            "client_id": inst.client_self_id,
        }
        self.platform_insts.append(inst)
        self._start_platform_task(
            f"platform_{platform_config['type']}_{platform_config['id']}",
            inst,
        )
```

`platform_cls_map` 只有两个灌入点：
- 内建分支 `manager.py:134-200`（`match platform_config["type"]` 的硬编码 case，`aiocqhttp` 在 `:135-138`）；
- 插件/内建 Star 通过 `@register_platform_adapter` 装饰器（`platform/register.py:58-59`）。

路线 A 的 Star 插件**不注册** `type`，所以完全不触碰这条链路。现有适配器收到消息后入队：

`astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py:509-510`
```python
    async def handle_msg(self, message: AstrBotMessage) -> None:
        self.commit_event(self.create_event(message))
```

`astrbot/core/platform/platform.py:147-165`
```python
    def commit_event(self, event: AstrMessageEvent) -> None:
        """提交一个事件到事件队列。"""
        self._event_queue.put_nowait(event)

    def create_event(self, message: AstrBotMessage) -> AstrMessageEvent:
        ...
        return AstrMessageEvent(
            message_str=message.message_str,
            message_obj=message,
            platform_meta=self.meta(),
            session_id=message.session_id,
        )
```

---

### 1.2 三个「发送」API 的确切签名与差异

#### (a) `AstrMessageEvent.send()` —— 发到「当前事件所属会话」

`astrbot/core/platform/astr_message_event.py:475-492`
```python
    async def send(self, message: MessageChain) -> None:
        """发送消息到消息平台。

        Args:
            message (MessageChain): 消息链，具体使用方式请参考文档。

        """
        # Leverage BLAKE2 hash function to generate a non-reversible hash of the sender ID for privacy.
        hash_obj = hashlib.blake2b(self.get_sender_id().encode("utf-8"), digest_size=16)
        sid = str(uuid.UUID(bytes=hash_obj.digest()))
        asyncio.create_task(
            Metric.upload(...),
        )
        self._has_send_oper = True
```

**签名是 `send(self, message: MessageChain)`，参数类型是 `MessageChain`，不是 `str`。**
⚠️ **与坊间指南/源码注释不符**：`astrbot/core/star/register/star_handler.py:415-420` 的示例写的是 `await event.send("🤔 正在思考中...")`，传的是 `str`——按真实签名这会一路传到平台适配器并失败。**不要照抄那段注释。**

关键副作用：`self._has_send_oper = True`（第 492 行）。这个标志在 `ProcessStage` 里用于**抑制默认 LLM 回复**：

`astrbot/core/pipeline/process_stage/stage.py:56-66`
```python
        if (
            not event._has_send_oper
            and event.is_at_or_wake_command
            and not event.call_llm
        ):
            # 是否有过发送操作 and 是否是被 @ 或者通过唤醒前缀
```

#### (b) `event.plain_result()` / `chain_result()` —— 构造「结果」，由框架发送

`astrbot/core/platform/astr_message_event.py:396-413`
```python
    def plain_result(self, text: str) -> MessageEventResult:
        """创建一个空的消息事件结果，只包含一条文本消息。"""
        return MessageEventResult().message(text)

    def image_result(self, url_or_path: str) -> MessageEventResult:
        ...
    def chain_result(self, chain: list[BaseMessageComponent]) -> MessageEventResult:
        """创建一个空的消息事件结果，包含指定的消息链。"""
        mer = MessageEventResult()
        mer.chain = chain
        return mer
```

`plain_result()` 返回的是 `MessageEventResult`（`MessageChain` 的子类，见 `message_event_result.py:223-224`），**它自己不会发送**，必须 `yield` 出去：

`astrbot/core/pipeline/context_utils.py:47-61`
```python
    if inspect.isasyncgen(ready_to_call):
        _has_yielded = False
        try:
            async for ret in ready_to_call:
                _has_yielded = True
                if isinstance(ret, MessageEventResult | CommandResult):
                    # 如果返回值是 MessageEventResult, 设置结果并继续
                    event.set_result(ret)
                    yield
```

#### (c) `send()` vs `plain_result()` 的**真实差异：是否经过 ResultDecorateStage**

阶段顺序（`astrbot/core/pipeline/stage_order.py:3-13`）：
```python
STAGES_ORDER = [
    "WakingCheckStage",  # 检查是否需要唤醒
    "WhitelistCheckStage",
    "SessionStatusCheckStage",
    "RateLimitStage",
    "ContentSafetyCheckStage",
    "PreProcessStage",
    "ProcessStage",  # 交由 Stars 处理（a.k.a 插件），或者 LLM 调用
    "ResultDecorateStage",  # 处理结果，比如添加回复前缀、t2i、转换为语音 等
    "RespondStage",  # 发送消息
]
```

- **`yield event.plain_result(text)`**：`ProcessStage` 内 `event.set_result(...)`（`context_utils.py:56`）→ 之后 `ResultDecorateStage` 加工（t2i 转图、`forward_threshold` 转合并转发、@/引用回复、回复前缀）→ `RespondStage` 调 `event.send()` 真正发出。
  证据：`pipeline/respond/stage.py:169-224`
  ```python
        result = event.get_result()
        if result is None:
            return
        ...
        if len(result.chain) > 0:
            ...
            # 发送消息链
            ...
                    await event.send(result.derive([*header_comps, comp]))
  ```
- **`await event.send(chain)`**：**立即发送，完全绕过 `ResultDecorateStage`**（因为装饰阶段是在插件 handler 返回之后才跑的；而 `event.send()` 在 handler 内部就把消息发出去了）。因此：**不会**被 `t2i` 转图、**不会**被 `forward_threshold` 包成合并转发、**不会**自动加 @/引用/回复前缀、**不会**触发 TTS。

#### (d) `Context.send_message()` —— 主动向任意会话发送（不是回复当前事件）

`astrbot/core/star/context.py:507-541`
```python
    async def send_message(
        self,
        session: str | MessageSesion,
        message_chain: MessageChain,
    ) -> bool:
        """根据 session(unified_msg_origin) 主动发送消息。

        Args:
            session: 消息会话。通过 event.session 或者 event.unified_msg_origin 获取。
            message_chain: 消息链。

        Returns:
            是否找到匹配的平台。
        ...
        """
        if isinstance(session, str):
            try:
                session = MessageSesion.from_str(session)
            except BaseException as e:
                raise ValueError("不合法的 session 字符串: " + str(e))

        for platform in self.platform_manager.platform_insts:
            if platform.meta().id == session.platform_name:
                await platform.send_by_session(session, message_chain)
                return True
        logger.warning(
            f"cannot find platform for session {str(session)}, message not sent"
        )
        return False
```

**这是路线 A 做「异步任务完成后主动推送」的官方姿势**（无需保存 `event` 对象）。注意两个坑：
1. 匹配的是 `platform.meta().id`（不是 `name`/类型），即 UMO 的第一段必须是**平台实例 ID**（本机是 `default` / `default-2` / `default-3`）。
2. `star/lib.filters` 的 UMO 解析用 `MessageSession.from_str`，格式固定为 `platform_id:message_type:session_id`（`platform/message_session.py:18-27`）。

封装版本（classmethod，便于在无 `self.context` 的地方调用）：
`astrbot/core/star/star_tools.py:32-52`
```python
    @classmethod
    async def send_message(
        cls,
        session: str | MessageSesion,
        message_chain: MessageChain,
    ) -> bool:
        ...
        return await cls._context.send_message(session, message_chain)
```
（`StarTools._context` 在插件管理器初始化时注入：`star_manager.py:199`）

#### (e) **零插件**的主动推送通道：AstrBot 内建 Open API

`astrbot/dashboard/api/open_api.py:299-320`
```python
@router.post("/im/messages")
async def send_im_message(
    payload: ImMessageRequest,
    _auth: AuthContext = Depends(require_im_scope),
    service: OpenApiService = Depends(get_service),
):
    body = _model_dict(payload)
    try:
        await service.send_message(body)
    except OpenApiServiceError as exc:
        raise ApiError(str(exc)) from exc

    return ok()


@router.post("/im/message", include_in_schema=False)
async def send_im_message_alias(
    payload: ImMessageRequest,
    auth: AuthContext = Depends(require_im_scope),
    service: OpenApiService = Depends(get_service),
):
    return await send_im_message(payload, auth, service)
```

请求体 schema：`astrbot/dashboard/schemas.py:212-216`
```python
class ImMessageRequest(OpenModel):
    umo: str | None = None
    message: Any = None
    type: str | None = None
```

服务实现（与 `Context.send_message` 等价，但走 HTTP）：`astrbot/dashboard/services/open_api_service.py:603-641`
```python
        ...
        session = MessageSesion.from_str(str(umo))
        ...
        platform_id = session.platform_name
        platform_inst = next(
            (inst for inst in self.platform_manager.platform_insts
             if inst.meta().id == platform_id), None)
        if not platform_inst:
            raise OpenApiServiceError(
                f"Bot not found or not running for platform: {platform_id}"
            )
        ...
            message_chain = await self.build_message_chain_from_payload(message_payload)
            await platform_inst.send_by_session(session, message_chain)
```

`message` 字段接受 `str | list`（`open_api_service.py:596-601`）；list 形式是 webchat 的 message-parts（`plain` / `image` / `record` / `reply` 等，见 `core/platform/sources/webchat/message_parts_helper.py:266-335`）。
鉴权：API Key + scope `im`（见 §5.2）。

---

### 1.3 路线 B：`Platform` 基类的全部真实签名

`astrbot/core/platform/platform.py:38-165`（**关键：只有 2 个 `@abc.abstractmethod`**）
```python
class Platform(abc.ABC):
    def __init__(self, config: dict, event_queue: Queue) -> None:
        super().__init__()
        # 平台配置
        self.config = config
        # 维护了消息平台的事件队列，EventBus 会从这里取出事件并处理。
        self._event_queue = event_queue
        self.client_self_id = uuid.uuid4().hex
        ...
    @abc.abstractmethod
    def run(self) -> Coroutine[Any, Any, None]:
        """得到一个平台的运行实例，需要返回一个协程对象。"""
        raise NotImplementedError

    async def terminate(self) -> None:
        """终止一个平台的运行实例。"""

    @abc.abstractmethod
    def meta(self) -> PlatformMetadata:
        """得到一个平台的元数据。"""
        raise NotImplementedError

    async def send_by_session(
        self,
        session: MessageSesion,
        message_chain: MessageChain,
    ) -> None:
        """通过会话发送消息。该方法旨在让插件能够直接通过**可持久化的会话数据**发送消息，而不需要保存 event 对象。

        异步方法。
        """
        asyncio.create_task(
            Metric.upload(msg_event_tick=1, adapter_name=self.meta().name)
        )

    def commit_event(self, event: AstrMessageEvent) -> None:
        """提交一个事件到事件队列。"""
        self._event_queue.put_nowait(event)

    def create_event(self, message: AstrBotMessage) -> AstrMessageEvent:
        return AstrMessageEvent(
            message_str=message.message_str,
            message_obj=message,
            platform_meta=self.meta(),
            session_id=message.session_id,
        )

    def get_client(self) -> object:
        """获取平台的客户端对象。"""
```

**核实结论（逐条对齐提问）**：
- 提问中的「`run()` / `meta()` / `send_by_session()` 三个名字」：**名字对，但 `send_by_session()` 不是抽象方法**，它有一个「只上报指标、不发送」的默认实现。子类不实现它不会报错，但 `Context.send_message()`/Open API 会**静默地什么也不发**（只写一条 warning）。这是一个非常容易踩的坑。
- `run()` 不是 `async def`，是**普通方法返回协程对象**（`def run(self) -> Coroutine`）。管理器用 `asyncio.create_task(inst.run(), ...)` 启动：`manager.py:51-52`。
- 构造函数：`Platform.__init__(self, config, event_queue)` 只有 2 个参数，但管理器实际调用是 **3 个位置参数** `cls_type(platform_config, self.settings, self.event_queue)`（`manager.py:218`）。所以**插件型适配器必须自己定义 3 参数 `__init__`**，参考 `AiocqhttpAdapter.__init__`：

`astrbot/core/platform/sources/aiocqhttp/aiocqhttp_platform_adapter.py:36-46`
```python
    def __init__(
        self,
        platform_config: dict,
        platform_settings: dict,
        event_queue: asyncio.Queue,
    ) -> None:
        super().__init__(platform_config, event_queue)
        self.settings = platform_settings
```

#### `PlatformMetadata` 字段（全部）

`astrbot/core/platform/platform_metadata.py:4-37`
```python
@dataclass
class PlatformMetadata:
    name: str
    """平台的名称，即平台的类型，如 aiocqhttp, discord, slack"""
    description: str
    """平台的描述"""
    id: str
    """平台的唯一标识符，用于配置中识别特定平台"""

    default_config_tmpl: dict | None = None
    adapter_display_name: str | None = None
    logo_path: str | None = None

    support_streaming_message: bool = True
    """平台是否支持真实流式传输"""
    support_proactive_message: bool = True
    """平台是否支持主动消息推送（非用户触发）"""

    module_path: str | None = None
    i18n_resources: dict[str, dict] | None = None
    config_metadata: dict | None = None
```

#### 事件入队的确切调用方式

`aiocqhttp_platform_adapter.py:509-510`（唯一需要写的两行）
```python
    async def handle_msg(self, message: AstrBotMessage) -> None:
        self.commit_event(self.create_event(message))
```
`create_event` 通常需要子类重写以塞入自己的 client/event 对象，例如：
`aiocqhttp_platform_adapter.py:492-507`
```python
    def create_event(self, message: AstrBotMessage) -> AiocqhttpMessageEvent:
        return AiocqhttpMessageEvent(
            message_str=message.message_str,
            message_obj=message,
            platform_meta=self.meta(),
            session_id=message.session_id,
            bot=self.bot,
        )
```

#### 注册装饰器

`astrbot/core/platform/register.py:11-61`
```python
def register_platform_adapter(
    adapter_name: str,
    desc: str,
    default_config_tmpl: dict | None = None,
    adapter_display_name: str | None = None,
    logo_path: str | None = None,
    support_streaming_message: bool = True,
    i18n_resources: dict[str, dict] | None = None,
    config_metadata: dict | None = None,
):
    def decorator(cls):
        if adapter_name in platform_cls_map:
            raise ValueError(
                f"平台适配器 {adapter_name} 已经注册过了，可能发生了适配器命名冲突。",
            )
        # 添加必备选项
        if default_config_tmpl:
            if "type" not in default_config_tmpl:
                default_config_tmpl["type"] = adapter_name
            if "enable" not in default_config_tmpl:
                default_config_tmpl["enable"] = False
            if "id" not in default_config_tmpl:
                default_config_tmpl["id"] = adapter_name
        ...
        pm = PlatformMetadata(
            name=adapter_name, description=desc, id=adapter_name, ...
        )
        platform_registry.append(pm)
        platform_cls_map[adapter_name] = cls
```
导出的导入路径：`from astrbot.api.platform import Platform, PlatformMetadata, register_platform_adapter`（`astrbot/api/platform/__init__.py:1-22`）。
热重载清理：`unregister_platform_adapters_by_module(module_path_prefix)`（`register.py:66-91`）。

#### `metadata.yaml` 要求

`astrbot/core/star/updator.py:13-14`
```python
PLUGIN_METADATA_FILENAMES = ("metadata.yaml", "metadata.yml")
PLUGIN_METADATA_REQUIRED_FIELDS = ("name", "desc", "version", "author")
```
校验实现（`updator.py:124-150`）要求这 4 个字段存在且为**非空字符串**；`description` 可作为 `desc` 的别名（`:128-129`）。

`astrbot_version` 是**可选**字段，但一旦填写就会被严格校验，不满足则插件直接加载失败：
`astrbot/core/star/star_manager.py:666-697`
```python
    @staticmethod
    def _validate_astrbot_version_specifier(
        version_spec: str | None,
    ) -> tuple[bool, str | None]:
        if not version_spec:
            return True, None
        ...
        try:
            specifier = SpecifierSet(normalized_spec)
        except InvalidSpecifier:
            return (False, "Invalid astrbot_version. Use a PEP 440 range, e.g. >=4.16,<5.")
        ...
        if not specifier.contains(current_version, prereleases=True):
            return (False, f"AstrBot {VERSION} does not satisfy plugin astrbot_version: {normalized_spec}")
        return True, None
```
调用点：`star_manager.py:1195-1205`（抛出 `PluginVersionUnsupportedError`）。

`plugin_id` 是**派生属性**（不是 yaml 字段）：
`astrbot/core/star/star.py:78-82`
```python
    @property
    def plugin_id(self) -> str:
        p_name = (self.name or "unknown").lower().replace("/", "_")
        p_author = (self.author or "unknown").lower().replace("/", "_")
        return f"{p_author}/{p_name}"
```
并被注入到插件类上：`star_manager.py:1209`、`:1216`、`:1238`。

真实可运行的 metadata.yaml 参考：`data/plugins/astrbot_plugin_dsh_connector/metadata.yaml:1-19`

---

## 2. 消息长度与格式限制

### 2.1 各平台适配器的发送侧切分逻辑（**逐平台核实**）

| 平台 | 有切分？ | 位置 | 行为 |
|---|---|---|---|
| **telegram** | ✅ 有 | `sources/telegram/tg_event.py:38-47`、`:83-106`、`:108-130` | `MAX_MESSAGE_LENGTH = 4096`，按 段落→行→句→词 优先级找切点；再 `telegramify_markdown.markdownify()` + `parse_mode="MarkdownV2"`，失败则降级纯文本 |
| **discord** | ⚠️ 只截断不切分 | `sources/discord/discord_platform_event.py:269-271` | `if len(content) > 2000: content = content[:2000]`（**丢弃多余内容**） |
| **weixin_official_account** | ✅ 有 | `sources/weixin_official_account/weixin_offacc_event.py:37-57` | `async def split_plain(self, plain: str, max_length: int = 1024) -> list[str]` |
| **wecom** | ✅ 有 | `sources/wecom/wecom_event.py:36` | `async def split_plain(self, plain: str)` |
| **wecom_ai_bot** | ✅ 有（按字节） | `sources/wecom_ai_bot/wecomai_webhook.py:46-63` | `_split_markdown_v2_content(content, max_bytes=4096)`，按 UTF-8 字节数切 |
| **qq_official** | ✅ 有（按媒体切） | `sources/qqofficial/qqofficial_message_event.py:200-230` | `_split_message_chain_by_media(message)` —— 按「媒体段不能和文本混发」切链，**不是按文本长度** |
| **line** | ⚠️ 只截断 | `sources/line/line_event.py:45`、`:51` | `text[:5000]` |
| **aiocqhttp（QQ/OneBot v11，本机在用）** | ❌ **完全没有长度切分** | `sources/aiocqhttp/aiocqhttp_message_event.py:125-181` | 只判断「Node/Nodes/File 必须单独发」，文本直接交给 OneBot |

aiocqhttp 发送主逻辑（无长度判断）：
`astrbot/core/platform/sources/aiocqhttp/aiocqhttp_message_event.py:125-153`
```python
    @classmethod
    async def send_message(
        cls,
        bot: CQHttp,
        message_chain: MessageChain,
        event: Event | None = None,
        is_group: bool = False,
        session_id: str | None = None,
    ) -> None:
        ...
        # 转发消息、文件消息不能和普通消息混在一起发送
        send_one_by_one = any(
            isinstance(seg, Node | Nodes | File) for seg in message_chain.chain
        )
        if not send_one_by_one:
            ret = await cls._parse_onebot_json(message_chain)
            if not ret:
                return
            await cls._dispatch_send(bot, event, is_group, session_id, ret)
            return
```

### 2.2 AstrBot 内部有没有现成的通用切分工具函数？

**已证实：没有通用工具。**
- `astrbot/core/utils/string_utils.py` 全文只有 `normalize_and_dedupe_strings`（`:7-21`），无切分。
- 在 `astrbot/core/utils/` 下全量搜索 `textwrap|def .*chunk|def .*segment|def truncate`，只命中 `quoted_message/chain_parser.py:264 _parse_onebot_segments`（与文本切分无关）。
- 各平台的切分函数都是**平台事件类的实例/类方法**，不是可复用的公共函数：
  - `TelegramPlatformEvent._split_message(text) -> list[str]`（`tg_event.py:83`，`@classmethod`，硬绑 4096）
  - `WeixinOfficialAccountEvent.split_plain(plain, max_length=1024)`（`weixin_offacc_event.py:37`）
  - `WeComPlatformEvent.split_plain(plain)`（`wecom_event.py:36`）
  - `WecomAIBotWebhook._split_markdown_v2_content(content, max_bytes=4096)`（`wecomai_webhook.py:46`）
  - `QQOfficialMessageEvent._split_message_chain_by_media(message)`（`qqofficial_message_event.py:200`）
- 结论：**桥接插件必须自己实现切分**。本机已有的 `astrbot_plugin_dsh_connector` 就是这么做的：
  `data/plugins/astrbot_plugin_dsh_connector/main.py:94-98`
  ```python
  def _chunk_text(text: str, size: int) -> list:
      """把长文本切成若干片，便于发送（size<=0 表示不切分）。"""
      if not size or size <= 0 or len(text) <= size:
          return [text]
      return [text[i : i + size] for i in range(0, len(text), size)]
  ```
  默认 `reply_chunk_size = 2000`、`max_reply_chars = 4000`（`data/config/astrbot_plugin_dsh_connector_config.json:9-10`）。

### 2.3 一个隐藏的「长度行为」：aiocqhttp 的 forward_threshold

如果走 `yield`（即经过 `ResultDecorateStage`），QQ 有额外的自动合并转发：

`astrbot/core/pipeline/result_decorate/stage.py:408-420`
```python
            # 触发转发消息
            if event.get_platform_name() == "aiocqhttp":
                word_cnt = 0
                for comp in result.chain:
                    if isinstance(comp, Plain):
                        word_cnt += len(comp.text)
                if word_cnt > self.forward_threshold:
                    node = Node(
                        uin=event.get_self_id(),
                        name="AstrBot",
                        content=[*result.chain],
                    )
                    result.chain = [node]
```
`forward_threshold` 来自 `platform_settings.forward_threshold`（`result_decorate/stage.py:42-44`），本机配置值为 **1500**。**注意**：`await event.send(...)` 绕过这个阶段，所以直接 `send` 长文本既不会被合并转发、也不会被切分——QQ 侧可能被 NapCat/服务端截断或报错。桥接插件应显式切分。

### 2.4 消息链组件如何构造与发送

`astrbot/core/message/components.py`（权威定义）：

| 组件 | 定义行 | 构造方式 |
|---|---|---|
| `Plain` | `:111-122` | `Plain(text="...")` |
| `At` | `:408-420` | `At(qq=123456, name="张三")`；`AtAll()`（`:423-427`） |
| `Image` | `:499-531` | `Image(file=...)`；`Image.fromURL(url)`、`Image.fromFileSystem(path)`、`Image.fromBase64(b64)`、`Image.fromBytes(b)`、`Image.fromIO(io)` |
| `Record`（语音） | `:133-162` | `Record(file=...)`、`.fromFileSystem/.fromURL/.fromBase64` |
| `Reply` | `:582-609` | `Reply(id=..., chain=[...], sender_id=..., message_str=...)` |
| `File` | `:761-...` | `File(name=..., file=..., url=...)` |

`MessageChain` 的便捷构造（`astrbot/core/message/message_event_result.py:17-192`）：
```python
    chain: list[BaseMessageComponent] = field(default_factory=list)
    use_t2i_: bool | None = None  # None 为跟随用户设置
    use_markdown_: bool | None = (
        None  # 是否使用 Markdown 发送消息。None 跟随平台默认，True 强制 Markdown，False 强制纯文本。
    )
    ...
    def message(self, message: str):        # :49  → 追加 Plain
    def at(self, name: str, qq: str | int): # :60  → 追加 At
    def url_image(self, url: str):          # :93
    def file_image(self, path: str):        # :106
    def use_t2i(self, use_t2i: bool):       # :127
    def use_markdown(self, use: bool | None = True):  # :137
    def get_plain_text(self, with_other_comps_mark: bool = False) -> str:  # :149
    def squash_plain(self):                 # :170  → 合并所有 Plain
```
组件类型枚举：`components.py:44-68`（`ComponentType.Plain/Image/Record/Video/File/Face/At/Node/Nodes/Poke/Reply/Forward/...`）。

发送方式二选一：
```python
yield event.chain_result([Plain("hi "), At(qq=event.get_sender_id()), Image.fromURL(url)])
# 或
await event.send(MessageChain([Plain("hi"), Image.fromFileSystem("C:/x.png")]))
```

### 2.5 Markdown 在 AstrBot → IM 这一侧会被怎么处理

**已证实的三种命运，取决于目标平台：**

1. **aiocqhttp（QQ，本机）**：**没有 Markdown 处理**。`_send_text_chunks` / `markdownify` 之类只存在于 telegram；aiocqhttp 事件类里搜不到任何 markdown 相关逻辑（`grep -n "markdown" aiocqhttp_message_event.py` 无命中）。Markdown 会**原样**作为纯文本发出，星号/井号会显示出来。
2. **telegram**：`telegramify_markdown.markdownify(chunk)` + `parse_mode="MarkdownV2"`，发送失败（`ValueError | BadRequest`）则**降级为纯文本**。
   `tg_event.py:116-130`
   ```python
            for chunk in cls._split_message(text):
                try:
                    markdown_text = telegramify_markdown.markdownify(
                        chunk,
                    )
                    await client.send_message(
                        text=markdown_text,
                        parse_mode="MarkdownV2",
                        **cast(Any, payload),
                    )
                except (ValueError, BadRequest) as e:
                    logger.warning(
                        f"Failed to convert message to Markdown，using normal text: {e!s}"
                    )
                    await client.send_message(text=chunk, **cast(Any, payload))
   ```
3. **qq_official 等声明支持 Markdown 的平台**：由 `MessageChain.use_markdown_` 控制，只有这些平台会读它。
   `sources/qqofficial/qqofficial_message_event.py:307-308`
   ```python
        # 根据消息链的 use_markdown_ 标记决定发送模式
        use_md = getattr(self.send_buffer, "use_markdown_", None)
   ```
   `MessageChain.use_markdown()` 的文档也明确说明「仅对支持 Markdown 的平台生效（如 QQ Official），不支持的平台会忽略此字段」（`message_event_result.py:137-147`）。

**另一条 Markdown→图片的路径（对桥接非常有用）**：t2i 文本转图片，由 `ResultDecorateStage` 自动触发。
`astrbot/core/pipeline/result_decorate/stage.py:364-406`
```python
            # 文本转图片
            elif (
                result.use_t2i_ is None and self.ctx.astrbot_config["t2i"]
            ) or result.use_t2i_:
                parts = []
                for comp in result.chain:
                    if isinstance(comp, Plain):
                        parts.append("\n\n" + comp.text)
                    else:
                        break
                plain_str = "".join(parts)
                if plain_str and len(plain_str) > self.t2i_word_threshold:
                    ...
                        url = await html_renderer.render_t2i(...)
```
阈值：`t2i_word_threshold`（本机配置 = 150，且被 clamp 到最小 50，见 `result_decorate/stage.py:32-37`）。本机 `t2i = false`，所以默认**不会**自动转图。
也可以手动转：`Star.text_to_image(text, return_url=True)`（`core/star/base.py:77-90`）或 `Star.html_render(...)`（`:92-105`）——`astrbot_plugin_dsh_connector` 就是这么把长 Markdown 渲染成图片卡的（`main.py:404-422`）。

---

## 3. 接收侧细节

### 3.1 `AstrMessageEvent` 可用的关键方法/属性（全部来自 `astrbot/core/platform/astr_message_event.py`）

| 名称 | 行号 | 类型 | 说明 |
|---|---|---|---|
| `message_str` | `:43` | 属性 | **纯文本**消息（已 strip；若命中 wake_prefix 则前缀被去掉） |
| `message_obj` | `:45` | 属性 | `AstrBotMessage`，完整结构 |
| `platform_meta` | `:47` | 属性 | `PlatformMetadata` |
| `role` | `:49` | 属性 | `"member"` / `"admin"` |
| `is_wake` | `:51` | 属性 | 是否唤醒 |
| `is_at_or_wake_command` | `:53` | 属性 | 是否 At 机器人 / 带唤醒前缀 / 私聊 |
| `session` | `:68` | 属性 | `MessageSession` 对象 |
| `unified_msg_origin` | `:104-106` | property | `platform_id:message_type:session_id` |
| `session_id` | `:115-122` | property | 会话 ID（群号或用户号；`unique_session` 时可能变形） |
| `created_at` | `:78` | 属性 | Unix 时间戳 |
| `get_platform_name()` | `:124-129` | 方法 | 平台**类型**（`aiocqhttp`） |
| `get_platform_id()` | `:131-136` | 方法 | 平台**实例 ID**（`default`） |
| `get_message_str()` | `:138-140` | 方法 | 同 `message_str` |
| `get_message_outline()` | `:172-177` | 方法 | 带 `[图片]`/`[At:...]` 占位的概要 |
| `get_messages()` | `:179-181` | 方法 | `list[BaseMessageComponent]` |
| `get_message_type()` | `:183-188` | 方法 | `MessageType` 枚举 |
| `get_session_id()` | `:190-192` | 方法 | 同 `session_id` |
| `get_group_id()` | `:194-196` | 方法 | 群号；私聊返回 `""` |
| `get_self_id()` | `:198-200` | 方法 | 机器人自身 ID |
| `get_sender_id()` | `:202-207` | 方法 | 发送者 ID（**str**） |
| `get_sender_name()` | `:209-219` | 方法 | 发送者昵称（可能 `""`） |
| `is_private_chat()` | `:254-256` | 方法 | `get_message_type() == FRIEND_MESSAGE` |
| `is_wake_up()` | `:258-260` | 方法 | 返回 `is_wake` |
| `is_admin()` | `:262-264` | 方法 | `role == "admin"` |
| `set_extra/get_extra/clear_extra` | `:221-234` | 方法 | 事件级 KV（插件间通信） |
| `set_result/get_result/clear_result` | `:311-377` | 方法 | 结果存取 |
| `stop_event()` / `continue_event()` / `is_stopped()` | `:340-362` | 方法 | 见 §3.2 |
| `should_call_llm(bool)` | `:364-369` | 方法 | 见 §3.2 末尾警告 |
| `send(MessageChain)` | `:475-492` | async | 立即发送 |
| `send_streaming(generator, use_fallback=False)` | `:279-291` | async | 流式（aiocqhttp 支持 fallback，见 `aiocqhttp_message_event.py:199-234`） |
| `react(emoji)` | `:494-501` | async | 默认发一条表情消息 |
| `get_group(group_id=None, **kwargs)` | `:503+` | async | 仅 aiocqhttp 实现（`aiocqhttp_message_event.py:236-283`） |
| `process_buffer(buffer, pattern)` | `:266-277` | async | 按标点切段限速发送（流式 fallback 用） |
| `make_result/plain_result/image_result/chain_result` | `:381-413` | 方法 | 构造结果 |

**⚠️ `raw_message` 不在 `AstrMessageEvent` 上。** 它在 `AstrBotMessage` 上：
`astrbot/core/platform/astrbot_message.py:50-66`
```python
class AstrBotMessage:
    """AstrBot 的消息对象"""

    type: MessageType  # 消息类型
    self_id: str  # 机器人的识别id
    session_id: str  # 会话id。取决于 unique_session 的设置。
    message_id: str  # 消息id
    group: Group | None  # 群组
    sender: MessageMember  # 发送者
    message: list[BaseMessageComponent]  # 消息链使用 Nakuru 的消息链格式
    message_str: str  # 最直观的纯文本消息字符串
    raw_message: object
    timestamp: int  # 消息时间戳
```
真实代码里的取法是 `event.message_obj.raw_message`（例如 aiocqhttp 适配器 `aiocqhttp_message_event.py:185`：`event = getattr(self.message_obj, "raw_message", None)`）。**如果坊间指南写 `event.raw_message`，那是错的。**
（注：`BaseMessageComponent.__repr_args__` 会截断 base64，`components.py:77-94`。）

`group_id` 也不是普通属性，而是 `AstrBotMessage.group_id` 这个 **property**（读写 `self.group.group_id`），私聊返回 `""`：`astrbot_message.py:71-89`。

### 3.2 `stop_event()` / `is_stopped()` / `priority` 的真实行为

`astrbot/core/platform/astr_message_event.py:55-57`（关键注释）
```python
        self._force_stopped: bool = False
        """独立的停止标志，不依赖 _result，不会被 clear_result() 重置"""
```

`astr_message_event.py:340-362`
```python
    def stop_event(self) -> None:
        """终止事件传播。"""
        self._force_stopped = True
        if self._result is None:
            self.set_result(MessageEventResult().stop_event())
        else:
            self._result.stop_event()

    def continue_event(self) -> None:
        """继续事件传播。"""
        self._force_stopped = False
        if self._result is None:
            self.set_result(MessageEventResult().continue_event())
        else:
            self._result.continue_event()

    def is_stopped(self) -> bool:
        """是否终止事件传播。"""
        if self._force_stopped:
            return True
        if self._result is None:
            return False  # 默认是继续传播
        return self._result.is_stopped()
```

`_force_stopped` 的实现注释明说「**不会被 `clear_result()` 重置**」（`:57`）。而 `StarRequestSubStage` 在每处理完一个 handler 后会 `event.clear_result()`：
`astrbot/core/pipeline/process_stage/method/star_request.py:36-53`
```python
        for handler in activated_handlers:
            if event.is_stopped():
                break
            ...
                wrapper = call_handler(event, handler.handler, **params)
                async for ret in wrapper:
                    yield ret
                if event.is_stopped():
                    break
                event.clear_result()  # 清除上一个 handler 的结果
```

**对写插件的实际影响（重要）**：`stop_event()` 一旦调用，**本事件后续所有环节都停**（包括 `ResultDecorateStage` 和 `RespondStage`）。阶段调度器的判定在这里：
`astrbot/core/pipeline/scheduler.py:50-78`
```python
            if isinstance(coroutine, AsyncGenerator):
                # 如果返回的是异步生成器, 实现洋葱模型的核心
                async for _ in coroutine:
                    # 此处是前置处理完成后的暂停点(yield), 下面开始执行后续阶段
                    if event.is_stopped():
                        logger.debug(...)
                        break

                    # 递归调用, 处理所有后续阶段
                    await self._process_stages(event, i + 1)

                    # 此处是后续所有阶段处理完毕后返回的点, 执行后置处理
                    if event.is_stopped():
                        ...
                        break
```
所以**正确顺序是「先 `yield` 结果，再 `stop_event()`」**：`yield` 时生成器挂起，调度器先跑完后置阶段（真正发出消息），生成器恢复后才执行 `stop_event()`，此时只影响后续 handler。本机真实插件就是这么写的：
`data/plugins/astrbot_plugin_listen_music/main.py:560-561`
```python
        yield event.plain_result(format_search_results(snapshot))
        event.stop_event()
```
**反例警告**：若写成 `event.stop_event()` 然后 `yield event.plain_result(...)`，则 `scheduler.py:54-58` 会直接 `break`，`RespondStage` 永不执行，**消息发不出去**。

#### `priority`

注册侧：`**kwargs` 全部塞进 `extras_configs`：
`astrbot/core/star/register/star_handler.py:62-68`
```python
    # 插件handler的附加额外信息
    if handler.__doc__:
        md.desc = handler.__doc__.strip()
    if "desc" in kwargs:
        md.desc = kwargs["desc"]
        del kwargs["desc"]
    md.extras_configs = kwargs
```
排序：**数值越大越先执行**（按 `-priority` 排序，默认 0）：
`astrbot/core/star/star_handler.py:19-26`
```python
    def append(self, handler: StarHandlerMetadata) -> None:
        """添加一个 Handler，并保持按优先级有序"""
        if "priority" not in handler.extras_configs:
            handler.extras_configs["priority"] = 0

        self.star_handlers_map[handler.handler_full_name] = handler
        self._handlers.append(handler)
        self._handlers.sort(key=lambda h: -h.extras_configs["priority"])
```
真实用法示例：`@filter.event_message_type(filter.EventMessageType.ALL, priority=maxsize)`（`astrbot/builtin_stars/astrbot/main.py:42`、`:51`）。

### 3.3 多个过滤器是 AND 逻辑（源码依据）

`astrbot/core/pipeline/waking_check/stage.py:174-198`
```python
            # filter 需满足 AND 逻辑关系
            passed = True
            permission_not_pass = False
            permission_filter_raise_error = False
            if len(handler.event_filters) == 0:
                continue

            for filter in handler.event_filters:
                try:
                    if isinstance(filter, PermissionTypeFilter):
                        if not filter.filter(event, self.ctx.astrbot_config):
                            permission_not_pass = True
                            permission_filter_raise_error = filter.raise_error
                    elif not filter.filter(event, self.ctx.astrbot_config):
                        passed = False
                        break
                except Exception as e:
                    await event.send(
                        MessageEventResult().message(
                            f"插件 {star_map[handler.handler_module_path].name}: {e}",
                        ),
                    )
                    event.stop_event()
                    passed = False
                    break
```
注意最后那个 `except` 分支：**过滤器抛异常时框架会往会话里发一条报错消息**（第 191-195 行），且用的是 `ResultDecorateStage` 之前的 `event.send()`。

### 3.4 唤醒判定：**这是路线 A 设计的关键，和坊间常见说法可能不同**

`astrbot/core/pipeline/waking_check/stage.py:102-148`（wake_prefix / At / 私聊）
```python
        wake_prefixes = self.ctx.astrbot_config["wake_prefix"]
        ...
        for wake_prefix in wake_prefixes:
            if event.message_str.startswith(wake_prefix):
                ...
                is_wake = True
                event.is_at_or_wake_command = True
                event.is_wake = True
                event.message_str = event.message_str[len(wake_prefix) :].strip()
                break
```
`waking_check/stage.py:199-242`（**filter 通过也会把 `is_wake` 置 True**）
```python
            if passed:
                ...
                is_wake = True
                event.is_wake = True
                ...
        event.set_extra("activated_handlers", activated_handlers)
        event.set_extra("handlers_parsed_params", handlers_parsed_params)

        if not is_wake:
            event.stop_event()
```

**结论**：一个带 `@filter.event_message_type(filter.EventMessageType.ALL)` 的 handler，其过滤器对**任意**该类型消息都通过 → `is_wake = True` → 事件不会被 `stop_event()`，handler 照常执行。**即：群聊里不需要 @ 机器人、也不需要 `/` 前缀，用 `event_message_type(ALL)` 就能"监听所有群消息"。**
（这与 `CommandFilter` 相反：命令过滤器强制要求 `event.is_at_or_wake_command`，见 `filter/command.py:191-193`。）
本机内建插件正是靠这个机制工作的：`astrbot/builtin_stars/astrbot/main.py:42-49`。

⚠️ 但 `is_at_or_wake_command` **不会**因此为 True。这反而是好事：默认 LLM 回复的触发条件是
`astrbot/core/pipeline/process_stage/stage.py:56-66`
```python
        if (
            not event._has_send_oper
            and event.is_at_or_wake_command
            and not event.call_llm
        ):
```
所以纯监听型插件不会意外触发 AstrBot 的 LLM 回复。**但如果用户写 `/ds xxx`（命中 wake_prefix `/`），`is_at_or_wake_command` 就是 True**，此时若你既 `yield` 了结果又没阻止默认 LLM，就会**同时**收到桥接回复和 LLM 回复。必须显式阻止：

`astr_message_event.py:364-369`
```python
    def should_call_llm(self, call_llm: bool) -> None:
        """是否在此消息事件中禁止默认的 LLM 请求。

        只会阻止 AstrBot 默认的 LLM 请求链路，不会阻止插件中的 LLM 请求。
        """
        self.call_llm = call_llm
```
⚠️ **语义陷阱（已证实）**：虽然文档写的是"是否禁止"，但因为 `ProcessStage` 的判定是 `not event.call_llm`，所以**传入 `True` 才是禁止默认 LLM**。真实用法印证：`data/plugins/astrbot_plugin_listen_music/main.py:531` → `event.should_call_llm(True)`。文档注释与参数语义是反的——**照抄"应该传 False 禁止"会踩坑**。

### 3.5 其他会拦住消息的阶段（桥接必须知道）

- `WhitelistCheckStage`：白名单为空时**不检查**（`whitelist_check/stage.py:39-41`）。本机 `id_whitelist` 为空、`enable_id_white_list=true`，所以不拦。
- `RateLimitStage`：固定窗口限流，超限时 `stall` 或 `discard`（`rate_limit_check/stage.py:15-41`）。本机配置 `time=60, count=30, strategy=stall` —— 高频桥接流量会被**挂起**（stall 会在窗口结束后自动恢复）。
- `ContentSafetyCheckStage`、`SessionStatusCheckStage` 也在此链路上（`stage_order.py:3-13`）。

---

## 4. 持久化与配置

### 4.1 `data` 目录常量与路径 API

`astrbot/core/utils/astrbot_path.py:22-100`（**全部真实存在的函数**）
```python
def get_astrbot_path() -> str:            # 源码树根
def get_astrbot_root() -> str:            # ASTRBOT_ROOT 环境变量，否则 cwd
def get_astrbot_data_path() -> str:       # <root>/data
def get_astrbot_config_path() -> str:     # <root>/data/config
def get_astrbot_plugin_path() -> str:     # <root>/data/plugins
def get_astrbot_plugin_data_path() -> str:# <root>/data/plugin_data
def get_astrbot_t2i_templates_path() -> str
def get_astrbot_webchat_path() -> str
def get_astrbot_temp_path() -> str
def get_astrbot_skills_path() -> str
def get_astrbot_workspaces_path() -> str
def get_astrbot_system_tmp_path() -> str  # 系统临时目录/.astrbot
def get_astrbot_site_packages_path() -> str
def get_astrbot_knowledge_base_path() -> str
def get_astrbot_backups_path() -> str
```
`get_astrbot_root()` 的关键实现（`:29-35`）：
```python
def get_astrbot_root() -> str:
    """Return the AstrBot root directory."""
    if path := os.environ.get("ASTRBOT_ROOT"):
        return os.path.realpath(path)
    if is_packaged_desktop_runtime():
        return os.path.realpath(os.path.join(os.path.expanduser("~"), ".astrbot"))
    return os.path.realpath(os.getcwd())
```
→ **AstrBot 的 `data/` 是相对「启动时的工作目录」或 `ASTRBOT_ROOT` 解析的，不是相对源码树。** 本机以 `C:\Users\<user>\Downloads\AstrBot-master` 为 cwd 启动，所以用到了该目录下的 `data/`。

给插件用的「我的数据目录」封装：
`astrbot/core/star/star_tools.py:205-260`
```python
    @classmethod
    def get_data_dir(cls, plugin_name: str | None = None) -> Path:
        ...
        data_dir = Path(
            os.path.join(get_astrbot_data_path(), "plugin_data", plugin_name),
        )
```
即 `data/plugin_data/<plugin_name>/`（本机该目录**已存在**，见 §6）。

### 4.2 推荐的 KV 持久化 API

`Star` 继承了两条 mixin：
`astrbot/core/star/base.py:19`
```python
class Star(CommandParserMixin, PluginKVStoreMixin):
```

`astrbot/core/utils/plugin_kv_store.py:9-28`（**完整**）
```python
class PluginKVStoreMixin:
    """为插件提供键值存储功能的 Mixin 类"""

    plugin_id: str

    async def put_kv_data(
        self,
        key: str,
        value: SUPPORTED_VALUE_TYPES,
    ) -> None:
        """为指定插件存储一个键值对"""
        await sp.put_async("plugin", self.plugin_id, key, value)

    async def get_kv_data(self, key: str, default: _VT) -> _VT | None:
        """获取指定插件存储的键值对"""
        return await sp.get_async("plugin", self.plugin_id, key, default)

    async def delete_kv_data(self, key: str) -> None:
        """删除指定插件存储的键值对"""
        await sp.remove_async("plugin", self.plugin_id, key)
```
`SUPPORTED_VALUE_TYPES = int | float | str | bytes | bool | dict | list | None`（`:5`）。
`self.plugin_id` 由框架注入（格式 `author/name` 小写）：`star/star.py:78-82`，注入点 `star_manager.py:1216`、`:1238`。
所以 **插件里直接 `await self.put_kv_data("k", v)` 即可**，不需要自己拼路径。

底层 `sp`（SharedPreferences）：
`astrbot/core/utils/shared_preferences.py:42-163`（摘）
```python
    async def get_async(self, scope, scope_id, key, default=None):
        if scope_id is not None and key is not None:
            result = await self.db_helper.get_preference(scope, scope_id, key)
            if result:
                ret = result.value["val"]
            else:
                ret = default
            return ret
    ...
    async def session_get(self, umo, key=None, default=None): ...   # scope="umo"
    async def global_get(self, key=None, default=None): ...         # scope="global"
    async def put_async(self, scope, scope_id, key, value):
        await self.db_helper.insert_preference_or_update(scope, scope_id, key, {"val": value})
    async def session_put(self, umo: str, key: str, value): ...
    async def global_put(self, key: str, value): ...
    async def session_remove(self, umo, key): ...
    async def global_remove(self, key): ...
    async def clear_async(self, scope, scope_id): ...
```
**⚠️ 与"文件存储"的坊间说法不符**：4.26.7 里 `sp` **是数据库后端**（`data_v4.db` 的 `preferences` 表），`shared_preferences.json` 只是遗留的可选 `json_storage_path` 参数（`:18-24`），本机**根本没有这个文件**。已实测确认（见 §6.4）。
插件可直接用 `from astrbot.api import sp`（`astrbot/api/__init__.py:4`、`:82`），例如 `await sp.session_put(event.unified_msg_origin, "k", v)` 做**按会话**持久化。

### 4.3 `_conf_schema.json` → `AstrBotConfig` 的确切路径与热更新

**A. schema 文件位置与配置文件名**
`astrbot/core/star/star_manager.py:202-212`
```python
        self.plugin_store_path = get_astrbot_plugin_path()
        """存储插件的路径。即 data/plugins"""
        self.plugin_config_path = get_astrbot_config_path()
        """存储插件配置的路径。data/config"""
        self.reserved_plugin_path = os.path.join(
            get_astrbot_path(), "astrbot", "builtin_stars"
        )
        """保留插件的路径。在 astrbot/builtin_stars 目录下"""
        self.conf_schema_fname = "_conf_schema.json"
        self.logo_fname = "logo.png"
```

**B. 加载逻辑（含生成默认值的落盘路径）**
`astrbot/core/star/star_manager.py:1151-1165`
```python
                # 检查 _conf_schema.json
                plugin_config = None
                plugin_schema_path = os.path.join(
                    plugin_dir_path,
                    self.conf_schema_fname,
                )
                if os.path.exists(plugin_schema_path):
                    # 加载插件配置
                    plugin_config = AstrBotConfig(
                        config_path=os.path.join(
                            self.plugin_config_path,
                            f"{root_dir_name}_config.json",
                        ),
                        schema=self._load_plugin_config_schema(plugin_schema_path),
                    )
```
→ **插件配置落盘在 `data/config/{插件目录名}_config.json`**（`root_dir_name` = 目录名）。本机实例：`data/config/astrbot_plugin_dsh_connector_config.json`。

schema 读取容错（接受 UTF-8 BOM）：`star_manager.py:602-616`。

**C. schema → 默认配置的转换与允许的类型**
`astrbot/core/config/astrbot_config.py:146-171`
```python
    def _config_schema_to_default_config(self, schema: dict) -> dict:
        """将 Schema 转换成 Config"""
        conf = {}

        def _parse_schema(schema: dict, conf: dict) -> None:
            for k, v in schema.items():
                if v["type"] not in DEFAULT_VALUE_MAP:
                    raise TypeError(
                        f"不受支持的配置类型 {v['type']}。支持的类型有：{DEFAULT_VALUE_MAP.keys()}",
                    )
                if "default" in v:
                    default = v["default"]
                else:
                    default = DEFAULT_VALUE_MAP[v["type"]]

                if v["type"] == "object":
                    conf[k] = {}
                    _parse_schema(v["items"], conf[k])
                elif v["type"] == "template_list":
                    conf[k] = default
                else:
                    conf[k] = default

        _parse_schema(schema, conf)

        return conf
```
允许的类型（`astrbot/core/config/default.py:4438-4448`）：
```python
DEFAULT_VALUE_MAP = {
    "int": 0,
    "float": 0.0,
    "bool": False,
    "string": "",
    "text": "",
    "list": [],
    "file": [],
    "object": {},
    "template_list": [],
}
```
配置对象是 `dict` 子类，支持属性式访问（缺失返回 `None`）：
`astrbot_config.py:325-339`
```python
    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError:
            return None

    def __delattr__(self, key) -> None: ...
    def __setattr__(self, key, value) -> None:
        self[key] = value
```
真实 schema 样例（可直接照抄结构）：`data/plugins/astrbot_plugin_dsh_connector/_conf_schema.json`（`description` / `type` / `default` / `options` / `hint`）。

**D. 插件实例如何拿到 config**
`astrbot/core/star/star_manager.py:1218-1233`
```python
                    if path not in inactivated_plugins:
                        # 只有没有禁用插件时才实例化插件类
                        if plugin_config and metadata.star_cls_type:
                            try:
                                metadata.star_cls = metadata.star_cls_type(
                                    context=self.context,
                                    config=plugin_config,
                                )
                            except TypeError as _:
                                metadata.star_cls = metadata.star_cls_type(
                                    context=self.context,
                                )
                        elif metadata.star_cls_type:
                            metadata.star_cls = metadata.star_cls_type(
                                context=self.context,
                            )
```
→ 插件应写成 `def __init__(self, context: Context, config: AstrBotConfig)`。注意 `Star.__init__` 自身**忽略** `config`（`core/star/base.py:28-32` 只处理 `context` 和 logger），所以插件要自己保存 `self.config = config`（本机插件正是如此：`data/plugins/astrbot_plugin_dsh_connector/main.py:104-106`）。

**E. 热更新行为 = 保存后「整插件重载」**
`astrbot/dashboard/services/config_service.py:909-938`
```python
    async def save_plugin_configs(
        self,
        post_configs: dict,
        plugin_name: str,
    ) -> None:
        metadata = self.get_plugin_metadata_by_name(plugin_name)
        ...
        errors, post_configs = validate_config(
            post_configs,
            getattr(metadata.config, "schema", {}),
            is_core=False,
        )
        if errors:
            raise ValueError(f"格式校验未通过: {errors}")
        metadata.config.save_config(post_configs)
        await self.core_lifecycle.plugin_manager.reload(plugin_name)

    async def save_plugin_configs_from_dashboard_payload(
        self,
        payload: object,
        *,
        plugin_name: str,
    ) -> str:
        post_configs = payload if isinstance(payload, dict) else {}
        await self.save_plugin_configs(post_configs, plugin_name)
        return f"保存插件 {plugin_name} 成功~ 机器人正在热重载插件。"
```
→ **WebUI 保存插件配置 → 写 `data/config/*_config.json` → 立刻 `plugin_manager.reload()`（先 `terminate()` 再重新 import+实例化）**。所以插件**不需要**自己做配置热更新；但要注意 `terminate()` 里要清理后台任务/连接（`star_manager.py:1973-2005` 调用 `terminate()` 或 `__del__()`）。
另外文件监听热重载只在 `ASTRBOT_RELOAD=1` 时启用：
`star_manager.py:220-221`
```python
        if os.getenv("ASTRBOT_RELOAD", "0") == "1":
            asyncio.create_task(self._watch_plugins_changes())
```

**F. 启停状态存在哪里（不是 plugins.json）**
`star_manager.py:1087`
```python
        inactivated_plugins = await sp.global_get("inactivated_plugins", [])
```
`star_manager.py:1947-1966`（禁用）与 `:2024-2028`（启用）都写 `sp.global_put("inactivated_plugins", ...)`。
本机 `data/plugins.json`（2 MB）是**插件市场缓存**，不是启用列表（头部有 `"$meta": {"name": "AstrBot Official Plugin Market", ...}`）。

---

## 5. 能否主动外呼 / 反向调用 AstrBot

### 5.1 插件里发 HTTP 请求：**完全可行**

- 内建依赖里就有 `aiohttp`（本机插件直接 `import aiohttp`：`data/plugins/astrbot_plugin_dsh_connector/main.py:35`、`core/dsh_client.py:12`）。
- 插件可自带 `requirements.txt`，框架会自动安装：`star_manager.py:328-374`（`_check_plugin_dept_update` → `_ensure_plugin_requirements`）。
- 本机实例就是长轮询 + POST 到 DSH 的 RPC：`core/dsh_client.py:61-80`
  ```python
    async def rpc(self, session: aiohttp.ClientSession, method: str, payload: dict[str, Any]) -> Any:
        envelope = {
            "type": "client-request",
            "rpcId": str(uuid.uuid4()),
            "method": method,
            "payload": payload,
        }
        url = f"{self.base_url}/api/{method}"
        try:
            async with session.post(
                url,
                json=envelope,
                headers={"content-type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=self.timeout),
            ) as response:
  ```
- **没有发现**任何出站网络限制代码。

### 5.2 AstrBot 的插件 Web API 注册机制：真实签名与 URL 形态

**注册：**`astrbot/core/star/context.py:52-53` + `:569-591`
```python
WebApiHandler = Callable[..., Awaitable[Any]]
RegisteredWebApi = tuple[str, WebApiHandler, list[str], str]
...
    def register_web_api(
        self,
        route: str,
        view_handler: WebApiHandler,
        methods: list[str],
        desc: str,
    ) -> None:
        """注册 Web API。

        Args:
            route: API 路由路径。
            view_handler: 异步视图处理函数。
            methods: HTTP 方法列表。
            desc: API 描述。

        Note:
            如果相同路由和方法已注册，会替换现有的 API。
        """
        for idx, api in enumerate(self.registered_web_apis):
            if api[0] == route and methods == api[2]:
                self.registered_web_apis[idx] = (route, view_handler, methods, desc)
                return
        self.registered_web_apis.append((route, view_handler, methods, desc))
```
**注意：是 `def`（同步方法），不是 `async def`。**

**路由匹配规则**（含 `<name>` / `<path:name>` 占位符）：
`astrbot/dashboard/api/plugins.py:147-180`
```python
def _normalize_plugin_api_route(route: str) -> str:
    route = route.strip()
    if not route.startswith("/"):
        route = f"/{route}"
    return route


def _plugin_api_route_pattern(route: str) -> str:
    normalized = _normalize_plugin_api_route(route)
    chunks = []
    pos = 0
    for match in re.finditer(r"<(?:(path):)?([A-Za-z_][A-Za-z0-9_]*)>", normalized):
        chunks.append(re.escape(normalized[pos : match.start()]))
        name = match.group(2)
        chunks.append(f"(?P<{name}>.*)" if match.group(1) else f"(?P<{name}>[^/]+)")
        pos = match.end()
    chunks.append(re.escape(normalized[pos:]))
    return "".join(chunks)


def _match_registered_web_api(registered_web_apis, subpath: str, method: str):
    request_path = f"/{subpath.lstrip('/')}"
    request_method = method.upper()

    for route, view_handler, methods, _ in registered_web_apis:
        allowed_methods = [item.upper() for item in methods]
        if request_method not in allowed_methods:
            continue

        pattern = _plugin_api_route_pattern(route)
        matched = re.fullmatch(pattern, request_path)
        if matched:
            return view_handler, matched.groupdict()
    return None
```

**调用约定**（handler 的 path 参数以 `**kwargs` 传入）：
`astrbot/dashboard/api/plugins.py:207-229`
```python
    view_handler, path_values = matched_api
    plugin_name = plugin_path.strip("/").split("/", 1)[0].strip() or None
    plugin_request = PluginRequest(
        request,
        path_params=path_values,
        plugin_name=plugin_name,
        username=username,
    )
    app_adapter = getattr(request.app.state, "dashboard_app_adapter", None)
    if app_adapter is None:
        with bind_request_context(plugin_request):
            return await run_maybe_async(lambda: view_handler(**path_values))

    g_obj = DashboardRequestState()
    g_obj.username = username
    with bind_request_context(plugin_request):
        return await call_request_view(
            request,
            app_adapter,
            view_handler,
            path_values,
            g_obj=g_obj,
            quart_compat_path=_plugin_extension_legacy_path(plugin_path, request),
        )
```
→ 因此 `view_handler` 可以是**零参数**（无占位符时 `path_values={}`）。

**两个真实挂载点（URL 前缀）**：
1. 新版（推荐）：`/api/v1/plugins/extensions/{plugin_path:path}`，需要 `plugin` scope：
   `astrbot/dashboard/api/plugins.py:380-422`（GET/POST/PUT/PATCH/DELETE 各一个），前缀 `/api/v1` 来自 `astrbot/dashboard/api/router.py:32-43`。
2. 旧版兼容：`/api/plug/{plugin_path:path}`（仅 GET/POST），用 dashboard 登录态鉴权：
   `astrbot/dashboard/api/plugins.py:1497-1503`
   ```python
   @legacy_router.api_route("/api/plug/{plugin_path:path}", methods=["GET", "POST"])
   async def dashboard_plugin_extension_route(
       plugin_path: str,
       request: Request,
       username: str = Depends(require_dashboard_user),
   ):
       return await _call_plugin_extension(plugin_path, request, username)
   ```

**所以：DSH 反向调用插件的完整 URL 形态是**
```
POST http://127.0.0.1:6185/api/v1/plugins/extensions/{你注册route时用的前缀}/你的子路径
Header: X-API-Key: <scope 含 plugin 的 API Key>
```
本机真实注册样例（`route` 前缀习惯是插件目录名）：
- `data/plugins/astrbot_plugin_galgame_web/api/prefs.py:6-12` → `f"/{pn}/prefs"`
- `data/plugins/astrbot_plugin_qzone_tools/main.py:2769-2781` → `f"/{PLUGIN_NAME}/get_config"` 等
- `data/plugins/astrbot_plugin_mimo_tts_clone/pages_api.py:53-77` → 带能力检测的写法：`register_web_api = getattr(self.context, "register_web_api", None)`（**推荐给需要兼容旧版的插件**）

**请求对象怎么读**（新 API）：
`from astrbot.api.web import request`（模块级代理，`astrbot/api/web.py:322`），提供 `request.json()`、`request.query`、`request.form()`、`request.files()`、`request.headers`、`request.path_params`（`api/web.py:254-322`）；响应助手 `json_response` / `error_response` / `file_response` / `stream_response`（`:342-439`）。
（旧式插件用 `from quart import request`，如 `astrbot_plugin_galgame_web/api/prefs.py:1` —— 这是兼容层，新代码建议用 `astrbot.api.web`。）

**鉴权细节**：
`astrbot/dashboard/api/auth.py:44-56`
```python
def _extract_raw_api_key(request: Request) -> str | None:
    auth_header = request.headers.get("Authorization", "").strip()
    ...
    if key := request.query_params.get("api_key"):
        ...
    if key := request.headers.get("X-API-Key"):
```
`auth.py:145-148` → 有 raw key 就走 `_require_api_key_scope`；否则回落到 dashboard JWT。
scope 白名单（**`plugin` 和 `im` 都在**）：`astrbot/dashboard/services/auth_service.py:50-62`
```python
ALL_OPEN_API_SCOPES = (
    "bot", "provider", "persona", "im", "config", "chat",
    "data", "file", "plugin", "mcp", "skill",
)
```
API Key 的创建接口：`POST /api/v1/api-keys`（需 `system` scope），见 `astrbot/dashboard/api/api_keys.py:88-94`。

### 5.3 **更省事的方案：DSH 根本不用插件 Web API**

既然 AstrBot 已经把 `POST /api/v1/im/messages`（scope `im`）内建成了一个通用的「按 UMO 发消息」接口（§1.2e），**DSH 可以只用两个内建接口完成双向桥**：

| 方向 | 接口 | 依据 |
|---|---|---|
| DSH → IM（主动推送） | `POST http://127.0.0.1:6185/api/v1/im/messages`，body `{"umo": "default:GroupMessage:<gid>", "message": "文本"}` | `open_api.py:299-311`、`open_api_service.py:603-641`、`schemas.py:212-216` |
| DSH 查可用 bot | `GET /api/v1/im/bots` → `{"bot_ids": [...]}` | `open_api.py:323-329`、`open_api_service.py:643-653` |
| DSH → LLM（webchat 会话） | `POST /api/v1/chat`（scope `chat`） | `open_api.py:179-191` |

插件 Web API 只在「需要自定义入站逻辑（ACL、鉴权、幂等、复杂 payload）」时才值得用。

### 5.4 反向（AstrBot → DSH）的落点（**交叉引用，非本报告独立核实**）

本报告只独立核实了 AstrBot 侧。AstrBot 插件要 POST 出去的**目标**在 DSH 一侧，姊妹报告 `docs/dsh-side-capabilities.md` 的结论是（**未由我独立复核**）：

- DSH Web 监听 `http://127.0.0.1:3080`（本机 `astrbot_plugin_dsh_connector` 的 `http_base_url` 正是这个值，见 `data/config/astrbot_plugin_dsh_connector_config.json:3`）。
- 自定义 HTTP 路由用 `ctx.webServer.register({kind, path, handler})`，`kind ∈ {'exact','prefix'}`，**这些路由没有任何鉴权**（适合 localhost 直连）；带鉴权的是 `ctx.connection.fetch.register(...)` / `ctx.connection.rpc.handle(...)`，路径挂在 `/api` 之下（即 DSH 自己的 RPC 面，需要 connection token）。
- 重复 `(kind, path)` 会抛错；**`prefix` 路由的 `path` 不能以 `/` 结尾**。
- 节流/审批等 waterfall hook（`'approval/request'`、`'user-questions/request'`）可以「挂住 → 去 IM 问用户 → 拿到答案再返回」，这正是网桥最有价值的用法。

**对骨架的影响**：骨架里 `bridge_url` 的默认值请按实际 DSH 侧注册的路由填写（例如 `http://127.0.0.1:3080/astrbot-relay/chat`），不要使用我原先示例中的占位端口。这一点属于「必须与 DSH 侧联调确认」的项。

---

## 6. 本机部署实况

### 6.1 AstrBot 当前**没有在运行**

- `Get-Process python, pythonw` → **无任何 Python 进程**（只有 4 个 node 进程）。
- `Get-NetTCPConnection -State Listen` 中 **6185 / 6199 / 10234 / 10235 均无监听**。
- `data/logs/astrbot.log` 只有 1 行、最后写入时间 `2026/9/15 23:18:11`：
  ```
  [2026-09-15 23:18:11.800] [astrbot_plugin_group_log_archive] [DBUG] [astrbot_plugin_group_log_archive_bak_20260823.main:325]: [GroupLogArchive] 已清空源日志: C:\Users\<user>\Downloads\AstrBot-master\data\logs\astrbot.log
  ```
  （该行本身是 group_log_archive 插件清空日志留下的痕迹。）
- 同目录还有空的 `event_loop_watchdog.log`。

### 6.2 运行方式与目录布局

- 源码树：`C:\Users\<user>\Downloads\AstrBot-master`，入口 `main.py`（8286 字节），另有 `main.py - 快捷方式.lnk`（Windows 快捷方式，说明用户是双击/快捷方式启动）。
- `.python-version` = `3.12`；系统 PATH 上的 Python 是 `C:\Python314\python.exe`（**注意：本机 `data/` 下的 `__pycache__` 是 `cpython-314.pyc`，说明实际是用 Python 3.14 跑起来的**，与 `.python-version` 的 3.12 不一致）。
- **没有 venv / .venv 目录**。
- `data/` 布局（实测）：
  ```
  attachments/  backups/  config/  dist/  knowledge_base/  logs/  plugins/
  plugin_data/  shit_detector_repos/  site-packages/  skills/  t2i_templates/
  temp/  webchat/  workspaces/
  cmd_config.json  cmd_config.json.bak_pre_grouplog  dashboard.zip  data_v4.db
  plugins.json  mcp_server.json  skills.json  shit_detector_data.json
  ```
  - `data/dist` = 已构建的 Dashboard 前端（`index.html` / `assets/` / `t2i/` / `favicon.svg`）。
  - `data/data_v4.db` = SQLite 主库（含 `preferences` / `api_keys` / `platform_sessions` / `attachments` / `command_configs` 等表，已实测列出表名）。
  - `data/site-packages` = 插件 pip 安装目录。
  - **没有 `data/shared_preferences.json`**（符合 §4.2 的「已改 DB」结论）。
  - `data/config/` 下有 ~37 个 `*_config.json`（每个装了 `_conf_schema.json` 的插件的配置）。

### 6.3 端口 / 配置文件

| 项 | 值 | 依据 |
|---|---|---|
| WebUI（Dashboard）默认 host | `0.0.0.0` | `astrbot/core/config/default.py:258` |
| WebUI（Dashboard）默认 port | **`6185`** | `astrbot/core/config/default.py:259` |
| 本机实际 WebUI | `0.0.0.0:6185`，`enable: true` | `data/cmd_config.json` → `dashboard` 段 |
| 主配置文件 | `data/cmd_config.json` | `astrbot/core/config/astrbot_config.py:20`：`ASTRBOT_CONFIG_PATH = os.path.join(get_astrbot_data_path(), "cmd_config.json")` |
| `wake_prefix` | `["/"]` | `data/cmd_config.json` |
| `admins_id` | `["astrbot", "1000000001"]` | `data/cmd_config.json` |
| `log_level` | `DEBUG`，`log_file_path` = `logs/astrbot.log` | `data/cmd_config.json` |
| `platform_settings.segmented_reply.enable` | `false` | `data/cmd_config.json`（所以不会自动分段发） |
| `platform_settings.forward_threshold` | `1500` | `data/cmd_config.json` |
| `platform_settings.enable_id_white_list` | `true`，但 `id_whitelist` 为 **空** → 实际不拦截 | `whitelist_check/stage.py:39-41` |
| `t2i` | `false` | `data/cmd_config.json` |
| `plugin_set` | `["*"]`（所有插件启用） | `data/cmd_config.json` |
| `timezone` | `Asia/Shanghai` | `data/cmd_config.json` |

### 6.4 本机 IM 平台实况：**3 个 aiocqhttp 反向 WS，无 telegram**

`data/cmd_config.json` → `platform`（3 个全部 `enable: true`）：

| id | type | ws_reverse_host | ws_reverse_port |
|---|---|---|---|
| `default` | `aiocqhttp` | `0.0.0.0` | **6199** |
| `default-2` | `aiocqhttp` | `0.0.0.0` | **10234** |
| `default-3` | `aiocqhttp` | `0.0.0.0` | **10235** |

每个都配了 `ws_reverse_token`（值略）。**没有 telegram / discord / 其他平台配置**。
另外 `WebChatAdapter` 永远会被自动创建并加入实例列表（`platform/manager.py:99-102`），所以 `webchat` 平台总是可用。

### 6.5 NapCat：**存在，且已与 AstrBot 端口配对**

安装位置：`C:\Users\<user>\Downloads\NapCat.Shell`（含 `napcat.mjs`、`launcher*.bat`、`config/onebot11_*.json` 等）。

`NapCat.Shell/config/onebot11_1000000002.json`（节选，token 略）
```json
  "network": {
    "websocketServers": [
      { "enable": false, "name": "xiaoy", "host": "ws://localhost:6199/ws", "port": 6199,
        "reportSelfMessage": true, "enableForcePushEvent": true,
        "messagePostFormat": "array", "token": "<与 AstrBot default 一致>" }
    ],
    "websocketClients": [
      { "enable": true, "name": "小圆", "url": "ws://localhost:6199/ws",
        "reportSelfMessage": true, "messagePostFormat": "array",
        "token": "<与 AstrBot default 一致>", "reconnectInterval": 30000 }
    ]
  }
```
`NapCat.Shell/config/onebot11_1000000003.json`（节选）
```json
    "websocketClients": [
      { "enable": true, "name": "和", "url": "ws://localhost:10235/ws",
        "messagePostFormat": "array", "token": "<与 AstrBot default-3 一致>" }
    ]
```
→ **反向 WS 客户端（NapCat → AstrBot）已配置好，token 与 AstrBot 侧一致**；`default-2`（10234）暂时没有对应的 NapCat 配置。`messagePostFormat: "array"` 与 aiocqhttp 适配器解析 `event.message` 为数组段的方式一致（`aiocqhttp_platform_adapter.py:243`）。

### 6.6 本机已有一个同路线的 DSH 桥接插件（**重大发现**）

| 项 | 值 | 依据 |
|---|---|---|
| 目录 | `data/plugins/astrbot_plugin_dsh_connector` | 实测 |
| 名称/版本 | `astrbot_plugin_dsh_connector` v**2.0.1**，author `konodiodaaaaa1` | `metadata.yaml:1-19` |
| `astrbot_version` | `">=4.0.0"` | `metadata.yaml:11` |
| `support_platforms` | `qq_official`, `aiocqhttp` | `metadata.yaml:12-14` |
| 连接方式 | HTTP 到 DSH Web（`http_base_url = http://127.0.0.1:3080`）+ `headless` 子进程兜底 | `data/config/astrbot_plugin_dsh_connector_config.json:2-3`、`main.py:282-292` |
| 关键配置 | `reply_chunk_size=2000`、`max_reply_chars=4000`、`stream_replies=true`、`reply_render_mode=text` | `data/config/...config.json:6-13` |
| 当前状态 | **已被禁用**（`inactivated_plugins` 里含 `data.plugins.astrbot_plugin_dsh_connector.main`） | 实测 `data_v4.db` → `preferences` 表 |
| 历史运行证据 | KV 里存在 per-UMO 的 DSH 会话绑定与选项，例如 `plugin / konodiodaaaaa1/astrbot_plugin_dsh_connector / dsh_session:default:FriendMessage:1000000001 = "session-d1a5c3fc-..."`、`dsh_session_options:default:GroupMessage:1000000004` | 实测 `data_v4.db` |

它同时**实证**了本报告的两条结论：
1. 插件 KV 是 DB 后端且 scope_id = `author/name`（`konodiodaaaaa1/astrbot_plugin_dsh_connector`）；
2. 路线 A 用 UMO（`platform_id:MessageType:session_id`）做「每个聊天一个 DSH 会话」的映射是可行且已落地的。

它用到的真实 import（**推荐的 4.26.7 导入路径**）：
`data/plugins/astrbot_plugin_dsh_connector/main.py:37-42`
```python
from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, MessageChain, filter
from astrbot.api.message_components import Image, Plain
from astrbot.api.provider import ProviderRequest
from astrbot.api.star import Context, Star
```
以及「指令剩余文本」的取法（wake_prefix 已被框架剥掉）：
`main.py:1485-1493`
```python
def _command_remainder(event: AstrMessageEvent) -> str:
    """取出指令名之后的所有文本。

    AstrBot 在唤醒阶段会去掉 wake_prefix（默认 ``/``），因此这里的
    ``event.message_str`` 形如 ``"dsh 帮我 写代码"``，按第一个空白切分即可。
    """
    raw = (event.message_str or "").strip()
    parts = raw.split(None, 1)
    return parts[1].strip() if len(parts) > 1 else ""
```

---

## 7. 最小可用路线 A 插件骨架（Python）

**目录结构**（放到 `AstrBot-master/data/plugins/astrbot_plugin_im_bridge/`）：

```
astrbot_plugin_im_bridge/
├── metadata.yaml
├── _conf_schema.json
├── requirements.txt
└── main.py
```

### `metadata.yaml`
```yaml
name: astrbot_plugin_im_bridge
display_name: IM Bridge
short_desc: 把 IM 消息转发给外部服务并回传结果
desc: 监听指定前缀的 IM 消息，转发给外部 HTTP 服务（如 DSH），并把返回文本发回同一会话。
version: 0.1.0
author: yourname
repo: https://github.com/yourname/astrbot_plugin_im_bridge
astrbot_version: ">=4.16,<5"
support_platforms:
  - aiocqhttp
```

### `_conf_schema.json`

> 历史示例提示：下面 `trigger_prefix` 的 `ds ` 是旧口径。现行 astrdsh-relay 的默认前缀为 `dsh `（配置文件里不带斜杠；匹配时先 strip 配置值、剥掉基名的一个前导 `/`、再对消息容忍一个前导 `/`，即 `dsh` 与 `/dsh` 等价，基名后必须紧跟空白或行尾）。实现见 `astrbot_plugin_dsh_relay/main.py` 的 `_match_prefix` 与同目录 `_conf_schema.json`。
```json
{
  "enable": {"description": "启用桥接", "type": "bool", "default": true},
  "trigger_prefix": {"description": "触发前缀（含结尾空格更精确）", "type": "string", "default": "ds "},
  "bridge_url": {"description": "外部服务 HTTP 地址（DSH 侧需先注册该路由）", "type": "string", "default": "http://127.0.0.1:3080/astrbot-relay/chat"},
  "bridge_token": {"description": "外部服务鉴权 Bearer Token（可空）", "type": "string", "default": ""},
  "timeout": {"description": "单次请求超时（秒）", "type": "int", "default": 120},
  "chunk_size": {"description": "回复分片长度（0=不切分）", "type": "int", "default": 1800},
  "reply_in_private_only": {"description": "仅在私聊响应", "type": "bool", "default": false}
}
```

### `requirements.txt`
```
aiohttp>=3.9
```

### `main.py`
```python
"""最小可用的 AstrBot(Star) ↔ 外部服务 IM 网桥。

路线 A：完全复用 AstrBot 现有的平台适配器（本机为 aiocqhttp/NapCat）。
收到指定前缀消息 -> POST 到外部 HTTP -> 把返回文本发回同一会话。

依据（4.26.7 源码）：
- astrbot/api/event/filter/__init__.py  : 过滤器与装饰器的公开导入路径
- core/star/filter/event_message_type.py:24-33 : EventMessageTypeFilter
- core/pipeline/waking_check/stage.py:163-242 : filter 通过即 is_wake=True（群聊无需 @）
- core/platform/astr_message_event.py:396-398 : plain_result()
- core/platform/astr_message_event.py:340-362 : stop_event() 必须在 yield 之后调用
- core/platform/astr_message_event.py:364-369 : should_call_llm(True) 阻止默认 LLM
- core/star/context.py:507-541            : Context.send_message() 主动推送
- core/utils/plugin_kv_store.py:9-28      : self.put_kv_data/get_kv_data 持久化
"""

from __future__ import annotations

import aiohttp

from astrbot.api import AstrBotConfig, logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star


def _chunk_text(text: str, size: int) -> list[str]:
    """AstrBot 没有通用的 IM 文本切分工具（见 core/utils/string_utils.py 全文），
    且 aiocqhttp 适配器不做长度切分（aiocqhttp_message_event.py:125-181），
    因此桥接侧必须自己切。"""
    if not size or size <= 0 or len(text) <= size:
        return [text]
    return [text[i : i + size] for i in range(0, len(text), size)]


class Main(Star):
    """IM 网桥插件入口。"""

    def __init__(self, context: Context, config: AstrBotConfig | None = None):
        super().__init__(context)  # Star.__init__(context, config=None)，config 需自己保存
        self.config = config

    # ---------- 配置 ----------
    def _cfg(self, key, default=None):
        if self.config is None:
            return default
        value = (
            self.config.get(key)
            if hasattr(self.config, "get")
            else getattr(self.config, key, None)
        )
        return default if value is None else value

    # ---------- 入站：监听指定前缀 ----------
    # 用 event_message_type(ALL) 而不是 command()：
    #   waking_check/stage.py:217-218 中「过滤器通过」会把 is_wake 置 True，
    #   所以群聊里不需要 @ 机器人也能收到消息；而 CommandFilter 强制要求
    #   event.is_at_or_wake_command（filter/command.py:191-193）。
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def on_bridge_message(self, event: AstrMessageEvent):
        if not self._cfg("enable", True):
            return
        if self._cfg("reply_in_private_only", False) and not event.is_private_chat():
            return

        # 【历史示例】旧实现只做 raw.startswith(prefix)。现行 astrdsh-relay 用 _match_prefix：
        # strip 配置值 -> 剥基名一个前导 / -> raw 容忍一个前导 / -> 基名后必须紧跟空白或行尾。
        prefix = str(self._cfg("trigger_prefix", "ds ") or "ds ")
        raw = (event.message_str or "").strip()
        if not prefix or not raw.startswith(prefix):
            return  # 不匹配：不设置结果、不发消息 -> 不干扰 AstrBot 默认逻辑

        prompt = raw[len(prefix) :].strip()
        if not prompt:
            yield event.plain_result("用法：" + prefix + "<指令>")
            event.stop_event()  # 必须放在 yield 之后（scheduler.py:50-78）
            return

        # 命中前缀后接管本事件：阻止 AstrBot 默认 LLM 回复。
        # 注意：should_call_llm(True) 才是「禁止」——见 process_stage/stage.py:59
        # 的 `not event.call_llm` 判定，文档注释与参数语义相反。
        event.should_call_llm(True)

        session_key = event.unified_msg_origin  # platform_id:MessageType:session_id
        logger.info(f"[im_bridge] {session_key} <- {prompt[:80]}")

        try:
            reply = await self._call_bridge(
                session=session_key,
                prompt=prompt,
                sender_id=event.get_sender_id(),
                sender_name=event.get_sender_name(),
                group_id=event.get_group_id(),
                platform_id=event.get_platform_id(),
                message_type=event.get_message_type().value,
            )
        except Exception as exc:  # 网络/协议错误都回一条可读提示
            logger.warning(f"[im_bridge] bridge call failed: {exc}")
            yield event.plain_result(f"❌ 桥接调用失败：{exc}")
            event.stop_event()
            return

        if not reply or not reply.strip():
            yield event.plain_result("（外部服务没有返回内容）")
            event.stop_event()
            return

        size = int(self._cfg("chunk_size", 1800) or 0)
        chunks = _chunk_text(reply, size)
        for chunk in chunks[:-1]:
            # 中间分片主动发送：不走 ResultDecorateStage，避免被合并转发/转图影响
            await event.send(event.plain_result(chunk))
        yield event.plain_result(chunks[-1])  # 最后一片走正常结果链路
        event.stop_event()

    # ---------- 出站：HTTP ----------
    async def _call_bridge(
        self,
        *,
        session: str,
        prompt: str,
        sender_id: str,
        sender_name: str,
        group_id: str,
        platform_id: str,
        message_type: str,
    ) -> str:
        url = str(self._cfg("bridge_url", "http://127.0.0.1:3080/astrbot-relay/chat")).strip()
        token = str(self._cfg("bridge_token", "") or "").strip()
        timeout = float(self._cfg("timeout", 120) or 120)

        headers = {"content-type": "application/json"}
        if token:
            headers["authorization"] = f"Bearer {token}"

        payload = {
            "session": session,  # 外部服务用它做多轮会话隔离
            "prompt": prompt,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "group_id": group_id,
            "platform_id": platform_id,
            "message_type": message_type,
        }

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=timeout)
        ) as http:
            async with http.post(url, json=payload, headers=headers) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise RuntimeError(f"HTTP {resp.status}: {text[:200]}")
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    return text
        if isinstance(data, dict):
            for key in ("reply", "text", "content", "message"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value
            if isinstance(data.get("data"), str):
                return data["data"]
            return str(data)
        if isinstance(data, list):
            return "\n".join(str(item) for item in data)
        return str(data)

    # ---------- 主动推送示例（异步任务完成后调用） ----------
    async def push_to_session(self, umo: str, text: str) -> bool:
        """不需要持有 event 对象；umo 可先用 put_kv_data 存下来。

        实现依据：core/star/context.py:507-541 -> platform.send_by_session()
        """
        from astrbot.api.event import MessageChain

        ok = await self.context.send_message(umo, MessageChain().message(text))
        if not ok:
            logger.warning(f"[im_bridge] no platform matched umo={umo}")
        return ok

    # ---------- 记住「最近一次会话」以便主动推送 ----------
    @filter.event_message_type(filter.EventMessageType.ALL)
    async def remember_session(self, event: AstrMessageEvent):
        """把最近的 UMO 存进插件 KV（scope='plugin'，落 data_v4.db 的 preferences 表）。"""
        if not self._cfg("enable", True):
            return
        try:
            await self.put_kv_data("last_umo", event.unified_msg_origin)
        except Exception:
            pass

    async def terminate(self) -> None:
        """插件被禁用/重载时调用（star_manager.py:1973-2005）。"""
        logger.info("[im_bridge] terminated")
```

**对外部服务的契约（DSH 侧需实现；见 §5.4）**
```http
POST http://127.0.0.1:3080/astrbot-relay/chat      # 路径以 DSH 侧实际注册的 ctx.webServer.register 路由为准
Content-Type: application/json
Authorization: Bearer <bridge_token，可空>

{"session":"default:GroupMessage:123456","prompt":"...","sender_id":"...",
 "sender_name":"...","group_id":"123456","platform_id":"default",
 "message_type":"GroupMessage"}

200 OK  →  {"reply": "要发回 IM 的文本"}
```

**同时，DSH 想让 AstrBot 主动推消息时，完全可以绕过插件**（§5.3）：
```http
POST http://127.0.0.1:6185/api/v1/im/messages
X-API-Key: <scope 含 im 的 API Key>
Content-Type: application/json

{"umo": "default:GroupMessage:123456", "message": "任务已完成"}
```

**部署后自检清单**
1. 把那 3 个平台的 `enable` 确认是 `true`，NapCat 侧的 `websocketClients[].url` 指向 `ws://localhost:<对应端口>/ws` 且 token 一致。
2. 在 WebUI(6185) → 插件页确认 `IM Bridge` 已加载、`_conf_schema.json` 生成了表单（配置落在 `data/config/astrbot_plugin_im_bridge_config.json`）。
3. 日志确认：`log_level=DEBUG` 时插件 logger 名为 `astrbot.plugin.<name>`（`core/log.py` 的 `LogManager.get_plugin_logger`，`core/star/base.py:35-49`）。
4. （历史示例，前缀口径已过期：现行 astrdsh-relay 默认 `dsh`，配置不带斜杠。）若在群里测试，注意既可以用 `dsh xxx`（无前缀唤醒依赖，因为 `event_message_type(ALL)` 会让 `is_wake=True`），也可以 `/dsh xxx`（此时 wake_prefix 会被剥掉，`event.message_str` 为 `dsh xxx`）。
5. 若同一群里既要桥接又要 AstrBot 自己的 LLM 对话，把 `trigger_prefix` 设得足够独特（现行默认 `dsh `，配置里写 `dsh` 即可，别写 `/dsh`），并且**不要**在桥接分支之外调用 `should_call_llm(True)`。

---

## 8. 不确定 / 未找到证据 / 与坊间说法不符 清单

### 8.1 「已证实」
- 路线 A 无需新建 Platform 适配器；`event.send / plain_result / chain_result / Context.send_message` 的真实签名与差异。
- `Platform` 只有 `run()` / `meta()` 两个抽象方法；`send_by_session()` 有非抽象默认实现；构造是 3 参。
- `PlatformMetadata` 全字段；`metadata.yaml` 必需字段 `name/desc/version/author`。
- 过滤器 AND 逻辑（`waking_check/stage.py:174-189`）；priority 越大越先（`star_handler.py:19-26`）。
- 过滤器通过即可让 `is_wake=True`，群聊无需 @（`waking_check/stage.py:217-218`、`:241-242`）。
- `stop_event()` 的 `_force_stopped` 不被 `clear_result()` 重置（`astr_message_event.py:55-57`）。
- Telegram 4096 切分、Discord 2000 截断、微信 1024、wecom_ai_bot 4096 字节切分、qq_official 按媒体切链；**aiocqhttp 没有任何文本长度切分**。
- AstrBot **没有**通用文本切分工具函数（`core/utils/` 全量搜索无命中）。
- AIocqhttp 场景下 `forward_threshold`（本机 1500）会把长文本包成合并转发 `Node`，且**只在走 `yield`（ResultDecorateStage）时生效**。
- `use_markdown_` 只对声明支持 Markdown 的平台生效；aiocqhttp/telegram 都不读它（telegram 走自己的 `markdownify`）。
- 插件 KV 是 **DB 后端**（`data_v4.db` 的 `preferences` 表），scope_id = `author/name`；本机实测数据可见。
- 插件配置落在 `data/config/{插件目录名}_config.json`；WebUI 保存后会**整插件 reload**。
- 插件启用状态存在 `sp.global_get("inactivated_plugins")`（DB），**不在** `data/plugins.json`。
- `register_web_api(route, view_handler, methods, desc)` 是**同步**方法；URL 为 `/api/v1/plugins/extensions/{plugin_path}`（scope `plugin`）或旧版 `/api/plug/{plugin_path}`（dashboard 登录态）。
- AstrBot 内建 `POST /api/v1/im/messages`（scope `im`）用于按 UMO 主动发消息。
- 本机：AstrBot 未运行；WebUI 6185；3 个 aiocqhttp 反向 WS（6199/10234/10235）；NapCat 存在于 `C:\Users\<user>\Downloads\NapCat.Shell` 且 client 指向 6199/10235，token 与 AstrBot 一致；无 telegram。
- 本机已有一个**同路线**的 DSH 桥接插件 `astrbot_plugin_dsh_connector` v2.0.1（当前处于**禁用**状态，但有历史运行数据）。

### 8.2 「未找到证据 / 无法确定」
1. **`C:\Users\<user>\Downloads\AstrBot-v4.26.7-dashboard` 无法用于交叉验证**：它只含 `dist/`（前端构建产物），没有 Python 源码。所谓「版本差异交叉验证」在本机素材下**做不到**。
2. **AstrBot 当前是否由某个服务/计划任务托管启动**（NSSM、任务计划、Docker、`start.bat` 等）：只看到 `main.py` 与一个 `.lnk` 快捷方式，未发现 systemd/service/compose 在本机的使用痕迹（`compose.yml`/`Dockerfile` 存在于源码树，但没有本机运行证据）。**无法确定**用户的启动方式。
3. **`python - 快捷方式`/`.lnk` 的目标**：未解析快捷方式内容，**未核实**具体命令行参数（例如是否设置了 `ASTRBOT_ROOT`）。
4. **Python 版本不一致**：`.python-version` 写 3.12，但 `data/` 下的字节码是 `cpython-314`。**未核实**实际运行时到底是 3.12 还是 3.14（只能说缓存文件表明曾被 3.14 运行过）。
5. **`data/plugins.json`（2 MB）与 `data/skills.json`、`mcp_server.json` 的用途细节**：只确认了 `plugins.json` 是插件市场缓存（头部 `$meta`），其余未逐字段核实。
6. **`data/shit_detector_repos`、`data/attachments`、`data/webchat` 的具体内容/权限**：未展开核查。
7. **qq_official 的 Markdown 实际渲染效果**：只找到 `use_markdown_` 被读取（`qqofficial_message_event.py:307-308`），**未追踪**后续如何构造 Markdown payload（未读完该文件全文）。
8. **`Platform.support_proactive_message` 字段是否被框架实际读取**：只在 `platform.py:101`（`get_stats`）里被读取用于展示，**未找到**任何"据此禁用主动推送"的逻辑。所以它**目前看起来只是元数据**，不代表能力开关。
9. **`event.send_streaming` 在非流式平台的真实降级细节**：只核实了 aiocqhttp 的实现（`aiocqhttp_message_event.py:199-234`），telegram/qq_official 的流式实现未逐行核实。
10. **`data/plugins/astrbot_plugin_dsh_connector` 是否与 DSH 当前版本兼容**：只核实了它存在且曾经运行过，未核实其 HTTP RPC 路径（`base_url + "/api/" + method`，`core/dsh_client.py:68`）与当前 DSH Web 的 RPC 面是否仍匹配。
11. **`AstrBotConfig` 在插件热重载期间被并发读写的行为**：`save_config` 有 `threading.Lock` + revision 机制（`astrbot_config.py:265-323`），但 reload 与配置写入之间的竞态**未核实**。

### 8.3 「与坊间指南/源码自带注释不符」
| 说法 | 事实 | 依据 |
|---|---|---|
| `event.send("文本")` 可直接传字符串 | 签名是 `send(self, message: MessageChain)`，传 `str` 会失败。源码 docstring 示例本身写错了 | `astr_message_event.py:475` vs `star_handler.py:415-420` |
| `event.raw_message` | 不存在于 `AstrMessageEvent`；应为 `event.message_obj.raw_message` | `astrbot_message.py:61`；`aiocqhttp_message_event.py:185` |
| `should_call_llm(False)` 表示"不调用 LLM" | 语义相反：`should_call_llm(True)` 才是**禁止**默认 LLM（判定式是 `not event.call_llm`） | `astr_message_event.py:364-369` vs `process_stage/stage.py:56-60`；实例 `astrbot_plugin_listen_music/main.py:531` |
| `Platform` 需实现 `run()/meta()/send_by_session()` 三个抽象方法 | 只有 `run()` 和 `meta()` 是 `@abc.abstractmethod`；`send_by_session()` 有默认空实现（**不实现不会报错，但主动消息发不出去**） | `platform.py:121-145` |
| 插件数据存在 `data/shared_preferences.json` | 4.26.7 里 `sp` 已是 DB（`data_v4.db` 的 `preferences` 表）；本机没有该 json 文件 | `shared_preferences.py:42-56`；实测 DB 表与数据 |
| 平台适配器构造函数是 `(config, event_queue)` | 框架实际以 **3 个位置参数** 调用：`(platform_config, platform_settings, event_queue)` | `manager.py:218` vs `platform.py:39` |
| `stop_event()` 之后仍能发出消息 | 若在 `yield` **之前**调用 `stop_event()`，`scheduler.py:54-58` 会 `break`，`RespondStage` 不执行 → 消息发不出去 | `scheduler.py:50-78` |
| 插件配置保存是"即时热更新" | 是"整插件重载"（`terminate()` + 重新 import/实例化），不是原地改内存对象 | `config_service.py:927-928` |
| AstrBot 有现成的长文本切分工具可复用 | `core/utils/` 下无任何通用切分函数；各平台切分逻辑都是平台事件类的私有方法 | `core/utils/string_utils.py` 全文；§2.2 的证据清单 |
