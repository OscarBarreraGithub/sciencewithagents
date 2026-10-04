# Verification

Use [Status](STATUS.md) for the release decision and [CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions)
for the source actually checked. Historical passing runs do not certify a newer revision.
Private logs, screenshots, disposable databases and native-session receipts stay under `data/`.

## Current focused checks — 2026-10-03

Chat-math checks cover both delimiter styles, inline/display equations, aligned expressions,
matrices, lists/tables, prices and literal code, streamed/incomplete input, malformed math,
external-content rejection and paged shared-editor replies. Desktop, 412×915, 360×800,
915×412 and iPhone WebKit checks include enlarged UI scaling through 200% and equation
overflow containment. PDF-link return/scroll/draft checks still pass with the shared renderer.

LaTeX/PDF checks cover real compilation with included chapters, equations and tables, failed
build/retry with the previous PDF retained, recent-file persistence, path validation, manager
links, paired-phone authentication and selected-computer PDF forwarding. The reader was
visually checked at desktop, 412×915, 360×800, 915×412 and iPhone WebKit emulation. Browser
checks cover zoom, page navigation, synthetic pinch/swipe, doubled UI scale, the phone content
security policy, and return to the exact mounted chat position with an unsent draft. These
are emulated browser checks, not physical iPhone acceptance or universal TeX-package support.
A real 33-page document with a shared parent-folder preamble compiled without changing its
source directory. Its PDF was opened, zoomed and navigated in the running app. The installed
Mac app still needs OS permission to browse that owner’s protected iCloud folder; a cached PDF
remains readable without source access.

Resource checks cover sustained-change triggers, transient spikes, sleep/restart, incident
deduplication/cooldowns, QUARK admission and read-only evidence retrieval. A disposable real
Python process on macOS verified script identification, CPU measurement, supervisor/project
association and distinction from untracked work; raw arguments were omitted. Computer-health
browser checks passed on desktop and all four emulated phone profiles. These checks do not
validate GPU/temperature telemetry or certify the reasoning in every generated diagnosis.

Folder browsing was checked through paired-phone authentication, selected-host forwarding,
selection/tracking retries, private-directory exclusion and directory replacement. Fifteen browser
checks passed at desktop, 412×915, 360×800, 915×412 and iPhone WebKit emulation. Manager permission
checks cover saved restrictions, Codex session reconnection and Claude launch boundaries.
These are focused checks; the full beta suite below was not rerun for this change.

## Earlier beta evidence — 2026-10-01

- Local production builds/typechecks passed with **827 backend and 99 companion checks**.
  The previous provider-routing/runtime/lease failures are corrected. Published-source CI
  separately checks Ubuntu; local success is not a substitute for that result.
- The current browser suite exercised desktop, 412×915, 360×800, 915×412 and iPhone WebKit.
  After correcting fixture isolation and native input targeting, all affected checks passed
  against the same populated database. Forty retained-workspace checks also passed. Coverage
  includes retries, conflicting saves, paged history, notepad, steering/queueing and keyboard
  layout. Chromium tab zoom was checked from 80% to 400%; phone keyboard tests are simulated.
- Crowded fixtures included 30 projects and 100 tasks, long unbroken titles, open human
  requests, stale readings and budget boundaries. Truncated lists have explicit continuation
  controls; budget links reveal and focus the relevant card.
- Isolated live work exercised an Opus manager, Sol implementation, independent Opus review,
  one correction and manager integration; another project continued while awaiting a human
  answer. QUARK priority/pause instructions persisted, and a quota stop ended an actually
  executing owned Python child before acknowledgement. Files, queued input and context
  identities stayed saved. Native read-only Claude allowed reads, a calculation and scoped
  review coordination while refusing both file-tool and shell writes to source sentinels.
- A clean source copy installed dependencies, built and compiled the Mac launcher. A moved
  launcher test needed an explicit fixture data path; its corrected checks and the remaining
  companion checks passed in that copy. No owner accounts or installation were replaced.
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
