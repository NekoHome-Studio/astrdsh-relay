#!/usr/bin/env node
/**
 * 把两侧插件打包成 GitHub Release 产物。
 *
 * 用法：
 *   node scripts/package-release.mjs v0.1.0    # 校验 tag 与版本，产物写入 dist/
 *   node scripts/package-release.mjs           # 同上但不校验 tag（本地冒烟用）
 *   node scripts/package-release.mjs --check   # 只校验版本一致性与必需文件，不打包
 *
 * 本项目采用**统一版本**：两侧插件的版本号必须相等，tag 形如 v0.1.0，
 * 一次发布同时出两个产物。
 *
 * 产物：
 *   dist/dsh-astrbot-relay-<version>.tgz        DSH 侧 host 插件（npm pack）
 *   dist/astrbot_plugin_dsh_relay-<version>.zip AstrBot 侧 Star 插件
 *   dist/SHA256SUMS                             上面两者的校验和（跨平台可复现）
 *   dist/RELEASE_NOTES.md                       发版说明（由本脚本生成）
 *
 * 为什么 DSH 侧发 .tgz 而不是让大家从 git 装：
 *   git 安装拉的是源码、要靠包的 prepare 脚本现场构建，而 pnpm ≥10 默认拒绝运行
 *   git 依赖的构建脚本，需要用户显式授权（等于允许该包在你机器上执行安装期代码）。
 *   本包是纯 ESM JS、无构建步骤，所以发预打包的 tgz 可以让安装路径**完全不需要**
 *   这项授权——`dsh plugin add ./xxx.tgz` 即可。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_DIR = join(ROOT, 'dsh-astrbot-relay')
const ASTRBOT_DIR = join(ROOT, 'astrbot_plugin_dsh_relay')
const ASTRBOT_PKG_NAME = 'astrbot_plugin_dsh_relay'
const DIST = join(ROOT, 'dist')
const STAGING = join(DIST, '_staging')
const REPO = 'NekoHome-Studio/astrdsh-relay'

/** CRC-32 查找表，模块加载时一次性建好（256 项）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const argv = process.argv.slice(2)
const checkOnly = argv.includes('--check')
const tag = argv.find((a) => !a.startsWith('--')) ?? ''

const fail = (message) => { console.error(`✗ ${message}`); process.exit(1) }
const ok = (message) => { console.log(`✓ ${message}`) }

// ─────────────────────────────────────────────────────────────────────
// 1. 版本一致性（统一版本：两侧必须相等，且与 tag 相符）
// ─────────────────────────────────────────────────────────────────────
const dshPkg = JSON.parse(readFileSync(join(DSH_DIR, 'package.json'), 'utf8'))
const metaRaw = readFileSync(join(ASTRBOT_DIR, 'metadata.yaml'), 'utf8')
const metaVersion = metaRaw.match(/^version:\s*(.+)$/m)?.[1]?.trim()

if (!dshPkg.version) fail('dsh-astrbot-relay/package.json 缺少 version')
if (!metaVersion) fail('astrbot_plugin_dsh_relay/metadata.yaml 缺少 version')
if (dshPkg.version !== metaVersion) {
  fail(
    `两侧版本不一致：dsh=${dshPkg.version}，astrbot=${metaVersion}。\n` +
    '  本项目采用统一版本，两处必须相等；请同时修改后再发版。',
  )
}
const version = dshPkg.version
ok(`版本一致：${version}`)

if (tag) {
  const expected = `v${version}`
  if (tag !== expected) {
    fail(`tag 与版本不匹配：tag=${tag}，但两侧版本是 ${version}，期望 tag ${expected}`)
  }
  ok(`tag 匹配：${tag}`)
}

const REQUIRED = [
  [DSH_DIR, 'package.json'],
  [DSH_DIR, 'cordis.patch.yml'],
  [DSH_DIR, 'lib/index.js'],
  [DSH_DIR, 'lib/contract.js'],
  [DSH_DIR, 'README.md'],
  [ASTRBOT_DIR, 'metadata.yaml'],
  [ASTRBOT_DIR, '_conf_schema.json'],
  [ASTRBOT_DIR, 'main.py'],
  [ASTRBOT_DIR, 'contract.py'],
  [ASTRBOT_DIR, 'README.md'],
]
const missing = REQUIRED.filter(([dir, rel]) => !existsSync(join(dir, rel)))
if (missing.length) fail(`缺少必需文件：${missing.map(([, rel]) => rel).join('、')}`)
ok(`必需文件齐全（${REQUIRED.length} 个）`)

if (checkOnly) {
  ok('--check 通过，未生成产物')
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────────────
// 2. 打包
// ─────────────────────────────────────────────────────────────────────
rmSync(DIST, { recursive: true, force: true })
mkdirSync(DIST, { recursive: true })

// --- DSH 侧：npm pack ---
// npm pack 尊重 package.json 的 files 字段，并给 tarball 加 npm 要求的 package/ 前缀，
// 因此比手搓 tar 可靠。参数不含绝对路径，避免 Windows 上 shell 引号问题。
runNpm(['pack'], DSH_DIR)
const tgzName = `${dshPkg.name}-${version}.tgz`
const tgzBuilt = join(DSH_DIR, tgzName)
if (!existsSync(tgzBuilt)) fail(`npm pack 未生成 ${tgzName}`)
renameSync(tgzBuilt, join(DIST, tgzName))
ok(`DSH 产物：${tgzName}`)

// --- AstrBot 侧：先做 staging 副本再打 zip ---
// 归档根目录必须叫 astrbot_plugin_dsh_relay，用户解压到 data/plugins/ 才直接可用。
mkdirSync(STAGING, { recursive: true })
const stageDir = join(STAGING, ASTRBOT_PKG_NAME)
cpSync(ASTRBOT_DIR, stageDir, {
  recursive: true,
  // 排除字节码等运行时垃圾，保证产物可复现
  filter: (src) => !/__pycache__|[\\/].*\.pyc$/.test(src),
})
const zipName = `${ASTRBOT_PKG_NAME}-${version}.zip`
writeZipDir(stageDir, join(DIST, zipName), ASTRBOT_PKG_NAME)
rmSync(STAGING, { recursive: true, force: true })
ok(`AstrBot 产物：${zipName}`)

// ─────────────────────────────────────────────────────────────────────
// 3. 校验和 + 发版说明
// ─────────────────────────────────────────────────────────────────────
const artifacts = readdirSync(DIST).filter((n) => /\.(tgz|zip)$/.test(n)).sort()
if (artifacts.length !== 2) fail(`预期 2 个产物，实际 ${artifacts.length} 个：${artifacts.join('、')}`)
const sums = artifacts.map((name) => `${sha256(join(DIST, name))}  ${name}`)
writeFileSync(join(DIST, 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8')
ok('SHA256SUMS')

writeFileSync(join(DIST, 'RELEASE_NOTES.md'), notes(version, tag, sums, artifacts), 'utf8')
ok('RELEASE_NOTES.md')

// ─────────────────────────────────────────────────────────────────────
// 辅助
// ─────────────────────────────────────────────────────────────────────

/**
 * 拉起 npm。
 *
 * Windows 上 npm 是 .cmd，而 child_process.execFile 无法直接执行 .cmd/.bat；
 * 用 `shell: true` 又能跑但会触发 Node 的 DEP0190 告警（参数不转义、只拼接）。
 * 因此显式经 cmd.exe 调用：既不需要 shell:true，也没有引号注入面。
 */
function runNpm(args, cwd) {
  const isWin = process.platform === 'win32'
  const [cmd, argv] = isWin
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args]]
    : ['npm', args]
  try {
    execFileSync(cmd, argv, { cwd, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (error) {
    fail(`npm ${args.join(' ')} 失败：${error.message}`)
  }
}

/**
 * 打 zip：**自己写归档器**，不再调系统 `zip` / `tar -a`。
 *
 * 为什么不用系统命令：它们会把每个文件的 mtime 写进条目头，于是同一份源码
 * 在本地（Windows bsdtar）和 CI（Linux zip）打出来字节不同、SHA256 也不同——
 * 发出去的 Release 校验和永远对不上本地 dist，用户照着核对会以为包坏了。
 *
 * 这里自己拼 zip：条目按路径排序、时间戳统一钉死 1980-01-01、权限统一
 * 0644/0755、只写必要字段，因此打包结果是**跨平台确定**的，dist 与 Release
 * 逐字节一致。DSH 侧的 tgz 本来就靠 `npm pack`（它已做同样的事）。
 *
 * 代价：包变大（deflate level 9 + 不写目录数据），收益是哈希可复现，
 * 而这个包只有几十 KB，值得。
 */
function writeZipDir(srcDir, outPath, rootName) {
  const entries = []
  walk(srcDir, rootName, entries)
  // 路径字典序排定条目顺序——顺序固定才谈得上可复现。
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const locals = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const isDir = entry.name.endsWith('/')
    const raw = isDir ? Buffer.alloc(0) : readFileSync(entry.abs)
    const body = isDir ? Buffer.alloc(0) : deflateRawSync(raw, { level: 9 })
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const sum = crc32(raw)
    // 1980-01-01 00:00:00 —— zip 的 DOS 时间能表示的最小值，写死即抹掉打包时刻。
    const dosTime = 0
    const dosDate = 0x0021
    const mode = isDir ? 0o40755 : 0o100644

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // 文件名按 UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(dosTime, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)

    const head = Buffer.concat([local, nameBuf])
    locals.push(head, body)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(0x031e, 4) // 标记为 unix 产出
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(0x0800, 8)
    cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(dosTime, 12)
    cen.writeUInt16LE(dosDate, 14)
    cen.writeUInt32LE(sum, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(raw.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt16LE(0, 30)
    cen.writeUInt16LE(0, 32)
    cen.writeUInt16LE(0, 34)
    cen.writeUInt16LE(0, 36)
    cen.writeUInt32LE((mode << 16) >>> 0, 38)
    cen.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cen, nameBuf]))

    offset += head.length + body.length
  }

  const cenBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cenBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  writeFileSync(outPath, Buffer.concat([...locals, cenBuf, end]))
}

/** 递归收集条目，目录以 `/` 结尾（zip 惯例），分隔符统一成 `/`。 */
function walk(dir, name, out) {
  for (const child of readdirSync(dir).sort()) {
    const abs = join(dir, child)
    const rel = `${name}/${child}`
    if (statSync(abs).isDirectory()) {
      out.push({ abs, name: `${rel}/` })
      walk(abs, rel, out)
    } else {
      out.push({ abs, name: rel })
    }
  }
}

/**
 * 标准 CRC-32（IEEE 802.3）。自己写是为了不赌 Node 版本的 zlib.crc32。
 * 表定义在文件顶部——本模块在顶层就直接打 zip，表若放在下面会撞 const 的
 * 暂时性死区（TDZ）。
 */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function notes(version, tag, sums, artifacts) {
  // 按**扩展名**取，不能按下标解构：readdirSync 给的是字典序，
  // `astrbot_*.zip` 排在 `dsh-*.tgz` 前面，解构出来两者就对调了。
  // （v0.1.0 的发布说明就是这么错的，发出去之后才发现。）
  const tgz = artifacts.find((name) => name.endsWith('.tgz'))
  const zip = artifacts.find((name) => name.endsWith('.zip'))
  if (!tgz || !zip) {
    fail(`产物命名异常，无法生成发布说明：tgz=${tgz}，zip=${zip}`)
  }
  const ref = tag || `v${version}`
  return `# AstrDsh Relay（星驿）${ref}

> ⚠️ **P1 + P2 全链路已打通，三项配置项仍未实现。**
>
> **已实现**（六端点全部有真实 handler）：DSH 侧 \`GET /health\`、\`GET /where\`、
> \`GET /conversations\`、\`POST /message\`（agent 会话驱动：create / resume / followup）、
> \`GET /events\`（SSE 下行，环形缓冲 + \`Last-Event-ID\` 续传）、\`POST /approval\`
> （审批 waterfall，4 位一次性 code）；含幂等（有界 LRU + TTL）、事件转发、
> 卸载期 \`cancel → whenIdle → flush → dispose\` 收尾；两侧 state 持久化、配置校验与
> Bearer 定长鉴权。AstrBot 侧 \`BridgeTransport\` 六方法（health / where / send_message /
> events / send_approval / aclose）全部实现，含 \`/dsh where\`、\`/dsh approve|reject\`、
> 流式节流回帖与 \`push_to_session\`。
>
> **未实现**（DSH 侧 \`assertConfigIsUsable\` **加载即抛错**，不静默降级）：
> \`hmacMode\`、非 \`one-to-one\` 的 \`policy\`（轮转策略）、\`idleTtlMs\`。
> 只要不使用这三个配置项，本版本即可正常收发消息。

## 产物

| 产物 | 对应半边 | 版本 |
|---|---|---|
| \`${tgz}\` | DSH 侧 host 插件 \`dsh-astrbot-relay\` | ${version} |
| \`${zip}\` | AstrBot 侧 Star 插件 \`astrbot_plugin_dsh_relay\` | ${version} |

## 安装

### DSH 侧

\`\`\`powershell
dsh plugin --profile web add ./${tgz}
dsh --profile web --dump-config    # 应出现 "# == dsh-astrbot-relay" 层
\`\`\`

本包是预打包产物、无构建步骤，因此**不需要** \`allowBuilds\` 授权
（那条路径只在从 git 源码安装、需要跑 prepare 时才出现）。

装好后**必须**在 profile 的 \`cordis.patch.yml\` 里给出 \`token\` 与 \`cwd\`：

\`\`\`yaml
- id: dsh-astrbot-relay
  config:
    token: '<32 字节以上随机串>'
    cwd: '<绝对路径>'
\`\`\`

两者都是 required，缺失会让插件**加载即失败**——这是刻意的（配置错误要响亮）。
注意 patch 是按顶层 key 赋值，写出的 \`config:\` 会整体替换整行 config，不是逐字段合并。

### AstrBot 侧

\`\`\`powershell
Expand-Archive .\\${zip} -DestinationPath <AstrBot 目录>\\data\\plugins\\
\`\`\`

然后在 WebUI 插件页启用，并填 \`bridge_url\` 与 \`bridge_token\`。

## 校验

\`\`\`
${sums.join('\n')}
\`\`\`

Linux/macOS 下可一键核对：\`sha256sum -c SHA256SUMS\`

## 文档

- 接口契约（唯一真相来源）：[\`docs/BRIDGE-CONTRACT.md\`](https://github.com/${REPO}/blob/main/docs/BRIDGE-CONTRACT.md)
- 设计（五层架构 + 迁移计划）：[\`docs/DESIGN.md\`](https://github.com/${REPO}/blob/main/docs/DESIGN.md)
- 发布流程：[\`docs/RELEASING.md\`](https://github.com/${REPO}/blob/main/docs/RELEASING.md)
`
}
