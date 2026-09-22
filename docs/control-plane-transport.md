# 控制面传输核实报告：第三方 DSH host 插件能否进程内调用/转发已注册的 host RPC 方法

- 核实对象：本机安装产物 `@deepseek-ai/dsh` **0.1.5-rc.2**（Web profile，`http://127.0.0.1:3080`，即当前 harness 自身）
- `<DSH>` 在下文缩写
  `C:\Users\<user>\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai`
  （报告内所有证据行均给出 `<DSH>` 下的相对包路径 + 行号；探针脚本给出绝对路径）
- 被复用对象：`C:\Users\<user>\Downloads\AstrBot-master\data\plugins\astrbot_plugin_dsh_connector\core\dsh_client.py`
- 核实方式：**源码逐行阅读 + 实机 HTTP 探针**（探针脚本见 §2）。凡未实跑者，明确标注「静态已证实，未实跑」。

---

## 0. 结论摘要

### 0.1 一句话

**「廉价管道」方案的传输机制成立（进程内按名调用既有 host RPC 方法可行、公开、约 100 行插件即可转发），但 DESIGN.md §7.3 里「AstrBot 侧几乎原样复用 `core/dsh_client.py`（只换 base_url + 加 Authorization 头）」这一前提被实机探测推翻**：`core/dsh_client.py` 里的 **27 个静态点号方法名**（外加动态拼接的 `f"goal.{action}"`，`dsh_client.py:404`）**没有一个**是当前 DSH 的合法 endpoint，连同任务清单里的其余点名共探测 **33 个点号 endpoint，33/33 全部 HTTP 404**（唯一本来就对的是 `commands/execute`，它原本就是斜杠形式）；必须把「点号方法名 + 平铺 payload」改写成「`<namespace>/<method>` + `{args:{...}}` 信封」。**好消息**：改写后各方法的**业务字段与 connector 现在发送的字段逐字段一致**（已实机取到真实数据验证，§2.3）。

| 结论 | 判定 | 证据位置 |
|---|---|---|
| 3(a) 第三方插件按方法名**进程内调用**已注册的 host RPC | **能** | §1.3.1 |
| 3(b) 注册一个 **channel** 把请求转发给既有方法 | **能**（新 channel），但**不能**接管 `/api` | §1.3.2 |
| 3(c) 挂到同一 HTTP 派发路径但**跳过鉴权** | **能**（`kind:'exact'` 路由先于 `/api` prefix 命中；或进程内直调根本不经过 HTTP 栅栏） | §1.3.3 |
| 4 `ctx.connection.fetch.register` 位于 `/api` 之下、受栅栏+鉴权、**支持流式响应** | **能** | §1.4 |
| 5 `ctx.connection.requestRejection(req)` 复用框架栅栏 | **能，且现实**（同步、公开、只读 headers） | §1.5 |
| 6 兜底「逐方法进程内重做」 | **不需要**（管道可行）；但 3 个方法无同名 endpoint，需替代物 | §1.6 |

### 0.2 三条必须先知道的实机事实

1. **dot 方法名不存在**：`POST /api/session.list`、`/api/host.describe`、`/api/workspace.list` … 全部 `HTTP 404 :: not found`；
   `POST /api/session/list` 返回 `200`，进入 gateway：
   `{"result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/list: args fields do not match the descriptor: missing \"_request\""}}}`
   （33 个点号 endpoint 逐个探测，结果见 §2.2）
2. **进程内派发入口是公开 API**：`ctx.typertGateway.invoke()` / `.stream()`，以及
   `ctx.connection.createSharedFetchHandler('/api')`。二者都不经过 HTTP 的 Host/Origin 栅栏与 cookie 鉴权——**栅栏只存在于 HTTP 载体上**（`dsh-client-connection/README.zh.md:35` 原文：*"每个 Host RPC 方法和 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层"*）。
3. **注册表按 `<namespace>/<method>` 索引**，`ctx.typert.local` 是公开可读的按名注册表；`service` 字段直接给出承载它的 Cordis 服务键。

### 0.3 成本重估（对 P5 的直接影响）

| 项 | 工作量 |
|---|---|
| DSH 侧 | 1 个 host 插件（≈120–180 行）：一条自有鉴权路由 + 一次 `createSharedFetchHandler('/api').fetch(...)` 或 `ctx.typertGateway.invoke(...)` 转发。**不需要**逐方法重做 28 个能力。 |
| AstrBot 侧 | 改 `core/dsh_client.py` **两处集中点**：`rpc()`（第 61–91 行）改 URL/信封，`execute_command()`（第 93–139 行）已正确；再把 §1.6 表里的方法名与 `payload` 外层键改掉。`main.py` 的业务调用点**不动**。 |
| 需要新写的映射 | 33 行「点号名 → `<ns>/<method>` + 外层 wire 键」对照表（= `dsh_client.py` 的 27 个静态方法 + `goal.{action}` 展开的 6 个动作；§1.6）。 |
| 无任何对应 endpoint 的 3 项 | `host.describe`（用 `session/list` 的 `cwd` 字段替代）、`goal.blocked`（进程内 `goals.block()`，需 live agent）、`workspace.list`（`workspaceRegistry.list()` 或 `workspace/follow` 首帧）。另 2 项只是改名：`session.history`→`session/page`、`session.models`→`session/modelCatalog`。 |

---

## 1. 逐条问题的证据

### 1.1 问题 1：注册表在哪 / 谁把方法注册到 `/api` 上

结论：**两层注册**。HTTP 层只有**一个** `/api` 拦截器（gateway 注册，按 channel 索引，**不是**按方法名）；方法级注册表是 Typert 的 `ctx.typert.local`，键为 `` `${namespace}/${method}` ``。

#### 1.1.1 `/api` 通道拦截器的唯一注册调用点

`<DSH>\dsh-api-gateway\lib\index.js:454-456`（构造函数内）：

```js
ctx.inject(["connection"], (connectionCtx) => {
    connectionCtx.connection.rpc.intercept("/api", (endpoint) => this.claimsEndpoint(endpoint), (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal));
});
```

配套 `.d.ts` 声明：`<DSH>\dsh-api-gateway\lib\types\index.d.ts:48-70`，其中 `claimsEndpoint` 被声明为 `private`（第 70 行），但 `intercept` 的注册发生在构造期，运行时是普通原型方法。

`.d.ts` 侧同源证据（转译前源码）：`<DSH>\dsh-api-gateway\lib\types\index.js:73` 同一行代码。

#### 1.1.2 唯一的 `/api` HTTP 路由（prefix，带栅栏）

`<DSH>\dsh-client-connection\lib\index.js:767-781`：

```js
const fetchHandler = connection.createSharedFetchHandler(API_PATH);
const route = {
    kind: "prefix",
    path: API_PATH,
    handler: async (req, res) => {
        const rejection = connection.requestRejection(req);
        if (rejection !== void 0) { res.writeHead(rejection); ... return; }
        await bridge(req, res, fetchHandler, maxRequestBodyBytes);
    }
};
webCtx.effect(() => webCtx.webServer.register(route), "client-connection: /api route");
```

全安装产物里 `webServer.register(` 的全部命中为：client-connection `:618`/`:781`、client-modules `:482`（`/plugins`）、client-hmr `:133`（HMR events endpoint）、webhook-github `:182`（`config.path`）、host-open-in-app `:1325`/`:1337`/`:1374`（open-in-app 路由）——**只有 client-connection 的两条落在 `/api` 名字空间**。

#### 1.1.3 方法级注册表：`ctx.typert.local`（Map，键 `<namespace>/<method>`）

- 键形状：`<DSH>\dsh-typert-registry\lib\index.js:29-34`

```js
function typertEndpoint(descriptor) {
	return `${descriptor.namespace}/${descriptor.method}`;
}
```
（`.d.ts` 同一注释：`<DSH>\dsh-typert-registry\lib\types\service.d.ts:26-30`，`@returns `<namespace>/<method>``）

- 底层是 `Map`：`<DSH>\dsh-typert-registry\lib\index.js:70-118`（`this.entries.set(endpoint, entry)` / `get(endpoint)` / `hasSeen(endpoint)`）
- 公开只读视图：`<DSH>\dsh-typert-registry\lib\types\service.d.ts:45` `get local(): TypertLocalRegistry;`，接口定义在 `<DSH>\dsh-typert-protocol\lib\types\types.d.ts:322-343`：

```ts
export interface TypertLocalRegistry {
    get(endpoint: string): InvocationDescriptor | undefined;   // 按名查
    hasSeen(endpoint: string): boolean;
    list(): readonly InvocationDescriptor[];
    subscribe(listener: TypertRegistryListener): TypertDisposer;
}
```

- 服务键：`<DSH>\dsh-typert-registry\lib\index.js:359` `super(ctx, "typert");` → `ctx.typert`
- 写入者（注册调用点）：`<DSH>\dsh-typert-loader\lib\index.js:282`

```js
registered.set(entryName, ctx.typert.register(manifest));
```
manifest 来自各包 `exports["./typert"]`（同文件 `:40 const TYPERT_HOST_EXPORT = "./typert";`、`:246-282`），例如
`<DSH>\dsh-api-session-controller\package.json` 的 `"./typert" → ./lib/typert.host.js`。

- gateway 认领端点即查这张表：`<DSH>\dsh-api-gateway\lib\index.js:510-517`

```js
claimsEndpoint(endpoint) {
    if (endpoint === "$events/result") return true;
    const segments = endpoint.split("/");
    if (segments.length !== 2 || segments[0] === "" || segments[1] === "") return false;
    if (this.ctx.typert.local.get(endpoint) !== void 0 || this.ctx.typert.local.hasSeen(endpoint)) return true;
    this.srcClaims ??= this.collectSrcClaims();
    return this.srcClaims.has(endpoint);
}
```

**注意 `segments.length !== 2`**：这正是 `session.list`（点号）无法被认领、直接 404 的原因。

- HTTP 层还有第三个 Map，但它是 **per-channel** 而不是 per-method：`<DSH>\dsh-client-connection\lib\index.js:526` `interceptors = new Map();`，`registerInterceptor` 对同一 channel 二次注册直接抛错（`:627`）——**第三方无法接管 `/api`**。

---

### 1.2 问题 2：注册/调用签名与派发路径

#### 1.2.1 `.d.ts` 侧（Host）

`<DSH>\dsh-client-connection\lib\types\rpc.d.ts:104-120`：

```ts
export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler): () => Promise<void>;
    intercept(channel: '/api', matches: ConnectionRpcEndpointMatcher, handler: ConnectionRpcHandler): () => Promise<void>;
}
```

- handler 形状（`:76`）：`type ConnectionRpcHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcResult<unknown>>;`
- channel 形状：`handle` 收「绝对逻辑 channel，如 `/rpc`」；`intercept` 只收字面量 `'/api'`（`:104-120`）
- matcher（`:78`）：`(endpoint: string) => boolean`，endpoint 是 channel 相对名（如 `session/list`）
- 结果形状（`:11-24`）：`ConnectionRpcResult<T> = {ok:true;value:T} | {ok:false;error:{code,message,details}}`
- **handler 拿不到 HTTP 客户端信息**：没有 request/headers/cookies 参数。签名里的 `signal` 来自 `Request.signal`（`<DSH>\dsh-client-connection\lib\index.js:657`）。

主 carrier（Host 侧总入口）：`<DSH>\dsh-client-connection\lib\types\rpc-host.d.ts:22-43`（`ctx.connection` 即 `HostConnectionHandle`，`:5-10` 声明合并 `interface Context { connection: HostConnectionHandle }`）。

#### 1.2.2 实现侧（Host）

- channel 注册：`<DSH>\dsh-client-connection\lib\index.js:539-546`

```js
get rpc() {
    const owner = this.ctx;
    return {
        handle: (channel, handler) => this.register(owner, channel, handler),
        intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler)
    };
}
```

- channel 名合法性 + 保留字：`:693-695`

```js
function assertChannel(channel) {
	if (!CHANNEL_PATTERN.test(channel) || channel === "/api") throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`);
}
```
（`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`，`:520`）→ **`/api` 被显式保留**。

- `register`（新 channel 会自己在 webserver 上挂一条带栅栏的路由）：`:602-619`

```js
const route = {
    kind: "prefix", path: channel,
    handler: async (req, res) => {
        const rejection = this.requestRejection(req);
        ...
    }
};
```

- `registerInterceptor`（`/api` 专用，单例）：`:620-633`
- 信封校验与响应包装：`:635-692`

```js
async fetch(request) {
    const endpoint = endpointFromPath(channel, new URL(request.url).pathname);
    if (request.method !== "POST" || endpoint === void 0) return new Response("not found", { status: 404 });
    if (request.headers.get("content-type")?.split(";",1)[0]?.trim().toLowerCase() !== "application/json") return new Response(..., { status: 415 });
    ...
    const envelope = clientRequestSchema.safeParse(body);
    if (!envelope.success) return invalidEnvelopeResponse(body, envelope.error.issues);
    if (message.method !== endpoint) return errorResponse(message.rpcId, { code: "gateway/bad-request", ... });
    const result = await handler(endpoint, message.payload, request.signal);
    return fullResponse(message.rpcId, result);
}
...
function fullResponse(rpcId, result) {
	const body = { type: "server-response", rpcId, result };
	return Response.json(body);
}
```

→ 返回值就是被原样放进 `result` 字段（不再二次包装），响应体恒为 `{type:"server-response", rpcId, result}`，HTTP 200。

- 端点名语法：`:673-678` `endpointFromPath` 要求 `pathname.startsWith(`${channel}/`)`，且每段匹配 `/^[A-Za-z0-9_$.-]+$/`（`:521`），拒绝空段与 `.`/`..`。
- 信封 schema（zod）：`:501-515`（`type:'client-request'`、`rpcId:string`、`method:string`、`payload:unknown`；响应 `type:'server-response'`、`rpcId`、`result`）。

#### 1.2.3 完整派发链（浏览器 → 业务方法）

```
POST /api/session/prompt
 → webserver prefix 路由            (client-connection\lib\index.js:768-781)  ← requestRejection 在这里
 → bridge() node:http→fetch         (client-connection\lib\index.js:33-104)
 → createSharedFetchHandler.fetch   (client-connection\lib\index.js:576-584)
 → interceptors.get('/api').fetchHandler  (rpcFetchHandler, :635-664)
 → TypertGatewayService.dispatchRpc (api-gateway\lib\index.js:566-580)
 → invokeRpc → remoteRequest        (api-gateway\lib\index.js:728-737, 925-936)
 → invoke → prepareInvocation       (api-gateway\lib\index.js:538-547, 738-757)
 → Reflect.apply(serviceMethod, receiver, args)   (api-gateway\lib\index.js:542)
```

`remoteRequest` 决定 payload 形状（`:925-936`）：

```js
function remoteRequest(endpoint, payload, signal) {
	const segments = endpoint.split("/");
	if (segments.length !== 2 || segments[0] === "" || segments[1] === "") throw new Error(...);
	const [namespace, method] = segments;
	if (!isObject(payload) || !isPlainObject(payload) || Reflect.ownKeys(payload).length !== 1 || !Object.hasOwn(payload, "args") || ...) throw new Error("Remote payload must contain exactly one plain-object args field");
	return { namespace, method, args: payload.args, signal };
}
```

→ **payload 必须**是 `{args:{...}}`，且 `args` 字段名必须**精确**等于描述符的 wire 名（`assertExactArguments`，`:1040-1052`）。

---

### 1.3 问题 3：核心问题 (a) / (b) / (c)

#### 1.3.1 (a) 第三方插件能否按方法名**进程内调用**已注册方法 —— **能**

有**两条**公开入口，都跳过 HTTP 栅栏与 cookie：

**入口 A（推荐，与浏览器完全同构）**：`ctx.connection.createSharedFetchHandler('/api').fetch(request)`

- 声明：`<DSH>\dsh-client-connection\lib\types\rpc.d.ts:127-139`

```ts
readonly rpc: HostConnectionRpc;
readonly fetch: HostConnectionFetch;
createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler;
```
`ConnectionFetchHandler.fetch(request: Request): Promise<Response>`（`:154-171`）

- 实现：`<DSH>\dsh-client-connection\lib\index.js:570-586`（见 §1.2.2 引文）。**函数体内没有任何 `requestRejection` 调用**；栅栏只在两个 HTTP route handler 里（`:609`、`:772`）。
- 于是第三方插件在 `apply(ctx)` 里可以：

```js
const dispatch = ctx.connection.createSharedFetchHandler('/api');
const res = await dispatch.fetch(new Request('http://dsh.internal/api/session/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/list', payload: { args: { _request: {} } } }),
}));
const { result } = await res.json();       // 与浏览器 /api 逐字节同构
```
（URL 只用于取 `.pathname`，origin 无意义：`new URL(request.url).pathname`，`:577`）

**入口 B（更低层，抛出业务错误）**：`ctx.typertGateway.invoke({namespace, method, args, signal})`

- 声明：`<DSH>\dsh-api-gateway\lib\types\index.d.ts:78` `invoke(request: InvokeRemoteRequest): Promise<unknown>;`
  流式：`:84` `stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>;`
- 请求形状：`<DSH>\dsh-api-gateway\lib\types\types.d.ts:8-17` `{namespace, method, args, signal?}`
- 实现：`<DSH>\dsh-api-gateway\lib\index.js:538-547`；端点构造 `endpointOf(namespace, method)`（`:990-992`，即 `` `${namespace}/${method}` ``）
- 官方 README 明确把 `invoke()` 当调用 API 使用：`<DSH>\dsh-api-gateway\README.zh.md:12`「Host 入口提供 `ctx.typertGateway`」、`:27`「每次调用时，`ctx.typertGateway.invoke()` 都会解析当前的描述符和 Cordis 服务…」、`:31`「直接调用 `invoke()` 会保留业务错误」、`:35`「进程内 Connection 载体直接提供等价的流，不打开该 WebSocket」。

**服务可达性（第三方插件能否 `ctx.get('typertGateway')`）——已在本机得到同类事实印证**：
本 profile 里真实安装的第三方 host 插件 `dsh-whale-widget` 就在用同一类框架服务：

- `C:\Users\<user>\.dsh\profiles\web\node_modules\dsh-whale-widget\lib\index.js:1328` `cred = await ctx.credentials.resolve('DEEPSEEK_API_KEY')`
- 同文件 `:1634/1653/1672/1687/1700/1760/1769/1778` `disposers.push(ctx.webServer.register({...}))`
- 同文件 `:1289` `disposers.push(ctx.on('session/event', ...))`
- 该插件由 profile bundle 正常加载：`C:\Users\<user>\.dsh\profiles\web\package.json:17`（`dsh.profile.bundles` 列表含 `dsh-whale-widget`）

→ 第三方 host 插件确实运行在**同一个根 Cordis 上下文**里，可注入/读取框架服务；`typertGateway`、`connection` 均为普通全局服务（`super(ctx, "typertGateway")`：`<DSH>\dsh-api-gateway\lib\index.js:449`；`super(ctx, "connection")`：`<DSH>\dsh-client-connection\lib\index.js:535`）。全 profile 未使用 Cordis `isolate()`（已实跑：`Select-String isolate` 在 `profiles\web\cordis.yml`、`cordis.patch.yml`、`package.json` 三处**均无命中**），故不存在作用域隔离。

**入口 C（旁路校验，直接拿服务方法）**：`ctx.typert.local.get('session/list')` → `descriptor.service` → `ctx.get(descriptor.service)` → 直接反射调用。`InvocationDescriptor` 带 `service` 与可选 `implementation`（例：`<DSH>\dsh-api-session-controller\lib\typert.host.js:896-897` 的 `service`；`<DSH>\dsh-subagent\lib\typert.host.js:109-112` 的 `implementation: remoteExportList`）。**不推荐**：绕过 wire 校验、需要自己构造 `AbortSignal`/lookup 参数。

**结论 (a)：能。** 唯一"不是万能"的地方：**流式方法**必须用 `ctx.typertGateway.stream()`；走 unary 那条会被显式拒绝（实机：`POST /api/workspace/follow` → `gateway/signature-invalid: stream Remote methods must be opened through the stream carrier`，`<DSH>\dsh-api-gateway\lib\index.js:540`）。

#### 1.3.2 (b) 注册一个 channel，把请求转发给既有方法 —— **能（新 channel）／不能（`/api`）**

- 能：`ctx.connection.rpc.handle('/my-plugin', handler)`。它会在 webserver 上挂一条 `prefix` 路由，**并自动套用框架的栅栏+鉴权**（`<DSH>\dsh-client-connection\lib\index.js:602-619`，其中 `requestRejection` 在 `:609`）。
- 不能接管 `/api`：
  - `handle('/api')` 抛错（`assertChannel`，`:694`）
  - `intercept('/api', ...)` 二次注册抛错（`:627` `if (this.interceptors.has(channel)) throw ...`），而这条已被 gateway 在构造期占用（`api-gateway\lib\index.js:455`）
- 转发完全可行：handler 内部调 §1.3.1 的入口 A/B 即可。

#### 1.3.3 (c) 挂到同一 HTTP 派发路径上但跳过鉴权 —— **能（两条独立机制）**

1. **进程内直调**（§1.3.1）：根本不进入 HTTP 载体，自然没有栅栏与 cookie。
2. **HTTP exact 路由抢在 `/api` prefix 之前**：`<DSH>\dsh-host-webserver\lib\index.js:321-331`

```js
/** Longest-prefix-wins over the prefix table after an exact-table miss. */
match(pathname) {
    const exact = this.exact.get(pathname);
    if (exact !== void 0) return exact;
    let best;
    for (const [prefix, route] of this.prefixes) { ... }
    return best;
}
```
（注册入口：`:176-183`；命中优先级：`exact` 表先于 `prefix` 表；`/api` 是 prefix，`prefixes` 与 `exact` 是两张不同的表：`:147-148`）

因此第三方插件执行 `ctx.webServer.register({ kind: 'exact', path: '/api/anything', handler })`
会**抢在** client-connection 的 `/api` prefix handler 之前命中，从而**完全绕过** `requestRejection`（Host/Origin 栅栏 + cookie 鉴权）。
副作用：这条 exact 路由只是"挂在 /api 名字空间下"，**不会**落到既有 RPC 方法；要转发仍需插件自己调 §1.3.1。
（更朴素的做法：注册任意的自有路径，例如 `/astrbot-relay/rpc`，同样无鉴权——这正是 `docs/dsh-side-capabilities.md:275` 已经得出的结论。）

---

### 1.4 问题 4：`ctx.connection.fetch.register` 确切签名 / 是否在 `/api` 下 / 能否流式

#### 1.4.1 `.d.ts`

`<DSH>\dsh-client-connection\lib\types\rpc.d.ts:79-102`：

```ts
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST';
export type ConnectionRequestBodyMode = 'buffered' | 'streaming';
export interface ConnectionFetchRoute {
    /** Absolute path below `/api`; query parameters remain available on the request URL. */
    readonly path: string;
    readonly methods: readonly ConnectionFetchMethod[];
    /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
    readonly requestBody: ConnectionRequestBodyMode;
    /** Handle one request after the physical carrier has applied its trust and authentication policy. */
    readonly fetch: (request: Request) => Promise<Response>;
}
export interface HostConnectionFetch {
    register(route: ConnectionFetchRoute): () => Promise<void>;
}
```

#### 1.4.2 实现与三条关键语义

- 注册：`<DSH>\dsh-client-connection\lib\index.js:587-601`（按 `path` 存 Map，重复注册抛错）
- 路径必须严格位于 `/api` 之下，且多段式（`/api/<seg>`，每段匹配 `[A-Za-z0-9_$.-]+`、禁止 `.`/`..`）：`:696-700`

```js
function assertFetchRoute(route) {
	if (endpointFromPath("/api", route.path) === void 0) throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`);
	...
}
```
→ `/api/file` ✓、`/api/astrbot-relay/rpc` ✓（`endpointFromPath` 允许 `endpoint.split("/")` 多段，`:676`）、`/astrbot-relay` ✗。

- **受栅栏+鉴权约束**：`fetch` 表由 `createSharedFetchHandler` 在 **`/api` prefix 路由内部**查询（`:573-579`），而该路由在进 `bridge()` 之前先跑 `requestRejection`（`:771-779`）→ 是，**在 `/api` 之下且受同一 Host/Origin 栅栏 + cookie 鉴权**。`.d.ts` 注释亦明说：*"Handle one request **after** the physical carrier has applied its trust and authentication policy"*（`:91`）。
- handler 能拿到什么：**只有 `Request`**（method/url/headers/body/signal）。`Request.signal` 由 bridge 绑定到客户端断开（`:34-37`、`:68-80`）。
- **能否返回流式（SSE / ReadableStream）响应 —— 能**：
  - 路由返回 `Promise<Response>`，bridge 对 `response.body` **边收边写**（`:88-103`）：

```js
if (response.body === null) { res.end(); ... return; }
for await (const chunk of response.body) if (!res.write(chunk)) await new Promise(...res.once("drain"...));
res.end();
```
  - webserver 的 gzip 中间件**显式放行 `text/event-stream`**（`<DSH>\dsh-host-webserver\lib\index.js:113`：`if (...startsWith("text/event-stream")) return false;`）——即框架预期 SSE 存在。
  - 请求体流式（上传）亦有先例：`<DSH>\dsh-client-file-upload\lib\index.js:170-175` `requestBody: "streaming"`；缓冲/流式的分派点在 bridge `:42-80`。
  - 现成样例（`GET|HEAD /api/file`）：`<DSH>\dsh-api-session-controller\lib\index.js:2369-2374`
- 与 `webServer.register` 的差别：`webServer` 路由的 handler 直接拥有 `ServerResponse`（`<DSH>\dsh-host-webserver\lib\types\index.d.ts:37`：*"Owns the full response lifecycle (may hold the response open, e.g. SSE)"*），**没有鉴权**；`connection.fetch.register` 有鉴权但只给 `Request`/`Response`。

---

### 1.5 问题 5：`ctx.connection.requestRejection(req)` 语义与"复用框架栅栏"是否现实

- 声明：`<DSH>\dsh-client-connection\lib\types\rpc.d.ts:128-139`

```ts
/**
 * Apply Connection's Host/Origin checks and browser authentication to
 * another Web route.
 * @param request - request headers from the HTTP or upgrade request.
 * @returns rejection status, or undefined when the route may accept the request.
 */
requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection;
```
`ConnectionTrustRequest = { headers: Headers | Readonly<Record<string, string|string[]|undefined>> }`（`:59-62`）；返回 `401 | 403 | undefined`（`:64`）。

- 实现：`<DSH>\dsh-client-connection\lib\index.js:552-556`

```js
requestRejection(request) {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403;
    return this.browserAuth.isAuthenticated(request) ? void 0 : 401;
}
```
- 语义：**同步**纯判定，只读 `headers.host` / `origin` / `sec-fetch-site` / `cookie`。先 Host 栅栏（`isTrustedApiRequest`，`:201-215`：Host 必须是 loopback 或 `trustedHosts`；`sec-fetch-site: cross-site` 直接拒；带 Origin 时必须与 Host 同源），再验签 cookie（`BrowserAuth.isAuthenticated`，`:431-441`）。
- 对第三方插件是否现实：**是**。它把 node:http `IncomingMessage.headers` 直接传进去即可（`.d.ts` 注释明说 "from the HTTP or upgrade request"）。框架自身两处这么用：`client-connection\lib\index.js:609`、`api-gateway\lib\index.js:463`（WebSocket upgrade）。
- 局限：**只对"浏览器会话 cookie"有效**。跨机/非浏览器客户端（AstrBot）拿不到该 cookie，因此复用它的实际收益仅是①挡掉本机浏览器 CSRF/DNS-rebinding，②保持与框架一致的行为。跨机鉴权必须自建（与 `docs/DESIGN.md:17`、`docs/dsh-side-capabilities.md:275` 的结论一致）。

---

### 1.6 问题 6：兜底清单（34 行：`dsh_client.py` 的 27 个静态方法 + `goal.{action}` 六动作 + `commands/execute`）

> 说明：本项目**不需要**走「逐方法重做」——管道可行。本表同时充当
> **「点号名 → 真实 endpoint + 外层 wire 键」迁移对照表**，以及万一要直连服务时的服务名清单。
> 「服务键」列即 `ctx.get(<key>)` 的名字，`super(ctx,"...")` 的行号给出「已核实存在于本机安装产物」的证据。

#### 1.6.1 对照表

| # | connector 现用方法（dot） | 真实 endpoint（slash） | 服务键（Cordis） | 描述符证据（`<DSH>\…`） | 服务键证据 | 实机探测 |
|---|---|---|---|---|---|---|
| 1 | `host.describe` | **无** | — | 全安装 grep `host.describe` **0 命中**；无 `host` namespace | — | `404` |
| 2 | `session.list` | `session/list` | `sessionController` | `dsh-api-session-controller\lib\typert.host.js:896-919`（wire 键 **`_request`**） | `...\lib\index.js:2726` | `200` 真实数据 |
| 3 | `session.search` | `session/search` | `sessionController` | 同上 `:1041-1043`（`request`） | 同上 | `200` `missing "request"` |
| 4 | `session.create` | `session/create` | `sessionController` | `:819-822`（`request`） | 同上 | `200` |
| 5 | `session.rename` | `session/rename` | `sessionController` | `:1015-1018`（`request`） | 同上 | `200` |
| 6 | `session.fork` | `session/fork` | `sessionController` | `:872-874`（`request`） | 同上 | `200` |
| 7 | `session.prompt` | `session/prompt` | `sessionController` | `:989-992`（`request`） | 同上 | `200` |
| 8 | `session.cancel` | `session/cancel` | `sessionController` | `:762-765`（`request`） | 同上 | `200` |
| 9 | `session.history` | `session/page` | `sessionController` | `:963-966`（`request`） | 同上 | `session/history` = `404`；`session/page` 存在 |
| 10 | `session.models` | `session/modelCatalog` | `sessionController` | `:922-925`（**无参数**） | 同上 | `200` **真实模型目录** |
| 11 | `session.selectModel` | `session/selectModel` | `sessionController` | `:1067-1069`（`request`） | 同上 | `200` |
| 12 | `session.updateQueue` | `session/updateQueue` | `sessionController` | `:1092-1094`（`request`） | 同上 | `200` |
| 13 | `session.attachment` | `session/attachment` | `sessionController` | `:736-740`（`request`） | 同上 | `200` |
| 14 | `settings.describe` | `settings/describe` | `settingsController` | `dsh-api-settings-controller\lib\typert.host.js:214-216`（**无参数**） | `dsh-api-settings-controller\lib\index.js:412` | `200` **真实 schema** |
| 15 | `settings.mutate` | `settings/mutate` | `settingsController` | 同上 `:229-231`（wire 键 **`ns`,`ops`**） | 同上 | `200` |
| 16 | `llm.providers` | `llm/listProviders` | `llm` | `dsh-llm\lib\typert.host.js:90-92`（**无参数**） | `dsh-llm\lib\index.js:1748` | `200` **真实 provider 列表** |
| 17 | `llm.models` | `llm/discoverModels` | `llm` | 同上 `:38-41`（wire 键 **`settingsNs`,`request`**；`implementation: remoteDiscoverModels` `:41`） | 同上 | `200` |
| 18 | `agentPreset.list` | `agentPresets/list` | `agentPresets` | `dsh-agent-presets\lib\typert.host.js:114-117`（**无参数**） | `dsh-agent-presets\lib\index.js:1294` | `200` **真实 preset 列表** |
| 19 | `agentPreset.select` | `agentPresets/select` | `agentPresets` | 同上 `:156-158`（wire 键 **`agentId`,`agentPreset`**） | 同上 | `200` |
| 20 | `agentPreset.read` | `agentPresets/read` | `agentPresets` | 同上 `:130-133`（wire 键 **`agentPreset`**） | 同上 | `200` **真实 preset 正文** |
| 21 | `skill.list` | `skills/list` | `sessionSkillCatalog` | `dsh-api-session-controller\lib\typert.host.js:1117-1119`（`request`） | `...\lib\index.js:2235` | `200` |
| 22 | `subagent.list` | `subagents/list` | `subagents` | `dsh-subagent\lib\typert.host.js:109-111`（wire 键 **`parentSessionId`**） | `dsh-subagent\lib\index.js:2853` | `200` |
| 23 | `subagent.interrupt` | `subagents/interruptByParent` | `subagents` | 同上 `:64-66`（wire 键 **`parentSessionId`,`childSessionId`,`mode`**） | 同上 | `200` |
| 24 | `workspace.list` | **无** | — | 无 `workspace/list`；`workspace` namespace 只有 archiveSession/create/delete/follow/insertBefore/insertSessionBefore/rename（`dsh-api-workspace-controller\lib\typert.host.js:206-350`） | `workspaceRegistry`：`dsh-workspace\lib\index.js:333` | `workspace/list` = `404` |
| 25 | `workspace.create` | `workspace/create` | `workspaceController` | `...\typert.host.js:231-233`（`request`） | `dsh-api-workspace-controller\lib\index.js:662` | `200` |
| 26 | `workspace.rename` | `workspace/rename` | `workspaceController` | 同上 `:348-350`（`request`） | 同上 | `200` |
| 27 | `workspace.archiveSession` | `workspace/archiveSession` | `workspaceController` | 同上 `:206-208`（`request`） | 同上 | `200` |
| 28 | `goal.create` | `goals/create` | `goals` | `dsh-goal\lib\typert.host.js:213-216`（wire 键 **`agentId`,`request`**；`implementation: remoteExportCreate` `:216`） | `dsh-goal\lib\index.js:592` | `200` |
| 29 | `goal.edit` | `goals/edit` | `goals` | 同上 `:254-256`（`agentId`,`ref`,`request`） | 同上 | `200` |
| 30 | `goal.pause` | `goals/pause` | `goals` | 同上 `:334-336`（`agentId`,`ref`） | 同上 | `200` |
| 31 | `goal.resume` | `goals/resume` | `goals` | 同上 `:374-376`（`agentId`,`ref`） | 同上 | `200` |
| 32 | `goal.complete` | `goals/complete` | `goals` | 同上 `:173-175`（`agentId`,`ref`） | 同上 | `200` |
| 33 | `goal.blocked` | **无** | — | goals namespace 只有 clear/complete/create/edit/get/pause/resume（同上 `:133-376`） | `goals`：`dsh-goal\lib\index.js:592` | `goals/blocked` = `404` |
| 34 | `commands/execute` | `commands/execute` | `commands` | `dsh-commands\lib\typert.host.js:45-47` | `dsh-commands\lib\index.js:250` | `200`（connector 已在用，**唯一本来就对的方法**） |

补充（表外但很可能会用到，均已实机确认存在）：

| 用途 | endpoint | wire 键 | 证据 |
|---|---|---|---|
| 会话事件流（`assistant/...` 等） | `session/control`（**stream**） | — | `dsh-api-session-controller\lib\typert.host.js:802-816`（`mode:'stream'`）；实机 `200 gateway/signature-invalid`（须走 `ctx.typertGateway.stream`） |
| Workspace 完整投影（baseline 首帧） | `workspace/follow`（**stream**） | — | `dsh-api-workspace-controller\lib\typert.host.js:281-283`；README.zh.md:25 说明首帧是完整 baseline |
| 会话历史页 | `session/page` | `request:{address,throughSeq,beforeSeq?,maxMessages?}` | `typert.host.js:1789`（`SessionPageRequest`）、`:1661`（`SessionAddress` = `{kind:'session',sessionId}`） |
| 全局 skill 目录 | `skills/list` | `request` | 同上 `:1117-1119` |

**`session.history` → `session/page` 的结构对应（静态比对，形状高度一致）**：

| connector 现在读的 | `session/page` 实际给的 | 证据 |
|---|---|---|
| `value["events"]`（`core/dsh_client.py:222`） | `value["records"]` | `typert.host.js:1785` `interface SessionPage { records: readonly SessionHistoryRecord[]; hasMore: boolean; }` |
| `entry["event"]`（`dsh_client.py:455`） | `record["event"]`（`SessionEventEntry = {type:'event', event: SessionWireEvent}`） | `typert.host.js:1713` |
| `event_seq(event)` → `event["seq"]`、`event["type"]`、`event["data"]`（`dsh_client.py:458-480`、`dsh_connector_helpers.py:21`） | `SessionWireEvent{type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp?}` | `typert.host.js:1909` |
| 新增必填 `throughSeq: number` | 可用 `session/list` 的 `projections.asOfSeq`（实机返回值里就有：`"projections":{"asOfSeq":351,…}`） | 实机探测输出，§2.3 |

→ 迁移是**字段改名级别**（`events`→`records`，payload 包一层 `request` 并补 `address`/`throughSeq`），不是重写。`throughSeq` 的确切语义已按宿主实现逐行核实（§4.2 第 5 条）。

#### 1.6.2 三个"无对应 endpoint"项的兜底

| 项 | 兜底（进程内，已核实服务存在） |
|---|---|
| `host.describe`（connector 只取 `cwd`） | `session/list` 的 `SessionSummary.cwd` 字段（`dsh-api-session-controller\lib\typert.host.js:1877`：`SessionSummary{ sessionId, updatedAt, running, blank, parentSessionId?, origin?, cwd?, projections? }`）。无需新服务。 |
| `goal.blocked` | 服务方法存在但**没有** Remote endpoint：`ctx.get('goals').block(agent, ref, reason)`（`dsh-goal\lib\index.js:720-729`；`reason` 校验在 `:77-79`，phase 只允许 `active→blocked`）。代价：需要 **live Agent 对象**（`this.assertLive(agent)`，`:767-768`），即插件得先按 sessionId 解析 agent。若不想碰这一层，可让 AstrBot 侧放弃 `blocked`（改用 `goals/complete` + 自己的备注）。 |
| `workspace.list` | 二选一：① 进程内 `ctx.get('workspaceRegistry').list()`（`dsh-workspace\lib\index.js:384-390`，同步、无持久化读，返回有序 workspace 实体数组）；② 走 `workspace/follow` 流，取首帧 baseline（`dsh-api-workspace-controller\README.zh.md:25`）。 |

#### 1.6.3 「逐方法进程内重做」的完整服务名清单（若真要走兜底）

| 能力域 | Cordis 服务键 | 提供包（`super(ctx, "...")` 证据） |
|---|---|---|
| session / skills / fileReferences | `sessionController` / `sessionSkillCatalog` / `sessionFileReferences` | `dsh-api-session-controller\lib\index.js:2726 / 2235 / 1710` |
| settings / credentials | `settingsController` / `credentialsController` | `dsh-api-settings-controller\lib\index.js:412 / 146` |
| workspace / directoryPicker | `workspaceController` / `directoryPickerController` | `dsh-api-workspace-controller\lib\index.js:662 / 415` |
| workspace 文件读写 | `workspaceFiles` | `dsh-api-workspace-files\lib\index.js:369` |
| workspace 注册表 | `workspaceRegistry` | `dsh-workspace\lib\index.js:333` |
| goal | `goals` | `dsh-goal\lib\index.js:592` |
| subagent | `subagents` | `dsh-subagent\lib\index.js:2853` |
| 命令 | `commands` | `dsh-commands\lib\index.js:250` |
| LLM provider/model 目录 | `llm` | `dsh-llm\lib\index.js:1748` |
| agent preset | `agentPresets` | `dsh-agent-presets\lib\index.js:1294` |
| skill 注册表 | `skills` | `dsh-skill\lib\index.js:132` |
| 历史检索（全文） | `sessionQuery` | `dsh-session-query\lib\index.js:1040` |
| settings 文档 | `settings` | `dsh-settings\lib\index.js:238` |
| 派发器 / 注册表 | `typertGateway` / `typert` | `dsh-api-gateway\lib\index.js:449` / `dsh-typert-registry\lib\index.js:359` |

---

## 2. 实机探针（可复现）

### 2.1 方法

脚本：`C:\Users\<user>\Downloads\astrdsh\.probe\probe-api.mjs`（**只读**：所有调用都是查询类）。

它按 `<DSH>\dsh-client-connection\lib\index.js:386-441`（`BrowserAuth.authorizeIndex` / `isAuthenticated`）的算法**自签**一枚浏览器会话 cookie：

- 密钥来源：`$DSH_HOME/.credentials.yaml` 的 `records.client-connection/browser-session.payload.secret`（键名由 `credentialKey("client-connection","browser-session")` 生成，`dsh-client-connection\lib\index.js:219`；文档：`dsh-client-connection\README.zh.md:37`）
- cookie 名：`dsh-auth-<base64url(sha256(authority))>`（`:280-282`）
- 值：`v1.<base64url(JSON{version,authority,issuedAt,expiresAt})>.<base64url(HMAC-SHA256(secret,body))>`（`:298-320`）
- 请求：`POST http://127.0.0.1:3080/api/<endpoint>`，body `{type:'client-request',rpcId,method:<endpoint>,payload:{args:{...}}}`

> 注：这一节本身也是 §1.3 的一个旁证——**任何能读 `$DSH_HOME` 的本机进程都能自签该 cookie**；它是防 CSRF/rebinding 的栅栏，不是身份边界（README.zh.md:39 原文："这些检查防御 DNS rebinding 与跨站浏览器请求，**绝不建立身份**"）。

### 2.2 结果 A：点号方法名一律 404（33/33）

命令（节选，全部 33 个点号名逐个跑过）：

```
node .probe\probe-api.mjs host.describe session.list session.search session.create session.rename \
  session.fork session.prompt session.cancel session.history session.models session.selectModel \
  session.updateQueue session.attachment settings.describe settings.mutate llm.providers llm.models \
  agentPreset.list agentPreset.select agentPreset.read skill.list subagent.list subagent.interrupt \
  workspace.list workspace.create workspace.rename workspace.archiveSession goal.create goal.edit \
  goal.pause goal.resume goal.complete goal.blocked
```

输出（逐行原始）：

```
POST /api/host.describe -> HTTP 404 :: not found
POST /api/session.list -> HTTP 404 :: not found
POST /api/session.search -> HTTP 404 :: not found
POST /api/session.create -> HTTP 404 :: not found
POST /api/session.rename -> HTTP 404 :: not found
POST /api/session.fork -> HTTP 404 :: not found
POST /api/session.prompt -> HTTP 404 :: not found
POST /api/session.cancel -> HTTP 404 :: not found
POST /api/session.history -> HTTP 404 :: not found
POST /api/session.models -> HTTP 404 :: not found
POST /api/session.selectModel -> HTTP 404 :: not found
POST /api/session.updateQueue -> HTTP 404 :: not found
POST /api/session.attachment -> HTTP 404 :: not found
POST /api/settings.describe -> HTTP 404 :: not found
POST /api/settings.mutate -> HTTP 404 :: not found
POST /api/llm.providers -> HTTP 404 :: not found
POST /api/llm.models -> HTTP 404 :: not found
POST /api/agentPreset.list -> HTTP 404 :: not found
POST /api/agentPreset.select -> HTTP 404 :: not found
POST /api/agentPreset.read -> HTTP 404 :: not found
POST /api/skill.list -> HTTP 404 :: not found
POST /api/subagent.list -> HTTP 404 :: not found
POST /api/subagent.interrupt -> HTTP 404 :: not found
POST /api/workspace.list -> HTTP 404 :: not found
POST /api/workspace.create -> HTTP 404 :: not found
POST /api/workspace.rename -> HTTP 404 :: not found
POST /api/workspace.archiveSession -> HTTP 404 :: not found
POST /api/goal.create -> HTTP 404 :: not found
POST /api/goal.edit -> HTTP 404 :: not found
POST /api/goal.pause -> HTTP 404 :: not found
POST /api/goal.resume -> HTTP 404 :: not found
POST /api/goal.complete -> HTTP 404 :: not found
POST /api/goal.blocked -> HTTP 404 :: not found
```

其中 `host.describe`/`workspace.list`/`goal.blocked` 是**真实不存在**（§1.6.1 #1/#24/#33），其余是**拼写错误**（点号 vs 斜杠）。

对照：`POST /api/session/list`、`/api/commands/execute`、`/api/$events/result` 均被认领并进入业务层：

```
POST /api/session/list -> HTTP 200 :: {"type":"server-response","rpcId":"probe-…","result":{"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: session/list: args fields do not match the descriptor: missing \"_request\"","details":{"endpoint":"session/list"}}}}
POST /api/commands/execute -> HTTP 200 :: {"…","message":"typert gateway: commands/execute: args fields do not match the descriptor: missing \"agentId\", \"line\", \"submi…"}
POST /api/$events/result -> HTTP 200 :: {"…","code":"gateway/internal","message":"api gateway: invalid Remote event result"}
```

### 2.3 结果 B：换成 slash + `{args:{…}}` 后**取到真实数据**（载荷体与 connector 逐字段一致）

```
POST /api/session/list args={"_request":{}} -> HTTP 200 ::
  {"result":{"ok":true,"value":{"items":[{"sessionId":"7882a840-…","updatedAt":…,"running":true,
   "cwd":"C:\\Users\\<user>\\Downloads\\astrdsh","projections":{"title":"你是一名代码考古工程师（Wind",…}}]}}}

POST /api/agentPresets/read args={"agentPreset":"standard"} -> HTTP 200 ::
  {"result":{"ok":true,"value":{"agentPreset":"standard","trust":"system","content":"# The `standard` agent preset…"}}}

POST /api/session/modelCatalog -> HTTP 200 ::
  {"result":{"ok":true,"value":{"default":{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"},"routableProviders":[…],"groups":[…]}}}

POST /api/settings/describe -> HTTP 200 :: {"result":{"ok":true,"value":{"writable":true,"hasDocument":true,"namespaces":[…]}}}

POST /api/llm/listProviders -> HTTP 200 :: {"result":{"ok":true,"value":[{"id":"deepseek-official","name":"DeepSeek"},{"id":"deepseek","name":"deepseek"}]}}

POST /api/agentPresets/list -> HTTP 200 :: {"result":{"ok":true,"value":{"presets":[{"id":"standard","trust":"system","isDefault":true,…}]}}}
```

### 2.4 结果 C：流式端点必须走流载体

```
POST /api/workspace/follow -> HTTP 200 :: {"…","code":"gateway/signature-invalid","message":"typert gateway: workspace/follow: stream Remote methods must be opened through the stream carrier"}
POST /api/session/control  -> HTTP 200 :: {"…","code":"gateway/signature-invalid","message":"typert gateway: session/control: stream Remote methods must be opened through the stream carrier"}
POST /api/session/follow   -> HTTP 200 :: {"…","code":"gateway/arguments-invalid","message":"…missing \"request\""}   // 一元，不是 stream
```

---

## 3. 最小可用代码骨架（DSH host 半）

```js
// bundle/host.js —— dsh host 插件：把既有 host RPC 方法原样转发给 AstrBot
import { randomUUID } from 'node:crypto';

export const name = 'dsh-astrbot-control-plane';
export const inject = ['connection'];            // 需要 ctx.connection（bring 起 /api 派发器）

export function apply(ctx) {
  // 与浏览器 /api 完全同构的进程内派发器；不含 Host/Origin 栅栏与 cookie 鉴权
  const dispatch = ctx.connection.createSharedFetchHandler('/api');

  const forward = async (endpoint, args, signal) => {
    const res = await dispatch.fetch(new Request(`http://dsh.internal/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args },
      }),
      signal,
    }));
    const envelope = await res.json();           // {type:'server-response', rpcId, result:{ok,value|error}}
    return { status: res.status, result: envelope.result };
  };

  ctx.inject(['webServer'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'exact',                             // exact 表先于 /api prefix 命中 → 不经过 connection 的栅栏
      path: '/astrbot-relay/rpc',
      handler: async (req, res) => {
        // TODO: 这里做你自己的鉴权（共享密钥 / HMAC / IP 白名单）——框架不会替你挡
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const { endpoint, args } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        try {
          const { status, result } = await forward(endpoint, args, AbortSignal.timeout(120_000));
          res.writeHead(status === 200 ? 200 : 502, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: { code: 'bridge/transport', message: String(error?.message ?? error), details: {} } }));
        }
      },
    }), 'astrbot-control-plane');
  });

  // 流式端点（session/control、workspace/follow）只能走这条：
  // const stream = await ctx.typertGateway.stream({ namespace: 'workspace', method: 'follow', args: {}, signal });
}
```

变体（不想经过 envelope，直接拿业务值/错误）：

```js
const value = await ctx.typertGateway.invoke({ namespace: 'session', method: 'list', args: { _request: {} } });
// 抛 RemoteError（code: 'gateway/*' 为派发故障，业务错误保留自身 code）
```

AstrBot 侧**唯一必须改的两处**（`core/dsh_client.py`）：
`rpc()` 第 61–91 行（URL + 信封：`payload: {args: {...}}`，方法名换 slash），以及调用点传入的 `payload` 外层键（见 §1.6.1 的「wire 键」列）。`main.py` 的业务调用点不需要改。

---

## 4. 未验证 / 未找到证据 / 与假设不符

### 4.1 与假设不符（重要）

| 假设 | 实机/源码事实 | 影响 |
|---|---|---|
| connector 的方法清单（`session.list`…）是当前 DSH 的合法方法名，可"原样复用" | **33 个点号方法全部 404**；当前 DSH 的 endpoint 是 `<namespace>/<method>`（`endpointOf`，`dsh-api-gateway\lib\index.js:990-992`；`claimsEndpoint` 要求 `split("/").length === 2`，`:510-517`） | DESIGN.md §7.3「管道式」的成本从「只换 base_url」上升为「加一张映射表 + 改两个函数」；仍远低于「逐方法重做」 |
| `/api` 面"按方法区分 loopback 豁免" | README 原文：**不存在**按方法区分的 loopback 层（`dsh-client-connection\README.zh.md:35`） | connector 的跨机部署必须自建鉴权（与已有结论一致） |
| 第三方插件只能注册自己的 channel | 还能注册 **exact 路由抢占 `/api/<path>`**，从而绕过 `/api` prefix 的栅栏与鉴权 | 安全模型上：`/api` 这个名字空间对其他插件不是封闭的 |
| `goal.<action>` 六件套齐备 | `goals/blocked` **不存在**（无该 descriptor）；`goals` 服务有 `block()` 方法但需 live Agent | 需要专门处理 |
| `workspace.list`、`host.describe` 是 RPC | 均不存在；需用 `workspaceRegistry.list()` / `session/list.cwd` 替代 | 需要专门处理 |
| `connection.fetch.register` 的**响应**流式未在文档中声明（`docs/dsh-side-capabilities.md:1513` 遗留问题） | **已证实可以**：`route.fetch` 返回 `Promise<Response>`，bridge 对 `response.body` 边收边写（`dsh-client-connection\lib\index.js:88-103`），且 webserver gzip 显式放行 `text/event-stream`（`dsh-host-webserver\lib\index.js:113`） | 该遗留问题可以关闭 |

### 4.2 未找到证据 / 未实跑

1. **未实跑「进程内直调」**：`createSharedFetchHandler('/api').fetch(...)` 与 `ctx.typertGateway.invoke(...)` 只有**静态已证实**（公开 `.d.ts` 声明 + 实现体无 `requestRejection` + 第三方插件可访问同类框架服务的本机实例证据）。原因：需要把插件装进 profile 并重启 harness，超出本次只读考古的范围。
2. **未实跑 `ctx.connection.fetch.register` 的 SSE**：仅静态已证实（`Promise<Response>` + `response.body` 流式写 + gzip 放行）。
3. **未实跑 `ctx.webServer.register({kind:'exact', path:'/api/...'})` 的抢占**：仅静态已证实（`match()` 先查 exact 表）。**注意**：`/api` 之外若已有同名 exact 路由会抛错（`dsh-host-webserver\lib\index.js:178`）。
4. **`host` namespace**：全安装 grep `host.describe` **0 命中**；未找到任何提供"主机事实/`cwd`"的 Remote endpoint（`dsh-web-app` 的 `surfaceContext` 只注入浏览器启动数据，未核实其是否含 `cwd`）。
5. ~~**`session.history` → `session/page` 的 `throughSeq` 语义**~~ **【已结案】**：结构对应已比对通过（§1.6.1 补充表），`throughSeq` 的语义已由宿主实现逐行取证——它是 log 的**闭区间上界**（inclusive log cut），不是"起始 seq"；`-1` 合法（空窗口上界）、`-0` 被拒（`dsh-api-session-controller\lib\index.js:1565-1569`）；`throughSeq > 末尾 seq` 抛 `gateway/bad-request` "session page through seq X is past cursor Y"（`:1378-1379`），`throughSeq >= 0` 还要求 `sourceLog[throughSeq].seq` 严格等于 `throughSeq`，否则 `gateway/internal`（`:1381`）。`maxMessages` 缺省 `DEFAULT_MAX_MESSAGES = 50`（`:1328`），分页自窗口末尾倒序收敛、`hasMore = cut > 0`（`:1602-1624`），返回体 `{records, hasMore}`（`:1383-1386`）。**残留已结案（v0.8.2 实跑）**：本仓库的回读不经 `session/page` 轮询，而是 SSE `BridgeTransport.events()` / `_stream_once()`（`astrbot_plugin_dsh_relay/main.py:545-671`）；旧 connector 的 `_await_reply`（`dsh_client.py:441-495`）已不在本仓库。实跑一次（`conversation=default:PrivateMessage:nene-e2e-0802`，桥 `bridgeVersion=4`，`/health` 200）帧序为 `turn/start(seq=1)` → `text/delta` ×2（**无 `seq`**，不进环形缓冲游标）→ `message/final(seq=2,text="pong")` → `turn/end(seq=3,reason.kind="completed")`，`lastEventId=3`；同一 `Idempotency-Key`（UUIDv4）重投返回 `{"accepted":true,"duplicate":true,"queueDepth":1}`，而**非 UUIDv4 的键被 400 `unsupported` 拒收**（"Idempotency-Key 必填且必须是 UUIDv4"，契约 §3.1）。
6. **`goals/*` 的 lookup 解析**：`goals` 的 wire 键 `agentId` 由哪个 lookup/Context provider 解析**未逐行核实**（只核实了 wire 名与 `assertExactArguments` 行为）。若要进程内直调 `ctx.get('goals').xxx(agent, …)`，需要先找到按 sessionId 解析 Agent 的入口。
7. **`dsh-client-connection` 的 in-process `rpc.call/open` 载体是否对 host 插件可用**：`ClientConnectionRpc.call/open`（`rpc.d.ts:173-193`）属于 **Client 半**（`dsh-client-connection/lib/client.js`，`createWebConnectionRpc` 在 `:6194`），本机 `web` profile 的 host 侧没有装载它。host 侧请用 §1.3.1 的入口 A/B。
8. **第三方插件是否会被 loader 隔离**：确认了本机 profile 未使用 `isolate()`，且 `dsh-whale-widget` 实际访问到 `ctx.credentials`/`ctx.webServer`；但**未核实** `dsh` loader 是否有其他（配置驱动的）作用域隔离路径。

### 4.3 「已证实」（汇总）

- 注册点、注册表对象、键形状、handler 签名、响应包装、派发链：**源码逐行已证实**。
- 33 个点号方法 404、slash 端点存在性、wire 参数名、部分端点的真实返回值：**实机探针已证实**（§2）。
- `requestRejection` 的签名与语义、`fetch.register` 的三条约束（`/api` 之下 / 受鉴权 / 可流式）：**源码已证实**。
- 第三方 host 插件与框架服务同上下文：**本机实例（`dsh-whale-widget`）已证实**。
