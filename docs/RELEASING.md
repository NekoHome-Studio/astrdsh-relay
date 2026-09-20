# 发布流程（Releasing）

> 本项目采用**统一版本**：版本号在**三处**必须相等，一个 tag 同时发两个产物。

## 1. 版本号在哪三处

| 半边 | 文件 | 字段 |
|---|---|---|
| 工作区根 | `package.json` | `"version"` |
| DSH 侧 | `dsh-astrbot-relay/package.json` | `"version"` |
| AstrBot 侧 | `astrbot_plugin_dsh_relay/metadata.yaml` | `version:` |

三处**必须相等**。`scripts/package-release.mjs` 会在打包前断言 **DSH 侧与 AstrBot 侧**
相等（工作区根不是可分发的包，根版本是「这棵树的版本」标记，由人工同步；
CI 的「版本一致性」步骤是同一道闸门）——不放心时可以拿
`node -e "console.log(require('./package.json').version)"` 自己对一眼。

> `metadata.yaml` 的 `astrbot_version` 是**AstrBot 本体**的兼容范围
> （`">=4.16,<5"`，PEP 440 写法、不带 `v`），跟本插件自己的 `version` 是两回事。

## 2. 发版步骤

```powershell
# 1) 改版本号（三处，改同一个值）
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
| `dsh-astrbot-relay-<v>.tgz` | `npm pack` 的结果，只含 `files` 字段列出的 8 个文件（`LICENSE`、`README.md`、`cordis.patch.yml`、`package.json` 与 `lib/` 下 4 个 JS） | 本包是**纯 ESM JS、无构建步骤**。发预打包 tgz 让安装路径**完全不需要** pnpm 的 `allowBuilds` 授权——那条授权等于允许该包在你机器上执行安装期代码。若改成从 git 安装，pnpm ≥10 默认拒绝跑 `prepare`，用户必须先授权才能装上。 |
| `astrbot_plugin_dsh_relay-<v>.zip` | 顶层目录为 `astrbot_plugin_dsh_relay/` 的压缩包 | AstrBot 只扫描 `data/plugins/<目录名>/metadata.yaml`，所以归档根目录名**必须**是插件目录名，用户才能「解压进 `data/plugins/`」一步到位。 |

DSH 侧**不发 npm**：本仓库根目录不是一个 npm 包（两个插件是并排的子目录），
且发 npm 需要额外的 `NPM_TOKEN` 与可用包名，收益不抵成本。需要时用
`github:org/repo#<sha>&path:dsh-astrbot-relay` 形式从 git 固定 commit 安装也可以，
但那会回到「需要构建授权」的问题上。

## 4. 本地核对产物

**先真跑一次打包，再看内容。** `npm test` 里的版本闸门走的是
`package-release.mjs --check`，它**只校验、不打包**——归档器的那段代码在
`--check` 下根本不会被执行。所以「`npm test` 全绿」不等于「打包脚本能跑」：
曾经有过 `npm test` 全绿、而 `node scripts/package-release.mjs` 一跑就在 zip
阶段崩掉（`crc32` 的查表撞上 `const` 的暂时性死区）的先例。

```powershell
# 0) 真打包一遍，必须 exit code 0（这是最容易漏掉的一步）
node scripts/package-release.mjs
echo "exit=$LASTEXITCODE"

# 1) 看 tgz 里到底有什么（应为 8 个文件：LICENSE、README.md、
#    cordis.patch.yml、package.json 与 lib/ 下 4 个 JS）
tar -tzf dist/dsh-astrbot-relay-<v>.tgz

# 2) 看 zip 的顶层目录名（必须是 astrbot_plugin_dsh_relay/）
tar -tf dist/astrbot_plugin_dsh_relay-<v>.zip

# 3) 核对校验和
Get-FileHash dist/*.tgz, dist/*.zip -Algorithm SHA256
Get-Content dist/SHA256SUMS
```

zip 由脚本**自写归档器**生成（条目按路径排序、时间戳钉死 1980-01-01、
权限统一 0644、deflate level 9），目的就是让同一份源码在任何平台打出来
**字节一致**。因此：本地 `dist` 的哈希应当与 CI 发布出的同名资产**完全相同**，
连打两次也应当完全相同。若对不上，先怀疑两边跑的不是同一版脚本（CI 侧会重建），
而不是包坏了——这也是 `.gitignore` 把 `dist/` 排除在外的原因：产物不入库，
只由脚本确定性重建。

「本地哈希 == Release 资产哈希」这句不是愿望，是有实测托底的：同一份源码分别在
**Node 22.23.2（npm 10.9.8）**与**Node 24.18.0（npm 11.x）**下各打一次（`v0.4.0`），
zip 与 tgz 的大小与 SHA256 **逐字节相同**（zip `1614474407…`、tgz `42e515d3…`），
`SHA256SUMS` 与 `RELEASE_NOTES.md` 也相同。CI 的打包冒烟会一直做同样的事
（Node 22 与 Node 24 各打一遍再 `diff` 校验和），所以这条承诺一旦被破坏会当场失败。

反过来说：**换 Node 大版本、动过归档器、或改过 `files` 字段之后，要重新跑一次这个对照**，
别默认它还成立。已发布的老版 Release 资产是旧脚本打出来的，与今天的本地 `dist`
对不上属正常——那是脚本变了，不是包坏了。

## 5. CI 的检查项

`ci.yml` 在 push 到 `main` 与所有 PR 上跑：

- DSH 侧 `node --check`（两个 JS 文件）；
- AstrBot 侧 `python -m py_compile`（两个 py 文件，骨架不 import astrbot，故无需装依赖）；
- 两侧契约常量一致性（`scripts/check-contract-parity.mjs`）；
- 版本一致性闸门；
- 完整打包冒烟：Node 22 与 Node 24 各真打一遍，两轮的 `SHA256SUMS` 必须逐字节相同，
  并 `sha256sum -c` 核对（`--check` 不执行归档器，所以这里跑的是真打包）。

## 6. 发布纪律：已知的“不可用”状态（自 `v0.3.0` 起的长期快照）

**`v0.3.0` 起已是可运行实现**，但下列**三项配置项至今未实现**，只要仍未落地，
每一次发布说明都必须如实列出：

- DSH 侧 `assertConfigIsUsable` 对 `hmacMode`、非 `one-to-one` 的 `policy`（轮转策略）、
  `idleTtlMs` **加载即抛错**。三者都是「宁可响亮失败，也不静默降级」。
- 除此之外，`/health`、`/where`、`/conversations`、`/message`、`/events`（SSE）、
  `/approval` 六个端点全部可用；AstrBot 侧 `BridgeTransport` 六个方法全部实现。

自动生成的 `RELEASE_NOTES.md` 会在开头显式声明“已实现 / 未实现(加载即失败)”。
**这三项做完之前不要移除该声明。**
