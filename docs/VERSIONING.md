# Versioning And Release Integrity

This project has had version-split incidents before. The rule is now: one engineering tree, one package version, one release gate.

## Canonical Layers

1. `package.json.version` is the semantic version authority.
2. `CHANGELOG.md` must contain the matching `## [version]` entry.
3. `src/admin/ui.mjs` must display the same version.
4. README badges/body, `HANDOFF.md`, and `dshQuality.testCount` must agree on the published release baseline; unreleased development counts are documented separately and must not change the release guard count.
5. `package.json.files` defines the npm payload. The engineering archive is not the npm payload.

`node scripts/verify-release.mjs` checks these invariants. A release is blocked when it fails.

## Commit Protocol

- Import or recover a source baseline in its own commit.
- Make runtime changes, tests, docs, and metadata in logically separate commits where practical.
- Do not publish from a dirty tree or from a `file:` installation.
- Use `codex/<topic>` branches for agent work; merge only after the parent agent reviews the diff and test result.
- Tag the exact release commit after the guard passes. Never retag a version with different source contents.

## Release Gate

```text
git status --short --branch          # must be clean before publish
npm test                             # full behavior contract
node scripts/verify-release.mjs      # version/docs/payload invariants
node scripts/gen-channel-matrix.mjs --check
npm pack --dry-run --json            # inspect actual npm file list
```

After publishing, verify in a disposable host profile, not only in the source tree:

```text
npm view dsh-notifier version
npm ls dsh-notifier
dsh plugin add dsh-notifier@<version> --profile <profile>
```

Restart DSH and verify the UI version, startup assembly markers, one outbound test, and one inbound command. A registry install is the real-machine baseline; a local `file:` install is for temporary development only.

## Artifact Comparison

The repository archive may include contributor-only files such as `HANDOFF.md`, `ADAPTER.md`, design notes, screenshots, and CI. The npm package intentionally excludes those. Compare manifests and hashes before release, but do not make the npm archive the source of truth.

## Dev → Public Mirror Release Flow

Two repositories exist with different jobs:

- `THEWOLFWALKER/dsh-notifier-dev` — private canonical dev workspace (branch `main` + `codex/*`). Engineered and authored here.
- `THEWOLFWALKER/dsh-notifier` — public release/source mirror (branch `main`). Read-only reference for consumers; never develop here.

The public mirror is a *filtered* snapshot, not a byte-for-byte copy. Engineering-only files stay in dev:

- Always excluded: `.agents/` (including the frontend-design / impeccable / hallmark / taste / ui-ux-pro-max skills and `neat-freak`), `.claude/ .codex/ .opencode/` pointer dirs, engineering-notes only files (`HANDOFF.md`, `ADAPTER.md`, workstream debris), `package-lock.json`, secrets/state/logs.
- Always kept: `src/ test/ scripts/`, `package.json`, `README.md` + `README.zh-CN.md` (with the console screenshot previews), `CHANGELOG.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `PLUGINS.md`, `cordis.patch.yml`, `docs/guide.md` + `docs/upgrade-guide*.md` + `docs/VERSIONING.md` + `docs/OPERATIONS.md` + `docs/screenshots/` (README references it), `.github/workflows/ci.yml`.

The npm payload (`package.json.files`) is smaller still and independent of the mirror.

Recommended publish procedure (do not develop in the mirror):

```text
# 1. dev main must be green and clean
git status --short --branch        # clean
npm test
node scripts/verify-release.mjs
node scripts/gen-channel-matrix.mjs --check

# 2. refresh a filtered staging clone of the public mirror
#    (copy from dev, excluding the engineering-only files above)

# 3. in the staging copy: sanity-check the README screenshots resolve
git status --short
git diff -- name-only            # review what moved
git commit -am "release: sync dev main to <version>" 

# 4. push the filtered snapshot to the public mirror main
git push origin main
```

Keep the public `main` pointer pinned to reviewed dev `main`. Never force-push over published history; if drift appears, reconcile from dev `main` forward.

## Version Bump Checklist

- Update `package.json.version`.
- Add a top CHANGELOG entry describing behavior, tests, and security/review identifiers when relevant.
- Update the admin UI version string.
- Run the full test suite and update `dshQuality.testCount` only from the actual runner summary.
- Synchronize README release badges/body and `HANDOFF.md` release count references; label any unreleased development baseline separately.
- Run the release guard and channel matrix check.
- Record the final commit, package version, npm registry version, and any real-device gap in `docs/memory/project-state.md`.
