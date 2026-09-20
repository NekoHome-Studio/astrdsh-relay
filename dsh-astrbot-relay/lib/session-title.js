/**
 * 会话标题写入 —— R3「反向定位」的落点。
 *
 * ## 为什么要有这个文件
 *
 * 会话在 DSH 侧是用 `dshSessionId` 标识的（本插件的映射表里就长这样），
 * 但在 Web UI 的会话列表里，人看到的是**标题**。没有标题时那条会话只会显示成
 * 一串不好认的 ID，于是「这条会话对应哪个 IM 群 / 哪个人」只能靠回 IM 侧翻
 * state.json 反查。写标题把这件事反过来：**从会话列表出发就能认出源 IM 对话**。
 *
 * ## 依赖的服务从哪来
 *
 * `session-title` 服务由 `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` 挂载
 * （包 `@deepseek-ai/dsh-session-title`，同一处给了 `maxTitleBytes: 80`），
 * headless profile 通过 `bundles` 依赖它，所以本插件**不自己补挂服务**，
 * 只在使用点 `ctx.get('sessionTitle')` 取；取不到就静默跳过（容错，不是错误）。
 *
 * ## 为什么要单独一个模块
 *
 * 本文件只 import `./location.js`（纯函数、零外部依赖），于是
 * `scripts/test-session-title.mjs` 能在**没装 dsh 依赖**的普通 Node 下直接跑，
 * 把渲染、服务缺席、标题为空、服务抛错这四条降级路径都钉住。
 * 真正的调用点（lib/index.js）需要 dsh 包才能加载，测不动。
 */
import { renderSessionTitle } from './location.js'

/**
 * 标题上限（**UTF-8 字节**）。
 *
 * 数值来自 dsh-base 里 session-title 的 `maxTitleBytes: 80`，这里只作**告知性**
 * 参考（日志里提示「这个标题会被截」），真正的截断由 dsh-session-title 的
 * normalize 链路完成：cleanTitleText → truncateTitleUtf8(maxBytes) → trimEnd。
 * 本插件刻意**不做第二遍截断**——同一件事有两份权威，迟早在某个边界上不一致。
 *
 * 两处字节相关的已知行为（写进文档，不算 bug）：
 *   - 默认模板里的 `·`（U+00B7）占 2 字节，星驿占 6 字节，加上分隔符前缀共 31 字节，
 *     留给平台/类型/会话 id 的只剩 49 字节；中文平台名每个字 3 字节，照样吃紧；
 *   - 长群名 / 长 sessionId 会被**按字节**截尾，可能正好把一个多字节字符劈成两半，
 *     此时 dsh 侧按 UTF-8 边界回退，不会写出半个字符。
 */
export const TITLE_MAX_BYTES = 80

/** 结果 reason 字面量：日志与测试都按字面比对，不做模糊匹配。 */
export const TITLE_RESULT = {
  OK: 'ok',
  /** 还没有 live session（时序不对：排在 create/resume 之前就会走到这里）。 */
  NO_SESSION: 'no-session',
  /** 渲染结果是空白。空模板在配置校验期就被拒了，这里是纯防御。 */
  EMPTY_TITLE: 'empty-title',
  /** 部署没挂 session-title 服务：静默跳过，不是错误。 */
  SERVICE_MISSING: 'service-missing',
  /** 标题归一化后为空（SessionTitleInvalidError）。 */
  INVALID_TITLE: 'invalid-title',
  /** 其余一切：会话不 live、服务已 dispose、rename 内部异常。 */
  RENAME_FAILED: 'rename-failed',
}

/**
 * 把一条 IM 对话的来源写进 DSH 会话标题。**纯函数式的编排**：
 * 取服务、渲染、调用、归类失败全在这里，调用方只负责传参和记日志。
 *
 * 调用前置条件（由调用方保证）：`session` 必须是**当前 live** 的那个 session 对象。
 * dsh-session-title 的 rename 第一步就校验
 * `ctx.sessions.get(session.id) === session`，对象身份不对会直接抛
 * `session "..." is not live in this store`；所以调用点必须排在
 * create/resume 成功之后，不能排在前。
 *
 * 已知副作用（有意为之，不是意外）：`source.kind === 'user'` 的标题会
 * **supersede 自动生成**——写入之后该会话不再随对话内容自动改标题，
 * 只有显式 refresh 才解钉。反向定位要的正是这种稳定性：
 * 标题一旦写下就锁死，不会因为多聊几句就漂走。
 *
 * @param {object} options
 * @param {{rename?: Function}} [options.titles] session-title 服务（缺席即降级）
 * @param {object} [options.session] 目标会话对象（live 的那个）
 * @param {string} [options.template] sessionTitleTemplate
 * @param {string} [options.conversation] 来源 IM 对话的 UMO
 * @returns {{ok: boolean, reason: string, title?: string, rendered?: string, accepted?: object, error?: Error}}
 *   绝不抛错：起标题是锦上添花，不该让一条 IM 消息投不出去。
 */
export function applySessionTitle({ titles, session, template, conversation } = {}) {
  if (session === undefined || session === null) {
    return { ok: false, reason: TITLE_RESULT.NO_SESSION }
  }

  const title = renderSessionTitle(template, conversation)
  if (title.trim() === '') {
    return { ok: false, reason: TITLE_RESULT.EMPTY_TITLE, rendered: title }
  }

  if (titles === undefined || titles === null || typeof titles.rename !== 'function') {
    return { ok: false, reason: TITLE_RESULT.SERVICE_MISSING, rendered: title }
  }

  try {
    const accepted = titles.rename(session, title)
    // accepted 是标题快照（{title, eventSeq, ...}）；它带的是**归一化后**的结果，
    // 所以日志里优先用它，配置写超长时能直接看出被截成了什么。
    return {
      ok: true,
      reason: TITLE_RESULT.OK,
      // title 是**落盘后**的（可能已被 dsh 侧按字节截短），rendered 是我们交出去的原文，
      // 调用方要提示「你的模板超长了」得看 rendered —— title 永远在限内，看不出超没超。
      title: accepted?.title ?? title,
      rendered: title,
      accepted,
    }
  } catch (error) {
    // SessionTitleInvalidError 与「不 live」都会落到这里。**不按类名 import 判定**：
    // 本插件不该为了认一个错误而去依赖 dsh-session-title 包（它不是 peer 依赖），
    // 认 name 字符串足够分类，认不出来的统一记 rename-failed。
    return {
      ok: false,
      reason: error?.name === 'SessionTitleInvalidError'
        ? TITLE_RESULT.INVALID_TITLE
        : TITLE_RESULT.RENAME_FAILED,
      error,
    }
  }
}

/** UTF-8 字节长度。仅用于日志提示「这个标题会被截」，不参与截断决策。 */
export function titleByteLength(title) {
  return Buffer.byteLength(String(title ?? ''), 'utf8')
}
