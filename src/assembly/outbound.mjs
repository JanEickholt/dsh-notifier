// dsh-notifier src/assembly/outbound.mjs
// 出站凭证 state overlay（从 src/index.mjs apply() 抽出，维护批 3 阶段 1）。
// 职责：admin.enabled 开启时，store 里每个非双域出站类型的 `<type>:account`
// （UI putChannel / 手写产物）与 YAML 行字段级合并——store 字段覆盖同名 YAML 字段
// （UI 改过的即为准）——重新过 adapter.resolve 后替换/追加 resolved.channels；
// admin 关闭时零执行——存量用户行为逐字节不变（§6 兼容红线）。
//
// 零配置首访（admin-zero-config-onboarding）：新增 admin 自有出站键
// `admin:channel:<type>:outbound`，overlay 读取优先级：新出站键 → 非双域类型的旧
// `<type>:account`（无 overlay 的类型保持主流程 resolve 产物，不在此重建）。
// 双域通道（feishu/dingtalk）的 `<type>:account` 键域归入站机器人凭证
// （v0.3.1 扫码落盘语义），不读出站；新出站键让 feishu/dingtalk 也能在网页
// 保存出站 webhook，不再要求改 YAML。
// 只读 store（无写副作用）；任何适配器 resolve 失败都只单选跳过/沿用，绝不弄崩装配。

import { ADAPTERS, resolveEnvRefs, CHANNEL_TYPES } from '../config.mjs'

export const DUAL_INBOUND_DOMAIN_TYPES = new Set(['feishu', 'dingtalk'])

/** store 账号防御读取：非普通对象（null/数组/标量/损坏）一律按无账号。 */
export function accountOf(store, key) {
  try {
    const value = store.get(key)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

/**
 * 读取某类型的出站 store overlay（按优先级）：新出站键 → 旧 `<type>:account`（非双域）。
 * 返回 null 表示无 store overlay——纯 YAML 类型不在此重建（装配主流程已 resolve 过，
 * 重过 adapter 只会变动对象同一性/补默认值，零收益且破坏「未触碰类型逐字节不变」）。
 * @param {object} store
 * @param {string} type
 * @returns {{ source: 'admin-outbound'|'legacy-account'|null, config: object|null }}
 */
function resolveOutboundConfig(store, type) {
  // 1. 新出站键（admin 自有域，最高优先级；双域类型同样适用——与入站键域分离）
  const adminOutbound = accountOf(store, `admin:channel:${type}:outbound`)
  if (adminOutbound !== null) return { source: 'admin-outbound', config: adminOutbound }
  // 2. 旧 `<type>:account`（仅非双域类型；双域的该键归入站凭证）
  if (!DUAL_INBOUND_DOMAIN_TYPES.has(type)) {
    const legacy = accountOf(store, `${type}:account`)
    if (legacy !== null) return { source: 'legacy-account', config: legacy }
  }
  return { source: null, config: null }
}

/**
 * 组装出站渠道（纯函数，无副作用）：
 * @param {{ channels: Array, yamlRows: Map<string, object>, store: object,
 *           adminEnabled: boolean, warn: (msg: string) => void }} deps
 * @returns {{ channels: Array, testRawConfigOf: (type: string) => object|null }}
 */
export function composeOutboundChannels({ channels, yamlRows, store, adminEnabled, warn }) {
  /** 连通性测试的 rawConfig（合并行优先，回落 YAML 行；ENV 引用由 runChannelTest 自行解析）。 */
  const makeTestRaw = (mergedRowOf) => (type) => {
    const row = mergedRowOf.get(type) ?? yamlRows.get(type)
    if (row === undefined) return null
    const { type: _drop, ...rest } = row
    return rest
  }
  // admin 关闭：零执行——channels 数组引用逐字节保持（apply() 原语义），无 merged 行
  if (adminEnabled !== true) return { channels, testRawConfigOf: makeTestRaw(new Map()) }

  const byType = new Map(channels.map((entry) => [entry.type, entry]))
  // type → 合并后的原始行（channelTest 的 rawConfig 来源）
  const mergedRowOf = new Map()
  for (const type of CHANNEL_TYPES) {
    const { source, config: overlayConfig } = resolveOutboundConfig(store, type)
    if (source === null || overlayConfig === null) continue
    const merged = { ...(yamlRows.get(type) ?? {}), ...overlayConfig, type }
    try {
      byType.set(type, { type, config: ADAPTERS[type].resolve(resolveEnvRefs(merged)) })
      mergedRowOf.set(type, merged)
    } catch (error) {
      // resolve 失败：YAML 条目原样保留（未破坏 byType），只记原因；store-only 类型即「暂不启用」
      const reason = error instanceof Error ? error.message : String(error)
      if (byType.has(type)) warn(`渠道 "${type}" state 凭证合并失败，沿用 YAML 配置: ${reason}`)
      else warn(`渠道 "${type}" 跳过（state 凭证不完整）: ${reason}`)
    }
  }
  return { channels: [...byType.values()], testRawConfigOf: makeTestRaw(mergedRowOf) }
}
