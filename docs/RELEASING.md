# 发布流程（Releasing）

> 本项目采用**统一版本**：两侧插件的版本号必须相等，一个 tag 同时发两个产物。

## 1. 版本号在哪两处

| 半边 | 文件 | 字段 |
|---|---|---|
| DSH 侧 | `dsh-astrbot-relay/package.json` | `"version"` |
| AstrBot 侧 | `astrbot_plugin_dsh_relay/metadata.yaml` | `version:` |

两处**必须相等**。`scripts/package-release.mjs` 会在打包前断言这一点，不一致直接失败。
（不用担心忘记：CI 的「版本一致性」步骤也是同一道闸门。）

> `metadata.yaml` 的 `astrbot_version` 是**AstrBot 本体**的兼容范围
> （`">=4.16,<5"`，PEP 440 写法、不带 `v`），跟本插件自己的 `version` 是两回事。

## 2. 发版步骤

```powershell
# 1) 改版本号（两处，改同一个值）
# 2) 本地先跑一遍闸门与打包
node scripts/package-release.mjs --check     # 只校验
node scripts/package-release.mjs             # 真打包到 dist/（本地冒烟）

# 3) 提交
git add -A
git commit -m "release: v0.1.0"
git push origin main

# 4) 打 tag 并推送 —— 这一步触发 Release workflow
git tag v0.1.0
git push origin v0.1.0
```

tag 推送后 `.github/workflows/release.yml` 会：

1. 校验 tag 与两侧版本号一致（不匹配就失败，**不会**发出错版）；
2. 打包两个产物 + `SHA256SUMS` + `RELEASE_NOTES.md`；
3. 用 `sha256sum -c` 核对校验和；
4. 创建 GitHub Release 并附上产物。

版本号里带 `-`（如 `v0.2.0-rc.1`）会自动标为 **pre-release**。

也可以在 Actions 页面手动触发 `Release` workflow 并填 tag（`workflow_dispatch`）。

## 3. 产物形态与为什么

| 产物 | 内容 | 为什么是这种形态 |
|---|---|---|
| `dsh-astrbot-relay-<v>.tgz` | `npm pack` 的结果，只含 `files` 字段列出的 5 个文件（`lib/`、`cordis.patch.yml`、`README.md`、`package.json`） | 本包是**纯 ESM JS、无构建步骤**。发预打包 tgz 让安装路径**完全不需要** pnpm 的 `allowBuilds` 授权——那条授权等于允许该包在你机器上执行安装期代码。若改成从 git 安装，pnpm ≥10 默认拒绝跑 `prepare`，用户必须先授权才能装上。 |
| `astrbot_plugin_dsh_relay-<v>.zip` | 顶层目录为 `astrbot_plugin_dsh_relay/` 的压缩包 | AstrBot 只扫描 `data/plugins/<目录名>/metadata.yaml`，所以归档根目录名**必须**是插件目录名，用户才能「解压进 `data/plugins/`」一步到位。 |

DSH 侧**不发 npm**：本仓库根目录不是一个 npm 包（两个插件是并排的子目录），
且发 npm 需要额外的 `NPM_TOKEN` 与可用包名，收益不抵成本。需要时用
`github:org/repo#<sha>&path:dsh-astrbot-relay` 形式从 git 固定 commit 安装也可以，
但那会回到「需要构建授权」的问题上。

## 4. 本地核对产物

```powershell
# 看 tgz 里到底有什么（应为 5 个文件）
tar -tzf dist/dsh-astrbot-relay-0.1.0.tgz

# 看 zip 的顶层目录名（必须是 astrbot_plugin_dsh_relay/）
tar -tf dist/astrbot_plugin_dsh_relay-0.1.0.zip

# 核对校验和
Get-FileHash dist/*.tgz, dist/*.zip -Algorithm SHA256
```

## 5. CI 的检查项

`ci.yml` 在 push 到 `main` 与所有 PR 上跑：

- DSH 侧 `node --check`（两个 JS 文件）；
- AstrBot 侧 `python -m py_compile`（两个 py 文件，骨架不 import astrbot，故无需装依赖）；
- 两侧契约常量一致性（`scripts/check-contract-parity.mjs`）；
- 版本一致性闸门；
- 完整打包冒烟 + 校验和核对。

## 6. 发布纪律：本次发布已知的“不可用”状态

**`v0.3.0` 已是可运行实现**，但仍有**三项配置项未实现**，必须在发布说明里如实列出：

- DSH 侧 `assertConfigIsUsable` 对 `hmacMode`、非 `one-to-one` 的 `policy`（轮转策略）、
  `idleTtlMs` **加载即抛错**。三者都是「宁可响亮失败，也不静默降级」。
- 除此之外，`/health`、`/where`、`/conversations`、`/message`、`/events`（SSE）、
  `/approval` 六个端点全部可用；AstrBot 侧 `BridgeTransport` 六个方法全部实现。

自动生成的 `RELEASE_NOTES.md` 会在开头显式声明“已实现 / 未实现(加载即失败)”。
**这三项做完之前不要移除该声明。**
