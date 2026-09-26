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
// 契约版本与路由表从唯一真相副本读取，发布说明不再手写字面量（v0.8.1 修：此前硬写 3）。
import { BRIDGE_VERSION, ROUTES } from '../dsh-astrbot-relay/lib/contract.js'

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

// ─────────────────────────────────────────────────────────────────────
// 1.5 README 的「最新发布」指针（v0.8.4 发版时漏改过一次，这里钉死）
// 指针落在仓库根 README；缺失或不等于当前版本都算失败，CI 与本地同样受管。
// ─────────────────────────────────────────────────────────────────────
const readmeRaw = readFileSync(join(ROOT, 'README.md'), 'utf8')
const pointer = readmeRaw.match(/最新发布[：:]\s*`?v(\d+\.\d+\.\d+[^`\s]*)/)
if (!pointer) {
  fail('README.md 里找不到「最新发布：`vX.Y.Z`」指针，无法体检；请确认它还在。')
}
if (pointer[1] !== version) {
  fail(
    `README.md 的最新发布指针是 v${pointer[1]}，与当前版本 ${version} 不符。
` +
    '  发版前请把 README 的「最新发布」改成当前版本（v0.8.4 曾漏过这一步）。',
  )
}
ok(`README 最新发布指针一致：v${pointer[1]}`)

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
  // 预发布提示由**版本号自己**决定，不靠人手记：带 `-` 就是预发布
  // （与 release.yml 的 `prerelease: contains(tag, '-')` 同一判据）。
  const preRelease = version.includes('-')
    ? `> 🅰️ **预发布（\`${version}\`）**：供真机部署验证使用，接口与行为在定版前仍可能变。\n>\n`
    : ''
  const body = `# AstrDsh Relay（星驿）${ref}

${preRelease}> ⚠️ **P1 + P2 全链路已打通；契约预留的三项配置（\`hmacMode\` / \`policy\` 轮转 / \`idleTtlMs\`）自本版起均已接线。**
>
> **已实现**（${Object.keys(ROUTES).length} 个端点全部有真实 handler）：DSH 侧 \`GET /health\`、\`GET /where\`、
> \`GET /conversations\`、\`GET /workspaces\`（工作区清单，\`workspaceRegistry.list()\`）、
> \`POST /session/rebind\`（改指到指定工作区：落在目标目录的新会话 + 换映射，旧会话保留）、
> \`POST /session/fork\`（把某个对话已完成的轮次前缀复制成新会话，源会话只读，
> 取轮次的口径照抄宿主 \`sessionController.fork\`）、
> \`POST /session/adopt\`（把某个 IM 对话改指到一个**已存在**的会话 id，
> 补上 v3 留下的缺口：fork 出来的子会话此前只能被 \`/message\` 顺势接管）、
> \`POST /message\`（agent 会话驱动：create / resume / followup）、
> \`GET /events\`（SSE 下行，环形缓冲 + \`Last-Event-ID\` 续传）、\`POST /approval\`
> （审批 waterfall，4 位一次性 code）、\`POST /answer\`（用户问答回执：与审批**严格分离**的第二条通道，
> \`callId\` 前缀 \`im-q-\` 与审批的 \`im-\` 互不干扰）、\`GET /proactive\`（主动消息取件，
> 有界发件箱 + \`since\` 游标 ack）；含幂等（有界 LRU + TTL）、事件转发、
> 卸载期 \`cancel → whenIdle → flush → dispose\` 收尾；两侧 state 持久化、配置校验与
> Bearer 定长鉴权。AstrBot 侧 \`BridgeTransport\` 十二方法（health / where / workspaces /
> rebind / fork / adopt / send_message / events / send_approval / send_answer / proactive /
> aclose）全部实现，含 \`/dsh where\`、
> \`/dsh approve|reject\`、\`/dsh answer <验证码>\`、\`/dsh workspaces\`、\`/dsh rebind <工作区 id>\`、
> \`/dsh fork [轮次序号]\`、\`/dsh adopt\`、流式节流回帖与 \`push_to_session\`。
>
> **v0.8.6 新增**：用户问答通道（\`ask_user_question\`；下行事件 \`question/required\` /
> \`question/resolved\`，含 \`/dsh answer\` 指令与 \`questionsEnabled\` / \`questionTimeoutMs\`）；
> **在途投递单**——\`queue\` 的每一份额度对应一张单子，由 \`turn/end\` 结算、等待态超时
> fail-closed 兜底（\`waitTimeoutMs\`）；\`/health\` 新增 \`pending[]\`，把「在等一个可能不到来的
> 答案」与「闸门已放、但不保证 turn 真的闭合」分开列出。另修掉一处「\`signal\` 预中止导致
> 问答 Promise 永久悬挂」的缺陷——那比它要修的队列死锁更隐蔽。
>
> **v0.8.7 新增**：心跳与主动消息（契约 §17 / §18，\`BRIDGE_VERSION\` 随之升到 \`6\`）。
> **A 半 = 连通性心跳**：IM 侧用「\`/health\` 探测 + 该对话最近见帧时刻」**两条**判据维护
> 每对话三态（\`online\` → \`suspect\` → \`offline\`，滞回防抖），跃迁时按
> \`off\` / \`fixed\` / \`offline-only\` 播报固定文案（含原因与持续时长，且**不含** Markdown
> 裸星号）。只做探测会漏掉「进程活着、这条流死了」——那正是 SSE 半开连接最常见的形态。
> **B 半 = 自主心跳**：DSH 侧按八条闸门（\`disabled\` / \`no-session\` / \`offline\` / \`busy\` /
> \`pending\` / \`too-soon\` / \`outside-window\` / \`quota-exceeded\`，顺序即优先级）决定是否发起
> 一轮，由模型用沉默哨兵 \`[SILENT]\` 决定说不说；出口是**有界发件箱 +
> \`GET /proactive?since=<游标>\` 轮询**，不是常连 SSE——\`seq\` 是每对话的，多对话复用进
> 一条流之后 \`Last-Event-ID\` 就失去意义，而主动消息天生需要存储转发（没人在听时丢了就是丢了）。
> 其中 \`online\` 闸门取「IM 最近在轮询」而不是同步 IM 的每对话在线态，两半因此可以分别上线。
> 另修掉两处**已在 v0.8.6 发布版里**的同行错位（都属「字段/方法挂错类」）：
> ①\`Main._health_task\` 被定义在 \`BridgeTransport.__init__\`，而 \`terminate\` 读的是
> \`Main\`——\`enable=false\` 时 \`initialize\` 会提前返回、从不创建该任务，
> 于是卸载插件就是一次 \`AttributeError\`；
> ②\`proactive()\` 被写进了 \`Main\`，而它内部调的是 \`BridgeTransport._request\`
> ——一段永不生效的死代码，只有真去调它才会 \`AttributeError\`，且让
> 「传输层十二方法」那句文档变成假的。两者都不会被 \`py_compile\` 或任何静态闸门发现，
> 是新增的假 AstrBot 上下文集成测试（含一条**泛化**的「\`Main\` 里所有 \`self._xxx\`
> 在构造后就必须存在」检查）抓到的。
>
> **配置项**：\`hmacMode\`（契约 §5.2 请求体 HMAC 签名）、\`policy\` 的 \`on-demand\` /
> \`daily\` 轮转、\`idleTtlMs\` 空闲回收均已实现；轮转与回收走
> \`workspaceRegistry.archiveSession\`，**只归档不删历史**。DSH 侧
> \`assertConfigIsUsable\` 对它们只做参数校验，不再加载即抛错。另有 \`questionsEnabled\` / \`questionTimeoutMs\`
> （问答通道）、\`waitTimeoutMs\`（在途投递单的等待态超时兜底；设 \`0\` 关闭），以及本版新增的
> \`heartbeatMs\` / \`proactiveHeartbeatMs\` / \`proactiveMinIdleMs\` / \`proactiveWindow\` /
> \`proactiveMaxPerDay\` / \`proactivePrompt\` / \`proactiveSilentSentinel\` /
> \`proactiveOutboxSize\` / \`proactivePollMax\` / \`proactiveImAliveMs\`（自主心跳，
> \`proactiveHeartbeatMs\` **默认 0 = 关闭**）与 IM 侧的 \`heartbeat_frame_miss_factor\` /
> \`heartbeat_notify\` / \`heartbeat_notify_targets\` / \`heartbeat_notify_min_gap_ms\` /
> \`proactive_enabled\` / \`proactive_poll_ms\` / \`proactive_prefix\`。
>
> ⚠️ **未实测**：B 半依赖 \`agent.followup(createUserMessage({source:{kind:'plugin',…}}))\`
> 真的能起一轮 turn，本机没有活的 DSH 宿主可验（契约 §18.8）。若它不起作用，表现是
> 「日志说发起了、但永远没有回复」，A 半不受影响。
>
> **v0.8.8 新增/修复**：心跳播报的 **\`agent\` 模式**——由对话模型把「链路断了/恢复了」
> 组织成一句人话（\`heartbeat_notify=agent\`）。**要不要播报是确定性的、模型只负责措辞**：
> 把判定也交给模型就会出现「它觉得这次不重要就不说了」，而连通性漏报的代价远大于措辞难看。
> 新增 \`heartbeat_agent_prompt\` / \`heartbeat_agent_system_prompt\` /
> \`heartbeat_agent_max_chars\` / \`heartbeat_agent_timeout_ms\`；取不到模型、抛错、超时、
> 返回空、模板为空**一律退回固定文案**（绝不因为模型挂了就漏报）；模型输出先洗再发
> （去 Markdown 标记、压成一行、截断）。AstrBot 的 LLM 入口已在源码里核实
> （\`Context.get_using_provider\` → \`Provider.text_chat\` →
> \`result_chain.get_plain_text()\`）。
>
> 🔴 **同时修掉一处用户可见的严重缺陷（v0.8.7 及以前一直如此）**：
> \`_on_approval_required\` / \`_on_question_required\` 标注 \`AsyncIterator\` 却**完全没有
> \`yield\`**（因此是协程），而调用点写的是 \`async for\` ⇒
> \`TypeError: 'async for' requires an object with __aiter__ method, got coroutine\`。
> 后果是**审批与问答提示根本到不了用户**，而且这个异常会打断整条 turn 的回帖；
> 审批 waterfall 本身又没有超时，agent 会一直挂在等一个不可能到的答案上。
> 已改为 \`await\`，并加了从两侧钉住形状的测试。**本版 \`BRIDGE_VERSION\` 仍是 \`6\`，
> 只动 IM 侧，两侧可以不同时升级。**
>
> **v0.8.9 修复**：\`reply_render_mode=card\` 此前**只对 agent 回复生效**，
> 而心跳播报与主动消息固定发纯文本——把渲染模式改成 \`card\` 的用户会发现这两类消息
> 仍是一张张纯文本，即**配置键在一条路径上说了谎**。现在对所有出站消息一视同仁，
> 共用同一条「任一片渲染失败就整条退回纯文本」的判定（绝不半图半文）。
> 图片链的构造与 \`event.image_result\` 逐字对应（http → \`Image.fromURL\`、
> 否则 \`Image.fromFileSystem\`，见 \`message_event_result.py:93-116\`）。
> **本版 \`BRIDGE_VERSION\` 仍是 \`6\`**，只动 IM 侧，两侧可以不同时升级。
>
> **v0.9.0-alpha 文档**：新增 **\`docs/DEPLOY-CHECKLIST.md\`**（部署与验证清单：装包 → 数据面 →
> 心跳 A → 自主心跳 B → 审批 → 问答 → 呈现 → 跨机反代 → 记录表 → 回滚），
> 其中三处「至今未实测」的项给了可判定的操作与判据，§11 的记录表就是关闭它们的凭据。
> 同时更正两处与事实不符的表述：契约 §3.4 的 \`/health\` 示例**删掉从未实现的
> \`dshVersion\`**；AstrBot 侧 \`metadata.yaml\` 的定位描述改为「当前只做数据面、
> 管理面尚未接管、目标是最终替代 connector」（原文读起来是长期并存，与设计决策相左）。
> **本版 \`BRIDGE_VERSION\` 仍是 \`6\`**：与 v0.8.7+ 的任一侧可以配对。
>
> **两侧必须配对**：本版 \`BRIDGE_VERSION=${BRIDGE_VERSION}\`（v0.8.7 起是 \`6\`、v0.8.5–v0.8.6 是 \`5\`、v0.8.0–v0.8.4 是 \`4\`、v0.6.x–v0.7.x 是 \`3\`、v0.5.x 是 \`2\`、v0.4.x 是 \`1\`）。AstrBot 侧启动时校验
> \`GET /health\` 的 \`bridgeVersion\`，不匹配**拒绝启用**，所以两边要一起升。

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
  // 防回归：上面那句「N 个端点全部有真实 handler」里的 N 是**算出来**的，
  // 而端点清单是**手写**的——v0.8.6 发布说明就出过「说 11 个、清单里只有 10 个」
  // （漏了 `POST /answer`，发出去之后才发现并 PATCH 了正文）。
  // 这里把两者钉死：任何一条路由没被写进清单，打包直接失败。
  const listed = new Set(
    [...body.matchAll(/`(?:GET|POST) (\/[a-z][a-z/-]*)`/g)].map((match) => match[1]),
  )
  const missing = Object.values(ROUTES).filter((route) => !listed.has(route))
  if (missing.length) {
    fail(
      `发布说明漏列端点：${missing.join('、')}\n` +
      `  说明里声称 ${Object.keys(ROUTES).length} 个，实际只列了 ${listed.size} 个。` +
      '请补齐「已实现」清单。',
    )
  }
  return body
}
