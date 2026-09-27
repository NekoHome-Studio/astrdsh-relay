# P5 白名单全量表 —— 84 条真实 RPC 描述符（2026-09-27 实测提取）

- 来源：`C:\Users\34300\.dsh\profiles\node_modules\@deepseek-ai\dsh-api-remotes\lib\client.js`
  （329,870 字节，本机安装产物，非文档、非推断）
- 提取方式：按 `id: "<pkg>#<ns>/<method>"` 字面量切块，块尾以 `sourceLocation` 收口，
  逐条取 `service / invocation.kind / parameters[].name / parameters[].wire / mode=="stream" / 源码行号`
- 结构化原始数据：`p5_rpc_descriptors.json`（同目录，可复核）
- 本表是 §4 白名单的**证据底座**：提案里的「启用前逐条实测」自留项**至此已消解**

---

## 0. 三条校正（相对上一轮结论）

1. **stream 类不是 3 条，是 4 条**：新增 `workspaceFiles/changes`（`mode:"stream"`，
   参数 `workspaceFileScope`→wire `workspaceFileScopeId`）。`session/control`、`session/follow`、
   `workspace/follow` 保持不变。上一轮把 `subagents/prompt` 判为 stream 是**切块越界造成的误判**，
   已排除 —— 它的 `invocation.kind` 是 `direct`、无 `mode` 字段。
2. **参数名 ≠ wire 键，共 28 条**，白名单校验必须落在 **wire 键**上（那才是报文里真正出现的键）。
   其中两组是系统性的 `source:"lookup"` 重命名：`agent`→`agentId`、`workspaceFileScope`→`workspaceFileScopeId`。
3. **`session/list` 是整体改名**，不是「name 与 wire 不一致」：它的参数名和 wire 键**都是 `_request`**，
   而其余 session 方法一律 `request`。这条最容易被写成 `{"request":{}}` 然后 400。

附带一条：**service 键与 namespace 不总同名**，共有 7 处不同名 ——
`session→sessionController`、`settings→settingsController`、`credentials→credentialsController`、
`workspace→workspaceController`、`directoryPicker→directoryPickerController`、
`fileReferences→sessionFileReferences`、`skills→sessionSkillCatalog`。
白名单若要同时校验 service 键，这 7 条必须走映射表。

---

## 1. namespace 分布（19 个 / 84 条）

| namespace | 条数 | service 键 |
|---|---|---|
| `session` | 16 | `sessionController` |
| `dynamicCordisRunner` | 12 | `dynamicCordisRunner` |
| `goals` | 7 | `goals` |
| `settings` | 7 | `settingsController` |
| `workspace` | 7 | `workspaceController` |
| `workspaceFiles` | 7 | `workspaceFiles` |
| `agentPresets` | 5 | `agentPresets` |
| `credentials` | 3 | `credentialsController` |
| `directoryPicker` | 3 | `directoryPickerController` |
| `llm` | 3 | `llm` |
| `messageFeedback` | 3 | `messageFeedback` |
| `subagents` | 3 | `subagents` |
| `commands` | 2 | `commands` |
| `fileReferences` | 1 | `sessionFileReferences` |
| `fileUploads` | 1 | `fileUploads` |
| `pluginInventory` | 1 | `pluginInventory` |
| `sessionFeedback` | 1 | `sessionFeedback` |
| `sessionReferenceResolver` | 1 | `sessionReferenceResolver` |
| `skills` | 1 | `sessionSkillCatalog` |

---

## 2. 全量 84 条

`wire 键` 一列标注 `参数名→wire`；未标注即两者同名。`建议` 一列是本提案的归类（X = 不暴露）。

### 2.1 `session`（16 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `session/attachment` | `request` | — | A 只读 | `packages/api/session-controller/src/index.ts:357` |
| `session/cancel` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:377` |
| `session/canOpenWorkspacePath` | — | — | A 只读 | `packages/api/session-controller/src/index.ts:272` |
| `session/control` | — | ✅ | X 不暴露 | `packages/api/session-controller/src/index.ts:410` |
| `session/create` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:244` |
| `session/follow` | `request` | ✅ | X 不暴露 | `packages/api/session-controller/src/index.ts:400` |
| `session/fork` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:335` |
| `session/list` | `_request` | — | A 只读 | `packages/api/session-controller/src/index.ts:223` |
| `session/modelCatalog` | — | — | A 只读 | `packages/api/session-controller/src/index.ts:263` |
| `session/openWorkspacePath` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:293` |
| `session/page` | `request` | — | A 只读 | `packages/api/session-controller/src/index.ts:388` |
| `session/prompt` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:346` |
| `session/rename` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:325` |
| `session/search` | `request` | — | A 只读 | `packages/api/session-controller/src/index.ts:234` |
| `session/selectModel` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:254` |
| `session/updateQueue` | `request` | — | B 会话写 | `packages/api/session-controller/src/index.ts:367` |

### 2.2 `dynamicCordisRunner`（12 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `dynamicCordisRunner/getClientCode` | `agent`→`agentId`, `pluginId`, `pluginRunId` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:384` |
| `dynamicCordisRunner/inventory` | — | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:525` |
| `dynamicCordisRunner/invoke` | `pluginId`, `pluginRunId`, `method`, `args` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:741` |
| `dynamicCordisRunner/reportClientGuardFailure` | `agent`→`agentId`, `pluginId`, `pluginRunId`, `failure` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:718` |
| `dynamicCordisRunner/reportRenderFailure` | `agent`→`agentId`, `pluginId`, `pluginRunId`, `failure` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:684` |
| `dynamicCordisRunner/resolveInspectQuery` | `agent`→`agentId`, `requestId`, `resolution` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:511` |
| `dynamicCordisRunner/resolveRequestRun` | `requestId`, `resolution` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:413` |
| `dynamicCordisRunner/runHostHalf` | `agent`→`agentId`, `pluginId`, `packageId`, `mode`, `requestId`, `approveFutureVersions` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:325` |
| `dynamicCordisRunner/settleUserRun` | `agent`→`agentId`, `pluginId`, `resolution` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:438` |
| `dynamicCordisRunner/stopFromPanel` | `agent`→`agentId`, `pluginId` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:480` |
| `dynamicCordisRunner/syncInspectManifest` | `providers` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:498` |
| `dynamicCordisRunner/undefineFromPanel` | `agent`→`agentId`, `pluginId` | — | C 全局写 | `packages/extensions/cordis-host-runner/src/index.ts:227` |

### 2.3 `goals`（7 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `goals/clear` | `agent`→`agentId`, `ref` | — | C 全局写 | `packages/goal/goal/src/index.ts:433` |
| `goals/complete` | `agent`→`agentId`, `ref` | — | C 全局写 | `packages/goal/goal/src/index.ts:391` |
| `goals/create` | `agent`→`agentId`, `request` | — | C 全局写 | `packages/goal/goal/src/index.ts:647` |
| `goals/edit` | `agent`→`agentId`, `ref`, `request` | — | C 全局写 | `packages/goal/goal/src/index.ts:329` |
| `goals/get` | `agent`→`agentId` | — | C 全局写 | `packages/goal/goal/src/index.ts:277` |
| `goals/pause` | `agent`→`agentId`, `ref` | — | C 全局写 | `packages/goal/goal/src/index.ts:352` |
| `goals/resume` | `agent`→`agentId`, `ref` | — | C 全局写 | `packages/goal/goal/src/index.ts:364` |

### 2.4 `settings`（7 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `settings/canOpenAgentPresetDirectory` | — | — | A 只读 | `packages/api/settings-controller/src/index.ts:131` |
| `settings/describe` | — | — | A 只读 | `packages/api/settings-controller/src/index.ts:117` |
| `settings/mutate` | `ns`, `ops`, `expectedRevision` | — | C 全局写 | `packages/api/settings-controller/src/index.ts:180` |
| `settings/openAgentPresetDirectory` | `agentPreset` | — | C 全局写 | `packages/api/settings-controller/src/index.ts:226` |
| `settings/openSettingsDocument` | — | — | C 全局写 | `packages/api/settings-controller/src/index.ts:195` |
| `settings/replace` | `ns`, `section`, `expectedRevision` | — | C 全局写 | `packages/api/settings-controller/src/index.ts:161` |
| `settings/update` | `ns`, `patch`, `expectedRevision` | — | C 全局写 | `packages/api/settings-controller/src/index.ts:144` |

### 2.5 `workspace`（7 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `workspace/archiveSession` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:108` |
| `workspace/create` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:58` |
| `workspace/delete` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:78` |
| `workspace/follow` | — | ✅ | X 不暴露 | `packages/api/workspace-controller/src/index.ts:118` |
| `workspace/insertBefore` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:88` |
| `workspace/insertSessionBefore` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:98` |
| `workspace/rename` | `request` | — | C 全局写 | `packages/api/workspace-controller/src/index.ts:68` |

### 2.6 `workspaceFiles`（7 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `workspaceFiles/changes` | `workspaceFileScope`→`workspaceFileScopeId` | ✅ | X 不暴露 | `packages/api/workspace-files/src/index.ts:365` |
| `workspaceFiles/list` | `workspaceFileScope`→`workspaceFileScopeId`, `path` | — | A 只读 | `packages/api/workspace-files/src/index.ts:337` |
| `workspaceFiles/read` | `workspaceFileScope`→`workspaceFileScopeId`, `path`, `range` | — | A 只读 | `packages/api/workspace-files/src/index.ts:232` |
| `workspaceFiles/readAll` | `workspaceFileScope`→`workspaceFileScopeId`, `path` | — | A 只读 | `packages/api/workspace-files/src/index.ts:278` |
| `workspaceFiles/readBytes` | `workspaceFileScope`→`workspaceFileScopeId`, `path`, `range` | — | A 只读 | `packages/api/workspace-files/src/index.ts:257` |
| `workspaceFiles/readRelated` | `workspaceFileScope`→`workspaceFileScopeId`, `path`, `relativePath` | — | A 只读 | `packages/api/workspace-files/src/index.ts:300` |
| `workspaceFiles/stat` | `workspaceFileScope`→`workspaceFileScopeId`, `path` | — | A 只读 | `packages/api/workspace-files/src/index.ts:324` |

### 2.7 `agentPresets`（5 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `agentPresets/copy` | `from`, `id`, `name` | — | C 全局写 | `packages/preset/agent-presets/src/index.ts:565` |
| `agentPresets/deletePreset` | `id` | — | C 全局写 | `packages/preset/agent-presets/src/index.ts:603` |
| `agentPresets/list` | — | — | A 只读 | `packages/preset/agent-presets/src/index.ts:261` |
| `agentPresets/read` | `agentPreset` | — | A 只读 | `packages/preset/agent-presets/src/index.ts:513` |
| `agentPresets/select` | `agent`→`agentId`, `agentPreset` | — | C 全局写 | `packages/preset/agent-presets/src/index.ts:695` |

### 2.8 `credentials`（3 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `credentials/describe` | `refs` | — | A 只读 | `packages/api/settings-controller/src/credentials.ts:83` |
| `credentials/set` | `ref`, `value` | — | C 全局写 | `packages/api/settings-controller/src/credentials.ts:100` |
| `credentials/unset` | `ref` | — | C 全局写 | `packages/api/settings-controller/src/credentials.ts:113` |

### 2.9 `directoryPicker`（3 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `directoryPicker/createDirectory` | `path`, `name` | — | X 不暴露 | `packages/api/workspace-controller/src/directory-picker.ts:88` |
| `directoryPicker/list` | `path` | — | X 不暴露 | `packages/api/workspace-controller/src/directory-picker.ts:72` |
| `directoryPicker/pick` | — | — | X 不暴露 | `packages/api/workspace-controller/src/directory-picker.ts:55` |

### 2.10 `llm`（3 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `llm/discoverModels` | `settingsNs`, `request` | — | A 只读 | `packages/llm/llm/src/index.ts:628` |
| `llm/listConfigurableProviders` | — | — | A 只读 | `packages/llm/llm/src/index.ts:541` |
| `llm/listProviders` | — | — | A 只读 | `packages/llm/llm/src/index.ts:469` |

### 2.11 `messageFeedback`（3 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `messageFeedback/delete` | `request` | — | B 会话写 | `packages/feedback/message-feedback/src/index.ts:207` |
| `messageFeedback/list` | `request` | — | A 只读 | `packages/feedback/message-feedback/src/index.ts:155` |
| `messageFeedback/put` | `request` | — | B 会话写 | `packages/feedback/message-feedback/src/index.ts:167` |

### 2.12 `subagents`（3 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `subagents/interruptByParent` | `childSessionId`, `parentSessionId`, `mode` | — | C 全局写 | `packages/subagent/subagent/src/index.ts:480` |
| `subagents/list` | `parentSessionId` | — | A 只读 | `packages/subagent/subagent/src/index.ts:386` |
| `subagents/prompt` | `request` | — | B 会话写 | `packages/subagent/subagent/src/index.ts:413` |

### 2.13 `commands`（2 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `commands/execute` | `agent`→`agentId`, `line`, `submittedAttachments` | — | C 全局写 | `packages/interaction/commands/src/index.ts:356` |
| `commands/list` | `agent`→`agentId` | — | C 全局写 | `packages/interaction/commands/src/index.ts:310` |

### 2.14 `fileReferences`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `fileReferences/list` | `agent`→`agentId`, `query` | — | A 只读 | `packages/api/session-controller/src/file-references.ts:33` |

### 2.15 `fileUploads`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `fileUploads/upload` | `agent`→`agentId`, `request` | — | B 会话写 | `packages/client/file-upload/src/index.ts:106` |

### 2.16 `pluginInventory`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `pluginInventory/list` | — | — | A 只读 | `packages/host/plugin-inventory/src/index.ts:66` |

### 2.17 `sessionFeedback`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `sessionFeedback/record` | `request` | — | B 会话写 | `packages/feedback/command-feedback/src/index.ts:101` |

### 2.18 `sessionReferenceResolver`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `sessionReferenceResolver/candidates` | `agent`→`agentId`, `query` | — | A 只读 | `packages/context/session-reference/src/index.ts:274` |

### 2.19 `skills`（1 条）

| 方法 | wire 键（参数名→wire） | stream | 建议 | 源码行号 |
|---|---|---|---|---|
| `skills/list` | `request` | — | A 只读 | `packages/api/session-controller/src/skill-catalog.ts:36` |

---

## 3. 禁入名单（更新版，写进代码注释）

- **不存在（实测 404）**：`host/describe`、`workspace/list`、`goals/blocked` —— 它们是真实缺失，不是拼写错
- **流式 4 条，v1 不暴露**：`session/control`、`session/follow`、`workspace/follow`、`workspaceFiles/changes`
- **高权限或不可用**：`dynamicCordisRunner/*`（12 条，插件运行器）、`directoryPicker/*`（3 条，弹本机原生对话框）
- **C 类默认关闭**：`settings/mutate` `settings/replace` `settings/update` `settings/openSettingsDocument`
  `settings/openAgentPresetDirectory` `credentials/set` `credentials/unset` `agentPresets/copy`
  `agentPresets/deletePreset` `commands/execute` `goals/*`（7 条）`subagents/interruptByParent`
  `workspace/*` 的写方法（`create` `rename` `delete` `archiveSession` `insertBefore` `insertSessionBefore`）
- **不采用**：任何 `/api` exact 路由抢占

---

## 4. 校验规则（更正后的三条）

1. 校验粒度 = **`<ns>/<method>` 方法名 + 该方法的 wire 键集合 + 是否 stream**，三者缺一不可
2. 报文 `args` 的键必须是该方法的 **wire 键**；出现描述符里没有的键 → 400 `unsupported`（不是 403）
3. 方法在表里但属于 stream → 403 `forbidden`（v1 策略），**不要**让请求掉进一元 `fetch` 吃 `gateway/signature-invalid`
