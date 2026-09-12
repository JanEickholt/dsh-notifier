// dsh-notifier strings.mjs
// 自动推送文案表：lang: 'zh'（默认）| 'en'。未知值一律回落 zh（安全配置的
// 非法值不配得到宽松解释，与 redaction 归一化同法）。
// 只覆盖插件自家文案（headline / 自有 detail / 状态正文模板）；助手摘录等
// 宿主数据片段不属于翻译范围（它们本就是会话语言）。

/** zh：与既有硬编码文案逐字节一致（默认路径零行为变化）。 */
const ZH = {
  turnStart: '🚀 任务开始',
  turnEndHeadline: {
    completed: '✅ 任务完成',
    error: '❌ 任务出错',
    blocked: '🚫 任务被阻塞',
    aborted: '⏹ 任务已中止',
    'max-tokens': '⚠️ 达到 Token 上限',
    interrupted: '⏸ 任务异常中断',
  },
  turnEndDetail: {
    error: '任务执行出错',
    blocked: '任务被阻塞，等待你处理',
    'max-tokens': '某一步骤达到输出 Token 上限',
    interrupted: '会话被异常中断，等待恢复',
  },
  approval: {
    headline: '🔐 需要你批准',
    toolName: (name) => `工具 ${name}`,
    toolFallback: '一个操作',
    reasonPrefix: '：',
    detail: (tool, reason) => `${tool} 需要授权${reason}`,
  },
  agentError: {
    headline: '❌ Agent 执行出错',
    detailFallback: 'agent 执行出错',
  },
  status: {
    longRunningHeadline: '⏱ 任务进行中',
    stallHeadline: '⚠️ 疑似卡住',
    runtimeLine: (elapsed, idle) => `已运行 ${elapsed}，最近活动 ${idle} 前`,
    stallHint: '长工具执行可能误报；可回复 /stop 取消，或调大 events.stall.afterMs',
    stopHint: '回复 /stop 取消',
    stopActionLabel: '⏹ 停止任务',
    recentOutputPrefix: '最近输出：',
  },
}

/** en：与 zh 同形状。 */
const EN = {
  turnStart: '🚀 Task started',
  turnEndHeadline: {
    completed: '✅ Task complete',
    error: '❌ Task failed',
    blocked: '🚫 Task blocked',
    aborted: '⏹ Task aborted',
    'max-tokens': '⚠️ Output token limit reached',
    interrupted: '⏸ Task interrupted',
  },
  turnEndDetail: {
    error: 'task execution failed',
    blocked: 'Task blocked, waiting for you',
    'max-tokens': 'A step hit its output token cap',
    interrupted: 'Session was interrupted abnormally, awaiting recovery',
  },
  approval: {
    headline: '🔐 Approval needed',
    toolName: (name) => `Tool ${name}`,
    toolFallback: 'An operation',
    reasonPrefix: ': ',
    detail: (tool, reason) => `${tool} needs your approval${reason}`,
  },
  agentError: {
    headline: '❌ Agent error',
    detailFallback: 'agent execution failed',
  },
  status: {
    longRunningHeadline: '⏱ Task still running',
    stallHeadline: '⚠️ Possibly stalled',
    runtimeLine: (elapsed, idle) => `Ran ${elapsed}, last activity ${idle} ago`,
    stallHint: 'Long tool call may be a false alarm; reply /stop to cancel, or raise events.stall.afterMs',
    stopHint: 'Reply /stop to cancel',
    stopActionLabel: '⏹ Stop task',
    recentOutputPrefix: 'Recent output: ',
  },
}

const TABLE = { zh: ZH, en: EN }

/** 按语言取文案表；未知/缺失回落 zh。own-property 校验：避免 `__proto__`/`constructor`
 *  等继承键命中 TABLE 原型链（CodeRabbit：返回非表对象会让格式化侧读出 undefined）。 */
export function stringsOf(lang) {
  return Object.prototype.hasOwnProperty.call(TABLE, lang) ? TABLE[lang] : ZH
}
