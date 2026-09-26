/**
 * 星驿 · Web 客户端半边（DSH Web 面板）
 *
 * 形态照抄本机已装且能跑的 `dsh-skin-market`：文件执行时**只注册工厂**，
 * 真正的工作在 `factory` 里；模块级没有副作用。
 *
 * 只依赖共享基座里的 `react`（`react-dom` / `react/jsx-runtime` 也都可用），
 * **不引任何 UI 组件库** —— 少一个 external 就少一处会随宿主版本漂移的接缝。
 * 样式用行内 style + 一小段注入的 CSS，不碰宿主主题变量。
 *
 * 数据来自宿主半边注册的只读路由 `GET <pathPrefix>/panel/status`
 * （见 `lib/panel.js` 与 `lib/index.js` 的 `handlePanelStatus`）。
 * 那个路由**默认关闭**，所以这个面板最常见的首屏就是一句「怎么打开它」。
 *
 * 为何是只读：改指/认领那些写操作要过权限门（`docs/DESIGN.md` §7.3.1），
 * 而那道门还没建（P5）。面板要是能改状态，就等于绕开它。
 */

window.__ModuleLoader__.load({
  id: 'dsh-astrbot-relay',
  factory: (require) => {
    const React = require('react')

    const name = 'dsh-astrbot-relay'
    /** 服务名注入：与 skin-market 同集合，确保 `slots` 能解析到。 */
    const inject = ['slots']

    const DEFAULT_PREFIX = '/astrbot-relay'
    const POLL_MS = 5000

    const els = React.createElement

    /** 把毫秒差写成「3 分钟前」这种人话。 */
    function humanAge(ms) {
      if (ms === null || ms === undefined) return '从未'
      if (ms < 1000) return '刚刚'
      const seconds = Math.floor(ms / 1000)
      if (seconds < 60) return `${seconds} 秒前`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 48) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    function humanUptime(ms) {
      const seconds = Math.floor((Number(ms) || 0) / 1000)
      if (seconds < 60) return `${seconds} 秒`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes} 分`
      return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
    }

    const CSS = `
.szx-root { font-size: 13px; line-height: 1.6; }
.szx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 10px 0 16px; }
.szx-card { border: 1px solid var(--dsh-border, rgba(128,128,128,.28)); border-radius: 8px; padding: 8px 10px; }
.szx-card b { display: block; font-size: 16px; }
.szx-card span { opacity: .7; font-size: 12px; }
.szx-note { opacity: .75; }
.szx-warn { border-left: 3px solid #d08b00; padding: 6px 10px; margin: 8px 0;
  background: rgba(208,139,0,.08); border-radius: 0 6px 6px 0; }
.szx-bad { border-left: 3px solid #d05050; padding: 6px 10px; margin: 8px 0;
  background: rgba(208,80,80,.08); border-radius: 0 6px 6px 0; }
.szx-ok { color: #2e9e5b; } .szx-off { color: #d05050; } .szx-dim { opacity: .6; }
.szx-table { width: 100%; border-collapse: collapse; margin-top: 6px; }
.szx-table th, .szx-table td { text-align: left; padding: 4px 8px 4px 0; vertical-align: top;
  border-bottom: 1px solid var(--dsh-border, rgba(128,128,128,.18)); }
.szx-table th { font-weight: 600; opacity: .7; font-size: 12px; }
.szx-mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
`;

    /** 只在第一次挂载时插一次样式；重复挂载不会堆出一排 <style>。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById('szx-panel-style')) return
      const style = document.createElement('style')
      style.id = 'szx-panel-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 读一次快照。把「没开」「被拒」「连不上」分成三种可读的结论。 */
    async function fetchSnapshot(pathPrefix) {
      const url = `${pathPrefix || DEFAULT_PREFIX}/panel/status`
      try {
        const response = await fetch(url, {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (response.status === 404) {
          return { state: 'disabled', url }
        }
        if (response.status === 403) {
          let reason = ''
          try { reason = (await response.json())?.error?.message ?? '' } catch { /* 正文不是 JSON */ }
          return { state: 'denied', url, reason }
        }
        if (!response.ok) return { state: 'error', url, reason: `HTTP ${response.status}` }
        return { state: 'ok', url, snapshot: await response.json() }
      } catch (error) {
        return { state: 'error', url, reason: String(error?.message ?? error) }
      }
    }

    function StatusCard({ label, value, hint }) {
      return els('div', { className: 'szx-card' },
        els('b', null, value),
        els('span', null, label),
        hint ? els('div', { className: 'szx-dim', style: { fontSize: 11 } }, hint) : null)
    }

    function Panel() {
      ensureStyles()
      const [view, setView] = React.useState({ state: 'loading' })
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let cancelled = false
        let timer = null
        const load = async () => {
          const prefix = (globalThis.__DSH_BOOT__ && globalThis.__DSH_BOOT__.pathPrefix) || DEFAULT_PREFIX
          const next = await fetchSnapshot(prefix)
          if (cancelled) return
          setView(next)
          // 未启用 / 被拒时不必每 5 秒重试：那不会自己变好。
          if (next.state === 'ok') timer = setTimeout(() => setTick((value) => value + 1), POLL_MS)
        }
        load()
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [tick])

      if (view.state === 'loading') {
        return els('div', { className: 'szx-root szx-note' }, '正在读取星驿状态…')
      }
      if (view.state === 'disabled') {
        return els('div', { className: 'szx-root' },
          els('div', { className: 'szx-warn' },
            '面板未启用。在 DSH profile 的 cordis.patch.yml 里给 dsh-astrbot-relay 加上 ',
            els('code', null, 'panelEnabled: true'),
            ' 并重启 DSH 后可用。'),
          els('div', { className: 'szx-note szx-mono' }, `探测地址：${view.url}`))
      }
      if (view.state === 'denied') {
        return els('div', { className: 'szx-root' },
          els('div', { className: 'szx-bad' },
            '面板拒绝了这次读取（',
            view.reason || 'unknown',
            '）。它默认只允许回环地址访问；跨机部署请用反向代理加认证，',
            '或在明确知道暴露面之后再开 ',
            els('code', null, 'panelAllowRemote'),
            '。'),
          els('div', { className: 'szx-note szx-mono' }, `探测地址：${view.url}`))
      }
      if (view.state === 'error') {
        return els('div', { className: 'szx-root' },
          els('div', { className: 'szx-bad' }, `读不到面板数据：${view.reason}`),
          els('div', { className: 'szx-note szx-mono' }, `探测地址：${view.url}`))
      }

      const snapshot = view.snapshot ?? {}
      const bridge = snapshot.bridge ?? {}
      const im = snapshot.im ?? {}
      const counts = snapshot.counts ?? {}
      const conversations = snapshot.conversations ?? []

      return els('div', { className: 'szx-root' },
        els('div', { className: 'szx-grid' },
          els(StatusCard, { label: '契约版本', value: bridge.bridgeVersion || '?' }),
          els(StatusCard, { label: '已知对话', value: String(counts.conversations ?? 0),
            hint: `其中 ${counts.mapped ?? 0} 条已建会话` }),
          els(StatusCard, { label: 'IM 是否在听', value: im.online ? '在线' : '离线',
            hint: im.online ? `上次轮询 ${humanAge(im.sinceLastPollMs)}`
              : (im.lastPollAt ? `上次轮询 ${humanAge(im.sinceLastPollMs)}` : '从未轮询')
          }),
          els(StatusCard, { label: '运行时长', value: humanUptime(bridge.uptimeMs),
            hint: `心跳 ${bridge.heartbeatMs}ms` })),

        !im.online ? els('div', { className: 'szx-warn' },
          'IM 侧没有在轮询，因此 DSH 不会发起自主心跳（契约 §18.5：没人在听时发起等于白烧一次调用）。',
          '确认 AstrBot 侧插件在运行、且 ',
          els('code', null, 'proactive_poll_ms'),
          ' 没被停掉。') : null,

        els('div', { className: 'szx-note' },
          '工作目录 ', els('code', 'szx-mono', bridge.cwd || '(未配置)'),
          '　策略 ', els('code', null, bridge.policy || '?'),
          '　前缀 ', els('code', null, bridge.pathPrefix || '?')),

        els('h4', { style: { margin: '16px 0 0' } }, `对话映射（${conversations.length}）`),
        conversations.length === 0
          ? els('div', { className: 'szx-note' }, '还没有任何 IM 对话建立映射。在群里发一条 `dsh 你好` 即可。')
          : els('table', { className: 'szx-table' },
            els('thead', null, els('tr', null,
              els('th', null, 'IM 对话'),
              els('th', null, 'DSH 会话'),
              els('th', null, '标题（DSH Web 列表里显示的那个）'),
              els('th', null, '上次活动'))),
            els('tbody', null, conversations.map((item) => els('tr', { key: item.conversation },
              els('td', { className: 'szx-mono' }, item.conversation),
              els('td', { className: 'szx-mono' }, item.dshSessionId || els('span', { className: 'szx-dim' }, '未建立')),
              els('td', null, item.title || els('span', { className: 'szx-dim' }, '—'),
                item.cwd ? els('div', { className: 'szx-dim szx-mono', style: { fontSize: 11 } },
                  `${item.cwd}（${item.cwdSource === 'conversation' ? '对话级覆盖' : '跟随全局'}）`) : null),
              els('td', { title: item.lastActiveAt ? new Date(item.lastActiveAt).toLocaleString() : '' },
                humanAge(item.idleMs),
                item.outboxSize > 0
                  ? els('div', { className: 'szx-dim', style: { fontSize: 11 } }, `发件箱 ${item.outboxSize} 条`)
                  : null,
                item.proactiveTurn
                  ? els('div', { className: 'szx-dim', style: { fontSize: 11 } }, '本轮是自主心跳')
                  : null))))),

        counts.pending > 0
          ? els('div', null,
            els('h4', { style: { margin: '16px 0 0' } }, `在途（${counts.pending}）`),
            els('table', { className: 'szx-table' },
              els('thead', null, els('tr', null,
                els('th', null, 'IM 对话'), els('th', null, '投递'),
                els('th', null, '审批'), els('th', null, '问答'), els('th', null, '闸门已放'))),
              els('tbody', null, (snapshot.pending ?? []).map((row) => els('tr', { key: row.conversation },
                els('td', { className: 'szx-mono' }, row.conversation),
                els('td', null, row.queue ? String(row.queue) : row.attaching ? '挂载中' : '—'),
                els('td', null, String(row.approvals ?? 0)),
                els('td', null, String(row.questions ?? 0)),
                els('td', null, row.stuckAt ? '是' : '—'))))))
          : null,

        els('div', { className: 'szx-note', style: { marginTop: 14, fontSize: 11 } },
          '数据每 ', POLL_MS / 1000, ' 秒刷新一次。这是**只读诊断面板**：',
          '改指/认领等写操作在 IM 侧用 /dsh 指令完成。生成于 ',
          new Date(snapshot.generatedAt || Date.now()).toLocaleTimeString(), '。'))
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'astrbot-relay',
        order: 46,
        label: () => '星驿',
      }, () => els(Panel, null)))
    }

    return { name, inject, apply, Panel }
  },
})
