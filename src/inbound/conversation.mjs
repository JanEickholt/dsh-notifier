// dsh-notifier inbound/conversation.mjs
// 会话路由器（阶段 5 + v0.3.2 路由引擎）：手机回复 → 送进正在跑的 agent。
// 三个投递语义（对齐宿主 Agent API，见 docs/subsystems/core.md）：
//  - followup：agent 空闲 → 作为下一轮输入并唤醒（「任务做完了，再做一件」）
//  - inject：  agent 忙碌 → 排队到下一步边界，不唤醒不打断（排队补料）
//  - steer：   `!` 前缀 → 就近纠偏；空闲时等价 followup（「马上改，别跑偏」）
// 命令集：/help /status /bind <sessionId> /unbind /stop /agent [/agent use|back] /route
//         /quiet <workspace|sid> /unquiet <workspace|sid>（v0.5 特性 C：静默/恢复会话出站推送）
// v0.3.2 入站去向（注入 router 时，设计稿 §3）：
//   显式 bind > 通道默认 agent（workspace 多活跃会话投最近活跃 + 消歧回执）
//   > 唯一 agent 兜底 > 最近活跃（现状）。router 缺省时保持 v0.3.1 旧行为（bind > latest）。
// 军规：入站文本只能以 plugin 来源进会话流（source.kind = 'plugin'），永不直接执行 shell；
// 任何投递异常只回执用户，绝不弄崩宿主。

import { randomUUID } from 'node:crypto'
import { stringsOf } from '../strings.mjs'
import { workspaceOf } from '../routing/session-registry.mjs'
import { CHANNEL_TYPES } from '../config.mjs'
import { chatScopeOf } from '../control/session-arbiter.mjs'
import { bindingKey as identityBindingKey } from './identity.mjs'
import { MESSAGE_PRIORITY } from './bus.mjs'

const DEFAULT_MERGE_WINDOW_MS = 1500
const SUMMARY_MAX_CHARS = 120

// 入站解析来源层的展示标签随 lang 在使用点解析（t.inboundSourceLabels，与
// agent-router 的 source 值一一对应）。

/** 组装宿主 UserMessage（source.kind = 'plugin'，与 call-me 同构）。 */
function buildUserMessage(text, plugin = 'dsh-notifier') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'notice', summary: String(text).slice(0, SUMMARY_MAX_CHARS) },
  }
}

/** zh 兜底（strings 未注入时的回落）：单一事实源 = stringsOf().conversation（无内联副本）。 */
const ZH_FALLBACK = stringsOf().conversation

/**
 * 注册会话路由器。
 * @param {object} deps
 * @param {object} deps.ctx - cordis 上下文（ctx.agents / ctx.on）
 * @param {ReturnType<typeof import('./bus.mjs').createInboundBus>} deps.bus
 * @param {import('./store.mjs').store} deps.store - 绑定关系持久化（bind:<channel>:<userId> → sessionId）
 * @param {(channel: string, chatId: string, text: string) => void} [deps.reply] - 回执通道（命令反馈）
 * @param {object} [deps.config] - { mergeWindowMs?, steerPrefix? }
 * @param {object} [deps.logger]
 * @param {ReturnType<typeof import('../routing/agent-router.mjs').createAgentRouter>} [deps.router]
 *   - v0.3.2 入站解析链（bind > 通道默认 > 单 agent > 最近活跃）；缺省回落旧行为
 * @param {ReturnType<typeof import('../routing/session-registry.mjs').createSessionRegistry>} [deps.registry]
 *   - 会话台账（/agent 命令族数据源、活跃信号 touch、入站对话挂钩维护）；缺省时命令族降级提示
 * @param {() => string[]} [deps.channelTypes] - 全局已启用渠道类型（v0.3.2 出站解析的兜底池
 *   与过滤白名单）；缺省回落 config.mjs 的 CHANNEL_TYPES 全量（乐观池）
 * @param {object} [strings] - stringsOf(lang) 全文案表（本函数读 conversation 节；
 *   缺省回落 ZH_FALLBACK）。装配层注入 stringsOf(config.lang) 全表；缺省路径输出与既有硬编码逐字节一致。
 * @returns {() => void} 反注册函数
 */
export function registerConversationRouter(deps, strings) {
  const { ctx, bus, store } = deps
  const t = strings?.conversation ?? ZH_FALLBACK
  const reply = typeof deps.reply === 'function' ? deps.reply : () => {}
  const cfg = deps.config ?? {}
  const router = deps.router ?? null
  const registry = deps.registry ?? null
  const control = deps.control ?? null
  // mergeWindowMs 归一：undefined/null → 默认；0 合法（README 承诺「0 = 关闭合并」，立即投递）；
  // 非数字/NaN → 默认；负数 → 0（Math.max 兜底）。注意不能用 `Number(x) || 默认`——那会把
  // 显式 0 当 falsy 回落 1500，使下方 `mergeWindowMs === 0` 的立即投递分支永不可达（v0.3.2 审查修复）。
  const mergeWindowRaw = cfg.mergeWindowMs
  const mergeWindowNumber = Number(mergeWindowRaw)
  const mergeWindowMs = mergeWindowRaw === undefined || mergeWindowRaw === null || !Number.isFinite(mergeWindowNumber)
    ? DEFAULT_MERGE_WINDOW_MS
    : Math.max(0, mergeWindowNumber)
  const steerPrefix = typeof cfg.steerPrefix === 'string' && cfg.steerPrefix.length > 0 ? cfg.steerPrefix : '!'
  const warn = (message) => {
    try { deps.logger?.warn?.('[dsh-notifier/conversation]', message) } catch { /* 日志失败绝不致命 */ }
    // v0.6.1 双写 stderr：宿主 logger 不落 stdout 时告警仍可见（真机事故复盘）
    try { console.error('[dsh-notifier/conversation]', message) } catch { /* 控制台不可用不致命 */ }
  }

  // 全局渠道池（v0.3.2 出站解析的兜底池 + 过滤白名单）。缺省回落 config 的全量渠道类型
  // （乐观池：装配层不注入时宁可多列也不漏，resolveOutbound 自带「全局池内存在」过滤）。
  const channelTypesFn = typeof deps.channelTypes === 'function' ? deps.channelTypes : () => CHANNEL_TYPES
  /** 防御：注入函数抛错 / 返回非数组 → []（绝不弄崩命令族）。 */
  const globalTypes = () => {
    try {
      const list = channelTypesFn()
      return Array.isArray(list) ? list.filter((type) => typeof type === 'string' && type !== '') : []
    } catch { return [] }
  }

  // 最近活跃的根 agent：未显式 /bind 时的默认投递目标
  let latestSessionId = null
  const disposers = []

  const agentsOf = () => {
    try { return typeof ctx?.agents?.list === 'function' ? ctx.agents.list() : [] } catch { return [] }
  }
  const agentOf = (sessionId) => {
    try { return typeof ctx?.agents?.get === 'function' ? ctx.agents.get(sessionId) : undefined } catch { return undefined }
  }
  // G-49：会话绑定持久化键。分量归一收敛到 identity.bindingKey（trim + channel 小写），
  // 与 agent-router resolveInbound L1 的读键同源——' user ' 与 'user' 写读同键永不裂
  // （休眠边界封口：现网适配器输出恰好归一，此改不改变现网行为）。
  const bindingKey = (envelope) => `bind:${identityBindingKey(envelope.channel, envelope.userId)}`

  // ---- v0.3.2 命令族支撑（军规：registry/router 任何缺失或抛错一律降级，绝不弄崩投递主线）----

  /** registry 方法防御壳：缺实例 / 缺方法 / 抛错 → undefined（调用方各自兜底）。 */
  const registryCall = (method, ...args) => {
    try {
      if (registry === null || typeof registry[method] !== 'function') return undefined
      return registry[method](...args)
    } catch (error) {
      warn(`registry.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  /** router 方法防御壳：同上。 */
  const routerCall = (method, ...args) => {
    try {
      if (router === null || typeof router[method] !== 'function') return undefined
      return router[method](...args)
    } catch (error) {
      warn(`router.${method} 调用失败（已降级）: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 会话的 workspace 名：registry 台账快照优先，缺档回落宿主 agent 的 cwd 末段。 */
  const workspaceOfSid = (sessionId) => {
    const record = registryCall('getSession', sessionId)
    if (typeof record?.workspace === 'string' && record.workspace !== '') return record.workspace
    const agent = agentOf(sessionId)
    return agent !== undefined ? workspaceOf(agent) : ''
  }

  /**
   * 当前对话的入站挂钩（与 bind:<channel>:<userId> 键同源，registry.attach/detach 用）。
   * G-49：分量归一镜像 identity.bindingKey 的规则（channel trim + 小写、userId trim）——
   * attach 与 detach 的分量必落在同一身份上，' user ' 与 'user' 同挂钩（否则覆盖绑定/
   * 解绑时摘不掉自己挂上的钩）。不从复合键反切分量（userId 可含冒号，反切会截断），
   * 规则漂移由 test/conversation.route.test.mjs 的 G-49 全链路用例锁死。
   */
  const inboundBindingOf = (envelope) => ({
    channel: String(envelope.channel ?? '').trim().toLowerCase(),
    userId: String(envelope.userId ?? '').trim(),
  })

  /**
   * 活跃会话快照（/agent 列表与 /agent use 的数据源）。registry 注入时用台账
   * （activeSessions 已按 lastActiveAt 降序）；缺省降级宿主 ctx.agents.list()
   * + workspaceOf(agent)（无活跃信号，排序退化为宿主列表顺序）。
   * @returns {{ infos: Array<{id: string, workspace: string}>, activitySorted: boolean }}
   */
  const activeSessionInfos = () => {
    if (registry !== null) {
      const ids = registryCall('activeSessions')
      if (Array.isArray(ids)) {
        return {
          infos: ids
            .filter((id) => typeof id === 'string' && id !== '')
            .map((id) => ({ id, workspace: workspaceOfSid(id) })),
          activitySorted: true,
        }
      }
    }
    return { infos: agentsOf().map((agent) => ({ id: agent.id, workspace: workspaceOf(agent) })), activitySorted: false }
  }

  /** 候选中取最近活跃者（§0.5-4「投最近活跃」）：台账有序直取首位，无信号时取末位启发式。 */
  const pickLatest = (infos, activitySorted) => {
    if (infos.length === 0) return null
    if (activitySorted) return infos[0].id
    const best = registryCall('latestActiveOf', infos.map((info) => info.id))
    if (typeof best === 'string' && best !== '') return best
    return infos[infos.length - 1].id // 无活跃信号：取列表末位（最近创建）启发式
  }

  /**
   * 入站去向解析（v0.3.2 §3 四层链）。router 注入时走完整链（L1 bind 读同一 store 键，
   * 行为与旧 boundSession 等价）；未注入时回落 v0.3.1 旧行为。解析异常回落旧链（绝不弄崩投递）。
   * @returns {{ sessionId: string|null, source: string, ambiguous: boolean, candidates?: string[] }}
   */
  const resolveTarget = (envelope) => {
    if (router !== null) {
      try {
        return router.resolveInbound(envelope.channel, String(envelope.userId ?? ''), { latestSessionId })
      } catch (error) {
        warn(`入站路由解析失败，回落默认链: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const bound = store.get(bindingKey(envelope))
    if (typeof bound === 'string' && bound !== '') return { sessionId: bound, source: 'bind', ambiguous: false }
    return { sessionId: latestSessionId, source: 'latest', ambiguous: false }
  }
  // 旧名兼容（/status 等沿用）
  const boundSession = (envelope) => resolveTarget(envelope).sessionId

  function handleCommand(envelope, text) {
    const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/)
    const cmd = rawCmd.toLowerCase()
    const say = (message) => reply(envelope.channel, envelope.chatId, message)
    if (cmd === 'help') {
      say(t.helpLines.join('\n'))
      return true
    }
    if (cmd === 'status') {
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      say([
        `${t.statusBindLabel}${store.get(bindingKey(envelope)) ?? t.bindUnset}`,
        `${t.statusTargetLabel}${bound ?? t.targetUnset}`,
        `${t.statusStateLabel}${agent !== undefined ? agent.status : t.statusNotFound}`,
        `${t.activeSessionsLabel}${agentsOf().map((agent) => `${agent.id}(${agent.status})`).join(t.joiner) || t.activeSessionsNone}`,
      ].join('\n'))
      return true
    }
    if (cmd === 'bind') {
      const target = args[0]
      if (target === undefined || target === '') {
        say(t.bindUsage)
        return true
      }
      if (agentOf(target) === undefined) {
        say(t.bindMissingSession(target))
        return true
      }
      // G-48：覆盖绑定先摘旧会话的入站挂钩。否则 store 换了目标，registry 反查表里同一
      // (channel,userId) 却同时挂在旧 sid 与新 sid 上（一 user 双挂）——旧会话看似仍
      // 挂着本对话，/route 与管理台会话视图永久失真。旧值 === 新目标时跳过（幂等重绑
      // 不做摘挂写放大）；旧值缺失（首绑）无钩可摘。registry.detachInbound 幂等：旧 sid
      // 无记录/无该挂钩时安全无操作，不抛。
      const previous = store.get(bindingKey(envelope))
      store.set(bindingKey(envelope), target)
      if (typeof previous === 'string' && previous !== '' && previous !== target) {
        registryCall('detachInbound', previous, inboundBindingOf(envelope))
      }
      // v0.3.2：同步维护台账入站挂钩与活跃信号（防御壳内降级，不影响绑定本身）
      registryCall('attachInbound', target, inboundBindingOf(envelope))
      registryCall('touch', target)
      say(t.boundReceipt(target))
      return true
    }
    if (cmd === 'unbind') {
      // 先读旧值再删：detachInbound 需要旧 sid 才能摘掉台账上的入站挂钩
      const key = bindingKey(envelope)
      const old = store.get(key)
      store.delete(key)
      if (typeof old === 'string' && old !== '') {
        registryCall('detachInbound', old, inboundBindingOf(envelope))
      }
      say(t.unboundReceipt)
      return true
    }
    if (cmd === 'stop' && args.length === 0) {
      // G-04：/stop 是无参命令——只有裸 '/stop' 命中取消。带附言的 '/stop 一下别急'
      // 不再命中（收紧前 startsWith('/stop ') 会把它当取消指令，误杀长任务），
      // 落到函数尾部的未知命令路径：回执「未识别的命令」+ 按普通文本投递。
      const bound = boundSession(envelope)
      const agent = bound !== null ? agentOf(bound) : undefined
      if (agent === undefined) { say(t.stopNone); return true }
      try {
        agent.cancel('remote-stop')
        say(t.stopRequested(bound))
      } catch (error) {
        warn(`/stop 失败: ${error instanceof Error ? error.message : String(error)}`)
        say(t.stopFailed)
      }
      return true
    }
    // ---- v0.3.2 会话路由命令族（设计稿 §4）：/agent [use|back] 与 /route ----
    if (cmd === 'agent') {
      const sub = String(args[0] ?? '').toLowerCase()
      if (sub === 'use') {
        // G-33：目标名可含空格（workspace 名如 "my space"）——args[1] 只取首词会截断，
        // 改为剩余参数整体作为 needle（matchSessionByNeedle 做精确/前缀匹配，本身 trim）。
        handleAgentUse(envelope, args.slice(1).join(' '), say)
        return true
      }
      if (sub === 'back') {
        handleAgentBack(envelope, say)
        return true
      }
      if (sub === '') {
        say(renderAgentList())
        return true
      }
      say(t.agentUsage)
      return true
    }
    if (cmd === 'route') {
      if (router === null) {
        say(t.routeUnavailable)
        return true
      }
      say(renderRoute(envelope))
      return true
    }
    // ---- v0.5 特性 C：/quiet /unquiet（设计稿 §4，目标解析复用 /agent use 智能匹配）----
    if (cmd === 'quiet' || cmd === 'unquiet') {
      const quiet = cmd === 'quiet'
      if (router === null) {
        say(t.quietUnavailable)
        return true
      }
      const target = args[0]
      if (typeof target !== 'string' || target.trim() === '') {
        say(t.quietUsage(cmd))
        return true
      }
      const matched = matchSessionByNeedle(target.trim())
      if (matched.sid === null) { say(matched.message); return true }
      const ok = routerCall('setSessionOutbound', matched.sid, { quiet })
      if (ok !== true) {
        say(t.quietWriteFailed(cmd))
        return true
      }
      const workspace = workspaceOfSid(matched.sid)
      const label = workspace === '' ? t.unknownWorkspace : workspace
      say([
        t.quietReceipt(quiet ? t.quietMarkMuted : t.quietMarkResumed, label, matched.sid, matched.matchedBy),
        quiet ? t.quietHint : '',
      ].filter((line) => line !== '').join('\n'))
      return true
    }
    // G-04：未知命令回执。/stop 收紧为仅裸 '/stop' 命中取消后，'/stop 等等' 这类带
    // 附言形态落到此路径——若只静默按普通文本投递，用户会误以为命令已被执行（回执黑洞）。
    // 回执仅告知未识别，「当普通文本处理（避免吞消息）」的既有语义保持不变
    // （若下方投递失败，routeUnsafe 还会另有回执）。
    say(t.unknownCommand(cmd))
    return false // 未知命令：当普通文本处理（避免吞消息）
  }

  /**
   * /agent 无参：活跃会话分组视图（设计稿 §4）。每行
   * 「workspace | sid（8 位前缀）| 状态 | 出站通道集合 | quiet 标记」，按 workspace 聚合、
   * 组内保持活跃降序。数据源 registry.activeSessions() + agentOf(id).status +
   * router.resolveOutbound(sid, workspace, globalTypes())；registry 缺省降级宿主 agent 列表；
   * router 缺省整体降级提示（出站集合无从解析）。
   */
  function renderAgentList() {
    if (router === null) {
      return t.agentListUnavailable
    }
    const { infos } = activeSessionInfos()
    const lines = [t.agentListHeader]
    if (registry === null) {
      lines.push(t.agentListDegraded)
    }
    if (infos.length === 0) {
      lines.push(t.agentListEmpty)
    }
    const groups = new Map() // workspace -> 该组行（保持活跃降序；组顺序 = 最近活跃组的 workspace 在前）
    for (const info of infos) {
      const key = info.workspace === '' ? t.unknownWorkspace : info.workspace
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(info)
    }
    for (const [workspace, rows] of groups) {
      for (const info of rows) {
        const status = agentOf(info.id)?.status ?? t.statusUnknown
        const outbound = routerCall('resolveOutbound', info.id, info.workspace, globalTypes())
        const channels = outbound !== undefined && Array.isArray(outbound.channelTypes)
          ? `[${outbound.channelTypes.join(', ')}]`
          : t.outboundUnavailable
        const quiet = outbound?.quiet === true ? 'quiet' : '-'
        lines.push(`  ${workspace} | ${info.id.slice(0, 8)} | ${status} | ${channels} | ${quiet}`)
      }
    }
    lines.push(t.agentListFooter)
    return lines.join('\n')
  }

  /**
   * 目标智能匹配（§0.5-5 解析顺序，/agent use 与 v0.5 /quiet|/unquiet 共用）：
   * workspace 名精确匹配（该 workspace 活跃会话取最近活跃者）> sessionId 精确 >
   * sid 前缀（≥4 位：唯一命中 / 多命中列候选 / 零命中提示）。
   * @param {string} needle - 用户输入的目标串。
   * @returns {{ sid: string, matchedBy: string } | { sid: null, message: string }}
   */
  const matchSessionByNeedle = (needle) => {
    const { infos, activitySorted } = activeSessionInfos()
    const ofWorkspace = infos.filter((info) => info.workspace !== '' && info.workspace === needle)
    if (ofWorkspace.length > 0) {
      const sid = pickLatest(ofWorkspace, activitySorted) // 同 workspace 多活跃会话 → 最近活跃者（§0.5-4）
      if (sid !== null) return { sid, matchedBy: t.matchedByWorkspace(needle) }
    }
    if (infos.some((info) => info.id === needle)) return { sid: needle, matchedBy: t.matchedBySessionId }
    if (needle.length >= 4) {
      const hits = infos.filter((info) => info.id.startsWith(needle)).map((info) => info.id)
      if (hits.length === 1) return { sid: hits[0], matchedBy: t.matchedBySidPrefix }
      if (hits.length > 1) {
        return {
          sid: null,
          message: [
            t.prefixAmbiguous(needle, hits.length),
            ...hits.map((id) => `  ${id}`),
            t.prefixHint,
          ].join('\n'),
        }
      }
    }
    return { sid: null, message: t.noMatch(needle) }
  }

  /**
   * /agent use <target>：智能绑定（§0.5-5 解析顺序，匹配逻辑见 matchSessionByNeedle）。
   * 成功后 store 写 bind 键 + 摘旧会话挂钩（G-48，覆盖绑定防双挂）+ registry.attachInbound
   * + touch，回执确认 workspace 与 sid。
   */
  function handleAgentUse(envelope, target, say) {
    if (typeof target !== 'string' || target.trim() === '') {
      say(t.agentUseUsage)
      return
    }
    const matched = matchSessionByNeedle(target.trim())
    if (matched.sid === null) { say(matched.message); return }
    const sid = matched.sid
    const workspace = workspaceOfSid(sid)
    // G-48：同 /bind——覆盖绑定先摘旧会话挂钩（防一 user 双挂；旧值 === 新目标跳过）
    const previous = store.get(bindingKey(envelope))
    store.set(bindingKey(envelope), sid)
    if (typeof previous === 'string' && previous !== '' && previous !== sid) {
      registryCall('detachInbound', previous, inboundBindingOf(envelope))
    }
    registryCall('attachInbound', sid, inboundBindingOf(envelope))
    registryCall('touch', sid)
    say(t.agentUseBound(workspace === '' ? t.unknownWorkspace : workspace, sid, matched.matchedBy))
  }

  /** /agent back：读旧绑定 → 删 bind 键 + registry.detachInbound，回到通道默认路由。 */
  function handleAgentBack(envelope, say) {
    const key = bindingKey(envelope)
    const old = store.get(key)
    if (typeof old === 'string' && old !== '') {
      store.delete(key)
      registryCall('detachInbound', old, inboundBindingOf(envelope))
      say(t.agentBackBound(old))
    } else {
      say(t.agentBackUnbound)
    }
  }

  /**
   * /route：双向解析展示（排障用，§4）。出站段 = router.describe(当前解析到的 sid,
   * workspace, globalTypes()) 逐层来源（sid 为空时提示当前无目标会话）；入站段 =
   * resolveTarget 的来源层标签 + 目标 sid + ambiguous 标记 + getChannelDefault(channel)。
   */
  function renderRoute(envelope) {
    const resolved = resolveTarget(envelope)
    const sid = resolved.sessionId
    const lines = [t.routeOutboundHeader]
    if (sid === null) {
      lines.push(t.routeNoTarget)
    } else {
      const described = routerCall('describe', sid, workspaceOfSid(sid), globalTypes())
      for (const line of String(described ?? '').split('\n')) lines.push(`  ${line}`)
    }
    lines.push('', t.routeInboundHeader)
    lines.push(t.routeSourceLine(t.inboundSourceLabels?.[resolved.source] ?? String(resolved.source)))
    lines.push(t.routeTargetLine(sid))
    lines.push(t.routeAmbiguousLine(resolved.ambiguous))
    if (resolved.ambiguous && Array.isArray(resolved.candidates) && resolved.candidates.length > 0) {
      lines.push(t.routeCandidatesLine(resolved.candidates.join(t.joiner)))
    }
    const channelDefault = routerCall('getChannelDefault', envelope.channel)
    lines.push(t.routeChannelDefaultLine(envelope.channel, channelDefault))
    return lines.join('\n')
  }

  /** 投递语义路由：! 前缀 steer；忙碌 inject；空闲 followup。 */
  function deliver(agent, text) {
    const wantsSteer = text.startsWith(steerPrefix)
    const body = (wantsSteer ? text.slice(steerPrefix.length) : text).trim()
    if (body === '') return 'empty'
    const payload = buildUserMessage(body)
    try {
      if (wantsSteer) {
        agent.steer(payload) // 空闲时宿主内部等价 followup
        return 'steer'
      }
      if (agent.status === 'running') {
        agent.inject(payload) // 忙碌：排队到下一步边界，不打断
        return 'inject'
      }
      agent.followup(payload) // 空闲：唤醒新 turn
      return 'followup'
    } catch (error) {
      warn(`投递失败: ${error instanceof Error ? error.message : String(error)}`)
      return 'error'
    }
  }

  // 合并窗：手机上打长句常拆多条；窗口内的连续消息合并为一条再投递。
  // `..` 结尾立即冲刷；`!!` 结尾立即冲刷并按 steer 投递。
  // G-51：键必须带 chatId 维度——`${channel}:${userId}:${String(chatId ?? '')}`。
  // 旧键 `${channel}:${userId}` 把同一用户「私聊 + 群」两个 chat 的碎片并进同一条合并线：
  // 私聊窗的半句被群窗的 terminator 顺手冲掉，或两个 chat 的碎片交叉拼接成一条混合投递
  // （跨 chat 串台）。加维度后：同 channel:userId:chatId 内照旧合并；同用户私聊 + 群
  // = 两条独立合并线、各自投递、回执回各自 chat。
  //   - chatId 缺失（undefined/null）→ String(chatId ?? '') = ''，仍聚合进同一 '' 维度
  //     （现状语义保持：无 chat 概念的适配器不会因本修裂窗）；
  //   - '' 与任何显式 chatId 是不同维度（缺维度的碎片不会并进显式 chat 的窗）。
  // 改这行键时三个分量一个都不能删：去 chatId 复活跨 chat 串台，去 userId 跨用户串台，
  // 去 channel 跨渠道串台。timer 回调闭包持有的就是设置它的那个 envelope，flush 用同一
  // 键函数反查，绝不找错窗。
  const pending = new Map() // `${channel}:${userId}:${String(chatId ?? '')}` -> { parts, timer, forceSteer }
  const mergeWindowKeyOf = (envelope) =>
    `${envelope.channel}:${envelope.userId}:${String(envelope.chatId ?? '')}`
  function flush(envelope) {
    const key = mergeWindowKeyOf(envelope)
    const entry = pending.get(key)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    pending.delete(key)
    const text = entry.parts.join('\n').trim()
    if (text === '') return
    const merged = entry.forceSteer ? `${steerPrefix}${text}` : text
    route(envelope, merged)
  }
  function routeUnsafe(envelope, text) {
    if (text.startsWith('/')) {
      if (handleCommand(envelope, text)) return
    }
    // 完整解析结果（非仅 sid）：ambiguous 时投递后要回执消歧提示（§0.5-4）
    const resolved = resolveTarget(envelope)
    const bound = resolved.sessionId
    if (bound === null) {
      reply(envelope.channel, envelope.chatId, t.noActiveSession)
      return
    }
    const agent = agentOf(bound)
    if (agent === undefined) {
      reply(envelope.channel, envelope.chatId, t.sessionGone(bound))
      return
    }
    const outcome = deliver(agent, text)
    if (outcome === 'error') {
      reply(envelope.channel, envelope.chatId, t.deliverFailed)
    } else if (outcome === 'empty') {
      // 空文本（如只有 !）：静默忽略
    } else {
      // 投递成功：刷新活跃信号（「投最近活跃」消歧的数据来源，§0.5-4；防御壳内降级）
      registryCall('touch', bound)
      if (resolved.ambiguous === true) {
        const count = Array.isArray(resolved.candidates) ? resolved.candidates.length : 1
        reply(envelope.channel, envelope.chatId, t.deliveredAmbiguous(bound, count))
      }
    }
  }

  // Control Core gate for session-affecting inbound text. Ordinary outbound
  // notifications never pass here; only remote control/conversation commands do.
  function route(envelope, text) {
    const trimmed = String(text ?? '').trim()
    // G-04：仅裸 '/stop' 归类为 stop 控制命令。'/stop 等等' 不再命中（旧 startsWith('/stop ')
    // 会把附言形态也送进 Control Core 当取消指令，误杀长任务），改走未知命令路径。
    const command = trimmed === '/stop' ? 'stop'
      : (trimmed.startsWith(steerPrefix) ? 'steer' : (trimmed.startsWith('/') ? null : 'ordinary-message'))
    if (control === null || command === null) return routeUnsafe(envelope, text)
    // QQ group/ambiguous envelopes must not fall through to the legacy route
    // when no session is resolved; consume with a receipt instead.
    if (String(envelope.channel ?? '').toLowerCase() === 'qq' && chatScopeOf(envelope) !== 'private') {
      reply(envelope.channel, envelope.chatId, chatScopeOf(envelope) === 'group'
        ? t.groupControlDenied
        : t.controlSourceUnverified)
      return
    }
    const target = resolveTarget(envelope)
    if (target.sessionId === null) return routeUnsafe(envelope, text)
    const receipt = control.handle({
      eventId: String(envelope.messageId ?? ''),
      command,
      channel: envelope.channel,
      // v0.8.7：绝不把 channel 当 accountId 兜底（硬性规则）。accountId 缺失时这里得到空串，
      // normalizeControlEvent 会以 missing_accountId fail-closed 拒绝——来源必须真实存在。
      accountId: String(envelope.accountId ?? ''),
      userId: String(envelope.userId ?? ''),
      chatId: String(envelope.chatId ?? ''),
      chatType: envelope.chatType,
      sessionId: String(target.sessionId),
      policyVersion: '1',
      pending: { status: 'pending', sessionId: String(target.sessionId), createdAt: Date.now() - 1, expiresAt: Date.now() + 10 * 60 * 1000 },
      settle: () => { routeUnsafe(envelope, text); return true },
    })
    if (receipt.status === 'accepted') return
    if (receipt.reason === 'conversation_disabled') reply(envelope.channel, envelope.chatId, t.conversationDisabled)
    else if (receipt.reason === 'group_chat_disabled') reply(envelope.channel, envelope.chatId, t.groupControlDenied)
    else if (receipt.reason === 'not_paired') reply(envelope.channel, envelope.chatId, t.notPaired)
    else reply(envelope.channel, envelope.chatId, t.controlRejected)
  }

  // G-31：会话路由是消费链末位兜底（priority 100）——前面审批/提问未消费的消息才进 agent 会话。
  const disposeMessage = bus.onMessage((envelope) => {
    const text = String(envelope.text ?? '').trim()
    if (text === '') return
    // 命令不进合并窗：立即处理
    if (text.startsWith('/')) {
      route(envelope, text)
      return
    }
    const key = mergeWindowKeyOf(envelope) // G-51：与 flush 同一键（含 chatId 维度）
    if (text.endsWith('..') || text.endsWith('!!')) {
      // 终止符：先并入再立即冲刷（!! 追加 steer 前缀）
      const entry = pending.get(key) ?? { parts: [], timer: null, forceSteer: false }
      entry.parts.push(text.slice(0, -2).trim())
      entry.forceSteer = entry.forceSteer || text.endsWith('!!')
      pending.set(key, entry)
      flush(envelope)
      return
    }
    if (mergeWindowMs === 0) {
      route(envelope, text)
      return
    }
    const entry = pending.get(key)
    if (entry !== undefined) {
      entry.parts.push(text)
      clearTimeout(entry.timer)
      entry.timer = setTimeout(() => flush(envelope), mergeWindowMs)
      return
    }
    pending.set(key, {
      parts: [text],
      timer: setTimeout(() => flush(envelope), mergeWindowMs),
      forceSteer: false,
    })
  }, { priority: MESSAGE_PRIORITY.conversation })

  // 追踪最近活跃 agent（默认投递目标）；agent 退出时清理绑定与合并窗。
  // v0.7.3（#4）：DSH 的 agent/created | agent/disposed 事件签名是 (payload: { agent })，
  // 监听器收到的是载荷对象而非 agent 本身——旧代码 agent?.id 恒 undefined，
  // latestSessionId 永不赋值，未 /bind 用户的文本消息全部走到「没有活跃会话」被拒投
  // （现象：命令能回、文本全丢）。此处解包 payload.agent（兼容直接传 agent 的旧宿主）。
  const payloadAgent = (arg) => {
    const agent = arg?.agent ?? arg
    return (agent !== null && typeof agent === 'object' && agent.id !== undefined) ? agent : null
  }
  // 只追踪根 agent：后台 subagent 同样触发 agent/created，若不滤掉会把投递目标
  // 劫持到 subagent 会话。宿主暴露 ctx.agents.roots() 时用它判定；老宿主无此 API
  // 则退化为全量追踪（与修复前行为一致，仅解包修复生效）。
  const rootIds = () => {
    try {
      const roots = ctx?.agents?.roots?.()
      return (roots !== null && typeof roots === 'object') ? roots : null
    } catch { return null }
  }
  const trackAgent = (payload) => {
    const agent = payloadAgent(payload)
    if (agent === null) return
    const roots = rootIds()
    if (roots !== null) {
      const ids = (Array.isArray(roots) ? roots : Object.values(roots)).map((a) => a?.id)
      if (!ids.includes(agent.id)) return // subagent：不劫持默认投递目标
    }
    latestSessionId = agent.id
  }
  try {
    disposers.push(ctx.on('agent/created', trackAgent))
  } catch { /* 宿主无此事件：默认绑定不可用，仍可 /bind */ }
  try {
    disposers.push(ctx.on('agent/disposed', (payload) => {
      const agent = payloadAgent(payload)
      if (agent !== null && agent.id === latestSessionId) latestSessionId = null
      // 显式绑定到该 agent 的用户下次投递会收到「会话不存在」回执并自行 /bind，
      // 不在此清绑定：store 里的绑定在 agent 重启（同 id resume）后仍然有效。
    }))
  } catch { /* 同上 */ }

  return () => {
    disposeMessage?.()
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 反注册失败不致命 */ }
    }
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
  }
}
