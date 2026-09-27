"""AstrDsh Relay（星驿）· DSH 控制面方法白名单（零依赖纯函数）。

与 ``allowlist.py`` 一样单独成模块：``main.py`` 顶部就 ``import astrbot``，
测试机装不上 AstrBot 时它连导入都过不去；这里零依赖，纯函数断言可以直接跑。

────────────────────────────────────────────────────────────────────────
口径来源（**唯一**）：``dsh-astrbot-relay/lib/rpc-methods.js``。
那份文件是 ``node scripts/gen-rpc-methods.mjs`` 生成的，**不要手改**；
本文件的三张表是从它逐字抄过来的镜像，抄写产物同时落在 ``rpc_tables.json``。
两边任何一侧的 DSH 版本升级后，都要重新生成再抄一遍——判据是文件名里的
``RPC_METHOD_COUNT``：本文件抄的是 84。

四张表的分工（别混）：

  ``RPC_WIRE_KEYS``（84 条）   endpoint → 该端点 ``args`` 里**允许出现**的 wire 键。
                              超集的请求在宿主侧被 400 挡掉，所以这里先挡一次，
                              省一个来回，也避免把「参数名写错」误读成「宿主不认」。
  ``RPC_REQUIRED_KEYS``（84 条）  endpoint → ``args`` 里**必须出现**的 wire 键，是上一张
                              表的子集。宿主 ``assertExactArguments`` 的期望键是**全部**
                              参数的 wire，只有 5 个参数可省（见那张表的注释），所以漏键的
                              请求会在宿主那边撞 400 ``gateway/arguments-invalid``；这张表
                              让同一件事在离用户最近的地方先讲成人话。
  ``RPC_STREAM_METHODS``（4 条） 流式方法，``/rpc`` **一律 403**：
                              它们是 SSE / WebSocket 长连接，一个 HTTP 响应装不下。
  ``RPC_ALLOWED_METHODS``（26 条） 宿主 ``Config.allowedRpcMethods`` 的**缺省值**，
                              只读、无副作用。

为什么只放行这 26 条（而不是把 84 条都放出去）：宿主侧的完整清单里还有
``credentials/set``（写密钥）、``commands/execute``（执行命令）、
``goals/*``、``dynamicCordisRunner/*`` 这类有副作用的端点，它们的放行是
DSH 配置侧的显式决定，不该由 IM 侧一条指令凭空打开。IM 侧只镜像「缺省就放行」
的这一档；要开更多，先在 DSH 侧改 ``allowedRpcMethods``，再回来补这张表。

容易错的两处（抄表时踩过）：
  1. 参数名 ≠ wire 键是常态：``agent`` → ``agentId``、``workspaceFileScope`` →
     ``workspaceFileScopeId``，84 条里有 28 条不同名。校验要按 wire 键，不是 Python 参数名。
  2. ``session/list`` 是全表唯一「方法名后缀与 wire 键同名」的巧合，别据此推广。
  3. 「参数可以不给」是极少数的例外：84 条里只有 5 个参数可省（全是宿主标了
     ``acceptsUndefined`` 的那些），别照着自己的直觉把必填键当成可选。
"""

from __future__ import annotations

#: 抄表时的 DSH 侧方法总数。对不上就是两边版本漂了，别硬跑。
RPC_METHOD_COUNT = 84

#: 口径来源（写进日志与报错，方便回溯是哪一版抄的）。
RPC_SOURCE = "dsh-astrbot-relay/lib/rpc-methods.js"

#: endpoint → args 里允许出现的 wire 键；空元组 = 该端点不吃参数。
RPC_WIRE_KEYS = {
    "agentPresets/copy": ("from", "id", "name"),
    "agentPresets/deletePreset": ("id",),
    "agentPresets/list": (),
    "agentPresets/read": ("agentPreset",),
    "agentPresets/select": ("agentId", "agentPreset"),
    "commands/execute": ("agentId", "line", "submittedAttachments"),
    "commands/list": ("agentId",),
    "credentials/describe": ("refs",),
    "credentials/set": ("ref", "value"),
    "credentials/unset": ("ref",),
    "directoryPicker/createDirectory": ("path", "name"),
    "directoryPicker/list": ("path",),
    "directoryPicker/pick": (),
    "dynamicCordisRunner/getClientCode": ("agentId", "pluginId", "pluginRunId"),
    "dynamicCordisRunner/inventory": (),
    "dynamicCordisRunner/invoke": ("pluginId", "pluginRunId", "method", "args"),
    "dynamicCordisRunner/reportClientGuardFailure": ("agentId", "pluginId", "pluginRunId", "failure"),
    "dynamicCordisRunner/reportRenderFailure": ("agentId", "pluginId", "pluginRunId", "failure"),
    "dynamicCordisRunner/resolveInspectQuery": ("agentId", "requestId", "resolution"),
    "dynamicCordisRunner/resolveRequestRun": ("requestId", "resolution"),
    "dynamicCordisRunner/runHostHalf": ("agentId", "pluginId", "packageId", "mode", "requestId", "approveFutureVersions"),
    "dynamicCordisRunner/settleUserRun": ("agentId", "pluginId", "resolution"),
    "dynamicCordisRunner/stopFromPanel": ("agentId", "pluginId"),
    "dynamicCordisRunner/syncInspectManifest": ("providers",),
    "dynamicCordisRunner/undefineFromPanel": ("agentId", "pluginId"),
    "fileReferences/list": ("agentId", "query"),
    "fileUploads/upload": ("agentId", "request"),
    "goals/clear": ("agentId", "ref"),
    "goals/complete": ("agentId", "ref"),
    "goals/create": ("agentId", "request"),
    "goals/edit": ("agentId", "ref", "request"),
    "goals/get": ("agentId",),
    "goals/pause": ("agentId", "ref"),
    "goals/resume": ("agentId", "ref"),
    "llm/discoverModels": ("settingsNs", "request"),
    "llm/listConfigurableProviders": (),
    "llm/listProviders": (),
    "messageFeedback/delete": ("request",),
    "messageFeedback/list": ("request",),
    "messageFeedback/put": ("request",),
    "pluginInventory/list": (),
    "session/attachment": ("request",),
    "session/canOpenWorkspacePath": (),
    "session/cancel": ("request",),
    "session/control": (),
    "session/create": ("request",),
    "session/follow": ("request",),
    "session/fork": ("request",),
    "session/list": ("_request",),
    "session/modelCatalog": (),
    "session/openWorkspacePath": ("request",),
    "session/page": ("request",),
    "session/prompt": ("request",),
    "session/rename": ("request",),
    "session/search": ("request",),
    "session/selectModel": ("request",),
    "session/updateQueue": ("request",),
    "sessionFeedback/record": ("request",),
    "sessionReferenceResolver/candidates": ("agentId", "query"),
    "settings/canOpenAgentPresetDirectory": (),
    "settings/describe": (),
    "settings/mutate": ("ns", "ops", "expectedRevision"),
    "settings/openAgentPresetDirectory": ("agentPreset",),
    "settings/openSettingsDocument": (),
    "settings/replace": ("ns", "section", "expectedRevision"),
    "settings/update": ("ns", "patch", "expectedRevision"),
    "skills/list": ("request",),
    "subagents/interruptByParent": ("childSessionId", "parentSessionId", "mode"),
    "subagents/list": ("parentSessionId",),
    "subagents/prompt": ("request",),
    "workspace/archiveSession": ("request",),
    "workspace/create": ("request",),
    "workspace/delete": ("request",),
    "workspace/follow": (),
    "workspace/insertBefore": ("request",),
    "workspace/insertSessionBefore": ("request",),
    "workspace/rename": ("request",),
    "workspaceFiles/changes": ("workspaceFileScopeId",),
    "workspaceFiles/list": ("workspaceFileScopeId", "path"),
    "workspaceFiles/read": ("workspaceFileScopeId", "path", "range"),
    "workspaceFiles/readAll": ("workspaceFileScopeId", "path"),
    "workspaceFiles/readBytes": ("workspaceFileScopeId", "path", "range"),
    "workspaceFiles/readRelated": ("workspaceFileScopeId", "path", "relativePath"),
    "workspaceFiles/stat": ("workspaceFileScopeId", "path"),
}

#: endpoint → args 里**必须出现**的 wire 键；是 ``RPC_WIRE_KEYS`` 的子集。
#:
#: 依据宿主 ``assertExactArguments``：期望键 = 该端点**全部** parameters 的 wire，只有
#: ``source == "json"`` 且（``acceptsUndefined == true`` 或 ``codec.mode == "src-json"``）
#: 的参数才允许缺席。全树扫下来，84 条里能省的只有 5 个，都在表里标了「可省」：
#: ``agentPresets/copy:name``、``settings/{mutate,replace,update}:expectedRevision``、
#: ``directoryPicker/list:path``。另外 ``invocation.kind == "context"`` 的端点是 **0 条**，
#: 所以这张表只抄 parameters，不必再追 invocation 的 wire。
#:
#: 空元组 = 该端点不吃参数，或者参数全可省（84 条里 70 条有必填，另 14 条为空）。
RPC_REQUIRED_KEYS = {
    "agentPresets/copy": ("from", "id"),
    "agentPresets/deletePreset": ("id",),
    "agentPresets/list": (),
    "agentPresets/read": ("agentPreset",),
    "agentPresets/select": ("agentId", "agentPreset"),
    "commands/execute": ("agentId", "line", "submittedAttachments"),
    "commands/list": ("agentId",),
    "credentials/describe": ("refs",),
    "credentials/set": ("ref", "value"),
    "credentials/unset": ("ref",),
    "directoryPicker/createDirectory": ("path", "name"),
    "directoryPicker/list": (),
    "directoryPicker/pick": (),
    "dynamicCordisRunner/getClientCode": ("agentId", "pluginId", "pluginRunId"),
    "dynamicCordisRunner/inventory": (),
    "dynamicCordisRunner/invoke": ("pluginId", "pluginRunId", "method", "args"),
    "dynamicCordisRunner/reportClientGuardFailure": ("agentId", "pluginId", "pluginRunId", "failure"),
    "dynamicCordisRunner/reportRenderFailure": ("agentId", "pluginId", "pluginRunId", "failure"),
    "dynamicCordisRunner/resolveInspectQuery": ("agentId", "requestId", "resolution"),
    "dynamicCordisRunner/resolveRequestRun": ("requestId", "resolution"),
    "dynamicCordisRunner/runHostHalf": ("agentId", "pluginId", "packageId", "mode", "requestId", "approveFutureVersions"),
    "dynamicCordisRunner/settleUserRun": ("agentId", "pluginId", "resolution"),
    "dynamicCordisRunner/stopFromPanel": ("agentId", "pluginId"),
    "dynamicCordisRunner/syncInspectManifest": ("providers",),
    "dynamicCordisRunner/undefineFromPanel": ("agentId", "pluginId"),
    "fileReferences/list": ("agentId", "query"),
    "fileUploads/upload": ("agentId", "request"),
    "goals/clear": ("agentId", "ref"),
    "goals/complete": ("agentId", "ref"),
    "goals/create": ("agentId", "request"),
    "goals/edit": ("agentId", "ref", "request"),
    "goals/get": ("agentId",),
    "goals/pause": ("agentId", "ref"),
    "goals/resume": ("agentId", "ref"),
    "llm/discoverModels": ("settingsNs", "request"),
    "llm/listConfigurableProviders": (),
    "llm/listProviders": (),
    "messageFeedback/delete": ("request",),
    "messageFeedback/list": ("request",),
    "messageFeedback/put": ("request",),
    "pluginInventory/list": (),
    "session/attachment": ("request",),
    "session/canOpenWorkspacePath": (),
    "session/cancel": ("request",),
    "session/control": (),
    "session/create": ("request",),
    "session/follow": ("request",),
    "session/fork": ("request",),
    "session/list": ("_request",),
    "session/modelCatalog": (),
    "session/openWorkspacePath": ("request",),
    "session/page": ("request",),
    "session/prompt": ("request",),
    "session/rename": ("request",),
    "session/search": ("request",),
    "session/selectModel": ("request",),
    "session/updateQueue": ("request",),
    "sessionFeedback/record": ("request",),
    "sessionReferenceResolver/candidates": ("agentId", "query"),
    "settings/canOpenAgentPresetDirectory": (),
    "settings/describe": (),
    "settings/mutate": ("ns", "ops"),
    "settings/openAgentPresetDirectory": ("agentPreset",),
    "settings/openSettingsDocument": (),
    "settings/replace": ("ns", "section"),
    "settings/update": ("ns", "patch"),
    "skills/list": ("request",),
    "subagents/interruptByParent": ("childSessionId", "parentSessionId", "mode"),
    "subagents/list": ("parentSessionId",),
    "subagents/prompt": ("request",),
    "workspace/archiveSession": ("request",),
    "workspace/create": ("request",),
    "workspace/delete": ("request",),
    "workspace/follow": (),
    "workspace/insertBefore": ("request",),
    "workspace/insertSessionBefore": ("request",),
    "workspace/rename": ("request",),
    "workspaceFiles/changes": ("workspaceFileScopeId",),
    "workspaceFiles/list": ("workspaceFileScopeId", "path"),
    "workspaceFiles/read": ("workspaceFileScopeId", "path", "range"),
    "workspaceFiles/readAll": ("workspaceFileScopeId", "path"),
    "workspaceFiles/readBytes": ("workspaceFileScopeId", "path", "range"),
    "workspaceFiles/readRelated": ("workspaceFileScopeId", "path", "relativePath"),
    "workspaceFiles/stat": ("workspaceFileScopeId", "path"),
}

#: 流式方法：``/rpc`` 一律 403，别让用户以为是自己参数写错了。
RPC_STREAM_METHODS = frozenset({
    "session/control",
    "session/follow",
    "workspace/follow",
    "workspaceFiles/changes",
})

#: 宿主 ``Config.allowedRpcMethods`` 的缺省值（只读、无副作用）。
RPC_ALLOWED_METHODS = frozenset({
    "agentPresets/list",
    "agentPresets/read",
    "credentials/describe",
    "fileReferences/list",
    "llm/discoverModels",
    "llm/listConfigurableProviders",
    "llm/listProviders",
    "messageFeedback/list",
    "pluginInventory/list",
    "session/attachment",
    "session/canOpenWorkspacePath",
    "session/list",
    "session/modelCatalog",
    "session/page",
    "session/search",
    "sessionReferenceResolver/candidates",
    "settings/canOpenAgentPresetDirectory",
    "settings/describe",
    "skills/list",
    "subagents/list",
    "workspaceFiles/list",
    "workspaceFiles/read",
    "workspaceFiles/readAll",
    "workspaceFiles/readBytes",
    "workspaceFiles/readRelated",
    "workspaceFiles/stat",
})

_EMPTY = frozenset()


def is_stream_method(endpoint: str) -> bool:
    """是不是流式方法（``/rpc`` 收不下，宿主固定回 403）。"""
    return str(endpoint or "") in RPC_STREAM_METHODS


def is_known_method(endpoint: str) -> bool:
    """宿主认不认这个名字（84 条全量，含被白名单挡在外面的那些）。"""
    return str(endpoint or "") in RPC_WIRE_KEYS


def is_allowed_method(endpoint: str) -> bool:
    """IM 侧放不放行。比宿主严：宿主还认 84 条，这里只放 26 条。"""
    return str(endpoint or "") in RPC_ALLOWED_METHODS


def wire_keys_of(endpoint: str) -> frozenset:
    """该端点 ``args`` 允许出现的键；未知端点给空集合（于是任何参数都算多余）。"""
    return frozenset(RPC_WIRE_KEYS.get(str(endpoint or ""), _EMPTY))


def required_keys_of(endpoint: str) -> frozenset:
    """该端点 ``args`` 里必须出现的键；未知端点给空集合（不拦，交给上一关报错）。"""
    return frozenset(RPC_REQUIRED_KEYS.get(str(endpoint or ""), _EMPTY))


def missing_arg_keys(endpoint: str, args) -> tuple:
    """``args`` 里缺掉的必填 wire 键（排序后的元组，便于拼提示）。

    这是宿主 ``assertExactArguments`` 那条 400 的本地前身：漏一个键，宿主只会回
    ``args fields do not match the descriptor: missing "_request"``。非 dict 的 ``args``
    当作「一个键都没给」——调用方本来就该先判类型，这里只是别让它把 TypeError
    冒到用户面前。
    """
    required = required_keys_of(endpoint)
    if not required:
        return ()
    given = args if isinstance(args, dict) else {}
    return tuple(sorted(str(k) for k in required if k not in given))


def _describe_params(endpoint: str) -> str:
    """拼「它认的是」那半句：必填的标（必填），其余标（可省）。"""
    wires = sorted(wire_keys_of(endpoint))
    if not wires:
        return "（无参数）"
    required = required_keys_of(endpoint)
    return ", ".join(
        "%s（必填）" % key if key in required else "%s（可省）" % key for key in wires
    )


def unknown_arg_keys(endpoint: str, args) -> tuple:
    """``args`` 里那些宿主不认的键（排序后的元组，便于拼提示）。

    非 dict 的 ``args`` 一律当作「一个键都不知道」——调用方本来就该先判类型，
    这里只是别让它把 TypeError 冒到用户面前。
    """
    if not isinstance(args, dict):
        return tuple(sorted(str(k) for k in args)) if args else ()
    known = wire_keys_of(endpoint)
    return tuple(sorted(str(k) for k in args if str(k) not in known))


def check(endpoint: str, args=None) -> str:
    """本地预检。通过返回空串，不通过返回一句**人话**（给用户看，不是给日志看）。

    顺序刻意与宿主三道门对齐（契约 §11）：先问「认不认这个名字」，
    再问「放不放行」，最后问「参数对不对」——换序会让「拼错了的方法名」
    被报成「方法不被允许」，把人往错方向带。

    参数那一关再分两步，与宿主 ``assertExactArguments`` 同序：**先缺后多**。
    缺必填键是宿主侧最常见的 400（``gateway/arguments-invalid``），只说一句
    ``missing "_request"`` 太干，这里连「它认的是」一起给出来，照着补就行。
    """
    name = str(endpoint or "").strip()
    if not name:
        return "要调哪个端点呢？用法：rpc <endpoint> [json]"
    if not is_known_method(name):
        return "宿主不认识这个端点，名字可能拼错了：%s" % name
    if is_stream_method(name):
        return "%s 是流式端点，走 HTTP 调不动（宿主固定回 403）" % name
    if not is_allowed_method(name):
        return (
            "%s 不在 IM 侧放行的白名单里——宿主侧默认也没放行它；"
            "要开先在 DSH 配置的 allowedRpcMethods 里加，再回来补表" % name
        )
    missing = missing_arg_keys(name, args)
    extra = unknown_arg_keys(name, args)
    if missing or extra:
        if missing and extra:
            head = "参数不对：少了 %s，又多了 %s" % (
                ", ".join(missing), ", ".join(extra),
            )
        elif missing:
            head = "少了必填参数：%s（宿主会回 arguments-invalid）" % ", ".join(missing)
        else:
            head = "不认这些参数：%s" % ", ".join(extra)
        return "%s %s；它认的是：%s" % (name, head, _describe_params(name))
    return ""
