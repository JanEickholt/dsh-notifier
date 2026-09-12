// dsh-notifier src/admin/ui.mjs
// 管理台单文件内嵌 HTML 组合器：零构建、无 CDN、离线可用，由 src/admin/server.mjs 以
// 200 text/html 原样返回本串；无任何外部资源引用（无外链脚本 / link / CSS url()），系统字体栈。
//
// 源码按职责拆为三个分片（本文件只做组合，勿在此写具体样式/结构/逻辑）：
//  - ui/theme.mjs  → ADMIN_UI_CSS     「宿主对齐·蓝白」视觉语言（白面板 + #f5f6f7 底 + DeepSeek Blue 主色）
//  - ui/markup.mjs → ADMIN_UI_MARKUP  页面骨架：解锁门 / 首访三步向导 / 首页 / 渠道 / 成员 / 通知 / 高级
//  - ui/client.mjs → ADMIN_UI_JS      浏览器端逻辑：fragment 启动凭证、站内解锁门、向导、SSE、全部面板交互
//
// 鉴权契约（Issue #13 重构后）：URL 仅在 fragment 携带启动 token（/#token=...），验证成功后
// 清地址栏 fragment 并只写 sessionStorage（禁止 localStorage）；无 token → 站内解锁门，绝不弹
// window.prompt；401 → 清 token 回解锁门，单飞询问不重试风暴。
// 组合约束：内嵌脚本正文不得含 "</script" 序列；测试以最后一个 "<script>" 与首个 "</script>" 切取脚本。
import { ADMIN_UI_CSS } from './ui/theme.mjs'
import { ADMIN_UI_MARKUP } from './ui/markup.mjs'
import { ADMIN_UI_JS } from './ui/client.mjs'

export const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-notifier 管理台</title>
<style>${ADMIN_UI_CSS}</style>
</head>
<body>
${ADMIN_UI_MARKUP}
<script>${ADMIN_UI_JS}</script>
</body>
</html>
`
