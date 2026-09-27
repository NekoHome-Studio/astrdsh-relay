/**
 * RPC 方法元数据 —— **自动生成，不要手改**。
 *
 *   生成器：`node scripts/gen-rpc-methods.mjs`
 *   原料：  `dsh-astrbot-relay/data/p5_rpc_descriptors.json`（84 条描述符，
 *           从 @deepseek-ai/dsh-api-remotes 的本机安装产物切块提取）
 *           `dsh-astrbot-relay/data/p5_rpc_allowlist.md`（同批 84 条的分级底表）
 *   契约：  `docs/BRIDGE-CONTRACT.md` §11（控制面转发）
 *
 * 三张口径固定在这里，改动前先读契约 §11.4：
 *
 *   1. **粒度 = 方法名 + wire 键集合 + 是否 stream**，三者缺一不可。
 *      只按方法名放行是不够的：同一个方法，参数键写错就该被 400 挡下，
 *      而不是把半成品透传给宿主再折成 `gateway/internal`。
 *   2. **wire 键才是报文里出现的键**（不是参数名）。全表 28 条参数名与 wire
 *      不同名，两组是系统性的 `source:"lookup"` 重命名：`agent`→`agentId`、
 *      `workspaceFileScope`→`workspaceFileScopeId`。最容易写错的是
 *      `session/list`：它的参数名和 wire 键**都是** `_request`。
 *   3. **stream 四类一律 403**：宿主 `invoke()` 对 `mode === 'stream'` 直接抛
 *      `gateway/signature-invalid`，插件侧必须前置拒绝，别让它变成 500。
 *
 * 另有一条禁入名单（不进任何白名单）：`host/describe`、`workspace/list`、
 * `goals/blocked`（实测 404）与高权限 `dynamicCordisRunner/*`（12 条）。
 * `dynamicCordisRunner/*` 在表里属 C 类（显式开启才可加），因此它**不得**
 * 出现在 `RPC_DEFAULT_METHODS` 里。
 */

/** 描述符条数（与契约 §11.4 的 84 条一致；闸门会在这里对不上时报错）。 */
export const RPC_METHOD_COUNT = 84

/**
 * endpoint → 允许出现在 `args` 里的 wire 键。
 *
 * 出现集合外的键 → **400 `unsupported`**（请求本身是好的，但粒度对不上）；
 * 出现未登记的方法 → **403 `forbidden`**（身份已确认、权限不够）。
 * 两条错误码刻意分开，见 contract.js 的 ERROR_CODE.FORBIDDEN 注释。
 */
export const RPC_WIRE_KEYS = Object.freeze({
  'agentPresets/copy': ['from', 'id', 'name'],
  'agentPresets/deletePreset': ['id'],
  'agentPresets/list': [],
  'agentPresets/read': ['agentPreset'],
  'agentPresets/select': ['agentId', 'agentPreset'],
  'commands/execute': ['agentId', 'line', 'submittedAttachments'],
  'commands/list': ['agentId'],
  'credentials/describe': ['refs'],
  'credentials/set': ['ref', 'value'],
  'credentials/unset': ['ref'],
  'directoryPicker/createDirectory': ['path', 'name'],
  'directoryPicker/list': ['path'],
  'directoryPicker/pick': [],
  'dynamicCordisRunner/getClientCode': ['agentId', 'pluginId', 'pluginRunId'],
  'dynamicCordisRunner/inventory': [],
  'dynamicCordisRunner/invoke': ['pluginId', 'pluginRunId', 'method', 'args'],
  'dynamicCordisRunner/reportClientGuardFailure': ['agentId', 'pluginId', 'pluginRunId', 'failure'],
  'dynamicCordisRunner/reportRenderFailure': ['agentId', 'pluginId', 'pluginRunId', 'failure'],
  'dynamicCordisRunner/resolveInspectQuery': ['agentId', 'requestId', 'resolution'],
  'dynamicCordisRunner/resolveRequestRun': ['requestId', 'resolution'],
  'dynamicCordisRunner/runHostHalf': ['agentId', 'pluginId', 'packageId', 'mode', 'requestId', 'approveFutureVersions'],
  'dynamicCordisRunner/settleUserRun': ['agentId', 'pluginId', 'resolution'],
  'dynamicCordisRunner/stopFromPanel': ['agentId', 'pluginId'],
  'dynamicCordisRunner/syncInspectManifest': ['providers'],
  'dynamicCordisRunner/undefineFromPanel': ['agentId', 'pluginId'],
  'fileReferences/list': ['agentId', 'query'],
  'fileUploads/upload': ['agentId', 'request'],
  'goals/clear': ['agentId', 'ref'],
  'goals/complete': ['agentId', 'ref'],
  'goals/create': ['agentId', 'request'],
  'goals/edit': ['agentId', 'ref', 'request'],
  'goals/get': ['agentId'],
  'goals/pause': ['agentId', 'ref'],
  'goals/resume': ['agentId', 'ref'],
  'llm/discoverModels': ['settingsNs', 'request'],
  'llm/listConfigurableProviders': [],
  'llm/listProviders': [],
  'messageFeedback/delete': ['request'],
  'messageFeedback/list': ['request'],
  'messageFeedback/put': ['request'],
  'pluginInventory/list': [],
  'session/attachment': ['request'],
  'session/canOpenWorkspacePath': [],
  'session/cancel': ['request'],
  'session/control': [],
  'session/create': ['request'],
  'session/follow': ['request'],
  'session/fork': ['request'],
  'session/list': ['_request'],
  'session/modelCatalog': [],
  'session/openWorkspacePath': ['request'],
  'session/page': ['request'],
  'session/prompt': ['request'],
  'session/rename': ['request'],
  'session/search': ['request'],
  'session/selectModel': ['request'],
  'session/updateQueue': ['request'],
  'sessionFeedback/record': ['request'],
  'sessionReferenceResolver/candidates': ['agentId', 'query'],
  'settings/canOpenAgentPresetDirectory': [],
  'settings/describe': [],
  'settings/mutate': ['ns', 'ops', 'expectedRevision'],
  'settings/openAgentPresetDirectory': ['agentPreset'],
  'settings/openSettingsDocument': [],
  'settings/replace': ['ns', 'section', 'expectedRevision'],
  'settings/update': ['ns', 'patch', 'expectedRevision'],
  'skills/list': ['request'],
  'subagents/interruptByParent': ['childSessionId', 'parentSessionId', 'mode'],
  'subagents/list': ['parentSessionId'],
  'subagents/prompt': ['request'],
  'workspace/archiveSession': ['request'],
  'workspace/create': ['request'],
  'workspace/delete': ['request'],
  'workspace/follow': [],
  'workspace/insertBefore': ['request'],
  'workspace/insertSessionBefore': ['request'],
  'workspace/rename': ['request'],
  'workspaceFiles/changes': ['workspaceFileScopeId'],
  'workspaceFiles/list': ['workspaceFileScopeId', 'path'],
  'workspaceFiles/read': ['workspaceFileScopeId', 'path', 'range'],
  'workspaceFiles/readAll': ['workspaceFileScopeId', 'path'],
  'workspaceFiles/readBytes': ['workspaceFileScopeId', 'path', 'range'],
  'workspaceFiles/readRelated': ['workspaceFileScopeId', 'path', 'relativePath'],
  'workspaceFiles/stat': ['workspaceFileScopeId', 'path'],
})

/**
 * 流式四类：`POST /rpc` 对它们一律 **403 `forbidden`**。
 * 理由不是「不方便」，而是宿主层根本不通：`invoke()` 见到
 * `descriptor.mode === 'stream'` 就抛 `gateway/signature-invalid`。
 * 将来要中继流，得走 `ctx.typertGateway.stream()`，那是独立的一条设计。
 */
export const RPC_STREAM_METHODS = Object.freeze([
  'session/control',
  'session/follow',
  'workspace/follow',
  'workspaceFiles/changes',
])

/**
 * `Config.allowedRpcMethods` 的**缺省白名单 = A 类 26 条**（提案 §4.2 / §7）。
 * 只读、无副作用，是「开箱可用」与「不越权」的交点。
 * 想开 C 类（含 `settings/*`、写工作区目录等）必须显式写进配置——
 * 那时出的事算配置者自己认下的。
 */
export const RPC_DEFAULT_METHODS = Object.freeze([
  'agentPresets/list',
  'agentPresets/read',
  'credentials/describe',
  'fileReferences/list',
  'llm/discoverModels',
  'llm/listConfigurableProviders',
  'llm/listProviders',
  'messageFeedback/list',
  'pluginInventory/list',
  'session/attachment',
  'session/canOpenWorkspacePath',
  'session/list',
  'session/modelCatalog',
  'session/page',
  'session/search',
  'sessionReferenceResolver/candidates',
  'settings/canOpenAgentPresetDirectory',
  'settings/describe',
  'skills/list',
  'subagents/list',
  'workspaceFiles/list',
  'workspaceFiles/read',
  'workspaceFiles/readAll',
  'workspaceFiles/readBytes',
  'workspaceFiles/readRelated',
  'workspaceFiles/stat',
])

/** 一条 endpoint 是否登记在描述符表里。 */
export function isKnownRpcMethod(endpoint) {
  return Object.prototype.hasOwnProperty.call(RPC_WIRE_KEYS, endpoint)
}

/** 该 endpoint 的 wire 键集合（未登记返回 undefined）。 */
export function wireKeysOf(endpoint) {
  return RPC_WIRE_KEYS[endpoint]
}

/** 该 endpoint 是否属流式四类（必须走流式通道，`/rpc` 一律 403）。 */
export function isStreamRpcMethod(endpoint) {
  return RPC_STREAM_METHODS.includes(endpoint)
}
