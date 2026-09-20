# AstrDsh Relay（星驿）· v0.7 待办清单

> 状态：**待办登记表，不是契约**。接口真相来源仍是 `docs/BRIDGE-CONTRACT.md`；
> 本文件只登记「还没做的事」+ 证据位置，落地后须回改契约与文档口径。
> 基线：`v0.6.2`（三项预留配置已接线，`npm test` 全绿）。
> 逐项证据均由源码实读得出（文件:行），未标【未核实】者可直接当事实使用。

---

## 0. 口径结论（先说没有的）

- `hmacMode` / `policy`（on-demand、daily）/ `idleTtlMs` **已接线，不再是待办**。
  README.md:12-14、docs/RELEASING.md:141-153、CHANGELOG.md:7、scripts/package-release.mjs:303 口径一致。
- DSH 侧 17 个配置键（`lib/index.js:79-114`）**全部有代码引用**，无空转键。
- AstrBot 侧 23 个配置键中**有 2 个是空转的**——见 §1，这是本次盘点唯一的「新缺陷」。

---

## 1. R1 · 空转的配置键 —— **已落地（v0.7.0，实施记录见 §7）**

（下面保留当初的盘点证据，落地后的现状列写在表内第三列右半边。）

两个键在 `_conf_schema.json` 里带默认值与选项，却在插件代码里**零引用**
（仅 `main.py:11-12` 的模块 docstring 自认「仍欠」）。

| 键 | schema 位置 | 代码状态 |
|---|---|---|
| `health_interval_ms`（默认 30000，0=关闭） | `_conf_schema.json:71-75` | 原先只在启动时校验一次 `/health` → **已改为周期任务 `Main._health_loop`** |
| `reply_render_mode`（`text`\|`card`） | `_conf_schema.json:105-111` | 原先无任何 t2i 实现 → **已落地 `Main._render_cards`（复用 `Star.text_to_image`）** |

为什么算缺陷：用户把 `reply_render_mode` 改成 `card`、把间隔改成 5000，
**插件既不生效也不报错**。这和本仓自己立的规矩（`index.js:123`
「配置错误要响亮：宁可加载失败，也不要运行期静默降级」、
`assertConfigIsUsable` 拒绝静默降级）直接冲突。

当初的两种收口，最终**都走了 (a)**（取证发现 t2i 可直接复用，不必自建，见 §7）：

- (a) 补实现：周期健康检查（连续失败即标记未就绪并把原因带给用户）+ `card` 渲染；✅ 本次
- (b) 撤下键：`card` 从 `options` 移除或在加载期显式抛错，间隔键删除或标注「预留」。✗ 未采用

---

## 2. R2 · 已声明但未实现（功能面）

1. **`user-questions` 转发**：契约 §5.3 / §9 #6 明确留二期。
   注意 `ERROR_NOT_IMPLEMENTED`（is `not_implemented` → 501）在两侧**已定义但全仓无人使用**
   （`contract.js:60,79`、`contract.py:75`）——即当前没有任何端点会返回 501。
   真做的时候要让未实现端点回 501，而不是让它掉成 404（`contract.js:67-69` 专门区分了这两件事）。
2. **写类控制面**：`settings/mutate`、`workspace/archiveSession` 默认关闭，仅白名单显式开启时可用（契约 §11.3）。
3. **P5 控制面整体未开**（契约 §11 标「v1.1 草案」）：目前 §12 只读；对话级 cwd 覆盖只能手改 `state.json`
   （DESIGN §7.2 记的现状），记录里的 `workspaceId` 已删除就是为它预留。
4. **P3 收尾**：DSH 重启恢复（`DESIGN.md:274` 记「待验证」）、插件卸载收尾顺序（`DESIGN.md:206-208`）。
5. **P4 收尾**：`card` 模式 —— **已落地**（§7），遗留仅「`push_to_session` 仍固定纯文本」。

---

## 3. R3 · 未实测 / 证据不足（契约 §11.4 列为阻塞项）

1. **`session/page` 的 `throughSeq` 语义**：是翻页上界还是起始 seq 未实跑；
   旧 connector 的 `_await_reply` 正压在这个调用上，属阻塞项。
2. **`sessionTitleTemplate` 应用到 DSH 会话**：当前只在 `/where`、`/conversations` 的
   **响应字段**里渲染标题（`location.js:66`、`location.js:245`、`index.js:1759-1767`），
   **没有写进 DSH 会话本身**——`index.js:1095-1100` 的 `agents.create` 只带 `cwd`（+ 可选 `agentPreset`）。
   后果：DSH Web 会话列表里看不出「哪条来自哪个群」，反向定位这一半功能是空的。
   严格说这算「未实现」，卡点在「进程内有没有等价的标题写入 API」未知。
3. **只有静态证据的项**：`fetch.register` 的 SSE、exact 路由抢占、进程内直调。
4. **契约 §9 残余**：`@deepseek-ai/schemastery` 第三方可解析性（**该条已结案：
   `dsh-astrbot-relay/lib/index.js:71-76` 的【未核实】注释已在本轮改掉**，
   与 `DESIGN.md:280-286` 的 P1 实测结论对齐）、新装插件免重启 HMR、
   `agents.create` 的 provider/model 三选一、DSH 会话被归档后 `agent.followup` 的行为。

---

## 4. R4 · 待共犯决策

契约 §9 #7：**是否把 `astrbot_plugin_dsh_connector` 的多会话管理、模型/preset 切换、
Settings、图片卡合并进本插件。** 这一步决定 R2-3（P5）的规模，也决定 P6（退役 connector）
能否开工——先定这个，再谈排期。

---

## 5. 建议切片

| 切片 | 内容 | 理由 |
|---|---|---|
| **v0.7.0** | R1（配置键不再说谎）✅ 已落地 + R3-1 `throughSeq` 实测 + R3-2 标题真正写进 DSH + 顺手修 `index.js:73` 过期注释 ✅ 已修 | 全是小改动，但堵住「配置无效」和「反向定位看不见」两个真实体感问题 |
| **v0.7.x** | R4 决策后按 P5 分片：控制面 `/rpc` + 权限门 + 集成测试 | 权限门在 P5 是「不做就是提权漏洞」（DESIGN §7.3.1） |
| **不排期** | 契约显式不做项：`user-questions` 转发、v1 暴露流式控制面端点（必须走 `ctx.typertGateway.stream`） | 设计取舍，不是欠账 |

---

## 6. 维护约定

- 本表每落地一项，同步删改：契约 §9 未决表、§11.4、`DESIGN.md` §8 风险登记、`CHANGELOG.md`。
- 契约顶部已声明：标【未核实】的条项**不得**在实现阶段当既成事实使用（`BRIDGE-CONTRACT.md:5`）。
- 复发检查手段（本次盘点用的）：全仓 grep `未实现|未核实|未实测|TODO|P1|P5|二期`，
  再对两侧 `_conf_schema.json` / `Config` 的每个键做「代码引用数为 0」扫描——
  §1 那两个键就是这样扫出来的，正则扫文本是扫不到的。

---

## 7. 落地记录 · R1（v0.7.0）

### 7.1 `health_interval_ms` 周期健康检查 —— 已落地

`astrbot_plugin_dsh_relay/main.py`：

- `Main.__init__`：新增 `self._health_task: asyncio.Task[None] | None`。
- `Main.initialize`：启动探测 + 版本协商成功后，
  `asyncio.create_task(self._health_loop(), name="dsh_relay.health")`；
  `health_interval_ms=0` 即不建任务（语义与 schema 描述一致）。
- 新增 `Main._health_loop()`：按间隔调 `transport.health()`；失败只置
  `_bridge_ok=False` 并写 `_bridge_error`（**下一条用户消息立刻带原因**，
  不是等超时），成功则自动恢复并打日志；`CancelledError` 一律向上抛。
- `Main.terminate`：**显式 cancel 并 `await asyncio.wait({task})`** 再置 None。
  用 `wait` 而非 `await task`，避免把子任务的取消与外层对插件的取消混在一条链路。
  **该函数 docstring 已整段重写**——原文「没有游离的任务」在加了常驻任务之后
  就是假话，这条承诺到此为止。

### 7.2 `reply_render_mode="card"` —— 已落地

- 渲染器复用的是 AstrBot 基类现成的 `Star.text_to_image(text, return_url=True)`
  （`astrbot/core/star/base.py:77-90`，内部走 `html_renderer.render_t2i`，
  实现在 `core/utils/t2i/renderer.py`）——**不自建渲染、不引入新依赖**。
- `Main._reply`：`card` 时先调 `Main._render_cards(event, chunks)`；
  返回 `None` 就整条落回原纯文本路径，其余分片发送策略（中间 `event.send()`、
  最后一片 `yield`）完全不变。
- 新增 `Main._render_cards`：逐片 `await self.text_to_image(...)` 后
  `event.image_result(url)`；**任一片异常或返回空 URL，就丢弃全部已生成的图片
  并整条降级纯文本**（warning 带「第 i/n 片」定位）。
  理由：t2i 是外部服务，半图半文比纯文本更糟。

### 7.3 文档与注释对齐

- `main.py` 头部「实现状态 / 仍欠」两段重写为 P1/P2/P4 全落地口径。
- `dsh-astrbot-relay/lib/index.js:71-76`：`@deepseek-ai/schemastery`
  的【未核实】改成已核实（本机 profile 已实测挂载生效）。

### 7.4 本切片**未**做（留给 v0.7.x，别当成已完成）

- `push_to_session` 仍固定纯文本：主动推送没有事件对象，
  出图要另走 `Context.send_message` + `Image` 组件，未验证，故不动。
- 健康检查失败目前**不**暂停投递，只把原因前置给用户——「自动停用」需要
  先定用户可见语义（是静默、还是每次回一句），留给共犯决策。

### 7.5 R1 收尾补记（v0.7.0 发布前同批）

- **`allow_users` 成员白名单（新增功能，非原 R1 范围）**：`allow_from` 只认会话（UMO），
  用户要的语义是「只有这些人可以用」——按发送者判。落地位置与既有两道过滤一致
  （分发之前），AND 语义，取不到发送者 ID 时拒绝，被挡只记一行 `info`
  （只记 ID、不记内容）。设计依据回填到 `docs/DESIGN.md` §3 策略表与 §4 配置清单
  （原文只写 `group_id`/`user_id`，实现里当时只有会话级）。
- **版本口径漂移修复**：R1 落地后 `package.json` / `dsh-astrbot-relay/package.json` /
  `metadata.yaml` 三处仍写 `0.6.2`，本批统一升到 `0.7.0`，`npm run check:version` 复验。
- **权限语义取证结论落文档**：`is_admin()` 只认 AstrBot 管理员（读写链路见
  `docs/astrbot-side-capabilities.md` §3.6）。**结论：插件做群管判定必须自读
  `group.group_admins`**，不复用 `is_admin()`。
- 7.4 的「健康检查失败是否暂停投递」仍未决策 —— 当前实现维持「只标记 + 下一条消息带
  原因」，不暂停。
