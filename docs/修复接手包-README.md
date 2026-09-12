# dsh-notifier 修复接手包

接手目标：把 `01-修复计划.md` 定义的 13 个批次按 5 个发布列车落地到私有仓，全程遵循仓库自有协作规范。本包是只读输入——真正的事实源是克隆下来的私有仓本身。

## 包内容

| 文件 | 用途 |
|---|---|
| `01-修复计划.md` | 修复主计划：13 批次详案、决策点 D1~D8、交付顺序、对抗审查清单、退出标准 |
| `02-问题清单总表.md` | 80 项问题证据基线（审查 20 轮的产物，仓库里没有，修复时逐条对照） |
| `workstreams/` | 13 个预填 workstream 文件，按批次一对一，克隆后复制进 `.agents/workstreams/` 即完成占位 |

从 GitHub 可拉取的东西不打包，直接用链接：

- 私有开发仓（唯一串行工作区，在此开发）：https://github.com/THEWOLFWALKER/dsh-notifier-dev
- 公共发布镜像（只读参照，禁止在此开发）：https://github.com/THEWOLFWALKER/dsh-notifier
- 竞品参照（只看思路，禁抄实现）：https://github.com/xmanrui/dsh-im
- 协议仲裁源（npm 包页，用于核对帧形状与字段名）：`dingtalk-stream` 2.1.4~2.1.7-beta.1、`qqbot-nodejs` 1.0.4、`@larksuiteoapi/node-sdk` 1.73.0
- 官方文档：QQ 机器人文档（bot.q.qq.com）、飞书开放平台（open.feishu.cn）、钉钉 Stream 模式（open.dingtalk.com）、Telegram Bot API（core.telegram.org/bots/api）

## 环境准备

```bash
gh auth status                      # 确认已登录，账号需有 dsh-notifier-dev 写权限
git clone git@github.com:THEWOLFWALKER/dsh-notifier-dev.git
cd dsh-notifier-dev
git status --short --branch         # AGENTS.md 规定：每任务开工先看状态与近 5 条提交
git log --oneline -5
```

克隆后必读（顺序即优先级，全部在仓库内）：

1. `AGENTS.md` —— 硬边界、分支纪律、workstream 协议、验证命令
2. `HANDOFF.md` —— 当前状态快照
3. `docs/VERSIONING.md` —— 版本/发布纪律，`dshQuality.testCount` 更新规则
4. `docs/memory/README.md` + `decisions.md` + `risks.md` —— 持久决策与风险
5. `docs/security/PLUGIN_SECURITY_FIX_PLAN.md` —— 上一次安全修复线的格式与纪律参照
6. `.agents/workstreams/TEMPLATE.md` —— workstream 文件字段

## 执行节奏（每个批次）

以下 10 步是一个批次的完整生命周期，对应 `AGENTS.md` 的 mandatory loop（plan → implement → adversarial review → revise → focused tests → full validation）：

```bash
# 1. 占位：把本包对应 workstream 文件复制进仓（一次全部复制亦可；13 个文件与 W1~W13 批次一对一）
cp workstreams/dingtalk-stream-protocol.md .agents/workstreams/

# 2. 建分支（禁止在 main 上开发）
git switch -c codex/fix-dingtalk-stream-protocol

# 3. 实现 + focused tests（每文件族一个窄提交，源码/测试/文档不混提交）

# 4. 对抗审查：对照 01-修复计划.md「对抗性审查清单」逐问自查，结论写进 workstream 文件

# 5. 全量验证（AGENTS.md 原文命令）
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check
node --check src/index.mjs
git diff --check

# 6. CHANGELOG 条目（行为变更必须带，注明审查编号 G-xx/S-xx）

# 7. workstream 文件更新：status: done、提交哈希、审查结论、遗留风险

# 8. neat-freak 检查清单（.agents/skills/neat-freak/SKILL.md，AGENTS.md 规定每任务收尾必过）

# 9. 提交推送
git push -u origin codex/fix-dingtalk-stream-protocol

# 10. 列车收口批次（每列车最后一个）：另做版本门（VERSIONING 检查清单）+ HANDOFF.md 快照刷新
```

推送与合并规则：分支推到私有仓即算交付；是否直接合 `main` 由用户在该机器上的习惯决定（历史 workstream 显示主线由父代理在审查 diff 与测试后集成）。不要动其他 workstream 文件，不要 reset/checkout 他人分支。

## 决策点处理

`01-修复计划.md` 的 D1~D8 每条都带推荐默认。执行代理的边界：推荐默认可以直接执行（workstream 与 CHANGELOG 注明“按计划默认执行”），但 D3（高危审批第二因子）与 S-15（git 历史刷量声明）明确不实现、只登记——这两条是产品与合规决策，超出代理职权。

## 不可越过的红线（摘自 AGENTS.md/HANDOFF.md，与计划决策规则同源）

- 零运行时依赖：只用 `fetch`、`node:*`、原生 WebSocket；optional 依赖保持 optional 且懒加载。
- 审批/提问/动作链路 fail-closed：超时、畸形、坏 token、错来源、任何异常一律交还桌面，沉默永不等于批准。
- 入站默认拒绝；身份是 `(channel, userId)` 绑定；token 单次核销有时限。
- 管理台只听 `127.0.0.1`；凭证不进日志/API 响应/DOM；状态写保留无关键。
- 单渠道故障不得拖垮启动或其他渠道。
- 不提交 `node_modules/`、`package-lock.json`、凭证、state 文件、日志。
- mock 通过不等于真机验证：协议类修复的真机缺口记 `docs/memory/risks.md`，发布措辞遵守“declared ≠ verified”。
