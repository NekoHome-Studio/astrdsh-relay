# DeepSeek Harness（已安装产物）网桥插件可用 API 核实报告（供 AstrDsh Relay 星驿使用）

核实对象：本机已安装的 dsh 产物（非源码 checkout）。

- dsh 安装根：`C:\Users\<user>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
- dsh CLI 版本：**0.1.5-rc.2**（`dsh --version` 实测输出 `0.1.5-rc.2`，exit 0）
- DSH home：`C:\Users\<user>\.dsh`（profile = `web`）
- 核实方式：逐文件阅读 `lib/*.js` 与 `lib/types/*.d.ts`，并对 `dsh` CLI 做了两次实跑验证。**本文所有结论均附「绝对路径:行号 + 代码片段」**；凡未实测的均列入「未验证」清单。

约定：为节省篇幅，下文用 `<DSH>` 代表
`C:\Users\<user>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai`。

---

## 0. 结论摘要（先看这 13 条）

| # | 结论 | 状态 |
|---|---|---|
| 1 | `ctx.webServer.register({kind, path, handler})` 存在；`kind` 只有 `'exact' \| 'prefix'`；handler 是 `(req, res) => void \| Promise<void>`，**自己拥有完整响应生命周期**（可挂住做 SSE） | **已证实** |
| 2 | **没有内建 SSE helper**。全仓库只有 3 处 `text/event-stream` 字符串：webserver 的 gzip 过滤器（排除 SSE）、dsh-client-hmr 的手写 SSE 示例、deepseek LLM 客户端。第三方 SSE 必须手写 `writeHead/write` | **已证实** |
| 3 | `ctx.webServer.register` 注册的路由**没有任何鉴权**。token/cookie + Host/Origin 栅栏由 `dsh-client-connection` 实现，且**只挂在它自己的 `/api` prefix 路由和它注册的 channel 上** | **已证实** |
| 4 | 想走鉴权 → 用 `ctx.connection.fetch.register({path, methods, requestBody, fetch})`（路径在 `/api` 之下）或 `ctx.connection.rpc.handle(channel, handler)`；也可以自己调 `ctx.connection.requestRejection(req)` 复用它的校验 | **已证实（API 声明）/ 未实跑** |
| 5 | **存在进程内编程式会话入口**：`ctx.agents.create({sessionId, meta, agentOptions, setup}) → {agent, dispose}`，`ctx.agents.resume({resumeSessionId, ...})`。投递消息用 `agent.followup(createUserMessage(...))`，等一轮结束用 `await agent.whenIdle()`，落盘用 `ctx.sessions.flush(agent.session)` | **已证实** |
| 6 | 工厂（factory）由 `dsh-agent-loop` 提供，本机 web profile **已挂载该插件**（`# == @deepseek-ai/dsh-web-app` 段内有 `- id: agent-loop`） | **已证实** |
| 7 | 事件名字符串**有两套**：进程内瞬时事件（`agent/status`/`agent/error`/`agent/inbox/inserted`/`tools/change` 等，Cordis Events；全树 `.emit("…")` 扫描**无** `agent/assistant-stream`）与持久化会话事件（`turn/start`、`assistant/message`、`turn/end`…，经 `ctx.on('session/event', …)`）。用户猜测的 `"assistant/message"`、`"turn/end"` **是真实名字** | **已证实** |
| 8 | **【本条已修订，原记录错误】**：`"assistant/chunk"` **是活事件且是本项目唯一可用的逐 token 流式源**——它在 `KNOWN_SESSION_EVENT_TYPES`（51 项，`dsh-session\lib\types\known-event-types.js`）之内，由 `dsh-agent-loop` 在 turn 循环里 `session.append("assistant/chunk", { turn, step, chunk })` 逐片写入，经 `session/event` 分发。原记「不在清单里 / 已被迁移器删除」经全树扫描为**误**。`"assistant/live-chunk"` 是**浏览器侧**合成事件，不是 host 事件——它只是 v0 老格式的遗留名字，被 v0→v1→v2 迁移器消费/删除，且不在 `KNOWN_SESSION_EVENT_TYPES` 里。`"assistant/live-chunk"` 是**浏览器侧**合成事件，不是 host 事件 | **已证实（与"存在 assistant/chunk"的假设不符）** |
| 9 | 审批拦截：`'approval/request'` 是 **waterfall hook**，签名 `(req, next) => Promise<ApprovalOutcome>`；**可以从 IM 异步拿答案再返回**（dsh-acp 就是这么干的）。审批服务**自身不设超时**；取消由 `req.signal` 驱动（预先 aborted → `'cancelled'`） | **已证实** |
| 10 | 提问拦截：`'user-questions/request'`，同样是 waterfall，返回 `AskUserQuestionAnswer` | **已证实** |
| 11 | 本机 `dsh plugin --profile web add <pkg>` **可用**（thin pnpm forwarder + 自动 reconcile `dsh.profile.bundles`），pnpm 11.22.0 已在 PATH；`dsh --profile web --dump-config` **可用**，但它会**写** `profiles\web\cordis.yml`，所以需要写权限 | **已证实（实跑）** |
| 12 | patch 覆盖语义 = **按顶层 key 赋值**（`target[key] = value`），因此显式写出的 `config:` 会被**整体替换**（不是逐字段 merge），未写出的 key 保持原值 | **已证实（代码 + 实跑 dump）** |
| 13 | 本机 web profile 的审批策略默认是 `'ask'`（除非 `DSH_PERMISSION_MODE=danger-full-access`），所以 IM 审批拦截**会真的被派发** | **已证实（实跑 dump）** |

---

## 1. HTTP 路由（确切 API 形态 / SSE / 鉴权）

### 1.1 `register` 的完整签名

定义在 `<DSH>\dsh-host-webserver\lib\types\index.d.ts`：

```ts
// index.d.ts:30-46
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
/** One named route registration. */
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns protocol negotiation and the upgraded socket after dispatch. */
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

```ts
// index.d.ts:84-114（节选）
    /** Register a named route. Duplicate (kind, path) throws — ... @returns the disposer removing the route. */
    register(route: WebRoute): () => void;
    /** Register an exact-path HTTP upgrade route. Duplicate paths throw ... */
    registerUpgrade(route: WebUpgradeRoute): () => void;
    /** Claim the fallback seat: ... One owner only — a second registration throws ... */
    registerFallback(handler: WebRoute['handler']): () => void;
    /** Register a raw-HTML index transform ... */
    tapIndex(transform: (html: string) => string): () => void;
```

- 服务名：`ctx.webServer`（`declare module` 于 `index.d.ts:15-18`；`super(ctx, "webServer")` 于 `lib\index.js:157`）。
- **返回值是 disposer**（`() => void`），卸载时删路由。
- **重复 `(kind, path)` 直接抛**：

```js
// <DSH>\dsh-host-webserver\lib\index.js:176-183
	register(route) {
		const table = route.kind === "exact" ? this.exact : this.prefixes;
		if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
		table.set(route.path, route);
		return () => {
			table.delete(route.path);
		};
	}
```

### 1.2 匹配顺序与 prefix 的尾斜杠陷阱

```js
// <DSH>\dsh-host-webserver\lib\index.js:321-331
	/** Longest-prefix-wins over the prefix table after an exact-table miss. */
	match(pathname) {
		const exact = this.exact.get(pathname);
		if (exact !== void 0) return exact;
		let best;
		for (const [prefix, route] of this.prefixes) {
			if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
			if (best === void 0 || prefix.length > best.path.length) best = route;
		}
		return best;
	}
```

即：先 exact，再最长 prefix，最后 fallback（`lib\index.js:228-244`，无 fallback 时 404）。

真实插件已经踩过这个坑并留了注释，值得照抄结论：**prefix 路由的 `path` 不要写成以 `/` 结尾**：

```ts
// C:\Users\<user>\Downloads\harness\dsh-skin-market\src\routes.ts:153-157
    // Prefix routes must not end in `/`: DSH matches descendants by appending
    // its own slash (`pathname.startsWith(`${prefix}/`)`). A trailing slash
    // here would therefore only match a double-slash URL and let normal
    // operation polling fall through to index.html.
    host.webServer.register({ kind: 'prefix', path: '/dsh-skin-market/operations', handler: (request, response) => {
```

### 1.3 SSE：没有内建 helper

全仓库 `text/event-stream` 只出现 3 次（grep 全量结果）：

- `<DSH>\dsh-host-webserver\lib\index.js:113` — 只是把 SSE 排除出 gzip：
  ```js
  // index.js:110-115
  		filter(request, response) {
  			if (response.getHeader("content-range") !== void 0) return false;
  			const contentType = response.getHeader("content-type");
  			if (typeof contentType === "string" && contentType.toLowerCase().startsWith("text/event-stream")) return false;
  			return compressionMiddleware.filter(request, response);
  		}
  ```
- `<DSH>\dsh-client-hmr\lib\index.js:117` — **本仓库内唯一的 host 侧 SSE 路由范例**。
- `<DSH>\dsh-llm-deepseek\lib\index.js:1663` — LLM 客户端请求头，与插件无关。

`dsh-client-hmr` 的完整写法（可直接照抄结构）：

```js
// <DSH>\dsh-client-hmr\lib\index.js:114-158（节选）
	const connections = /* @__PURE__ */ new Set();
	const connect = (res) => {
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"connection": "keep-alive"
		});
		res.write(": connected\n\n");
		res.write(sseData({
			type: "graph",
			graph: ctx.clientModules.graph()
		}));
		connections.add(res);
		res.on("close", () => {
			connections.delete(res);
		});
	};
	ctx.effect(() => {
		const disposeRoute = ctx.webServer.register({
			kind: "exact",
			path: EVENTS_ENDPOINT,
			handler: (req, res) => {
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.writeHead(405);
					res.end();
					return;
				}
				connect(res);
			}
		});
		...
		return () => {
			unsubscribe();
			disposeRoute();
			for (const res of connections) res.destroy();
			connections.clear();
		};
	}, "client-hmr: /plugins/events channel");
```

要点：handler **不 `end()`** 就一直挂住 → 天然支持 SSE；`res.on('close')` 清理；在 `ctx.effect` 的清理函数里 `res.destroy()` 所有连接。

### 1.4 鉴权 / token 机制

**`webServer` 本身没有任何鉴权**（`dsh-host-webserver\lib\index.js` 全文无 token/auth/origin 逻辑，handler 被直接调用：`lib\index.js:233-234`）。

鉴权在 `dsh-client-connection`：

```js
// <DSH>\dsh-client-connection\lib\index.js:552-556
	/** Apply the configured Host/Origin fence, then browser authentication. */
	requestRejection(request) {
		if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
		return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
	}
```

它只应用于两处：

1. 自己注册的 `/api` prefix 路由：
```js
// <DSH>\dsh-client-connection\lib\index.js:768-781
		const route = {
			kind: "prefix",
			path: API_PATH,
			handler: async (req, res) => {
				const rejection = connection.requestRejection(req);
				if (rejection !== void 0) {
					res.writeHead(rejection);
					res.end(rejection === 401 ? "unauthorized" : "forbidden");
					return;
				}
				await bridge(req, res, fetchHandler, maxRequestBodyBytes);
			}
		};
		webCtx.effect(() => webCtx.webServer.register(route), "client-connection: /api route");
```
2. 通过它注册的 channel：
```js
// <DSH>\dsh-client-connection\lib\index.js:602-618（节选）
	register(owner, channel, handler) {
		assertChannel(channel);
		const fetchHandler = rpcFetchHandler(channel, handler);
		const route = {
			kind: "prefix",
			path: channel,
			handler: async (req, res) => {
				const rejection = this.requestRejection(req);
				if (rejection !== void 0) { res.writeHead(rejection); res.end(rejection === 401 ? "unauthorized" : "forbidden"); return; }
				await bridge(req, res, fetchHandler);
			}
		};
		return owner.effect(() => owner.webServer.register(route), `client-connection: ${channel} rpc channel`);
	}
```

栅栏语义（明确写着"不是 auth 层"的是 Host 栅栏，401 才是认证）：

```ts
// <DSH>\dsh-client-connection\lib\types\api-request-trust.d.ts:1-13（节选）
 * ... Non-browser and remote clients pass the same fence via loopback,
 * deployment-derived LAN IP literals, or a declared `trustedHosts` authority.
 * Network reachability and authentication stay out of scope: binding policy
 * belongs to the webserver config, and this fence is not an auth layer.
```

给第三方插件的三条可用路径（都在 `HostConnectionHandle` 上有声明）：

```ts
// <DSH>\dsh-client-connection\lib\types\rpc.d.ts:84-111（节选）
export interface ConnectionFetchRoute {
    /** Absolute path below `/api`; query parameters remain available on the request URL. */
    readonly path: string;
    readonly methods: readonly ConnectionFetchMethod[];      // 'GET' | 'HEAD' | 'POST'
    readonly requestBody: ConnectionRequestBodyMode;          // 'buffered' | 'streaming'
    readonly fetch: (request: Request) => Promise<Response>;
}
export interface HostConnectionFetch {
    register(route: ConnectionFetchRoute): () => Promise<void>;
}
export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler): () => Promise<void>;
}
```
```ts
// <DSH>\dsh-client-connection\lib\types\rpc.d.ts:133-139
    /**
     * Apply Connection's Host/Origin checks and browser authentication to
     * another Web route.
     */
    requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection;  // 401 | 403 | undefined
```

> 结论：**IM 网桥若用 `ctx.webServer.register` 自建 `/astrbot-relay/...` 路由，必须自己做鉴权（共享密钥 / HMAC 头 / 白名单 IP 等）**。想白嫖 DSH 的 token 栅栏，就挂到 `/api` 之下走 `ctx.connection.fetch.register`。

### 1.5 本机实际配置（web profile）

```yaml
# docs\evidence\dump-web-composed.txt:420-429（--dump-config 实测输出）
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject:
    - webStartup
  config:
    host: !!js ctx.webStartup.host ?? '127.0.0.1'
    port: !!js ctx.webStartup.port ?? 3080
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
```
```yaml
# docs\evidence\dump-web-composed.txt:430-448
- id: web-runtime
  name: '@deepseek-ai/dsh-web-app'
  ...
- id: connection
  name: '@deepseek-ai/dsh-client-connection'
  inject:
    - webRuntime
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
```
`WebServer.Config` 字段与默认见 `<DSH>\dsh-host-webserver\lib\types\index.d.ts:47-59`。

---

## 2. 会话驱动：host 插件能否编程式创建/恢复 session 并投递消息

**能。** 入口是 `ctx.agents`（服务名 `agents`，类 `AgentRegistry`，实现在 `dsh-agent`；创建/恢复的 factory 由 `dsh-agent-loop` 注册）。

### 2.1 入口签名

```ts
// <DSH>\dsh-agent\lib\types\index.d.ts:187-199（类文档）
/**
 * Agent service (`ctx.agents`): tracks live agents and carries the initiating
 * Agent through one process-local asynchronous driver chain. Agent *creation*
 * is provided by whichever plugin implements the {@link AgentFactory}
 * (`@deepseek-ai/dsh-agent-loop`), registered via {@link setFactory}.
 * ...
 */
export declare class AgentRegistry extends Service {
```

```ts
// <DSH>\dsh-agent\lib\types\index.d.ts:270-287
    /**
     * Create and publish a new agent through the registered factory.
     * ... @returns the handle after setup, rollback-covered publication, and loop start complete.
     */
    create(options: CreateAgentOptions): Promise<AgentHandle>;
    /**
     * Load a persisted session and resume an agent on it through the registered factory.
     * ...
     */
    resume(options: ResumeAgentOptions): Promise<AgentHandle>;
```

```ts
// <DSH>\dsh-agent\lib\types\index.d.ts:48-105（CreateAgentOptions 节选）
export interface CreateAgentOptions {
    /** The live agent/session identity. */
    readonly sessionId: SessionId;
    readonly parentAgent?: Agent;
    readonly meta?: {
        readonly cwd?: string;
        readonly parentSession?: SessionId;
        readonly isSeeded?: boolean;
        readonly origin?: 'subagent';
        readonly delegationDepth?: number;
        readonly agentPreset?: string;
    };
    readonly inheritedEventCount?: SessionLogOffset;
    readonly seed?: readonly SessionEvent[];
    /** Per-agent options (model, …). */
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
}
```
```ts
// <DSH>\dsh-agent\lib\types\index.d.ts:110-129
export interface ResumeAgentOptions {
    /** The persisted session id to load and use as the live agent/session identity. */
    readonly resumeSessionId: SessionId;
    readonly parentAgent?: Agent;
    readonly agentOptions?: AgentOptions;
    readonly signal?: AbortSignal;
    readonly setup?: AgentSetup;
}
```
```ts
// <DSH>\dsh-agent\lib\types\index.d.ts:144-147
export interface AgentHandle {
    agent: Agent;
    dispose(): Promise<void>;
}
```

`AgentOptions`（模型路由）：`<DSH>\dsh-agent\lib\types\runtime-types.d.ts:21-30`（`provider` / `model` / `reasoningEffort` / `maxTokens`）。

### 2.2 Agent 的活体能力（投递/等待/取消）

```ts
// <DSH>\dsh-agent\lib\types\runtime-types.d.ts:138-209（declare module './types.ts' 内节选）
    interface Agent {
        readonly options: AgentOptions;
        /** The live session this agent drives; its log is the durable source of truth. */
        readonly session: Session;
        readonly inbox: Inbox;
        readonly status: AgentStatus;               // 'idle' | 'running'（:90）
        readonly ctx: Context;
        cancel(cause: AgentCancelCause, options?: CancelOptions): void;
        whenIdle(): Promise<void>;
        runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
        send(message: UserMessage, target: InboxTarget, wakeup: boolean): void;
        /** Queue an ordinary follow-up turn and wake the driver. */
        followup(message: UserMessage): void;
        /** Submit steering for the nearest step. */
        steer(message: UserMessage): void;
        /** Queue model-facing context for the next pre-step without waking the driver. */
        inject(message: UserMessage): void;
    }
```

用户消息构造：
```ts
// <DSH>\dsh-llm\lib\types\message.d.ts:180-183
export declare function createUserMessage<T extends NewUserMessage>(input: T & {
    readonly id?: never;
    readonly role?: never;
}): T & Pick<UserMessage, 'id' | 'role'>;
```

落盘：
```ts
// <DSH>\dsh-session\lib\types\index.d.ts:398-411
    /**
     * Dispatch the awaited `session/flush` durability checkpoint for `session`, ...
     * @returns whether at least one durability listener participated ...
     */
    flush(session: Session): Promise<boolean>;
```
`ctx.sessions` 的其余 API（`create` / `prepare` / `enter` / `announce` / `get` / `list` / `fork`）见 `<DSH>\dsh-session\lib\types\index.d.ts:317-441`。

### 2.3 现有的"正确做法"代码（可直接照抄）

**(A) 最小的一轮：`dsh-headless`（`<DSH>\dsh-headless\lib\index.js:127-167`）**

```js
async function run(ctx, task, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	const sessions = ctx.get("sessions");
	if (agents === void 0 || defaultModel === void 0 || sessions === void 0) return;
	const selection = defaultModel.currentSelection();
	const { agent } = await agents.create({
		sessionId: brandString(`session-${randomUUID()}`),
		meta: { cwd: process.cwd() },
		agentOptions: {
			provider: selection.provider,
			model: selection.model
		},
		setup: (agentCtx) => {
			installModelSelection(agentCtx, {
				current: selection,
				assembled: void 0
			});
		}
	});
	await agent.whenIdle();
	const firstSeq = agent.session.seq;
	const stopReasoning = streamReasoning(ctx, agent, io.stderr);
	try {
		agent.followup(createUserMessage({
			content: [{
				type: "text",
				text: task
			}],
			source: { kind: "user" }
		}));
		await agent.whenIdle();
	} finally {
		stopReasoning();
	}
	await sessions.flush(agent.session);
	const outcome = summarize(agent.session, firstSeq);
	io.stdout.write(outcome.text + "\n");
	...
}
```
其 **inject 声明**（同一文件 `:21-25`）：`const inject = ["agentDefaultModel", "agents", "sessions"];`

**(B) ACP 网桥：创建 / 恢复（`<DSH>\dsh-acp\lib\index.js:692-730`）**

```js
	static async create(ctx, options) {
		const modelControl = new AcpModelControl(ctx.llm, options.fallbackSelection);
		return new AcpSession(ctx, await ctx.agents.create({
			sessionId: options.sessionId,
			meta: { cwd: options.cwd },
			agentOptions: options.agentOptions,
			signal: options.signal,
			setup: async (agentCtx) => {
				modelControl.install(agentCtx);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
			}
		}), modelControl, options.notify);
	}
	static async resume(ctx, options) {
		let modelControl;
		const handle = await ctx.agents.resume({
			resumeSessionId: options.sessionId,
			agentOptions: options.agentOptions,
			signal: options.signal,
			setup: async (agentCtx, agent) => {
				modelControl = new AcpModelControl(ctx.llm, selectionFor(agent.session.requestHeader(), options.fallbackSelection));
				modelControl.install(agentCtx);
				await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
			}
		});
		...
		return new AcpSession(ctx, handle, modelControl, options.notify);
	}
```

**(C) ACP 网桥：投递一条 prompt（`<DSH>\dsh-acp\lib\index.js:831-844`）**

```js
				const message = createUserMessage({
					content,
					source: { kind: "user" }
				});
				inflight.messageId = message.id;
				inflight.messageQueued = true;
				if (promptSelection !== void 0) this.pendingSelections.set(message.id, promptSelection);
				try {
					this.agent.followup(message);
				} catch (error) {
					inflight.messageQueued = false;
					this.pendingSelections.delete(message.id);
					throw error;
				}
```

**(D) Webhook → 新 Session：带 workspace / preset / 权限 / 标题 / 回滚（`<DSH>\dsh-webhook\lib\types\session.js:88-145`）**

```js
export async function createWebhookSession(ctx, delivery, ruleId, request, signal) {
    const resolved = resolveRequest(ctx, request);
    ctx.permissionPresets.resolve(resolved.permissionPreset);
    const preset = await ctx.agentPresets.resolve(resolved.agentPreset);
    await ctx.agentPresets.standingKeyFor(preset.id);
    signal.throwIfAborted();
    const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath);
    signal.throwIfAborted();
    const sessionId = brandString(`webhook-${randomUUID()}`);
    const handle = await ctx.agents.create({
        sessionId,
        signal,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        agentOptions: resolved.agentOptions,
        setup: async (agentCtx) => {
            await ctx.agentPresets.mount(agentCtx, preset.id);
            installInitialModelSelection(agentCtx, resolved.modelSelection);
        },
    });
    let attached = false;
    try {
        signal.throwIfAborted();
        await workspace.attachSession(sessionId);
        attached = true;
        signal.throwIfAborted();
        ctx.permissionPresets.set(handle.agent.session, resolved.permissionPreset);
        ctx.sessionTitle.rename(handle.agent.session, resolved.title);
        handle.agent.followup(createUserMessage({
            content: [{ type: 'text', text: resolved.prompt }],
            source: { kind: 'webhook', provider: delivery.kind, ... },
        }));
    }
    catch (error) { /* detach + handle.dispose() 回滚 */ }
}
```

> **对 IM 网桥的直接启示**：`dsh-webhook` 是产品里最接近"外部事件 → 新 Session"的设施，但它是 **fire-and-forget**：README 明确写"runtime 不等待 idle、不执行特殊 flush、不检查回复，也不发布完成状态"（`<DSH>\dsh-webhook\README.zh.md:41`），已知限制里也写"**无完成结果** — HTTP 接受与规则结算都不报告 Agent 成功、idle 或输出"（同文件 `:73`）。**所以 webhook 不能拿来回推流式输出**；回推必须由网桥自己订阅事件（见第 3 节）。

### 2.4 其它可参考的"外部驱动"入口

- **`dsh-sdk-jsonrpc-server`**：进程外客户端经 **stdio JSON-RPC** 驱动 harness。`prompt(params: SessionPromptParams): Promise<SessionPromptResult>`（`<DSH>\dsh-sdk-jsonrpc-server\lib\types\server.d.ts:47`），README 描述为："为每个 `sessionId` 打开一个会话、把用户提示词排入队列，并把每个会话事件与 agent 状态转换实时流回客户端"；`session/prompt` 立刻返回 `{ messageId }`，随后每个持久事实作为 `session.event`、每次生命周期状态转换作为 `session.status` 流式发出（`<DSH>\dsh-sdk-jsonrpc-server\README.zh.md`）。**但它是 stdio 传输 + 需要独占 stdout**，不能直接当 HTTP IM 网桥用，只宜作为"另一个进程里再开一个 headless dsh"的参考。
- **`dsh-acp`**：进程外 ACP 客户端同样驱动会话（`dsh-acp\lib\index.js:1308-1322` 的 `session/new` / `prompt` / `cancel` / `session/update`）。它是完整功能的宿主网桥范例（含审批透传），是最值得抄的对象。

### 2.5 本机 web profile 是否具备这些服务

取自实测 `--dump-config` 输出：`agent-loop`（`docs\evidence\dump-web-composed.txt:367-368`）、`webserver`（`:420-421`）、`connection`（`:443-444`）、`user-questions`（`:38-39`）、`user-approval`（`:121`）、`agent-presets`（`:536-539`，`default: standard`）。

---

## 3. 流式事件：确切事件名 + payload 结构 + 定义位置

**关键区分**：`dsh` 有**两套**事件词汇，都可用，但语义不同。

### 3.1 第一套：进程内瞬时事件（Cordis `Events`，**不落盘**）

定义位置：`<DSH>\dsh-agent\lib\types\runtime-types.d.ts:212-418`。

| 事件名字符串 | mode | payload | 行号 |
|---|---|---|---|
| `'agent/created'` | emit | `{ agent }` | `:224-226` |
| `'agent/disposed'` | emit | `{ agent }` | `:235-237` |
| `'agent/status'` | emit | `{ agent, status }`（`'idle'\|'running'`） | `:247-250` |
| `'agent/inbox/inserted'` | emit | `{ agent, message }` | `:258-261` |
| `'agent/inbox/claimed'` | emit | `{ agent, message, turn }` | `:272-276` |
| `'agent/inbox/discarded'` | emit | `{ agent, message }` | `:284-287` |
| `'agent/session-start'` | emit | `{ agent, source }`（`'startup'\|'resume'\|'clear'\|'compact'`，`:105`） | `:298-301` |
| `'agent/pre-step'` | **waterfall** | `{ agent, messages, turn, step, signal }`, `next: () => Promise<PreStepDecision>` | `:313-319` |
| `'agent/request'` | **waterfall** | `{ agent, turn, step, signal }`, `next: () => Promise<LlmCallConfig>` | `:336-341` |
| `'agent/request-error'` | **waterfall** | `{ agent, turn, step, provider, failure, retryPolicy, signal }` | `:357-365` |
| ~~`'agent/assistant-stream'`~~ | **不存在（已证伪）** | 0.1.2-rc.1 全树 724 个 `.js/.mjs/.cjs` 中 `emit("agent/assistant-stream")` **0 命中**，`AssistantStream` 0 命中；本机宿主对应行段不存在 | **已证伪** |
| `'agent/turn-stopping'` | serial | `{ agent, turn, signal }` | `:396-400` |
| `'agent/error'` | emit | `{ agent, turn, step, error }` | `:411-416` |

> **【已证伪，勿照抄以下类型】** 本机宿主 `@deepseek-ai/dsh@0.1.2-rc.1` 全树无 `agent/assistant-stream`、无 `AssistantStreamFrame`。流式文本的**正确入口**是 `ctx.on('session/event', (session, event) => …)` 里的 `assistant/chunk`（`event.data.chunk`，字段见 :656-676）。以下为旧文档残留，仅供比对：

```ts
// <DSH>\dsh-agent\lib\types\runtime-types.d.ts:106-137
/** One process-local live assistant streaming publication. */
// 【已证伪】本机宿主中该类型不存在 —— 仅供比对
// export type AssistantStreamFrame = {
    readonly type: 'start';
    readonly attemptId: LlmAttemptId;
    /** Monotone within one attached Agent lifecycle; replacement restarts at 1. */
    readonly revision: number;
    readonly turn: number;
    readonly step: number;
} | {
    readonly type: 'chunk';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    /** Dense zero-based position within the attempt. */
    readonly index: number;
    /** Safe-integer timestamp reused by the durable embedded stream. */
    readonly time: number;
    readonly chunk: StreamChunk;
} | {
    readonly type: 'end';
    readonly attemptId: LlmAttemptId;
    readonly revision: number;
    /** Number of chunk frames emitted by this attempt. */
    readonly index: number;
    readonly outcome: {
        readonly kind: 'committed';
        readonly eventType: 'assistant/message' | 'assistant/attempt';
        readonly seq: SessionSeq;
    } | {
        readonly kind: 'abandoned';
    };
};
```

`StreamChunk` 的封闭联合（**逐 token delta 的确切字段名**）：

```ts
// <DSH>\dsh-llm\lib\types\types.d.ts:359-389
export type StreamChunk = {
    type: 'block-start';
    index: number;
    blockType: ContentBlockType;
} | {
    type: 'text-delta';
    index: number;
    text: string;
} | {
    type: 'reasoning-delta';
    index: number;
    text: string;
} | {
    type: 'tool-call-delta';
    index: number;
    id: ToolCallId;
    name?: string;
    argumentsDelta: string;
} | {
    type: 'block-end';
    index: number;
    block: ContentBlock;
} | {
    type: 'usage';
    usage: TokenUsage;
} | {
    type: 'finish';
    reason: FinishReason;
    /** Replay metadata for a successful response; see {@link ReplayEnvelope}. */
    replayState?: ReplayEnvelope;
};
```

> **⚠️ 修订（宿主 0.1.2-rc.1 实证）**：本文档旧版此处记录的发射点
> `dispatch.emit("agent/assistant-stream", { frame })` 与 `AssistantStreamAttempt`，
> 已对 `<DSH>
ode_modules\@deepseek-ai` 下全部 2132 个 `.js/.mjs/.cjs/.ts/.d.ts/.json`
> 文件做全量字符串扫描：`assistant-stream` 与 `AssistantStream` **均 0 命中**（同批次
> `assistant/message` 53 文件命中，扫描器有效）。该事件在 `0.1.2-rc.1` 中**不存在**，
> 属于文档沿用了旧版本 / 错误包的记录。**P2 回程绝不可照抄该事件名与帧结构。**

**真正的发射点**——`dsh-agent-loop` 把每个流式分片写进**持久化会话日志**：

```js
// <DSH>\dsh-agent-loop\lib\index.js（turn 循环内，for await (const chunk of stream)）
		this.session.append("assistant/chunk", { turn, step, chunk });
```
`session.append` 提交后即向所有订阅者广播 `session/event`（见 3.2 节），
回调签名是 `(session, event)`，分片本体在 `event.data.chunk`。

**权威消费范例**（`dsh-headless` 把 reasoning 打到 stderr，全文仅 6040 字节 / 186 行）：

```js
// <DSH>\dsh-headless\lib\index.js:74-109（节选，函数 streamReasoning）
	const dispose = ctx.on("session/event", (session, event) => {
		if (session !== agent.session) return;          // ← scope 过滤：按 session 对象身份
		if (event.type === "turn/start") { close(); started = true; return; }
		if (!started || event.type !== "assistant/chunk") return;
		const chunk = event.data.chunk;                 // ← chunk 在 event.data.chunk
		switch (chunk.type) {
			case "reasoning-delta": ... stderr.write(chunk.text); return;
			case "block-start": ...
			case "block-end": ...
			case "usage": return;
			case "text-delta":
			case "tool-call-delta":
			case "finish":
				close();
				return;
			default: return assertNever(chunk, "headless reasoning stream");
		}
	});
```

**要点**：`StreamChunk` 是**封闭联合**，`switch` 必须穷尽；未知变体应 `assertNever`
**抛错**而非静默吞掉，否则新版本新增分片类型时会出现"流卡住但不报错"。
`session/event` 只报**本进程内新产生**的事件（构造函数 seed 灌入的历史日志不 emit），
若需重放历史必须自行读 store。

**scope 过滤注意**：这些事件用 `this: Scoped<Session>` / `Scoped<Agent>` 派发，
但**未打 tag 的监听者（例如在 host 根 ctx 注册的插件）会收到所有 session / agent 的事件**：

```js
// <DSH>\dsh-scope\lib\index.js:327-338
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;                       // ← untagged listener: 全局接收
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}
```
所以 IM 网桥必须在 handler 内**按 `agent` / `session` 对象身份过滤**（`dsh-headless:75` 用 `session !== agent.session`，`dsh-acp\lib\index.js:1102-1104,1116` 同理）。

### 3.2 第二套：持久化会话事件（`ctx.on('session/event', ...)`，**落盘、可重放**）

```ts
// <DSH>\dsh-session\lib\types\index.d.ts:51-62
        /**
         * Post-commit, fire-and-forget append feed. ...
         * @param session - the session whose log grew.
         * @param event - the appended event, exactly as recorded.
         * @mode emit
         */
        'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
```

**权威全量名单**（生成的持久化目录，共 55 个名字）：

```js
// <DSH>\dsh-session\lib\types\known-event-types.js:21-78
export const KNOWN_SESSION_EVENT_TYPES = new Set([
    'agent-preset/selected',
    'agent/inbox/spliced',
    'approval/asked',
    'approval/decided',
    'approval/policy',
    'assistant/attempt',
    'assistant/message',
    'command/done',
    'command/run',
    'compaction/end',
    'compaction/prune',
    'compaction/start',
    'compaction/summary',
    'deliverables/presented',
    'feedback/message-delete',
    'feedback/message-put',
    'feedback/record',
    'goal/change',
    'hook/invoked',
    'hook/result',
    'llm/retry',
    'llm/retry-started',
    'model/selection',
    'permission/preset',
    'plan/mode',
    'request/context',
    'request/header',
    'sandbox/mode',
    'schedule/change',
    'session-log-deepseek/delivery-accepted',
    'session/end-seed',
    'session/title',
    'session/title-llm-request',
    'step/end',
    'step/start',
    'subagent/catalog',
    'subagent/descriptor',
    'subagent/model-selection-policy',
    'system/message',
    'team/member',
    'team/message/delivered',
    'team/message/queued',
    'team/task',
    'todo/write',
    'tool-workflow/agent-end',
    'tool-workflow/agent-start',
    'tool-workflow/run-end',
    'tool-workflow/run-start',
    'tool/call',
    'tool/ptc-dispatch',
    'tool/ptc-dispatch-start',
    'tool/result',
    'turn/end',
    'turn/start',
    'user/message',
    'web/deepseek-search-llm-request',
]);
```

**核心 payload 结构**（`SessionEventMap`，`<DSH>\dsh-session\lib\types\types.d.ts:242-404`）：

```ts
// types.d.ts:242-273
export interface SessionEventMap {
    'turn/start': { turn: number; };                                        // :249-251
    'turn/end': { turn: number; reason: TurnEndReason; };                   // :260-263
    'step/start': { turn: number; step: number; };                          // :265-268
    'step/end': { turn: number; step: number; };                            // :270-273
```
```ts
// types.d.ts:281
    'user/message': UserMessage;
```
```ts
// types.d.ts:294-327
    'system/message': { turn: number; step: number; message: SystemMessage; };
    'assistant/message': {
        turn: number;
        step: number;
        message: AssistantMessage;
        /** Exact timed model stream, compacted without joining delta boundaries. */
        stream: AssistantStreamRecord[];
        usage?: TokenUsage;
        interrupted?: true;
    };
    'assistant/attempt': {
        turn: number;
        step: number;
        stream: AssistantStreamRecord[];
    };
```
```ts
// types.d.ts:333-361
    'tool/call': { turn: number; step: number; callId: ToolCallId; name: string; arguments: string; };
    'tool/result': { turn: number; step: number; message: ToolResultMessage; error?: { name: string; code: string; }; meta?: JsonValue; };
```
```ts
// types.d.ts:366-403
    'request/header': { header: EpochHeader; reason: RequestHeaderReason; startsSeries?: true; };
    'request/context': RequestContext;
    'session/end-seed': { inherited?: true; };
```

其它插件追加进同一 map 的名字（示例）：`'approval/asked'` / `'approval/decided'`（`<DSH>\dsh-user-approval\lib\types\types.d.ts:37-51`）、`'agent/inbox/spliced'`（`<DSH>\dsh-agent\lib\types\types.d.ts:80-86`）。

**消费范例（把持久事件投影成外部流）**：

```js
// <DSH>\dsh-acp\lib\index.js:1102-1105（订阅）
	ctx.on("session/event", (session, event) => {
		const record = sessions.get(session.header.id);
		if (record?.ownsSession(session) === true) record.onSessionEvent(session, event);
	});
```
```js
// <DSH>\dsh-acp\lib\index.js:877-913（投影）
	onSessionEvent(session, event) {
		try {
			if (event.type === "assistant/message") { ... }
			else if (event.type === "tool/call") { ... }
			else if (event.type === "tool/result") { ... }
		} finally {
			const inflight = this.inflight;
			if (inflight !== void 0 && event.type === "turn/end" && inflight.turn === event.data.turn) inflight.endReason = event.data.reason;
			if (event.type === "turn/end") this.modelControl.releaseTurn(event.data.turn);
		}
	}
```

### 3.3 明确了"不存在"的名字（避免设计被带偏）

| 名字 | 事实 | 证据 |
|---|---|---|
| `"assistant/chunk"` | **【已修订】是活事件**：在 `KNOWN_SESSION_EVENT_TYPES`（51 项）中，由 `dsh-agent-loop` 逐片 append，`session/event` 可见，`event.data.chunk` 为 `StreamChunk` 封闭联合 | `dsh-session\lib\types\known-event-types.js`（含 `assistant/chunk`）；`dsh-agent-loop\lib\index.js`（append 点）；原先引用的 `v1-to-v2:6` 系**误读** | `<DSH>\dsh-session-format-v0-to-v1\lib\index.js:37`（`"assistant/chunk": disposition([...])`）、`:42`；`<DSH>\dsh-session-format-v1-to-v2\lib\index.js:6`（把 `assistant/chunk` 从 retained 里过滤掉）、`:15` |
| `"assistant/live-chunk"` | **浏览器侧合成事件**，不是 host 事件。在 host→client 投影里由 `agent/assistant-stream` 的 chunk 帧生成 | 声明：`<DSH>\dsh-cordis-client-runner\lib\client.js:1657`；构造：`<DSH>\dsh-api-session-controller\lib\types\client\sessions\assistant-stream.js:39,109` |
| `"assistant/delta"` 之类 | **未找到证据** | 全仓库 grep 无该字符串 |

> 也就是说：**host 侧插件拿流式文本只有一条路** —— 订阅 `session/event`，取 `assistant/chunk` 的 `text-delta` / `reasoning-delta` 分片（逐 token，进程内新事件；`turn/start` 起、`turn/end` 收），末尾用 `assistant/message` 取权威全文 + `usage`。~~(a) 订阅 `agent/assistant-stream`~~ 已证伪，不存在该事件。

---

## 4. 审批与提问拦截

### 4.1 `approval/request`：waterfall，可异步外部作答

```ts
// <DSH>\dsh-user-approval\lib\types\types.d.ts:67-78
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for one decision. Return an outcome to claim the
         * request or call `next()` to delegate. Scope-filtered dispatch
         * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
         * @param req - pending approval request.
         * @mode waterfall
         */
        'approval/request'(this: Scoped<Agent>, req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome>;
    }
}
```

请求与结果词汇：

```ts
// <DSH>\dsh-user-approval\lib\types\types.d.ts:22-26
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

// :54-66
export interface ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    readonly signal?: AbortSignal;
}
```
```ts
// <DSH>\dsh-user-approval\lib\types\index.d.ts:56-81（服务侧更全的 ApprovalRequest，含 callId/reason/signal 语义）
export interface ApprovalRequest extends ApprovalRequestEvent {
    readonly agent: Agent;
    readonly toolName: string;
    readonly callId?: ToolCallId;
    readonly reason?: string;
    /**
     * Aborting withdraws the question: the request settles `'cancelled'`
     * immediately and a late answer from a still-pending answerer is discarded.
     */
    readonly signal?: AbortSignal;
}
```

服务入口：`ctx.approval.request(req): Promise<ApprovalOutcome>`（`<DSH>\dsh-user-approval\lib\types\index.d.ts:109-127`）。

**派发与失败关闭 / 取消行为**：

```js
// <DSH>\dsh-user-approval\lib\index.js:175-192
	async decide(req, session) {
		const signal = req.signal;
		if (signal?.aborted) return "cancelled";
		if (this.effectivePolicy(session) === "never") return "rejected";
		const answer = Promise.resolve().then(() => this.ctx.waterfall(scopeTarget(req.agent, req.agent), "approval/request", req, () => Promise.resolve("unavailable"))).then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable");
		if (signal === void 0) return answer;
		return await new Promise((resolve) => {
			const onAbort = () => {
				signal.removeEventListener("abort", onAbort);
				resolve("cancelled");
			};
			signal.addEventListener("abort", onAbort, { once: true });
			answer.then((outcome) => {
				signal.removeEventListener("abort", onAbort);
				resolve(outcome);
			});
		});
	}
```

**结论（针对"能否异步从 IM 拿答案再返回"）：**

- **能。** handler 返回一个 Promise，`await` 多长都行；`dsh-acp` 正是这么做的（转发给 ACP 客户端并 await 其响应）：

```js
// <DSH>\dsh-acp\lib\index.js:1115-1138
	ctx.on("approval/request", (request, next) => {
		const record = ownedRecord(request.agent);
		if (record === void 0 || request.callId === void 0) return next();
		const callId = request.callId;
		return record.drainUpdates().then(() => {
			const params = {
				sessionId: record.agent.session.id,
				toolCall: { toolCallId: callId },
				options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
				          { optionId: "reject-once", name: "Reject", kind: "reject_once" }]
			};
			return conn.request(methods.client.session.requestPermission, params);
		}).then(({ outcome }) => {
			if (outcome.outcome === "cancelled") return "cancelled";
			return outcome.optionId === "allow-once" ? "allowed-once" : "rejected";
		});
	});
```

- **超时**：审批服务**自己不设任何超时**（全文无 setTimeout/计时器）。未作答就永远挂着。
- **取消**：唯一取消来源是 `req.signal`。`signal` 由**发起方**给出——工具执行路径传的是当前 turn 的 signal：

```js
// <DSH>\dsh-tools\lib\index.js:3330-3336
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
```
因此"用户取消/超时"表现为：turn 被 cancel → signal abort → 你的 handler 也在同一 Promise 竞赛里被 `'cancelled'` 抢先解决（`lib\index.js:181-191`）。**IM 网桥应当自己也监听 `request.signal`**（或在自己的 fetch 上设超时），否则一条没人回的审批会永久堵住该 turn。

- **审计约束（重要坑）**：`approval/asked` + `approval/decided` 必须成对且**包在一个已开启的 turn 内**，否则直接抛：

```js
// <DSH>\dsh-user-approval\lib\index.js:131-146
	async request(req) {
		const session = req.agent.session;
		if (!hasOpenTurn(session)) throw new Error("approval.request() outside an open turn: the approval/asked + approval/decided audit pair must be turn-enclosed (a bare event between turns is crash-tail garbage on reload). Ask from inside the turn that needs the decision.");
		const id = ApprovalRequestId(randomUUID());
		session.append("approval/asked", { id, toolName: req.toolName, ... });
		const outcome = await this.decide(req, session);
		session.append("approval/decided", { id, outcome });
		return outcome;
	}
```

- **策略**：`'ask'`（默认，交给 answerer 链）/ `'never'`（不问任何人，直接 `'rejected'`）。
```ts
// <DSH>\dsh-user-approval\lib\types\index.d.ts:36-48（节选）
export type ApprovalPolicy = 'ask' | 'never';
export declare const APPROVAL_POLICIES: readonly ApprovalPolicy[];
```
（配置默认字段见同文件 `:83-91`；`ctx.approval.setPolicy(agent, policy)` 见 `:108`。）

**本机 web profile 的实际策略**（决定了 IM 审批拦截到底会不会被触发）：

```yaml
# docs\evidence\dump-web-composed.txt:120-125
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js >-
      (process.env.DSH_PERMISSION_MODE ?? 'workspace-write') ===
      'danger-full-access' ? 'never' : 'ask'
```
即：除非进程环境把 `DSH_PERMISSION_MODE` 设为 `danger-full-access`，**默认就是 `'ask'`** → `'approval/request'` waterfall 会被派发，IM 网桥的审批拦截**有实际触发机会**。
另外 permission preset（`dump-web-composed.txt:126-133+`）里 `read-only.approval: ask`、`workspace-write: ...`，可按会话覆盖。

### 4.2 `user-questions/request`：同样的 waterfall 形状

```ts
// <DSH>\dsh-user-questions\lib\types\types.d.ts:68-79
declare module '@deepseek-ai/cordis' {
    interface Events {
        /**
         * Ask composed answerers for structured user input. Return an answer to
         * claim the request or call `next()` to delegate. ...
         * @mode waterfall
         */
        'user-questions/request'(this: Scoped<Agent>, request: AskUserQuestionRequestEvent, next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer>;
    }
}
```
```ts
// <DSH>\dsh-user-questions\lib\types\types.d.ts:55-67
export interface AskUserQuestionAnswer { answers: AskUserQuestionAnswerItem[]; }
export interface AskUserQuestionRequestEvent {
    questions: AskUserQuestionItem[];
    agent?: Agent;
    signal?: AbortSignal;
}
```
```ts
// <DSH>\dsh-user-questions\lib\types\index.d.ts:26-45（节选）
export declare class UserQuestionService extends Service {
    /**
     * Ask the scoped answerer waterfall and wait for the user's answer.
     * ... @throws {UserQuestionError} code `ASK_ABORTED` when the supplied signal
     *   is already or becomes aborted, `CALLER_NOT_LIVE` when a supplied agent
     *   is not the registry's exact live instance, or `DELEGATED_CALLER` when
     *   that live agent is owned by another agent.
     */
    ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>;
}
```
注意：`agent` 是人机交互的边界依据——**只有"精确的活体 runtime root"才允许提问**（子 agent 没有人类 answerer，会永久阻塞）。IM 网桥若把外部消息伪装成提问方，要遵守同一约束。

---

## 5. 插件安装路径（本机现状，非源码 checkout）

### 5.1 `dsh` CLI 能力核实（实跑）

| 命令 | 结论 | 证据 |
|---|---|---|
| `dsh --version` | **可用**，输出 `0.1.5-rc.2`，exit 0 | 实跑 |
| `dsh plugin --profile <name> <pnpm args>` | **存在**：初始化缺失 profile → `spawnSync("pnpm", args, {cwd: profileDir, shell: win32})` → reconcile bundles | `lib\bin.js:105-113`；`lib\plugin-Ddi42qoW.js:101-128` |
| 相对路径锚定 | `add .` 之类会被重写成调用目录的绝对路径（避免在 profile 里自我链接） | `lib\plugin-Ddi42qoW.js:90-94` |
| pnpm 缺失 | 返回 127 并打印提示；git 插件构建被 pnpm 拦截时另给 allowBuilds 提示 | `lib\plugin-Ddi42qoW.js:114-119,125` |
| 本机 pnpm | **存在**，版本 `11.22.0`（`C:\Users\<user>\AppData\Roaming\npm\pnpm.ps1`） | 实跑 |
| `dsh --profile web --dump-config` | **选项存在**（`lib\bin.js:85`），实跑进入 `runDumpConfig` | `lib\dump-config-lFgMwK8i.js:24-25` |
| `--dump-config` 的副作用 | **会写 profile 根配置文件**：`writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)`。在我的沙箱下第一次实跑直接 `EPERM`。改用 `DSH_HOME` 指向工作区副本后成功，输出 18266 字符 | 失败栈指向 `lib\profile-boot-Dk-7KqJc.js:209`；成功输出存于 `C:\Users\<user>\Downloads\astrdsh\docs\evidence\dump-web-composed.txt` |

```
# 第一次（真实 home）实跑结果（节选）
Error: EPERM: operation not permitted, open 'C:\Users\<user>\.dsh\profiles\web\cordis.yml'
    at writeFileSync (node:fs:2412:20)
    at prepareProfile (file:///C:/Users/<user>/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/profile-boot-Dk-7KqJc.js:209:2)
    at runDumpConfig (.../dsh/lib/dump-config-lFgMwK8i.js:25:17)
    at runCli (.../dsh/lib/bin.js:162:4)
```

**复现说明（给后续 agent）**：第二次成功的那次实跑，我创建了一个临时探针 DSH home
`C:\Users\<user>\Downloads\astrdsh\.dsh-probe\`，内容为 `profiles\web\{package.json, cordis.patch.yml}` 的副本，
并用 `node_modules` 目录联接（junction）指回 `C:\Users\<user>\.dsh\profiles\web\node_modules`，然后
`$env:DSH_HOME=<probe>` + `dsh --profile web --dump-config`。
**该 junction 已在取证后删除（真实目录完好无损），因此现在重跑该命令会因为缺 `node_modules` 而失败**——
如需重跑，先重建联接：
`New-Item -ItemType Junction -Path "<probe>\profiles\web\node_modules" -Target "C:\Users\<user>\.dsh\profiles\web\node_modules"`。
证据本身已固化在 `docs\evidence\*.txt`，不依赖探针目录。

`dsh plugin` 的 reconcile 逻辑（决定新装的包会不会自动成为 profile 层）：
```js
// <DSH>\dsh\lib\plugin-Ddi42qoW.js:34-59（节选）
/**
* Reconcile `dsh.profile.bundles` against the installed state: pnpm has
* already written the real installed names ... A dependency that resolves to a `dsh.bundle`-declaring
* package joins the layer stack (appended in dependency order); ...
*/
function reconcilePlugins(before, profileDir) {
	const after = readProfileManifest(NAME, profileDir);
	const beforeDeps = new Set(Object.keys(before.dependencies ?? {}));
	const dependencies = Object.keys(after.dependencies ?? {});
	const plugins = after.dsh?.profile?.bundles ?? [];
	let changed = false;
	for (const packageName of dependencies) {
		const isBundle = exportsPatch(packageName, profileDir);
		if (isBundle && !plugins.includes(packageName)) {
			plugins.push(packageName);
			changed = true;
		} else if (!isBundle && !beforeDeps.has(packageName)) process.stderr.write(`${NAME}: warning: ${packageName} declares no dsh.bundle — installed as a plain dependency, not a profile layer ...`);
	}
	...
}
```
其中"是不是 bundle"看 `package.json` 的 `dsh.bundle.patch`：
```js
// <DSH>\dsh\lib\plugin-Ddi42qoW.js:25-33
function exportsPatch(packageName, profileDir) {
	let dir;
	try { dir = resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir); } catch { return false; }
	return readProfileManifest(NAME, dir).dsh?.bundle?.patch !== void 0;
}
```

### 5.2 本机 `profiles\web` 现状（逐文件贴出）

目录树：
```
C:\Users\<user>\.dsh\
  attachments\  llm-deepseek\  profiles\  sessions\  skills\  storages\
  .anonymous-user-id  .credentials.yaml  .dshw-size.json  .dshw-usage.json  .env  settings.yaml
  （注意：**没有** home 级 cordis.patch.yml）

C:\Users\<user>\.dsh\profiles\
  node_modules\  web\

C:\Users\<user>\.dsh\profiles\web\
  .dsh-module-fallback\  .dsh-skin-market\  node_modules\
  .npmrc  cordis.patch.yml  cordis.yml  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
```

`profiles\web\package.json`（**原文**）：
```json
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {
    "@dsh-external/dsh-client-ui-skin-maid-atelier": "github:Small-tailqwq/dsh-deep-whale#51ff7b80ee163596672b98194d8877e196ac460b&path:maid-atelier",
    "dsh-client-liang-intensity-skin": "github:kingOfSoySauce/dsh-liang-skin#976fcbf9b4a91b79f14b90c16cbe0d3f553c2bd3",
    "dsh-skin-market": "^0.1.32",
    "dsh-whale-widget": "^0.2.5",
    "open-sea-skin": "github:d-dev0101/open-sea-skin#2437d80a96de4124c54fbe89872fa7090103f025"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-skin-market",
        "dsh-whale-widget",
        "dsh-client-liang-intensity-skin",
        "open-sea-skin",
        "@dsh-external/dsh-client-ui-skin-maid-atelier"
      ]
    }
  }
}
```
（`C:\Users\<user>\.dsh\profiles\web\package.json:1-24`）

`profiles\web\cordis.patch.yml`（**原文**，4 行）：
```yaml
- id: open-sea-skin
  disabled: true
- id: liang-intensity-skin
  disabled: true
```
（`C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml:1-4`）

`profiles\web\cordis.yml`（**原文**，空树 + 注释）：
```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```
（`C:\Users\<user>\.dsh\profiles\web\cordis.yml:1-4`）

`profiles\web\pnpm-workspace.yaml`（**原文**）：
```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
minimumReleaseAgeExclude:
  - dsh-skin-market@0.1.30
  - dsh-skin-market@0.1.32
  - dsh-whale-widget@0.2.5
```

`profiles\web\.npmrc`（**原文**）：
```
# Slow/flaky GitHub network tolerance for the skin market's plugin installs.
# GitHub tarball downloads from this machine are slow and stall; pnpm's default
# 60s fetch timeout aborts mid-download. Raise it and retry more.
fetch-timeout=600000
fetch-retries=6
fetch-retry-mintimeout=5000
fetch-retry-maxtimeout=60000
fetch-retry-factor=3
```

`profiles\web\node_modules\` 顶层（**hoisted，真实目录**）：`.bin\ .pnpm\ @dsh-external\ @phosphor-icons\ @primer\ ajv\ dsh-client-liang-intensity-skin\ dsh-skin-market\ dsh-whale-widget\ fast-deep-equal\ fast-uri\ json-schema-traverse\ open-sea-skin\ require-from-string\ yaml\` + `.modules.yaml .package-map.json .pnpm-workspace-state-v1.json`。
→ 也就是说**第三方插件是走 pnpm 装到 profile 的 `node_modules`**，不是 junction 到 `.dsh\plugins\`。

### 5.3 层叠顺序与 patch 覆盖语义（代码 + 实跑双重验证）

代码（唯一权威的层序）：

```js
// <DSH>\dsh\lib\profile-boot-Dk-7KqJc.js:212-219
/** The full patch stack of one composed profile, in application order. */
function allPatches(composed) {
	return [
		...composed.bundlePatches,
		...composed.profile.patches,
		...composed.homePatches,
		...composed.overlays
	];
}
```
```js
// <DSH>\dsh\lib\profile-boot-Dk-7KqJc.js:221-247（节选）
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order ..., the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays, ...
	const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? [];
	const overlays = patchFiles.flatMap((file) => loadOverlayPatches(NAME, resolve(file)));
	const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
	const rows = new Map();
	for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays]))
		if (typeof row.id === "string") rows.set(row.id, row);
```
`homePatchPath` 定义：`lib\profile-boot-Dk-7KqJc.js:116`（= `$DSH_HOME/cordis.patch.yml`）。patch 文件热重载：同文件 `:321-336`（`patchReload === "live"` 时 watch profile 级与 home 级 patch 文件）。

实跑（`--dump-config`）证实层序与"patch 覆盖"：

```
# C:\Users\<user>\Downloads\astrdsh\docs\evidence\dump-web-composed.txt 尾部
# == dsh-skin-market
- id: dsh-skin-market
  name: dsh-skin-market
# == dsh-whale-widget
- id: dsh-whale-widget
  name: dsh-whale-widget
# == dsh-client-liang-intensity-skin, patched by C:\...\profiles\web\cordis.patch.yml
- id: liang-intensity-skin
  name: dsh-client-liang-intensity-skin
  disabled: true
# == open-sea-skin, patched by C:\...\profiles\web\cordis.patch.yml
- id: open-sea-skin
  name: open-sea-skin
  disabled: true
# == @dsh-external/dsh-client-ui-skin-maid-atelier
- id: ui-skin-maid-atelier
  name: '@dsh-external/dsh-client-ui-skin-maid-atelier'
```

再加一层 home patch（我在探针 home 写 `cordis.patch.yml` 写 `- id: open-sea-skin / disabled: false`）后重跑，输出变成：

```
# == open-sea-skin, patched by C:\...\profiles\web\cordis.patch.yml, C:\...\.dsh-probe\cordis.patch.yml
- id: open-sea-skin
  name: open-sea-skin
```
→ **home 层在 profile 层之后生效并成功反转 `disabled`**：层序得到实证。（输出存于 `C:\Users\<user>\Downloads\astrdsh\docs\evidence\dump-web-with-home-patch.txt`）

**patch 覆盖语义（确切代码）**：

```js
// <DSH>\cordis-plugin-include\lib\index.js:57-106（节选）
function applyEntryPatches(data, patches, warn) {
	data = structuredClone(data);
	...
	for (const patch of patches) {
		const { id, insert, name, ...overrides } = patch;
		if (insert) {
			if (id) {
				const target = entryMap.get(id);
				if (!target) { warn("patch insert: entry %C not found", id); continue; }
				if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
				if (!Array.isArray(target.config)) target.config = [];
				target.config.push(...insert);
			} else data.push(...insert);
			buildMap(insert);
			continue;
		}
		if (!id) { warn("patch: id is required for non-insert patches"); continue; }
		const target = entryMap.get(id);
		if (!target) { warn("patch: entry %C not found", id); continue; }
		if (name && name !== target.name) { warn("patch: name mismatch for %C ... skipping", id, target.name, name); continue; }
		for (const [key, value] of Object.entries(overrides)) {
			if (key === "id") continue;
			target[key] = value;
		}
	}
	return data;
}
```

精确结论：
- **覆盖是"顶层 key 赋值"**：`target[key] = value`。所以写出 `config:` 会把**整个 `config` 对象替换掉**（不是逐字段 merge）；没写出的顶层 key（如 `name`、`inject`、`disabled`）保持原值。
- `- insert: [...]`：**无 `id` → 追加到根数组**；**有 `id` 且该行是 group → push 进该 group 的 `config`**。
- `id` 找不到 / `name` 不匹配 / 非 insert 缺 `id`：**warning + 跳过**（不报错）。

### 5.4 一个第三方 host 插件要怎么装进 `profiles\web`

已证实的路径（二选一）：

1. **CLI 路径（推荐）**：`dsh plugin --profile web add <你的包>`。
   - 会 `spawnSync("pnpm", ["add", ...], {cwd: <profileDir>})`（`plugin-Ddi42qoW.js:109-113`），成功后自动把你补进 `dsh.profile.bundles`（前提：你的 `package.json` 声明了 `dsh.bundle.patch`）。
   - 若包来自 git，pnpm 可能拦截 prepare 构建，需要往 `profiles\web\pnpm-workspace.yaml` 的 `allowBuilds` 加 key（提示文本见 `plugin-Ddi42qoW.js:125`）。
   - ⚠️ 我**没有实跑 add**（需要联网 + 会改真实 profile），只核实了代码路径 + pnpm 在位。
2. **手工路径**：把插件放到可解析位置 + 在 `profiles\web\node_modules\` 建链接 + 往 `profiles\web\package.json` 的 `dsh.profile.bundles` 加名字。（skill 参考：`C:\Users\<user>\.dsh\skills\dsh-plugin-dev\references\install-and-verify.md:6-16`；bundle 解析顺序"先 dsh 安装目录，再 profile 的 node_modules"见 `references\profile-and-patch.md:22-23` 与 `plugin-Ddi42qoW.js:28` 的 `resolveBundleDir(NAME, packageName, INSTALL_ANCHOR, profileDir)`。）
3. **`host` 半 + `client` 半的声明**照抄 skin-market（见第 6 节）；纯 host 只写 `dsh.bundle.patch`。

---

## 6. 必需契约（最小 host 插件）

### 6.1 `package.json` 的 dsh 字段

真实范例（`C:\Users\<user>\Downloads\harness\dsh-skin-market\package.json`）：

```json
// :34-55
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-settings"
      ],
      "platform": "web"
    }
  },
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": "./client/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
```

**纯 host 插件只需要**：`dsh.bundle.patch` + 一个能被 import 的入口（`exports["."]` 或 `main`）。`dsh.client.platform` 只在有 client 半时必需。

### 6.2 `cordis.patch.yml`

```yaml
# C:\Users\<user>\Downloads\harness\dsh-skin-market\cordis.patch.yml:1-3
- insert:
    - id: dsh-skin-market
      name: dsh-skin-market
```

`- insert:` 不带 `id` → 追加到 profile 根数组（`cordis-plugin-include\lib\index.js:70-84`）。

### 6.3 入口文件导出什么

真实范例 A（TS 源）：`C:\Users\<user>\Downloads\harness\dsh-skin-market\src\index.ts:7-45`
```ts
export const name = 'dsh-skin-market'
export interface Config { profile?: string }

export function apply(ctx: Context, config?: Config): void {
  ctx.inject(['webServer', 'loader', 'agents'], hostContext => {
    const host = hostContext as unknown as EffectHost
    ...
    host.effect(() => mountRoutes(host, {...}), 'dsh-skin-market: routes')
  })
}
export { mountRoutes } from './routes.ts'
```
编译产物一致：`dsh-skin-market\lib\index.js:5,10`（`export const name = 'dsh-skin-market';` / `export function apply(ctx, config)`）。

真实范例 B（包导出形状）：`<DSH>\dsh-headless\lib\index.js:187`
```js
export { Config, apply, inject, internals, name };
```

Cordis 如何解析：
```js
// <DSH>\cordis\lib\index.js:1526-1537
	/** Resolve a supported plugin shape to its executable callback. */
	resolve(plugin) {
		try {
			if (typeof plugin === "function") return plugin;
			if (isApplicable(plugin)) return plugin.apply;
		} catch {}
	}
```
```js
// <DSH>\cordis\lib\index.js:1445-1447
function isApplicable(object) {
	return object && typeof object === "object" && typeof object.apply === "function";
}
```
```js
// <DSH>\cordis\lib\index.js:1622-1634（节选）
			runtime = {
				name,
				callback,
				fibers: new DisposableList(),
				Config: plugin.Config
			};
			...
		const fiber = new Fiber(this.ctx, config, Inject.resolve(plugin.inject), runtime, getOuterStack);
```
即：`apply` 必须有（函数或 `{apply}` 的 `apply`）；`inject` 被 `Inject.resolve` 解析成依赖；`Config` 作为配置校验 schema；`name` 仅用于诊断（若是 `apply` 则置空）。

### 6.4 `ctx.effect` / `ctx.logger` / `ctx.inject` 的确切行为（本版本）

```js
// <DSH>\cordis\lib\index.js:1168-1198（节选）
	effect(execute, label = "anonymous") {
		this.assertActive();
		if (this.state === 5) throw new CordisError("INACTIVE_EFFECT");
		const disposables = [];
		let disposing = false;
		let disposalTask;
		const dispose = () => {
			if (disposing) return disposalTask;
			disposing = true;
			let task;
			for (const disposable of disposables.splice(0).reverse()) ...  // 逆序清理
			return disposalTask = task;
		};
		const meta = { label, children: [] };
		const runner = { execute, epoch: true, collect: (dispose) => { disposables.push(dispose); ... }, getOuterStack: buildOuterStack() };
```
- 立即执行 `execute`；执行期间通过 `runner.collect` 收集到的 disposer 在 fiber 卸载时**逆序**执行；支持异步/生成器式 effect（`:1155-1166`）；`label` 进诊断树。
- 关键：**在 `ctx.effect` 内注册的 route / listener 才随插件卸载而清理**。

```js
// <DSH>\cordis\lib\index.js:1593-1605
	* @param inject — required services, as an array or a name → config map.
	* @param callback — plugin body called with `(ctx, config)`.
	* @returns the fiber; awaiting it settles once loading finished.
	inject(inject, callback) {
		return this.plugin({ inject, apply: callback, name: callback.name });
	}
```
- `ctx.inject([...], cb)` = 起一个子 plugin，等依赖齐了再跑 `cb`；返回 fiber（可 await）。**推荐在 `apply` 顶部用它拿 `webServer` / `agents` / `sessions`，而不是在顶层直接取**。

```js
// <DSH>\cordis\lib\index.js:576-634（节选）
/**
* Built-in logging service.
* Call `ctx.logger()` to create a named logger, or call `ctx.logger.info()`
* directly to log with the current fiber-derived name.
*/
var LoggerService = class LoggerService {
	...
	[symbols.invoke](name) {
		const config = this._resolveConfig();
		const fiber = (this.ctx[symbols.shadow] ?? this.ctx).fiber;
		name ??= config.name;
		name ??= hyphenate(fiber.name);
		return new Logger({ name, ...
```
- `ctx.logger` 是**可调用对象**：`ctx.logger.info(...)` / `warn` / `error` 直接用 fiber 名做前缀；`ctx.logger('name')` 或 `ctx.logger('name')` 式命名 logger 也可（`symbols.invoke`）。webServer 内部自己的错误就是 `this.ctx.logger.warn(...)`（`dsh-host-webserver\lib\index.js:248`）。
- 其它常用：`ctx.get(name, strict = true)`（`:762`）、`ctx.provide(name, value, check)`（`:799`）、`ctx.on(name, listener, options)`（`:371`，返回注册为 effect 的 disposer）、`ctx.waterfall / parallel / emit / serial / bail`（`:271-325`）。

---

## 7. 未验证 / 查不到的项目（明确标注，不要当结论用）

1. **`dsh plugin --profile web add <pkg>` 的完整实跑未做**。只核实了命令存在、转发逻辑、pnpm 在位。未验证：联网抓取、git 插件 `allowBuilds` 交互、reconcile 后 `bundles` 的实际排序。
2. **`--dump-config` 在真实 home（`C:\Users\<user>\.dsh`）下未成功**。在我的沙箱里因 `profiles\web\cordis.yml` 写入被拒（EPERM）而失败。成功的那次是把 `DSH_HOME` 指向工作区副本（同样的 `package.json` + `cordis.patch.yml`，`node_modules` 用 junction 指回真实目录）。**结论的层序结论来自代码 + 该副本 dump，而非真实 home 的 dump。**
3. **home 级 `$DSH_HOME/cordis.patch.yml` 在本机不存在**（`.dsh` 根目录只有 `settings.yaml`、`.env` 等）。我用探针副本**新建**一个才验证了它的层序，真实机器上没有这个文件。
4. **`ctx.connection.fetch.register` / `ctx.connection.rpc.handle` 未实跑**。只读了 `.d.ts` 声明与 `register` 实现（`dsh-client-connection\lib\index.js:587-618`）。未验证：注册到 `/api` 之下的路由能否返回**流式 Response**（`rpc.d.ts:89` 只说明了 *请求体* 的 `streaming` 模式，**响应流式未在文档中声明**）、以及 `intercept('/api', ...)` 的匹配行为。
5. **【已结案】** 原疑点「`ctx.on('agent/assistant-stream', ...)` 是否真能收到帧」——**该事件不存在**，无需实测：全树 `emit()` 扫描 0 命中。等价问题改为「`ctx.on('session/event', (session, event) => …)` 能否在 web profile 内实时收到 `assistant/chunk`」，照抄源 `dsh-headless\lib\index.js` 的 `streamReasoning`。
6. **创建 agent 时"模型选择"是否必须由插件自己安装未定论**。`dsh-headless` 用 `installModelSelection(agentCtx, ...)`（`lib\index.js:141-146`），`dsh-webhook` 用 `agentPresets.mount` + 自己的 `agent/request` hook（`session.js:63-75,102-105`），`dsh-acp` 用 `AcpModelControl.install(agentCtx)`。web profile 默认 preset 是 `standard`（`docs\evidence\dump-web-composed.txt:536-539`）。**三条路径都"能跑"，但哪一条对 IM 网桥是必需/最省事，我没有实测对比。**
7. **`dsh-agent-default-model` 的完整 API 未读**（只用了 `currentSelection()` 这一处，来自 `dsh-headless\lib\index.js:133` 与 `dsh-webhook\lib\types\session.js:36`）。其 `lib\types\index.d.ts` 未通读。
8. **`createUserMessage` 的 `source.kind` 全集未枚举**。已证实存在的取值：`'user'`（`dsh-acp\lib\index.js:833`、`dsh-headless\lib\index.js:157`）、`'webhook'`（`dsh-webhook\lib\types\types.d.ts:60-73`）、`'plugin'`（`dsh-user-approval\lib\index.js:107-110`）。完整 `MessageSourceMap` 联合未读。
9. **用户提问的 UI 侧 answerer 注册方式未读**（`dsh-client-ui-user-questions` / `dsh-api-remotes` / `dsh-client-ui-approval` 只在 grep 中看到 `ctx.remote.$on('approval/request', ...)`，`dsh-client-ui-approval\lib\client.js:282`）。host 侧第三方 answerer 的注册我只验证了 `ctx.on('approval/request', ...)`（ACP 实例）。
10. **`dsh-sdk-protocol` 的 JSON-RPC 方法名/字段未通读**（只读了 `dsh-sdk-jsonrpc-server\lib\types\server.d.ts` 的方法列表）。
11. **安装新插件后父进程是否免重启生效未验证**。代码里有 `patchReload: "live"` 时 watch patch 文件的逻辑（`profile-boot-Dk-7KqJc.js:321-336`），但那只覆盖 patch 文件变化；**新增包需要重新 resolve/import，是否热生效我没测**。
12. **`ctx.webServer.register` 的 handler 里未捕获异常的行为**：代码显示会 `logger.warn` + `400`（`dsh-host-webserver\lib\index.js:246-256`），但 SSE 已发头的情况是 `res.destroy()`（`:249-252`）。未按 IM 场景实测。
13. ~~`agent/assistant-stream` 的 `end` 帧 `'abandoned'`~~ **该项作废**（事件不存在）。改为：`assistant/chunk` 的 `finish` 分片（`{ reason, replayState? }`）在中断/重试路径下的实际取值未实跑。
14. **`ctx.approval` 在 IM 场景下的并发/多 answerer 行为未测**：多个插件同时注册 `approval/request` waterfall 时"先返回者 wins"，这点从 waterfall 语义（`cordis\lib\index.js:317-325`）可推断，但未实测。
15. **DEEPSEEK 安装根目录下的 `dsh-base`/`dsh-web-app` 的完整 `cordis.patch.yml` 未逐行读**（只读了 dump 结果对应的行）。

---

## 8. 与常见设计假设不符的点（汇总）

| 假设 | 实际 | 证据 |
|---|---|---|
| 第三方注册的 HTTP 路由自带鉴权 | **不带**。鉴权只在 `dsh-client-connection` 的 `/api` 路由和它注册的 channel 上 | `dsh-client-connection\lib\index.js:552-556, 602-618, 768-781` |
| 有内建 SSE helper | **没有**。只有 gzip 过滤器识别 `text/event-stream`，写法需手抄 `dsh-client-hmr` | `dsh-host-webserver\lib\index.js:112-114`；`dsh-client-hmr\lib\index.js:114-158` |
| 事件名是 `"assistant/chunk"` | **【已修订】该事件就是正确的那个**：它是 `session/event` 上的活事件，流式文本取它。旧记录说「当前格式不存在」系误读 | `dsh-session\lib\types\known-event-types.js`（51 项含 `assistant/chunk`）；`dsh-agent-loop\lib\index.js`（append）；`dsh-headless\lib\index.js`（消费范式） |
| 事件名是 `"assistant/live-chunk"` | 那是**浏览器侧**合成事件，host 拿不到 | `<DSH>\dsh-api-session-controller\lib\types\client\sessions\assistant-stream.js:39,109` |
| 驱动 agent 需要 spawn 一个 headless 子进程 | 进程内有**一等入口** `ctx.agents.create/resume` + `agent.followup` | `dsh-agent\lib\types\index.d.ts:279-287`；`dsh-agent\lib\types\runtime-types.d.ts:192` |
| `dsh-webhook` 可以拿来做 IM 网桥（含回推） | webhook 是 **fire-and-forget**，不返回 agent 输出、不做完成通知 | `dsh-webhook\README.zh.md:41,73` |
| patch 是"整行替换"（连 `id`/`name` 都换） | 实际是**顶层 key 赋值**；只有显式写出的 key 被覆盖，`config` 作为一个整体被替换 | `cordis-plugin-include\lib\index.js:100-103` |
| 审批有内建超时 | **没有**。取消完全依赖 `req.signal` | `dsh-user-approval\lib\index.js:175-192` |
| `--dump-config` 是纯读操作 | 它会**写** profile 根 `cordis.yml`，所以只读环境会 EPERM | `dsh\lib\profile-boot-Dk-7KqJc.js:209`；实测 EPERM |

---

## 9. 附录：最小 host 插件骨架（可直接照抄）

以下每一行都对应上文已证实的 API；`TODO` 处是业务逻辑。

### 9.1 `package.json`

```json
{
  "name": "dsh-astrbot-relay",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }
  },
  "exports": {
    ".": "./lib/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.1" }
}
```
（纯 host 不需要 `dsh.client.platform`；对照 `dsh-skin-market\package.json:34-46`。）

### 9.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-astrbot-relay
      name: dsh-astrbot-relay
```
（`insert` 无 `id` → 追加到 profile 根数组，见 `cordis-plugin-include\lib\index.js:70-84`。）

### 9.3 `lib/index.js`

```js
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'

export const name = 'dsh-astrbot-relay'

/** 每个 IM 会话 ⇄ 一个 dsh agent */
const bridges = new Map()   // conversationId -> { agent, dispose, subscribers:Set<res>, queue:[], approvals:Map }

export function apply(ctx, config) {
  // 只在所需服务就绪后做副作用注册（cordis/lib/index.js:1599-1605）
  ctx.inject(['webServer', 'agents', 'sessions', 'agentDefaultModel'], (host) => {
    const log = host.logger   // 可调用：host.logger.info/warn/error，前缀取 fiber 名（cordis:576-634）

    // ---- (1) 流式事件：host 根 ctx 上的“未打 tag”监听者会收到**所有** agent 的事件
    //          (dsh-scope/lib/index.js:327-338)，所以必须按 agent 过滤。
    //          ctx.on 自身就注册为 effect，返回 disposer，fiber 卸载自动移除（cordis:326-345, 360-365）。
    // 【已修订】原写法 `host.on('agent/assistant-stream', ({agent,frame}) => …)` 已证伪。
    ctx.on('session/event', (session, event) => {
      const b = bridges.get(agent.id)
      if (!b) return
      if (frame.type === 'start') { b.push({ event: 'start', turn: frame.turn, step: frame.step }); return }
      if (frame.type === 'end') { b.push({ event: 'attempt-end', outcome: frame.outcome }); return }
      const chunk = frame.chunk                       // dsh-llm StreamChunk 封闭联合
      if (chunk.type === 'text-delta') b.push({ event: 'text', text: chunk.text })
      else if (chunk.type === 'reasoning-delta') b.push({ event: 'reasoning', text: chunk.text })
      else if (chunk.type === 'tool-call-delta') b.push({ event: 'tool-call-delta', id: chunk.id, name: chunk.name, delta: chunk.argumentsDelta })
      else if (chunk.type === 'usage') b.push({ event: 'usage', usage: chunk.usage })
      else if (chunk.type === 'finish') b.push({ event: 'finish', reason: chunk.reason })
    })

    // 想拿“一步的完整消息 + usage”就用持久事件（含 usage / interrupted）
    host.on('session/event', (session, event) => {
      const b = [...bridges.values()].find((x) => x.agent.session === session)
      if (!b) return
      if (event.type === 'assistant/message') b.push({ event: 'message', message: event.data.message, usage: event.data.usage })
      else if (event.type === 'tool/call') b.push({ event: 'tool-call', callId: event.data.callId, name: event.data.name })
      else if (event.type === 'tool/result') b.push({ event: 'tool-result', message: event.data.message })
      else if (event.type === 'turn/end') b.push({ event: 'turn-end', reason: event.data.reason })
    })

    // ---- (2) 审批拦截：waterfall，签名 (req, next) => Promise<ApprovalOutcome>
    //          可以 await 很久等 IM 回执；不返回就 next() 交给后续 answerer。
    //          取消只能靠 request.signal，自己没有超时 —— 建议自己也加超时。
    host.on('approval/request', (request, next) => {
      const b = bridges.get(request.agent.id)
      if (!b) return next()
      return b.askApproval(request)                 // → 'allowed-once' | 'rejected' | 'cancelled'
    })

    // ---- (3) HTTP 路由：webServer.register 无鉴权，必须自己校验
    host.effect(() => host.webServer.register({
      kind: 'prefix',                               // 注意：path 不要以 '/' 结尾
      path: '/astrbot-relay',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        if (req.headers['x-bridge-secret'] !== config.secret) { res.writeHead(403); res.end(); return }  // 自建鉴权
        if (url.pathname === '/astrbot-relay/events') return openSse(req, res)
        if (url.pathname === '/astrbot-relay/send' && req.method === 'POST') return onSend(req, res, url)
        res.writeHead(404); res.end()
      }
    }), 'astrbot-relay: routes')

    // ---- (4) 会话驱动
    async function agentFor(conversationId) {
      const existing = bridges.get(conversationId)
      if (existing) return existing
      const selection = host.get('agentDefaultModel').currentSelection()
      const sessionId = brandString(`im-${randomUUID()}`)
      const handle = await host.agents.create({        // 也可 host.agents.resume({ resumeSessionId: brandString(known), ... })
        sessionId,
        meta: { cwd: config.cwd },                     // meta.cwd 必须是绝对路径
        agentOptions: { provider: selection.provider, model: selection.model },
      })
      const b = { agent: handle.agent, dispose: () => handle.dispose(), subscribers: new Set(), queue: [], approvals: new Map() }
      b.push = (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of b.subscribers) res.write(line); b.queue.push(ev) }
      b.askApproval = (request) => new Promise((resolve) => {
        const timer = setTimeout(() => { b.approvals.delete(request.callId); resolve('rejected') }, config.approvalTimeoutMs ?? 120_000)
        b.approvals.set(request.callId, { resolve, timer })
        b.push({ event: 'approval-required', callId: request.callId, toolName: request.toolName, reason: request.reason })
        request.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve('cancelled') }, { once: true })
      })
      bridges.set(conversationId, b)
      // 卸载时按顺序收尾：先等静默，再落盘，最后 dispose（对照 dsh-acp/lib/index.js:947-985）
      host.effect(() => () => (async () => {
        const { agent, dispose } = b
        try { agent.cancel({ kind: 'user' }); await agent.whenIdle() } catch {}
        try { await host.get('sessions').flush(agent.session) } catch {}
        try { await dispose() } catch {}
        bridges.delete(conversationId)
      })(), `astrbot-relay: teardown ${conversationId}`)
      return b
    }

    async function onSend(req, res, url) {
      const conversationId = url.searchParams.get('conversation') ?? 'default'
      const text = await readBody(req)
      const b = await agentFor(conversationId)
      b.agent.followup(createUserMessage({                // 投递一条 user 消息并唤醒 driver
        content: [{ type: 'text', text }],
        source: { kind: 'user' },                          // 也可走自定义 MessageSourceMap（对照 dsh-webhook）
      }))
      b.agent.whenIdle().then(() => host.get('sessions').flush(b.agent.session)).catch((e) => log.warn(`[dsh-astrbot-relay] ${String(e)}`))
      res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ accepted: true }))
    }

    function openSse(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' })
      res.write(': connected\n\n')
      const conversationId = new URL(req.url ?? '/', 'http://x').searchParams.get('conversation') ?? 'default'
      const attach = (b) => { b.subscribers.add(res); for (const ev of b.queue) res.write(`data: ${JSON.stringify(ev)}\n\n`) }
      const b = bridges.get(conversationId)
      if (b) attach(b)
      res.on('close', () => { for (const x of bridges.values()) x.subscribers.delete(res) })
    }

    async function readBody(req) {
      const chunks = []
      for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
      return JSON.parse(Buffer.concat(chunks).toString('utf8')).text
    }

    log.info('[dsh-astrbot-relay] mounted')   // 安装验证就靠这行 + 路由可访问（见 skill 的三条判据）
  })
}
```

关键提醒（都有证据）：
- `host.agents.create` 的 factory 由 `dsh-agent-loop` 提供，**没挂它就会 reject**（`dsh-agent\lib\types\index.d.ts:154-186`）。
- `host.get('loader')?.await()` 之后再创建 agent 更稳（`dsh-headless\lib\index.js:128`）。
- 路由没有鉴权（`dsh-client-connection\lib\index.js:552-556`）；SSE 无 helper（`dsh-host-webserver\lib\index.js:112-114`）。
- `kind: 'prefix'` 的 `path` 不要写尾斜杠（`dsh-host-webserver\lib\index.js:327`）。

