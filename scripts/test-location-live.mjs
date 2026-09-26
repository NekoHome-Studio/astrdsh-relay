#!/usr/bin/env node
/**
 * 星驿 · 「定位不同会话集」的实测脚本（只读，不写任何文件）。
 *
 * 验四条链路，每条对应契约的一节：
 *
 *   1. 正向定位（§12.1）：`GET /where?conversation=<umo>` 能否答出「这个 IM 对话落在
 *      哪条 DSH 会话、哪个工作目录、目录来源是什么」。
 *   2. 映射集合（§12.2）：`GET /conversations` 能否一次列全已知映射，
 *      且 count / returned 分开报。
 *   3. 反向定位（§12.4）：**标题是否真的写进了 DSH 会话日志**。这里读会话存档里的
 *      `session/title` 事件——那才是 DSH Web 会话列表显示的来源；只看接口返回的
 *      title 不算证据（那只是本插件按模板渲染出来的字符串）。
 *   4. 不同会话集：`policy=one-to-one` 下，**不同 IM 对话必须落在不同 DSH 会话**。
 *      只有 1 个对话时这条是恒真的，脚本会自己说明。
 *
 * ⚠️ 两个踩过的坑，写在这里免得下次又踩：
 *   · 会话存档是**多帧 zstd**（append-only）。`zstdDecompressSync` 只解第一帧，
 *     `createZstdDecompress` 的管道在本机也只吐第一帧——必须按 zstd 魔数自己切帧。
 *     只读第一帧会得出「存档里只有会话头、没有消息、没有标题」的**错误结论**
 *     （16 KB 的文件只解出 213 字节时就该警觉）。
 *   · 判 cwd 不能拿路径串去 `includes`：存档里是 JSON 转义过的
 *     `C:\\Users\\...`（双反斜杠），串比较必然失败。要解析出字段再比。
 *
 * 期望值全部从 profile 的 ``cordis.patch.yml`` 里读（token / pathPrefix / cwd），
 * 所以换机器、换目录都不用改本脚本。
 *
 * 用法：
 *     node scripts/test-location.mjs
 *     node scripts/test-location.mjs --profile headless --host 10.0.0.5:3080
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = argOf('profile', 'web')
const HOST = argOf('host', '127.0.0.1:3080')
const ROW_ID = argOf('row', 'dsh-astrbot-relay')

const PATCH = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
const SESSIONS = join(DSH_HOME, 'sessions')
const CACHE = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')

let pass = 0
const failed = []
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`) }
  else { failed.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

/** 从 profile 的 patch 里抠出本条插件的 config（够用的解析，不引 YAML 库）。 */
function patchRow() {
  if (!existsSync(PATCH)) return {}
  const text = readFileSync(PATCH, 'utf8')
  const index = text.indexOf(`- id: ${ROW_ID}`)
  if (index < 0) return {}
  const values = {}
  for (const line of text.slice(index).split('\n').slice(1)) {
    if (line.startsWith('- ')) break
    const colon = line.indexOf(':')
    if (colon < 0) continue
    values[line.slice(0, colon).trim()] = line.slice(colon + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return values
}

const row = patchRow()
const TOKEN = row.token ?? ''
const PATH_PREFIX = row.pathPrefix || '/astrbot-relay'
const EXPECTED_CWD = row.cwd ?? ''
const BASE = `http://${HOST}${PATH_PREFIX}`
const TEMPLATE = '星驿 · {platform}/{messageType}/{sessionId}'

async function api(path) {
  const response = await fetch(BASE + path, { headers: { authorization: `Bearer ${TOKEN}` } })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text.slice(0, 200) } }
  return { status: response.status, body }
}

/** 按 zstd 魔数切帧、逐帧解压 —— 只解第一帧会漏掉全部消息与标题。 */
function readArchive(path) {
  const buf = readFileSync(path)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  let text = ''
  let frames = 0
  for (const [index, start] of starts.entries()) {
    const end = index + 1 < starts.length ? starts[index + 1] : buf.length
    try {
      text += zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
      frames += 1
    } catch { /* 坏帧跳过 */ }
  }
  const events = text.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line) } catch { return { type: '(解析失败)' } }
  })
  return { frames, totalFrames: starts.length, events }
}

function findSessionFile(sessionId) {
  if (!existsSync(SESSIONS)) return null
  for (const dir of readdirSync(SESSIONS)) {
    const candidate = join(SESSIONS, dir, sessionId, 'session.v3.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const stateFile = row.statePath || join(DSH_HOME, 'astrbot-relay', 'state.json')
const conversations = existsSync(stateFile)
  ? Object.keys(JSON.parse(readFileSync(stateFile, 'utf8')).conversations ?? {})
  : []

console.log('== 0) 前置 ==')
check(`profile patch 存在：${PATCH}`, existsSync(PATCH))
check('patch 里有 token', Boolean(TOKEN))
check('patch 里有 cwd', Boolean(EXPECTED_CWD), JSON.stringify(EXPECTED_CWD))
const health = await api('/health')
check('桥已挂上（/health 200）', health.status === 200,
  `HTTP ${health.status} ${JSON.stringify(health.body)}`)
console.log(`      已知 IM 对话 ${conversations.length} 个：${conversations.join('、') || '（还没有）'}`)
if (health.status !== 200) {
  console.log('\n先解决上面的问题（跑 scripts/verify-bridge-live.py 看细节），后面的检查没有意义。')
  process.exitCode = 1
} else {
  await main()
}

async function main() {
  console.log('== 1) 正向定位：/where 逐个问答 ==')
  const rows = []
  for (const conversation of conversations) {
    const { status, body } = await api(`/where?conversation=${encodeURIComponent(conversation)}`)
    check(`/where ${conversation} → 200`, status === 200, `HTTP ${status} ${JSON.stringify(body)}`)
    if (status !== 200) continue
    rows.push({ conversation, ...body })
    check('  ↳ found=true（有绑定记录）', body.found === true, JSON.stringify(body))
    check('  ↳ sessionId 非空', typeof body.sessionId === 'string' && body.sessionId.length > 0)
    check('  ↳ title 非空（反向定位的抓手）',
      typeof body.title === 'string' && body.title.trim().length > 0)
    check('  ↳ cwd 与 profile 配置一致',
      String(body.cwd ?? '').toLowerCase() === EXPECTED_CWD.toLowerCase(),
      `接口 ${JSON.stringify(body.cwd)} vs profile ${JSON.stringify(EXPECTED_CWD)}`)
    check('  ↳ title 符合模板（含这个对话的平台/类型/会话号）', (() => {
      if (typeof body.title !== 'string') return false
      const parts = String(conversation).split(':')
      return parts.every((part) => body.title.includes(part)) || body.title.includes(TEMPLATE.split(' ')[0])
    })(), JSON.stringify(body.title))
  }

  console.log('== 2) 映射集合：/conversations ==')
  const list = await api('/conversations?limit=200')
  check('/conversations → 200', list.status === 200, `HTTP ${list.status}`)
  if (list.status === 200) {
    check('count ≥ 已知对话数', Number(list.body.count) >= conversations.length,
      `count=${list.body.count} 已知=${conversations.length}`)
    check('returned 与 items 长度一致', Number(list.body.returned) === (list.body.items ?? []).length)
    check('每条 item 都带 sessionId 与 title',
      (list.body.items ?? []).every((i) => i.sessionId && i.title))
  }

  console.log('== 3) 反向定位：标题是否真的写进 DSH 会话日志 ==')
  for (const item of rows) {
    const file = findSessionFile(item.sessionId)
    check(`${item.sessionId} 的存档存在`, Boolean(file), '在 <DSH_HOME>/sessions/*/<id>/ 下没找到')
    if (!file) continue
    const { events, frames, totalFrames } = readArchive(file)
    const types = events.map((event) => event.type)
    console.log(`      ${(statSync(file).size / 1024).toFixed(1)} KB → ${frames}/${totalFrames} 帧、${events.length} 条事件`)

    const titleEvent = events.find((event) => event.type === 'session/title')
    check('  存档里有 session/title 事件（Web 会话列表就读它）', Boolean(titleEvent))
    check('  标题事件的值 == /where 报的标题',
      Boolean(titleEvent) && String(titleEvent.data?.title) === item.title,
      `事件 ${JSON.stringify(titleEvent?.data?.title)} vs 接口 ${JSON.stringify(item.title)}`)

    const header = events.find((event) => event.type === 'session')
    check('  会话头里的 cwd == /where 报的 cwd（比字段，不比字符串）',
      Boolean(header) && String(header.cwd).toLowerCase() === String(item.cwd).toLowerCase(),
      `头里 ${JSON.stringify(header?.cwd)} vs 接口 ${JSON.stringify(item.cwd)}`)

    check('  这一轮对话真的跑过（turn/start … turn/end 与 assistant/message）',
      types.includes('turn/start') && types.includes('turn/end') && types.includes('assistant/message'),
      `事件类型：${types.join(', ')}`)

    const cached = join(CACHE, `${item.sessionId}.json`)
    check('  投影缓存里也有标题（Web 列表的另一个数据源）',
      existsSync(cached) && readFileSync(cached, 'utf8').includes(item.title))
  }

  console.log('== 4) 不同会话集：映射是否互不撞车 ==')
  const ids = rows.map((item) => item.sessionId)
  check('不同 IM 对话 → 不同 DSH 会话', new Set(ids).size === ids.length,
    `共 ${ids.length} 个对话、${new Set(ids).size} 条会话`)
  check('不同 IM 对话 → 不同标题', new Set(rows.map((item) => item.title)).size === rows.length)
  if (conversations.length < 2) {
    console.log('  ! 只有 1 个 IM 对话时，上面两条「不同」是**恒真**的，证明不了什么。')
    console.log('    要真验「不同会话集」：换一个群（或私聊）再发一条 `dsh 你好`，然后重跑本脚本。')
  }

  console.log('== 5) 改指的目标清单：/workspaces ==')
  const workspaces = await api('/workspaces?limit=50')
  check('/workspaces → 200', workspaces.status === 200, `HTTP ${workspaces.status}`)
  if (workspaces.status === 200) {
    const items = workspaces.body.items ?? []
    console.log(`      登记 ${workspaces.body.count} 个，本次给出 ${workspaces.body.returned} 个`)
    for (const item of items.slice(0, 10)) console.log(`      · ${item.title}  id=${item.id}`)
    if (!items.length) console.log('      （空——`/dsh rebind` 暂时没有可改指的目标）')
  }

  if (rows.length) {
    console.log('\n== 映射表 ==')
    for (const item of rows) {
      console.log(`  ${item.conversation}\n    → ${item.sessionId}`)
      console.log(`      标题 ${item.title}`)
      console.log(`      目录 ${item.cwd}（${item.source}）`)
    }
  }

  console.log(`\n通过 ${pass} 项，失败 ${failed.length} 项`)
  if (failed.length) {
    console.log('失败：' + failed.join('、'))
    process.exitCode = 1 // 用 exitCode 而非 process.exit()：Windows 上后者会触发 libuv 断言
  }
}
