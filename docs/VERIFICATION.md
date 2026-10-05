# Verification

How to check this source, and what the collected evidence does and does not show. Use
[Status](STATUS.md) for the release decision and [CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions)
for the source actually checked. Historical passing runs do not certify a newer revision.
Private logs, screenshots, disposable databases and native-session receipts stay under `data/`.

## Historical evidence — recorded through 2026-10-04

This summarizes the beta verification notes recorded through October 4, 2026, including
earlier setup checks. They were not rerun for this page. Dated details are in Git history
and private receipts; rerun the relevant checks when a change touches these areas.

**Real environments (Apple Silicon macOS):**

- Isolated live work exercised an Opus manager, Sol implementation, independent Opus review,
  one correction and manager integration while another project awaited a human answer. QUARK
  priority/pause instructions persisted; a quota stop ended an executing owned Python child
  before acknowledgement, retaining files, queued input and context identities.
- Native read-only Claude allowed reads, a calculation and scoped review coordination while
  refusing file-tool and shell writes to source sentinels.
- Earlier isolated setup runs (dated in Git history) produced native Codex-only and Claude-only
  first replies. A clean source copy installed, built and compiled the Mac launcher; no owner
  accounts or installation changed.
- Opus 5.5 workers ran bounded availability reviews. A Sonnet 5.5 formatting request completed
  through QUARK with its original unchanged; the copy was read at 360 and 412 pixels.
- A 33-page LaTeX document with a shared parent-folder preamble compiled, opened, zoomed and
  navigated in the running app. The installed Mac app still needs OS permission for a
  protected iCloud folder; a cached PDF remains readable without source access.
- A disposable Python process verified Computer health script identification, CPU measurement
  and project association, distinct from untracked work.
- The installed host passed an authenticated screenshot upload, same-receipt retry and
  byte-for-byte download after an idle restart.
- Both public domains redirected to GitHub and loaded the README in Chromium and iPhone WebKit.

**Fixture and emulated coverage:** focused backend checks and isolated demo servers, with
browser checks at desktop, 412×915, 360×800, 915×412 and, for phone work, iPhone WebKit:

- Failed requests and retry, idempotent resends, conflicting saves, saved and retained drafts,
  paged history, steering/queueing, queue states, keyboard layout and enlarged text/UI scale.
- Crowded fixtures: many projects and tasks, long titles, open human requests, stale readings
  and budget boundaries, with explicit continuation controls.
- Phone pairing authorization, screenshot attachments, folder browsing, selected-host
  forwarding, setup-prompt copy fallback and manager permission boundaries.
- Chat math and the LaTeX/PDF reader: delimiters, malformed input, failed builds retaining the
  previous PDF, zoom/navigation, synthetic pinch/swipe and return to an unsent chat draft.
  Reading-mode formatting was measured in the browser DOM from 360 to 1440 pixels.
- Scheduler recovery, provider-discovery outage and retry, SSE backpressure, startup with both
  providers unavailable and idle HTTP connection renewal.
- Resource triggers, cooldowns, QUARK admission and read-only evidence retrieval.
- Retained classic-workspace regression checks.

**Limits:**

- Keyboard geometry, gestures and phone layouts above are emulated. Physical installation,
  Home Screen retention, cellular reconnection, iOS focus panning, the photo picker and
  hardware keyboards need [phone acceptance](PHONE_ACCEPTANCE.md) on the actual device.
- Ubuntu CI checks the source build, backend and emulated browsers. It does not certify native
  Linux desktop integration; Intel Mac and Windows remain unqualified.
- Image delivery tests verify readable paths, not provider vision accuracy. Fixture browser
  connections do not certify a real browser inventory. Resource checks do not validate GPU or
  temperature telemetry or every generated diagnosis.
- Some formatted equations still scroll; no universal TeX equivalence or package support
  is claimed.
- Live provider evidence applies to the versions used; do not extend it to later provider updates.

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

## Test hygiene

Ordinary installation uses the setup script and actual first-run journey, not the full developer
suite. Never point tests at an existing user's database. Close owned servers/browsers, archive
fixture sessions through native APIs and preserve unrelated processes.

Record the source, command, result and meaningful limits in a change/PR or CI artifact. Keep
this page a current verification guide rather than appending every edit and old test count.
A failing check needs a concrete correction or explicit unresolved disposition, not repeated
runs until a different result appears. Docs-only cleanup checks links, formatting, public file
contents and the exported tree; it is not another app acceptance run.
