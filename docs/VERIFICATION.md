# Verification

How to check this source, and what the collected evidence does and does not show. Use
[Status](STATUS.md) for the release decision and [CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions)
for the source actually checked. Historical passing runs do not certify a newer revision.
Private logs, screenshots, disposable databases and native-session receipts stay under `data/`.

## Historical evidence — recorded through 2026-10-05

This summarizes the beta verification notes recorded through October 5, 2026, including
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
- A real bug-report journey on October 5 used a Codex manager and distinct Opus 5.5/xhigh
  implementation and review turns. The exact reviewed one-line fix was applied, its tests
  passed and the original report closed. A bounded observation timeout required an explicitly
  authorized continuation of the same saved manager session; no duplicate report or worker
  was created. Fixture servers closed and owned Codex sessions were archived through the
  supported API; Claude histories remain private.
- A separate real Settings update journey moved an older public source (`5df5b47`) to the
  pinned public revision `b9e468c`, retaining two local page-title adaptations. A Codex manager
  obtained independent Opus 5.5/xhigh review and applied the exact reviewed commit after
  explicitly authorized bounded same-session continuations. The manager corrected `accept`
  to `complete` for the approved task before preview/application. The recovery copy was verified; the
  disposable installation was rebuilt and reopened with the same data. Actual HTTP/browser
  checks retained its original project, history, unsent draft, model policy, preference, file
  bytes and custom browser title. Reopening used no model turns. Three phone test failures
  were independently traced to reloading before a Spawn acknowledgement; deterministic
  exact-key recovery checks passed separately. The original failed results remain recorded.
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
- Slurm: the read-only collector ran live over a cached FASRC session (Slurm 26.05.4); its
  anonymized replies are the parser fixtures. A no-model Codex App Server sandbox and
  Anthropic's standalone sandbox runtime showed which roles reach the SSH control socket. A
  disposable local SSH server exercised the sign-in's background master and loopback notebook
  forwards. The notebook template ran locally on loopback with JupyterLab 4.6.4 (jupyter_server
  2.21.1): a log path with spaces became mode 600 before Jupyter wrote, a piped log was left
  alone, and a log that could not be changed stopped the job before Jupyter started. Startup URLs
  showed `token=...`; only a request error on a token-bearing URL printed the token. A bounded
  real Slurm job subsequently completed through an app-managed Claude agent, including native
  file creation, submission, polling, copy-back and scratch cleanup. Real password/code sign-in
  remains unverified. A real compute-node Jupyter server subsequently returned HTTP 200
  through the app's private loopback forward. Repeated open reused that forward; close
  removed it. The test found and corrected split-DNS interface binding: the same node and
  port became reachable when Jupyter listened on the compute node's IPv4 interfaces.
  Connection and job-log files were private; the token was absent from stored app records.
  The separate notebook gateway was also checked against a real compute-node Jupyter server:
  native Lab and status pages returned 200, a kernel executed a calculation over WebSocket,
  and revocation closed both HTTP and the active socket. This used a simulated HTTPS Host on
  loopback, not a publicly routed phone origin. The owned job, scratch files and forward were
  removed while the existing SSH sign-in remained running. Separate local checks covered
  one-use handoffs, device removal, selected-host lease expiry and lost hostname isolation.
  Native writing-role checks exercised files, HTTPS, browser rendering and cached SSH without
  app permission prompts; read-only roles remain restricted. A private Unix reverse forward
  worked on FASRC, but an actual remote VS Code workspace still needs acceptance.

**Fixture and emulated coverage:** focused backend checks and isolated demo servers, with
browser checks at desktop, 412×915, 360×800, 915×412 and, for phone work, iPhone WebKit:

- Failed requests and retry, idempotent resends, conflicting saves, saved and retained drafts,
  paged history, steering/queueing, queue states, keyboard layout and enlarged text/UI scale.
  Synthetic visual-viewport events cover keyboard dismissal while zoomed, reordered or missing
  final events, route changes, resume and rotation; Chromium also applies a real page scale.
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
- Compact coordinator/resource evidence, bounded detail reads and totals-only manager
  accounting. Fresh-context checks cover queued owner follow-ups, inactivity measured from
  owner messages, retained choices/history and cancellation while a native session closes.
- Owner controls: queued-message edit holds and recoverable steering receipts, general file
  retention, immediate Spawn drafts, direct background tickets, completion Undo, reversible
  chat archiving and reply-only QUARK bypass with worker supervision. Boundary checks include
  selected computers, interrupted requests, reloads and independent source-message triage.
- Shared-chat queue checks use the real app outbox with a simulated editor bridge. They cover
  held edits, native handoff, exact-key recovery, late steering acknowledgements and selected
  computers across all five browser profiles. They do not certify every native editor version.
- Retained classic-workspace regression checks.

**Limits:**

- Keyboard geometry, gestures and phone layouts above are emulated. Physical installation,
  Home Screen retention, cellular reconnection, iOS focus panning, the photo picker and
  hardware keyboards need [phone acceptance](PHONE_ACCEPTANCE.md) on the actual device.
- Ubuntu CI checks the source build, backend and emulated browsers. It does not certify native
  Linux desktop integration; Intel Mac and Windows remain unqualified.
- Image delivery tests verify readable paths, not provider vision accuracy. Fixture browser
  connections do not certify the owner's connected Chrome inventory, which remains unchecked.
  Native disk/network/GPU/thermal-warning probes returned readings on the test Mac; they do
  not certify other drivers or every diagnosis.
  Temperature readings are unavailable through these unprivileged probes.
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
