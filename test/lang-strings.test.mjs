import test from 'node:test'
import assert from 'node:assert/strict'
import { stringsOf } from '../src/strings.mjs'
import { resolveConfig } from '../src/config.mjs'
import { intentOfSessionEvent, intentOfAgentError, intentToMessage } from '../src/event-listener.mjs'

test('stringsOf: 未知语言回落 zh，且 zh 为默认', () => {
  assert.equal(stringsOf('en'), stringsOf('en'))
  assert.equal(stringsOf('weird'), stringsOf('zh'))
  assert.equal(stringsOf(undefined), stringsOf('zh'))
})

test('resolveConfig: lang 归一化 — en 保留，未知回落 zh', () => {
  assert.equal(resolveConfig({ lang: 'en' }).lang, 'en')
  assert.equal(resolveConfig({ lang: 'fr' }).lang, 'zh')
  assert.equal(resolveConfig({}).lang, 'zh')
  assert.equal(resolveConfig(null).lang, 'zh')
})

test('intentOfSessionEvent: 默认（zh）文案与既有硬编码逐字节一致', () => {
  const ok = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(ok.headline, '✅ 任务完成')
  const approval = intentOfSessionEvent({ type: 'approval/asked', data: { toolName: 'email_send', reason: '给 x@y.z 发邮件' } })
  assert.equal(approval.detail, '工具 email_send 需要授权：给 x@y.z 发邮件')
})

test('intentOfSessionEvent: lang en — headline/detail 级别不变仅文案切换', () => {
  const strings = stringsOf('en')
  const ok = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, strings)
  assert.equal(ok.headline, '✅ Task complete')
  assert.equal(ok.level, 'active')
  const blocked = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'blocked' } } }, strings)
  assert.equal(blocked.headline, '🚫 Task blocked')
  assert.equal(blocked.detail, 'Task blocked, waiting for you')
  const approval = intentOfSessionEvent({ type: 'approval/asked', data: { toolName: 'email_send', reason: 'send mail' } }, strings)
  assert.equal(approval.headline, '🔐 Approval needed')
  assert.equal(approval.detail, 'Tool email_send needs your approval: send mail')
  assert.equal(intentOfSessionEvent({ type: 'turn/start' }, strings).headline, '🚀 Task started')
})

test('intentOfAgentError: lang en — 错误原文不翻译，仅 fallback/headline 切换', () => {
  const strings = stringsOf('en')
  assert.equal(intentOfAgentError({}, strings).headline, '❌ Agent error')
  assert.equal(intentOfAgentError({}, strings).detail, 'agent execution failed')
  assert.equal(intentOfAgentError({ error: new Error('boom') }, strings).detail, 'boom')
})

test('intentToMessage: en 标题套 titlePrefix 与钳制不变', () => {
  const strings = stringsOf('en')
  const intent = intentOfSessionEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, strings)
  const message = intentToMessage(intent, { assistantText: 'done', config: { titlePrefix: '[DSH]', summaryMaxChars: 500, lang: 'en' } })
  assert.equal(message.title, '[DSH] ✅ Task complete')
  assert.equal(message.level, 'active')
})
