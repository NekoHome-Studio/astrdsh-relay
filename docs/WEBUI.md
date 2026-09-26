# 星驿 · Web 面板（WebUI）

> 面板长在 **DSH Web 里**（就是你现在看的这个界面），不是另起一个服务、
> 也不是 AstrBot 那边的一页。理由是数据在哪：会话映射、发件箱、IM 轮询活性
> 全都在 DSH 侧，面板离数据近一点，少一层转发就少一处会说谎的地方。

---

## 1. 它显示什么

| 区块 | 内容 | 数据来源 |
|---|---|---|
| 顶部四张卡 | 契约版本 / 已知对话数（其中已建会话数）/ **IM 是否在听** / 运行时长 | `/panel/status` |
| 对话映射表 | 每个 IM 对话 → DSH 会话 id、**标题**（DSH Web 会话列表里显示的那个）、最终生效的工作目录与**它的来源**、上次活动、发件箱条数 | 同上（`state.json` 的 records + `sessionTitleTemplate` 渲染） |
| 在途 | 有投递/审批/问答/闸门已放的对话 | 同上 |
| IM 离线提示 | 为什么此刻不会发起自主心跳 | `lastProactivePollAt` vs `proactiveImAliveMs` |

**「IM 是否在听」这一格值得单独说**：它是 DSH 侧唯一能观测到的 IM 活性证据，
也正是自主心跳 `online` 闸门取的那个判据（契约 §18.5）。面板上看到它变红，
就等于「此刻发起心跳会白烧一次 LLM 调用且回复没人取」。

---

## 2. 它**不**做什么

* **不写状态。** 只读。改指（rebind）/认领（adopt）/分支（fork）仍在 IM 里用
  `/dsh` 指令完成。写操作要过权限门，而那道门还没建（`docs/DESIGN.md` §7.3.1
  写着「不做就是提权漏洞」）——面板要是能改状态，就等于绕开它。
* **不是控制面。** P5 的控制面接管是另一件事（`docs/DESIGN.md` §7.3）。
* **不展示消息正文。** 快照里只有对话键、会话 id、标题、目录、计数。
  **不含 token、不含聊天内容**（有一条测试专门钉这件事）。

---

## 3. 打开它

面板**默认关闭**。在 profile 的 `cordis.patch.yml` 里给本插件那一行加上：

```yaml
- id: dsh-astrbot-relay
  config:
    # ……你原有的 token / cwd 等……
    panelEnabled: true
```

然后**重启 DSH**（客户端半边是随页面加载的插件，改配置不足以让它出现在界面里）。 
打开 **设置 → 星驿**，就能看到那张表。

> 配置项有两个，都在 `cordis.patch.yml` 的注释里写明了：
>
> | 键 | 默认 | 含义 |
> |---|---|---|
> | `panelEnabled` | `false` | 是否提供 `/panel/status` 只读快照 |
> | `panelAllowRemote` | `false` | 是否允许**非回环** Host 读快照 |

---

## 4. 安全模型（**刻意写清楚，别当成认证**）

`panelAccessDecision()`（`lib/panel.js`）做三件事：

1. **未启用 ⇒ 404**（不是 403）。403 等于对外宣告「这里有个东西」。
2. `Sec-Fetch-Site: cross-site` ⇒ 403。挡掉浏览器**跨站**发起的读取；
   该头缺失（老浏览器 / 非浏览器客户端）不当作跨站。
3. **非回环 Host ⇒ 403**，除非显式打开 `panelAllowRemote`。
   另加一条：`Origin` 存在时必须与 `Host` 同源（防 DNS rebinding）。

**它不是认证**：它不证明调用者是谁。**同一台机器上的任何进程都能读到这份快照**
（它和 DSH 自己的端口同级）。跨机部署若把 3080 直接暴露出去，
请**在反向代理上加认证**，而不是靠这个开关——本模块不假装自己解决了那个问题。

---

## 5. 怎么验收

三层，从便宜到贵：

```powershell
# ① 纯逻辑（零依赖，CI 里跑）
npm run test:panel

# ② 接线（假宿主，真跑路由与访问判定，也在 CI 里）
npm run test:panel-chain

# ③ 真机（需要已装 + 已重启）
curl.exe -i -H "Host: 127.0.0.1:3080" http://127.0.0.1:3080/astrbot-relay/panel/status
```

真机上期望：

| 情况 | 期望 |
|---|---|
| `panelEnabled` 未开 | `404` |
| 开着 + 本机请求 | `200` + JSON；`counts.conversations` 与你实际聊过的对话数一致 |
| 带上 `Origin: http://evil.example` | `403`，正文含 `panel/origin-mismatch` |
| 任何情况下 | 正文里**不出现** `token` / `Bearer` |

界面上则是：设置页出现「星驿」，里面那张映射表的行数 = `state.json` 里的对话数，
标题与 DSH Web 会话列表里看到的一致。

---

## 6. 已知边界

* **⚠️ 客户端半边的 `inject` 声明是「照抄本机能跑的插件」，不是逐条核实过的。**
  具体说：`dsh.client.inject` 那句
  `["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-settings"]`
  与客户端里的 `inject = ['slots']`，是照着本机已装且确实渲染出设置分区的
  `dsh-skin-market` 抄的。**`slots` 这个服务由哪个包 provide，我没有静态确认**
  （在 `@deepseek-ai/*` 里按 `provide('slots')` 搜不到，那些包是打包产物）。
  宿主半边与契约部分不受影响；但**第一次装上如果设置页里没有「星驿」分区，
  第一个要看的就是这两行 inject**——那是唯一一处「抄来的」地方。
* **客户端半边只在 Web 平台可用。** 声明里写死了 `platform: "web"`；
  别的平台没有这个界面（宿主半边不受影响）。
* **面板路由不进契约常量表。** 它用独立的 `PANEL_ROUTE`（`lib/panel.js`），
  而不是 `contract.js` 的 `ROUTES`——那张表是 IM↔DSH 协议、要与 `contract.py`
  逐字对齐并参与 `bridgeVersion` 协商；面板只是 DSH 本机的 UI 面，IM 永远不会调它。
  **因此加这个面板不需要升 `bridgeVersion`。**
* **右侧栏的 per-session 面板还没做**（`rightbar.session` 那个落点）。
  它需要拿到「当前这条会话」的上下文，属于下一步；现在这张全局表已经把
  「哪条会话来自哪个群」说清楚了。
* **改配置后必须重启 DSH**，不是热更新。客户端插件随页面加载，
  光改 `cordis.patch.yml` 不会让界面里冒出这个分区。
* **改 `client/client.js` 之后也需要重建/重启才会生效**：这个仓库不引入构建步骤，
  客户端文件是**直接发布**的（`files` 里带 `client`），没有打包产物要重建——
  但浏览器侧仍是随页面加载，所以重启 DSH（或至少刷新页面）才能看到改动。
