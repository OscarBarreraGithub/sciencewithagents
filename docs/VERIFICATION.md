# Verification

Use [Status](STATUS.md) for the release decision and [CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions)
for the source actually checked. Historical passing runs do not certify a newer revision.
Private logs, screenshots, disposable databases and native-session receipts stay under `data/`.

## Current evidence — 2026-10-01

- The last inspected backend CI run failed six model-routing/runtime/lease checks. These
  remain release blockers; documentation or UI checks do not resolve them.
- Focused model-preference, phone/recovery layout, copy-prompt, navigation-loop and Back-spacing
  checks passed on desktop, 412×915, 360×800, 915×412 and iPhone WebKit. They include retries,
  conflicting saves and enlarged text where relevant, using isolated data.
- Additional-computer prompt checks passed copying both machine-specific prompts, selectable
  fallback when copying fails, doubled text and no setup mutation merely from opening/copying.
- Both public domains were verified in Chromium and iPhone WebKit to redirect to GitHub and
  load the README. The production version is recorded privately with the deployment receipt.
- Earlier isolated Apple Silicon setup runs exercised native Codex-only and Claude-only first
  replies. Native worker/retrospective, shared-editor steering/queueing and scoped-write checks
  have dated evidence in Git history; do not call those freshly rerun on each provider update.
- Physical phone installation, cellular/restart retention and other desktop platforms require
  separate acceptance. Browser emulation and a connector-ready indication are insufficient.

## Run relevant checks

From the repository root, use Node 24+ and the pinned wrapper:

```sh
sh scripts/pnpm format:check
sh scripts/pnpm build
sh scripts/pnpm verify
sh scripts/pnpm test:e2e
```

Do not run all four for every small change. `verify` already builds and runs backend/companion
checks. Select affected tests while developing; run the relevant release checks before sign-off.
Browser setup/profiles are in [the browser guide](../apps/web/tests/README.md). Live provider
scripts are opt-in and can spend allowance; [the script index](../scripts/README.md) explains them.

Ordinary installation uses the setup script and actual first-run journey, not the full developer
suite. Never point tests at an existing user's database. Close owned servers/browsers, archive
fixture sessions through native APIs and preserve unrelated processes.

## Record evidence without clutter

Record the source, command, result and meaningful limits in a change/PR or CI artifact. Keep
this page a current verification guide rather than appending every edit and old test count.
A failing check needs a concrete correction or explicit unresolved disposition, not repeated
runs until a different result appears. Docs-only cleanup checks links, formatting, public file
contents and the exported tree; it is not another app acceptance run.
