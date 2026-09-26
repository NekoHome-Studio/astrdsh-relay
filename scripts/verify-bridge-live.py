#!/usr/bin/env python3
"""星驿 · 重启 DSH 之后的一键验收（只读，不改任何文件）。

回答一个问题：**桥到底挂上了没有。** 部署清单 §2~§4 的机器可判定部分全在这里。

从 profile 的 ``cordis.patch.yml`` 里读出 ``token`` / ``pathPrefix`` / ``cwd``，
所以换机器、换目录都不用改本脚本；token **不打印**，只打印它的 sha256 前 12 位，
便于与另一侧比对而不泄露。

前置：``DSH_HOME``（缺省 ``~/.dsh``）、profile 名默认为 ``web``（``--profile`` 可覆盖）。

用法：
    python scripts/verify-bridge-live.py
    python scripts/verify-bridge-live.py --profile headless
    DSH_HOME=/opt/dsh python scripts/verify-bridge-live.py
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except (AttributeError, ValueError):
    pass

PROBE_CONVERSATION = "default:GroupMessage:1000000001"

_passed: list[str] = []
_failed: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    """``detail`` **只在失败时**打印：否则「失败原因」会在成功行下面出现，读起来像报错。"""
    (_passed if ok else _failed).append(name)
    print(f"  {'✓' if ok else '✗'} {name}" + (f"\n      {detail}" if detail and not ok else ""))


def parse_patch_row(text: str, row_id: str) -> dict[str, str]:
    """从 profile 的 patch 里抠出 ``<row_id>`` 那条的 config 值（够用的解析）。

    不引 YAML 库：这条记录是我们自己写出来的扁平结构，
    真出错时下面的「读不到」检查会直接说出来，不会静默给错值。
    """
    index = text.find(f"- id: {row_id}")
    if index < 0:
        return {}
    values: dict[str, str] = {}
    for line in text[index:].splitlines()[1:]:
        if line.startswith("- "):
            break
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        values[key.strip()] = value.strip().strip("'\"")
    return values


def call(base: str, path: str, token: str):
    request = urllib.request.Request(
        base + path, headers={"Authorization": f"Bearer {token}"} if token else {}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", "replace")
        try:
            return error.code, json.loads(body)
        except ValueError:
            return error.code, {"raw": body[:200]}
    except Exception as error:  # noqa: BLE001 - 连不上也是一种结果
        return 0, {"error": str(error)}


def main() -> int:
    parser = argparse.ArgumentParser(description="星驿桥的一键验收")
    parser.add_argument("--profile", default="web", help="DSH profile 名（默认 web）")
    parser.add_argument("--host", default="127.0.0.1:3080", help="DSH 的 host:port")
    parser.add_argument("--row", default="dsh-astrbot-relay", help="patch 里的插件行 id")
    args = parser.parse_args()

    home = Path(os.environ.get("DSH_HOME") or Path.home() / ".dsh")
    patch_path = home / "profiles" / args.profile / "cordis.patch.yml"

    print("== 0) 前置 ==")
    check(f"profile patch 存在：{patch_path}", patch_path.exists(),
          "先按部署清单 §2.2 写配置")
    if not patch_path.exists():
        return 1
    row = parse_patch_row(io.open(patch_path, encoding="utf-8").read(), args.row)
    token = row.get("token", "")
    path_prefix = row.get("pathPrefix", "") or "/astrbot-relay"
    expected_cwd = row.get("cwd", "")
    check("patch 里有 token", bool(token))
    if token:
        print(f"      token sha256 前 12 位：{hashlib.sha256(token.encode()).hexdigest()[:12]}")
        print("      （只打哈希，方便与另一侧比对，不泄露明文）")
    check("patch 里有 cwd（绝对路径）", bool(expected_cwd) and Path(expected_cwd).is_absolute(),
          repr(expected_cwd))
    base = f"http://{args.host}{path_prefix}"

    status, payload = call(base, "/health", token)
    check(f"{args.host} 上有东西在听", status != 0, f"HTTP {status} {payload}")

    print("== 1) 桥路由是否挂上 ==")
    if status == 404:
        check(f"GET {path_prefix}/health 不再是 404", False,
              "还是 404 ⇒ DSH 进程**没有加载到这个插件**：profile 没装包、或根本没重启")
    elif status == 401:
        check("鉴权通过（不是 401）", False,
              "401 ⇒ 两侧 token 不一致；注意 AstrBot 侧改完配置文件必须**重载插件**才会生效")
    elif status == 200:
        check(f"GET {path_prefix}/health → 200", True)
        check("bridgeVersion 是 6", str(payload.get("bridgeVersion")) == "6",
              f"实际 {payload.get('bridgeVersion')!r}")
        check("pathPrefix 与 patch 一致", payload.get("pathPrefix") == path_prefix,
              f"实际 {payload.get('pathPrefix')!r}")
        check("cwd 与 patch 一致",
              str(payload.get("cwd", "")).lower() == expected_cwd.lower(),
              f"实际 {payload.get('cwd')!r} vs patch {expected_cwd!r}")
        print(f"      heartbeatMs={payload.get('heartbeatMs')} "
              f"conversations={payload.get('conversations')} policy={payload.get('policy')!r} "
              f"stateExisted={payload.get('stateExisted')}")
    else:
        check(f"GET {path_prefix}/health 返回 200", False, f"HTTP {status} {payload}")

    print("== 2) 另外几条路由也挂上了 ==")
    for route in (f"/where?conversation={PROBE_CONVERSATION}", "/proactive?since=0",
                  "/conversations?limit=1", "/workspaces?limit=1"):
        code, body = call(base, route, token)
        check(f"GET {route.split('?')[0]} → 200", code == 200, f"HTTP {code} {str(body)[:160]}")

    print("== 3) 鉴权是 fail-closed 的 ==")
    if status == 200:
        check("不带 token 的 /health 应被拒（401）", call(base, "/health", "")[0] == 401,
              "无 Authorization 时居然不是 401")
        check("错 token 也应被拒（401）",
              call(base, "/health", "definitely-wrong-token")[0] == 401)
    else:
        print("  - 路由还没挂上，跳过（先解决上面的问题）")

    print("== 4) 桥是否真的跑起来过 ==")
    state_path = row.get("statePath") or str(home / "astrbot-relay" / "state.json")
    if os.path.exists(state_path):
        state = json.load(io.open(state_path, encoding="utf-8"))
        conversations = state.get("conversations") or {}
        check(f"state.json 已生成（{len(conversations)} 个对话）", True)
        for conversation, record in list(conversations.items())[:5]:
            print(f"      {conversation} → {record.get('dshSessionId')}")
    else:
        check("state.json 已生成", False,
              f"不存在（{state_path}）⇒ 还没有任何一次成功投递；在 IM 里发一条 `dsh 你好` 再看")

    print(f"\n通过 {len(_passed)} 项，失败 {len(_failed)} 项")
    if _failed:
        print("失败：" + "、".join(_failed))
        return 1
    print("全绿 —— 桥已挂上，可以去群里发 `dsh 你好` 了")
    return 0


if __name__ == "__main__":
    sys.exit(main())
