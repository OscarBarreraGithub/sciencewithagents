# Verification

Use [Status](STATUS.md) for the release decision and [CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions)
for the source actually checked. Historical passing runs do not certify a newer revision.
Private logs, screenshots, disposable databases and native-session receipts stay under `data/`.

## Computer setup prompt and publication checks — 2026-10-04

The computer-connection prompts retain a readable dark background inside generic form panels.
Five viewport/browser profiles verify colors, both copy buttons, clipboard fallback, larger
text and absence of setup side effects. This fixes a CSS specificity conflict, not missing text.
The five failures in the first updated public CI run were reproduced or traced to obsolete
charter expectations, the new discovery retry delay and an assumed cross-project start order.
Focused checks now include the formatting charter, exercise the retry delay with a controlled
clock and explicitly finish fixture turns while checking concurrency, pause and per-agent order.

## Phone to-do and manager headings — 2026-10-04

Regression checks reproduce Home cards shrinking when the keyboard opens and manager names
being clipped beside the toolbar. Home now keeps content sizing independent of keyboard
height; phone headings wrap above their tools. Desktop, 412×915, 360×800, 915×412 and iPhone
WebKit checks cover name visibility up to double text size, retained to-do drafts and existing
chat keyboard/reading-position behavior. Keyboard geometry is emulated; native iOS focus
panning still needs a physical-phone check.

## Screenshot attachments — 2026-10-04

Focused checks cover paired-phone authorization, uploads larger than the ordinary request
limit, idempotent retry, private file permissions, missing/symlink rejection and same-thread
native forwarding. Desktop, 412×915, 360×800, 915×412 and iPhone WebKit emulation exercise the
picker, previews, draft reloads and screenshot-only sends. Shared-chat composer/queue regressions
also pass. Native delivery tests verify readable image paths, not provider vision accuracy;
physical iPhone photo-picker behavior still needs device acceptance.
The installed host also passed an authenticated upload, same-receipt retry and byte-for-byte
image download after an idle restart; previous scheduler settings were restored.

## Queue and context checks — 2026-10-04

Focused checks cover native queue acknowledgements and unreadable/unsupported queue states,
editable composers during delayed sends, original receipt retries and retention of newer drafts.
Desktop, 412×915, 360×800 and 915×412 browser emulation checked actual queue scrolling and
stable composer position. Browser-setup dialogs were checked for failure/retry and doubled
UI scale. Native browser inventory can still require an active provider conversation; fixture
results do not certify a real browser connection or physical phone.

Work-item checks cover retrieval beyond sixty open asks and project isolation. Scheduler
regressions verify that streaming text does not schedule a pass per delta, bursts coalesce,
and pending wakeups yield to network/timer processing. Focused tests and the workspace build
passed. A scheduling-only live repair restored HTTP responses and the Home screen without
restarting the server or interrupting active runs. A later owned-launcher restart loaded the new backend routes and tool schemas after active
turns had finished. The prior queue setting was restored; no user project was interrupted.

## Availability and phone formatting — 2026-10-04

Actual Opus 5.5 workers performed bounded availability reviews and eight synthetic LaTeX
formatting experiments. The latter used Pandoc/KaTeX conversion and TeX-based estimates,
not browser measurements. A separate actual Reading DOM pass covered their original and
formatted examples at 360, 412, 915 and 1440 pixels, with 20, 26 and 30 pixel text; equations
stayed within local scroll regions and common numbering/manual tags matched the fixtures.
Some expressions still require scrolling. No universal TeX equivalence or physical-phone
certification is claimed.

A real Sonnet 5.5 formatting request completed through QUARK. Its original and formatted
Reading routes both returned usable content; the original source remained unchanged.
The resulting copy was checked in the actual reader at 360 and 412 pixels with enlarged text.

Focused regressions cover scheduler recovery, provider discovery isolation and retry,
bounded history reads, SSE backpressure, startup with both providers unavailable, actual
draft revision conflicts, source/hash/reference preservation and selectable formatting.
Browser checks cover desktop, 412×915, 360×800 and 915×412. Provider-outage and formatter
control checks use isolated servers; private reports, screenshots and fixtures remain under data/.

Post-install polling exposed an idle HTTP connection stall, also reproducible on this Mac
with a minimal Node 26.7 server independent of the app. A five-second idle keep-alive lifetime
avoided it in the reproducer. The HTTP regression checks connection renewal while an active
event stream keeps delivering updates. This changes only idle connections; see
[Fastify's setting](https://fastify.dev/docs/latest/Reference/Server/#keepalivetimeout).

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
