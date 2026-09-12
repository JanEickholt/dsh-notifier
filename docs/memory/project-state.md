# Project state

Snapshot date: 2026-09-12. Current release line **v0.9.7** (`codex/pr22-issue23-fix` fix line; **1548 tests, all pass**, published 2026-09-12). Scope: Telegram PR #22 (ask_user single-choice cards gained "custom answer / skip" helper buttons with full callback-ref reclamation on every failure path, plus fail-closed token/ledger/exact-source validation for custom and skip in `handleCardAction`) and QQ Issue #23 (gateway heartbeat resequenced: HELLO only records the interval and authenticates, the first beat fires idempotently only after READY/RESUMED, single-miss keeps sending, threshold reconnects, per-connection state isolation). Both fixes are mock/contract-tested; the QQ fix follows real-device A/B evidence from the issue but no fresh real-device soak was run on this codebase (see [risks.md](risks.md)). Previous line: v0.9.6 zero-config first-visit onboarding (admin enabled by default in `cordis.patch.yml`; first-run fragment launch link `/#token=...` with launchToken printed once; port-conflict fallback to a kernel-assigned port; outbound state key separation `admin:channel:<type>:outbound`; direction-aware channel APIs with instant real outbound testing; admin UI rebuilt as `src/admin/ui/` trio). Before that: R1–R5 fix trains complete; v0.9.5 closed with 1531 tests. The 80-item 2026-08 review list is reconciled: 70 items fixed across R1–R5, G-19 evidence-logged (no code change), and 9 registered non-fix items (G-35/36/37 structural debt; S-01/03/08/09/10/15 — see `docs/TECHNICAL_DEBT.md` / `docs/memory/risks.md`). Latest released npm artifact is now `0.9.7` (published 2026-09-12, 1548-test contract). Test-count baselines in release guards are updated at train close, not per-commit.

- Current development validation: `npm test` = **1548** total, **1548 pass** (2026-09-12, pr22-issue23-fix line); v0.9.6 close baseline was **1544** (2026-09-12).
- Historical npm `0.8.6` artifact carried contract count **909**; `0.9.0` used **1352**; v0.9.5 closed at **1531**; v0.9.6 closed at **1544**; the current v0.9.7 line is **1548**.
- Canonical engineering repository is private `dsh-notifier-dev`; the public GitHub repository is a release/source mirror (`main` now carries v0.9.7) and is not a development relay.
- Runtime is Node.js ESM, Node `>=22`, no production dependencies, no build step. There are 27 outbound adapters and six inbound control channels.
- Inbound identity is composite and source-bound: `(channel,userId)` plus exact `accountId`/`chatId` when present. Unknown or missing source authority fails closed; channel names are never used as account IDs.
- The loopback Web/admin console is the only control console (`127.0.0.1` + Bearer). It supports personal-mode setup, pairing, channel test sends, masked question listing, and Control-Core choose/reject settlement. YAML remains an advanced/automation entry.
- Desktop `ask_user` has no safe host interface. Desktop fallback is the fail-closed outcome for timeout/error; do not claim desktop settlement or dual-end parity.
- Control Core, session arbiter, bounded approval members, session control overlay persistence, provider facades, callback capacity, and public notifier facade limits are code/contract-tested.
- Public discovery metadata is aligned with v0.9.7; Awesome DSH refresh is tracked by PR #3490, and dshfind consumes the repository metadata on its scheduled sync.
- QQ C2C buttons, QQ GROUP text fallback, and QQ/WeChat iLink/DingTalk image envelopes are contract-tested only. Media/file support and provider-specific payload/reconnect behavior remain `declared` or unverified.
- `allowUsers` is retained as one-shot `inbound:migrated` compatibility import; optional Feishu/QQ SDK lifecycle seams are documented in [compatibility-matrix.md](../compatibility-matrix.md).

## Validation evidence

- `npm test`: 1548 total (1548 pass), 2026-09-12 (v0.9.7 publication baseline); focused Telegram 117 pass, focused QQ 45 pass.
- `node scripts/verify-release.mjs`: release guard compares package `0.9.7` with its documented 1548-test contract (badge / test text / homepage metadata / HANDOFF).

## Next release gate

v0.9.7 is published. The next gate reuses the same checklist: run `npm pack --dry-run --json` and a registry-artifact disposable-profile smoke (registry install in a disposable profile, not a `file:` install). Validate startup, one outbound test, one inbound command, and the `ask_user` assembly boundary. Real-device, provider, and DSH-host validation remains an external gate; see [risks.md](risks.md).
