# Orchestrator troubleshooting — wiki seed

**Purpose:** durable incident notes to turn into a troubleshooting wiki later. These are
observations and decisions, not a new implementation plan or a claim that v1 is finished.
Keep private transcripts, provider paths and runtime databases out of this document/Git.
Current product readiness belongs in [STATUS.md](STATUS.md); operational authority and
recovery procedures belong in [OPERATIONS.md](OPERATIONS.md).

Phone setup/OAuth handoffs and live-stream revocation incidents are recorded in
[CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md). Private source-backup history scanning,
uncertain pushes and queue/status recovery are in [SOURCE_BACKUPS.md](SOURCE_BACKUPS.md).
Both are marked as future wiki material; deployment status remains separate from fixtures.

## 2026-09-17 — stop receipts are not completion events (future wiki material)

The real Claude mirror Stop check reached native interrupted/ready state but the phone
still said working. Claude's old `turnComplete` field remained false after interruption.
Do not set native fields or declare idle merely because interrupt was acknowledged. Observe
the original result/end event for that selected channel/session, then also require no queued
work, outstanding requests, background work or approvals. Keep the original event flowing
to the editor. The corrected real probe stopped a reply and then completed a follow-up in
the same conversation; Codex passed its equivalent check.

A phone Stop needs the exact visible native turn identity, not just a conversation ID.
Persist the operation before dispatch, consume that turn's stop token, and refuse stale
tokens after a newer desktop turn starts. Lost acknowledgements need read-only receipt
lookup, never automatic replay. Separate the stop receipt from text delivery and preserve
the user's unsent draft. Legacy companions should omit the unsupported control.

## 2026-09-17 — display formatting caused a review loop (future wiki material)

A real mixed-provider fixture produced the correct one-line file. The reviewer interpreted
the native Read tool's numbered display as an extra newline and requested unnecessary
rewrites until the bounded review gate stopped it. Keep that failure receipt; a successful
file write is not proof of completed review. Do not solve it with a larger project plan or
by auto-approving the review.

The missing evidence was the already-existing clean-checkpoint Git diff. Expose it through
`dock_inspect {taskId, changes:true}` to the assigned worker, with fixed task paths and no
browser-supplied shell command. Refuse dirty/changing/actively written worktrees, suppress
external Git diff/text-conversion helpers, label truncation, and retain the exact head and
fingerprint. Managers still delegate inspection. Clarify that numbered Read output is not
raw file bytes. A new bounded Claude manager → Codex builder → Claude reviewer run then passed.

Review limits must also cover continuing existing workers: a peer message may not restart
work in a task awaiting manager disposition or a closed task. Otherwise the manager can
accidentally bypass the spawn/revision cap by messaging the same reviewer again.

## 2026-09-17 — lazy native resume and cancellation boundaries (future wiki material)

Check the real launch environment as well as terminal tests. The Mac launcher initially
recorded Node/Codex but not optional Claude; Finder's PATH can omit the user's local binary
directory. Setup now records the stable Claude executable entry and supplies it explicitly.
Preserve the auto-updating symlink, not its version-specific resolved target. Old configs
remain valid for Codex, and a bad explicit selection must not overwrite working config.
See CONTRIBUTOR_SETUP.md; do not fix this by copying credentials or changing global PATH.

Claude documents that resuming a terminated native session may continue its unfinished turn.
Consequently, do not launch `--resume` just to display a saved conversation or start the app.
Keep the handle inert until explicit input. Retain the original UUID/account affinity;
missing history or changed accounts must not silently produce a replacement conversation.
An initialized native session and an attempted user-message write are distinct receipts.

Stop can arrive during authentication or startup, before a user frame is written. Record
submission intent immediately before that write, not at the start of an asynchronous setup.
Known pre-write cancellation must neither claim uncertain delivery nor strand a newly
queued message. Keep the scheduler lease until the old setup settles. Capture source
session/run at event ingress before waiting for an async lock: otherwise a late old result
or message can be archived under a newer turn. Expire known-closed approval requests before
recording a decision; genuinely uncertain writes still cannot be retried automatically.

Native subscription sign-in and API-billed noninteractive execution are not interchangeable.
Check account affinity and conflicting credential/endpoint/provider environment overrides
before each turn. Reject conflicts visibly instead of unsetting the owner's configuration,
extracting tokens or falling back to paid API usage. Role tool restrictions are not an OS
sandbox, and ordinary hook-disable flags cannot override administrator-managed hooks.
See MANAGED_CLAUDE.md for the first-party references and precise supported surface.

## 2026-09-17 — a recovery copy must be a standalone database (future wiki material)

Use SQLite's online backup operation, not a raw copy of a live WAL database. Finish the
backup in standalone journal mode before hashing it; unexpected sidecars, linked files,
non-private permissions or a changed file invalidate verification. Keep durable failed or
interrupted receipts and require an explicit new copy/recheck; never hide failure or delete
the only copy automatically. Restoration tests must open a separate database and inspect
real archived entries/settings/image bytes, not merely assert that a file exists.

The in-app feature exposes metadata, not credential-bearing database downloads or live
replacement. Same-disk snapshots are useful recovery points, not protection from disk loss.
Database copies also carry phone trust metadata: review that trust before bringing a
restored installation online. GitHub source checkpoints never replace conversation backups.

## 2026-09-17 — release pins caused avoidable downtime (future wiki material)

**Symptom:** sharing reported “This Claude Code build is not supported yet” immediately
after the 0.2.0 handoff. VS Code's registered Claude installation had auto-updated from
2.1.273 to 2.1.274; inspecting an older extension folder would have missed the actual cause.
The connection methods/state were still compatible. An unrelated hash/minifier-name change
was enough to reject the bridge. This was not a phone-pairing or authentication problem.

**Disposition:** the owner wants compatible updates to work without a release-by-release
allowlist. Companion 0.2.1 parses the host construction and checks actual runtime features.
Missing/ambiguous structure stops sharing before file modification; missing channel features
stop sends. Exact backups/guarded restore and native approval/input ownership remain intact.
Keep provider auto-updates on. Do not promise that private APIs can never genuinely break.

**Reusable check:** resolve the provider through the actual extension registry; copy it
into an isolated profile. Test patch/idempotency/exact restoration, native and phone text,
draft preservation and history reload. Include minifier renames and a synthetic future
version, not only the currently installed version. The probe now selects the registered
build automatically. Preserve older recognized patches' undo paths when changing hooks.

The synthetic activation test initially read a VM's symbol-keyed global from its outer
sandbox object. Node 26 does not reflect that property there: inspect it inside the VM.
That fixture assertion failed before the real acceptance run; the corrected fixture and
real Claude 2.1.274 bidirectional test both pass. No owner conversation was used or replayed.

## 2026-09-17 — navigation identity must not be a transport ID (future wiki material)

Moving the live mirror from a modal into normal chat navigation exposed two identity
boundaries: restarting the editor changes its connection ID, while changing the shared
thread must not change the destination of an already-written phone draft. Use a stable
computer/provider/thread key for navigation and draft storage, and resolve the current
connection separately. Identical thread strings from Codex and Claude are not one chat.

A send may finish after its view unmounts. Resolve only the matching saved receipt and
notify only the matching draft view; a generic "reload all drafts" event can discard
memory-only edits in an unrelated chat when storage is unavailable. Retain uncertain
delivery identity rather than auto-resending. Regression tests cover navigation during
delivery, provider separation, reload, and reconnection with a new window ID.

Distinguish loaded transcript memory from durable provider history. Keeping an offline
sidebar row does not mean its whole conversation was backed up in Agent Dock. State
where history lives and what a tab reload can recover. Do not re-run owner prompts or
reload the active editor merely to verify a visual web update.

Review also caught a cached-offline deadlock: if the extension WebSocket is still alive
but the provider is temporarily unavailable, stopping reads prevents the cached summary
from ever becoming ready again. Track producer presence separately and keep bounded reads
while it is attached. An absent producer needs discovery, not a history-read error loop.

Finally, same-key POST deduplication is not a strictly read-only delivery check. If the
original request never reached the gateway, POSTing it again can be its first execution.
Use a protected GET receipt route for **Check delivery**. An absent receipt remains
uncertain because the original request may still be in flight; never infer permission
to clear/re-send from absence alone. This does not change the original send contract.

Claude review exposed another identity boundary: its native channel object/ID can be
reused for a different session. Observing only the channel ID leaked new, unshared
output into the previously shared view before the next read. Pin the selected session,
the currently mapped channel object and any explicit frame session ID in both observer
paths. Always forward the original native event even when it is not retained remotely.
Tests cover channel mutation/replacement and old callbacks after selection changes.

## 2026-09-17 — a supported protocol is not a public extension API (future wiki material)

The owner explicitly authorized a maintained monkeypatch after the standard-interface
investigation. A tiny activation hook exposed the existing private connection inside
the extension host. A companion observer/text sender then achieved real bidirectional
native/browser chat without a second provider or per-handoff restart. Do not continue
asking about stop/resume when the owner has accepted this different maintenance tradeoff.

The fixture copies the installed extension into an isolated profile and proves exact
patch restoration before model tests. Fresh VS Code onboarding initially hid the chat
editor; that was a fixture setup issue, not evidence that the bridge failed. The macOS
application executable is `Contents/MacOS/Code`, not an assumed `Electron` filename.
Discard neither failure receipts nor the distinction between fixture and owner acceptance.

Two race corrections matter beyond this extension: a late idle read must not overwrite
newer native turn activity, and a late send receipt must not clear a different thread's
draft after the desktop changes sharing. Both have focused regression checks. Closing a
WebSocket during connection establishment can emit an error; preserve an error handler
even when removing other callbacks so stopping a retry cannot crash the extension host.

The existing pairing boundary is reused, not replaced with a new bearer URL. Preserve
native permissions, decline automatic retries of uncertain sends, and record the exact
tested version/checksum. Restore before uninstall; an extension uninstall cannot be
assumed to run cleanup code. See VSCODE_MIRROR.md for the full maintenance/release contract.

## 2026-09-17 — same live thread is not an exclusive input lease (future wiki material)

A disposable Codex 0.154.0 two-client check confirmed that `thread/resume` can join an
existing active thread without replacing its policy or runtime. It also showed that
`turn/start` from the second client was accepted into the already-running turn. An
Agent Dock-only input lock does not control an independently connected native client.
Do not mistake matching thread IDs or shared events for collision-safe handoff.

New empty threads were not resumable until their first turn created a rollout. Use a
disposable live fixture, not an owner prompt, to distinguish that persistence precondition
from attachment support. A received host-tool request is not proof that native approvals
are safe with multiple responders. See the dated September 17 entry in VERIFICATION.md
for the probe evidence and VSCODE_MIRROR.md for the subsequently implemented editor bridge.

Read-only inspection found private-pipe VS Code App Servers and no default shared daemon.
Do not retrofit arbitrary running sessions by patching the IDE or exposing unfiltered RPC.
Record the supported boundary and ask about a coordinated one-time stop/resume rather
than silently changing “existing live session” into a copied-history or relaunched session.

## 2026-09-16 — checkpoint text is not a visible chat assertion (future wiki material)

After the owner authorized continuation, a stage-labelled failure receipt isolated the
remaining smoke failure to **return to saved chat**, before local CLI attachment. The
controls-only fixture used `agent.checkpoint` as if it were the agent's visible final reply.
It was not: the checkpoint was a separate tool result. Comparing raw assistant Markdown
to rendered text also fails when the source contains backticks. Neither failure diagnoses
a broken input-ownership handoff.

The minimal correction compares the actual rendered reply before/after terminal use;
the existing exact database/archive and restart assertions remain. Model-enabled smoke
checks retain their explicit completion-marker assertion. Failure stage, error and CLI
output are now saved only under the ignored private fixture directory. Do not expose
those artifacts in Git or call a test timeout a product bug before inspecting its predicate.

The complete controls-only check now passes, as do the 28 focused tests and server build.
The permission-flag correction was deployed with one owned restart and a verified private
database backup. Enrollment, saved history and drafts were preserved exactly; phone access
reconnected without re-pairing. No usage reset, model turn or message replay was needed.
Physical phone interaction remains an owner acceptance check, not inferred from Chromium.

## 2026-09-16 — remote TUI rejects permission overrides (future wiki material)

**Owner evidence:** `permission overrides are not supported when resuming a remote task`.
Agent Dock appended `--ask-for-approval on-request --sandbox <saved-policy>` to
`codex resume --remote unix://...`. Codex CLI 0.154.0 rejected that combination before
the terminal could attach. The mocked terminal test incorrectly required those same flags.

**Bounded correction:** remove only the TUI flags and assert the exact remote-resume argv.
Keep the saved agent permission and existing App Server `sandbox` / `approvalPolicy`
configuration. Remote attachment is not authority to disable the server's approval gates.
The official [CLI reference](https://learn.chatgpt.com/docs/cli/reference) describes remote
resume, and the [App Server reference](https://learn.chatgpt.com/docs/app-server) describes
thread permission configuration; the exact incompatibility is evidenced by the owner's
error and local behavior, not assumed from those general flag descriptions.

**Result and stop:** 28 focused tests and the server build pass. An isolated real CLI test
opened the browser terminal and rendered `/status`, but the broader controls-only handoff
check failed afterward. The exact failed assertion was not retained in the available tool
output; do not invent a local-CLI, history or takeover diagnosis. Private fixture screenshots
and the server log remain under ignored `data/`. No complete smoke success is claimed.
The owner's stop-on-failure instruction takes precedence over earlier autonomous scope:
save the candidate and evidence, clean up test processes, and stop without live deployment.
Do not run a usage reset, replay requests, or use a model turn to investigate this CLI error.

## 2026-09-15 — live phone workflow failure; bounded diagnostic stop (future wiki material)

**Owner report:** phone terminal cannot be used; attempted chat work also failed. The owner
already handled a usage reset manually and explicitly prohibited repeating it. New scope
is minimal repair, stopping for instruction if the workflow cannot be verified.

**Read-only evidence:** local health/phone status report the existing app and connector up,
with the approved device retained. The two latest saved chat failures (04:57–04:58 UTC)
contain the provider code `usageLimitExceeded`. These describe those attempts, not the
current account state after the owner's manual action. No model call or reset was retried.
Terminal-open events occurred around both attempts, but no native `resume --remote` process
remained under the app when inspected. Do not infer the exit cause: the current terminal
code sends an exit frame to its browser but does not retain the exit reason in events.

**Disposition:** no speculative runtime fix, account change, process restart, credential
inspection, new browser/server or broad test loop. Existing app/provider processes are
left alone. Ask for the exact message/screenshot from the phone's terminal view before
choosing a bounded reproduction. A terminal-open event, health check or passing fixture
suite must never be reported as proof of usable live terminal input and agent execution.

## 2026-09-14 — connected is not installed; staying signed in is not unpairing (future wiki material)

**Progress:** physical Safari enrollment succeeded. The earlier no-device observation is
superseded. Do not ask for another pairing code to repeat a solved connection or treat that
success as proof of Home Screen, cellular or restart behavior.

**Product correction:** make post-unlock setup prominent, with repeat lock on by default,
an explicit per-device **Stay signed in** choice and installation instructions. Save setup
completion on the server, without pretending it proves installation. Keep App lock and
the guide accessible afterwards. Initial passkey/computer confirmation still apply; lock,
off, enrollment removal and lost browser storage have different recovery paths. The complete
preservation checklist is [PHONE_WORKFLOW.md](PHONE_WORKFLOW.md), not scattered old UI notes.

**Offline lock edge:** hiding this page cannot revoke an unreachable server session. Save
deny-only local lock intent, show the unconfirmed-revocation warning, and retry when online;
do not reopen from an old remembered status. Other contexts remain potentially active until
server confirmation. If local storage is unavailable, explicitly limit the guarantee after
closing. This flag stores no credential and must never grant access.

## 2026-09-14 — separate the next input from completed setup work (future wiki material)

The owner confirmed the QR handoff worked, then requested separate code and nickname
screens. Show only the next input: manual **Enter pairing code → Continue → Name your
phone**; QR opens **Name your phone** directly without redisplaying the code. Navigation
alone must not submit preparation. Returning to code entry preserves the nickname.
The previous visible-autofill acceptance below is historical; test the current skip instead.

Keep success scoped: the owner's QR report is real progress, while the host still showed
no enrolled device at that check-in. Neither repeat solved QR work as if nothing passed
nor call passkey enrollment/home-screen use complete. Check each remaining transition
without weakening consent or adding another authentication flow.

## 2026-09-13 — QR visibility passed, but scan-to-autofill was never accepted (future wiki material)

**Symptom:** after the invitation-visibility correction, the owner still had to type the
16-character code after scanning. The QR contained only the public address. The original
request was scan-assisted pairing; the implementation and its checks had narrowed that
request to navigation plus manual entry without the owner's agreement.

**Correction:** include the active code in a URL fragment, scrub it synchronously before
React/API startup, and autofill from page memory only. Do not retain it in local/session
storage or submit automatically. Continue, explicit passkey creation and matching-number
computer confirmation keep their original authority and shared 15-minute deadline. A
manual path remains useful, but is not a replacement for the requested scan behavior.
Treat live QR images/links as temporary secrets; never commit them or assume the app can
erase an external scanner's history.

**Installation order:** pair in the phone browser first and add the home-screen app after
confirmation. A preexisting icon does not automatically inherit later browser enrollment;
it may need adding again from the paired browser. See the documented new-install cookie
boundary and actual-device checks in [PHONE_ACCEPTANCE.md](PHONE_ACCEPTANCE.md). Do not
clear working browser enrollment to make an installation test easier.

**Required acceptance:** scan the actual fixture QR payload into a fresh browser; verify
the code is filled without typing, the fragment is scrubbed, the code never reaches
local/session storage, and no registration is submitted until Continue. Exercise malformed
or expired links and the manual fallback separately. A virtual authenticator or visible
QR does not establish physical camera/Safari/Face ID or new home-screen installation success. Record those real-device
steps separately; this note does not claim they passed.

**Rule for future orchestrators:** trace the owner's requested action through to its
visible result. Do not let tests, revised copy or repeated safety explanations silently
replace the requested interaction with a less convenient one. The earlier address-only
QR notes below are superseded by this correction.

## 2026-09-13 — an online address is not an active pairing invitation (future wiki material)

**Symptom:** an unpaired owner saw a QR next to “Pairing is closed.” The panel rendered
the public address whenever the connector was on, regardless of whether it held a valid
one-use code. Show the QR/address/code together only after an explicit start, while the
connection and code are usable. Hide them on expiry, cancellation and confirmation.

**Review corrections:** consume the old local display before requesting a replacement
code; a lost response can mean the old code was already invalidated. Also distinguish
phone-side passkey saving from closed enrollment. Code acceptance consumes the code
before a credential exists; an immediate virtual authenticator hid that waiting interval.
A local-only progress boolean now shows “Continue pairing on your phone” and Cancel;
the confirmation number remains unavailable until server verification succeeds. Waiting
for a person is not a reason to invite a replacement code that cancels their work.

**Rule:** test what each invitation means in inactive, waiting, failed-response, expired
and completed states, not merely whether the address loads or the happy path passes.
The owner identified Safari as the original failing browser; whether a passkey prompt
appeared remains unknown. These display fixes are not proof of successful physical pairing.

## 2026-09-13 — a generic pairing error hid the real failure stage (future wiki material)

**Observed symptom:** the owner's phone showed “Pairing did not finish” and requested a
new computer code. No device was enrolled. That exact UI message is emitted only when
`startRegistration()` fails after the server accepted the code and before a credential
is submitted. The original browser exception was discarded, so its specific cause is
unknown; neither an account-login repair nor an assumed Safari defect follows from it.

**Corrections:** separate code preparation from an explicit Save passkey action, retain
unused prepared options only in memory for explicit retry, and show safe error categories
with recovery guidance. Consume the local retry state before submission; inspect uncertain
success rather than resending a signed credential. Use a nonempty display name. Extend the
one shared code/registration/confirmation deadline to the owner's requested 15 minutes,
keeping single-use, attempt limits and mandatory user verification/computer confirmation.
Add a manual address-and-code explanation so scanning the navigation QR is clearly optional.

**Compatibility evidence, not a diagnosis:** the installed library defaults an omitted
display name to an empty string; its official docs describe a cross-device compatibility
issue with that value. They also identify older Safari gesture constraints around extra
async work, while noting newer Safari relaxed those requirements. Neither proves which
exception this phone encountered. See [browser quirks](https://simplewebauthn.dev/docs/advanced/browser-quirks)
and [registration troubleshooting](https://simplewebauthn.dev/docs/packages/browser#troubleshooting).

**Rule for future orchestrators:** distinguish rejected code, browser credential creation,
server verification and computer confirmation. A successful virtual authenticator at four
viewport sizes is not Safari/Face ID acceptance. Keep physical results pending until the
person retries and reports what the actual device does; never weaken the gate to pass it.

**Separate backup-tool observation:** after the owned app closed its WAL sidecars, the
system sqlite3 CLI's read-only backup failed with “unable to open database file.” The app's
Node SQLite driver could read the same stopped database and made a verified backup with
quick_check=ok. The CLI's empty failed output was removed; the valid private backup was
retained. Do not infer archive corruption, remove a real database, or delete WAL files as
a repair from one helper's error. This was not the phone passkey failure.

## 2026-09-13 — durable receipts do not freeze observations (future wiki material)

**Symptoms:** a repeated quota-refresh request returned its saved freshness booleans even
after that report had aged or its reset time passed. Separately, two overlapping identical
delegations could both miss the outer receipt check; the second then failed the busy-worker
guard despite the first having successfully created its exact requested worker.

**Corrections:** retain the durable refresh receipt to prevent another provider read, but
recompute the usage summary from saved observations and the current time. For delegation,
recheck the exact receipt inside the task lock before applying current-state guards. This
does not permit a different payload to reuse a key, and does not replay model work.

**Evidence:** `providers.test.ts` advances time beyond report freshness/reset and confirms
one account-limit read; its overlapping same-key implementer calls return the same worker
with one run and one assignment event. The follow-up full backend run passes 244 tests.
`usage.test.ts` separately checks cumulative snapshot deduplication and unknown values.

**Rule for future orchestrators:** idempotency prevents repeated effects; it does not make
an old observation current. A receipt check before a lock is an optimization, not the
concurrency boundary. Exercise retries after time advances and while another request is
still committing, not only the easy sequential retry.

## 2026-09-13 — reconnect is not replay (future wiki material)

**Additional acceptance:** five actual Codex 0.154.0 conversations, not mock thread IDs,
survived an abrupt production-host process stop and same-data restart. Exactly five initial
fixture turns persisted the conversations; restoration made five thread/resume calls and
zero new model turns. All recorded provider descendants exited on both lifetimes. The
test uses idle saved conversations; uncertain in-flight effects remain a separate safety
case and are never automatically replayed. Script: `smoke-workspace-restart.mjs --run`.

**Symptoms found by independent regression review:** a delayed provider startup could
finish after app shutdown, leaving its process alive. Separately, replaying a completed
message's receipt could clear a later interrupted status and release newer queued work.
These are lifecycle/idempotency defects, not provider cache failures or a reason to plan
the project again.

**Corrections:** refuse new provider starts during shutdown; await in-flight startup,
restore and lock operations; close a late-created provider before registering it. Close
each owned provider once, including shared native-child processes. A receipt lookup and
exact payload validation happen before any status change. A duplicate submitted draft or
message returns its old receipt and cannot resume another action. Two restore slots are
shared across all device requests, with same-identity deduplication.

**Evidence:** delayed factory/shutdown and plain/copied-message receipt regression tests;
five persisted interrupted identities restored with unchanged models and no model turns;
overlapping device restores bounded to two; native-child restart archive/approval tests.
Real Codex 0.154.0 delegation, front-desk routing and legacy JSONL import also retain exact
thread identity through restart. Hidden context and cache expiry are not claimed recovered.

**Rule for future orchestrators:** an acknowledged old request is evidence, not permission
to re-enter a state transition. Closing resources must include resources still being
created. Compare IDs and actual model-turn counts, not just a reassuring UI status.

## 2026-09-13 — account switching and misleading connection errors (future wiki material)

A second tab changes shared localStorage when selecting a computer. Pinning request URLs
but rereading that selection for labels/draft keys was inconsistent. The entire document
now uses one immutable host scope. Another tab may select a different computer without
relabeling or moving this tab's draft or send; explicit selection reloads only its own tab.
The three-host browser test includes simultaneous tabs and checks the actual destination.

A connected computer could be replaced at the same local forwarded port after handshake
but before a write. Pinning only at connect time was insufficient. The gateway now sends
its configured destination identity on every HTTP/WebSocket request; the target checks
it before mutation. A three-host test deliberately replaces the backend in that gap and
proves the new workspace receives no write. Browser documents also pin their account
route for their lifetime; changing selection performs a full reload, not a partial remount
that could send a stale callback to the newly selected account.

Remote connection failures must not become phone-authentication failures. The gateway
maps target outages/login/redirects to computer-unavailable responses and never forwards
credentials or retries a request body. The UI clears connection-only errors on recovery,
retains unrelated action errors and labels history as belonging to the selected computer.
See MULTI_COMPUTER_SETUP.md for SSH alias, host-key and lifetime ownership precautions.

## 2026-09-13 — browser runtime startup is a separate failure domain (future wiki material)

The in-app browser bootstrap failed before opening a page with
`Cannot redefine property: process`. The tool runtime itself was available; repeating the
earlier missing-node_repl repair or changing protected global descriptors was not warranted.
The browser skill permits the repository-owned isolated runner when that runtime cannot
attach. That runner successfully exercised real pages and virtual WebAuthn at all four
sizes. Each run owns and closes its browser/server. A mock assertion, a collected test
list and a physical Face ID check remain three different kinds of evidence.

## 2026-09-13 — app startup, shutdown and rejected upgrades (future wiki material)

An invalid phone configuration or occupied listener used to occur after queue startup.
Main now validates configuration and binds both listeners before enabling work, with a
temporary readiness gate. Signals/lifetime-pipe loss during startup still close acquired
resources and release only this instance's lock. Shutdown stops queue admission before
waiting for network resources. Exact unrelated listeners are preserved. Seven startup and
eight launcher checks cover these failures, including a real compiled applet.

The live HTTPS check correctly refused a forged terminal upgrade with 401, but then hung
on app.close and exited with an unsettled top-level await. A denied raw socket reproduced
the issue locally: the security onRequest hook ran before the WebSocket plugin could mark
the request, so its response cleanup did not recognize the rejected upgrade. Registering
that plugin before the security hook supplies bookkeeping, not authorization; all existing
gates still run before acceptance. New 401 and startup-503 socket tests require actual
closure, no provider work and completed app shutdown. The real HTTPS script now passes
all requests and its cleanup with exit 0. A successful denial alone was not enough evidence.

## 2026-09-13 — fixture consistency after adding durable views (future wiki material)

The combined browser suite found an old native-child mock visible in snapshot/detail but
absent from the server's durable workspace validator. Reload correctly returned to a real
saved selection, exposing the inconsistent fixture. The test now seeds an actual child and
entry only in its explicitly verified demo SQLite, then checks real saved selection,
archive/reload and parent control. A separate MCP-form test now selects its validation
alert specifically, leaving a legitimate metadata retry warning visible. No production
validation or recovery warning was weakened to make a mock pass.

The source-only setup check starts without data, dependencies or compiled output. Process
integration tests need the current compiled server, so the root test command now builds
it first; a successful test against leftover developer dist is not clean-clone evidence.
Source-only setup/verification passed with a disabled real Codex executable and private
caches; it does not prove a pristine OS installer or physical phone setup.

## 2026-09-13 — browser assertions do not finish asynchronous fixtures (future wiki material)

The integrated source passed all 148 browser checks locally, but Linux CI reported
`apiResponse.json: Response has been disposed` in the MCP URL fixture. Its final visible
approval assertion could finish while the application's follow-up detail request was
still inside an asynchronous `route.fetch` handler. Browser-context teardown then disposed
the response before the handler read it. The other 147 checks passed; the failing run
still counts as a failure, not acceptable evidence for the final source.

Drain registered page/context route handlers before fixture disposal using the documented
[`unrouteAll({ behavior: 'wait' })`](https://playwright.dev/docs/api/class-page#page-unroute-all)
lifecycle. Do not swallow handler exceptions, add arbitrary sleeps or weaken approval
assertions. Five repetitions of the original journey and the deliberately held-response
regression passed at all four sizes (40/40); require a matching clean-checkout CI result
too. Tests own asynchronous fixtures just as the app owns provider/socket lifetimes;
a successful last assertion is not proof that teardown is safe.

Outcome: exact source `c476764` passed clean-checkout CI run 34788983230, including all
152 browser checks. The final documentation-only checkpoint records that result; it does
not change the verified application or test source.

## ORCH-001 — Native-child compatibility became a rabbit hole

Recorded 2026-09-08; observed with Codex 0.153.4. Status: startup race corrected and
same-child legacy recovery verified; optional checkpoint limitation documented. The
subsequent ordinary-worker activation also passed (see follow-through below). Do not
generalize these observations to every provider version or model.

### What happened

A real parent and native child wrote separate files, an independent reviewer approved
their combined commit, and that exact commit integrated into a disposable repository.
Ordinary child MCP consent and child plugin consent also worked. Compatibility probing
then kept growing around custom-agent selection, an initial metadata race, and a missing
child `dock_checkpoint` call. This was integration debugging, not the earlier plan/review
loop, but it was still consuming attention without advancing the normal user workflow.

### Evidence and dispositions

| Symptom                                             | What the evidence established                                                                                                                                             | How it was handled                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Writable smoke failed after successful work/review  | The assertion expected `fileChange`; the actual archived title was `File changes`.                                                                                        | Corrected the assertion and verified/integrated the **same** completed fixture. Did not repeat model work to manufacture a green run.                                                                                                                                         |
| Requested custom role was not selected              | An ordinary child succeeded, but its role provenance did not match the requested role. A feature flag alone did not select the older backend.                             | Checked the installed model catalog's `multiAgentVersion`, used a declared v1 model in the isolated probe, and explicitly registered `agents.fixture_reader.config_file`. Actual custom-role provenance then matched. No global settings changed.                             |
| Child activity arrived before metadata was readable | The first read failed because the initial rollout was empty; terminating the provider at that point left the child unreadable.                                            | Added bounded read-only retries for that exact error: at most eight reads, 1.35 seconds of backoff. Unrelated errors fail immediately. No turn/tool replay and no private provider path in the surfaced error. Real child registration then succeeded.                        |
| Older-style child did not save an app checkpoint    | Its visible conversation, MCP activity and final reply were retained, but no `dock_checkpoint` invocation was recorded.                                                   | An optional model-authored checkpoint is not a completion requirement when the relevant work/result/history are retained. Do not invent a checkpoint or claim the tool was unavailable merely because it was not called.                                                      |
| Follow-up after restart returned `notFound`         | The parent sent input and waited, but there was no new child turn. The exact old child archive remained. The parent had **not** first called the native resume operation. | Explicit native `resume_agent`, then `send_input` and `wait`, successfully reached the **same** saved child. A new child-owned reply and completed run proved delivery; old entries and IDs stayed unchanged. No replacement child, MCP execution or other child tool action. |

The custom-role probe verified **decline**, not acceptance after restart. The separate
ordinary-child and plugin probes do not fill that gap. A successful parent run also does
not prove its child received a message: inspect the child-owned result and run record.

Official [subagent documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
guided configuration and parent-controlled coordination checks. It does not establish
these exact installed-version recovery semantics; local protocol types and real retained
events are the evidence for those details.

### The bounded decision

Stop adding compatibility scenarios. Preserve the successful work, verify the concrete
resume sequence, and continue the core manager workflow. Keep optional checkpoint enrichment
separate from required visible-history retention, identity continuity and safe handoff.
Do not silently drop required native functionality or mark the whole product complete.
No further owner approval was needed for these isolated, reversible checks; existing
tool-consent and exact-integration gates remained in force.

The recovery result corrected our earlier diagnosis: `notFound` did **not** establish
lost provider history. This installed legacy backend needed its child explicitly loaded
before follow-up. The smoke now requests that sequence and requires a new child-owned
reply, not merely successful parent completion. Its optional-checkpoint assertions also
distinguish an actual tool call from retained conversation. The complete custom-MCP
decline/accept scenario has not been rerun after these harness changes.

### Follow-through: make verified behavior available to the owner

The next slice removed fixture-only enablement from the real write, plugin and native
viewing checks and enabled helpers in ordinary workers. Those existing checks then
passed on the production path, including exact reviewed integration and phone/local-CLI
handoff. Managers remain coordination-only and each worker has a two-open-helper limit.
This closes the gap between an isolated adapter success and an available application
feature. The optional checkpoint did not trigger more work, and the still-unverified
legacy/MCP surfaces remain explicitly recorded in STATUS.md rather than hidden.

### Guidance for future orchestrators

- After a failed check or non-approval, state the specific causal evidence and why the
  next bounded action should close it. A new independent failure domain is a separate
  task, not another clause in the same ever-growing plan.
- Distinguish application defects, test-harness defects, unsupported provider behavior,
  optional evidence enrichment, and missing authority. They require different responses.
- Require evidence for **delivery and effect**, not just a successful coordinator turn,
  a preserved transcript, requested configuration, or a green exit code.
- Preserve IDs, archives, worktrees and exact reviewed commits while investigating.
  Resume existing work where supported; do not silently spawn replacements or replay
  actions whose effects are uncertain.
- Retry a proven read-only startup race narrowly and with a bound. Never apply the same
  retry policy to approvals, writes, external actions or uncertain completion.
- A feature-specific gap is not a blocked overall goal while useful authorized work
  remains. Ask the owner only for genuinely missing authority or a material product choice.
- Record verified results and unresolved limits separately. Test counts, iterations and
  elapsed time are activity; delivered behavior or evidence that changes the next action
  is progress.

### Evidence location

Maintainer-only ignored fixtures: writable group `bd8acd29`, native plugins `742adef1`,
custom legacy child `811f454b`. These identifiers are breadcrumbs, not collaborator
dependencies. Portable coverage lives in `scripts/smoke-codex.mjs`,
`scripts/smoke-plugins.mjs`, `scripts/smoke-native-children.mjs` and the native-child tests.
See [VERIFICATION.md](VERIFICATION.md) for what actually ran and its limitations.

## ORCH-002 — A completed result is not necessarily code to integrate

Recorded 2026-09-08. Resolved: the UI treated every completed task as ready for Git
integration, including transcript-only research/plans. The server already had the
necessary private worktree/base/review records. A derived public boolean now drives a shared
task badge and hides the inapplicable action without changing completion or approval gates.
No migration, new task state, private path exposure or repeat model work was necessary.

The first rendered check caught one missed consumer: the sidebar changed, but the
workboard still used its old badge. Sharing the component closed that same finding;
desktop and all three phone checks then passed. Capture cards explicitly when the app
scrolls inside its shell: a full-page screenshot can omit the earlier results.

The subsequent live-data check caught a more important mistaken assumption: read-only
delegation also creates a worktree, and its review records the unchanged base commit.
The original synthetic cases omitted that state and passed without proving the actual
owner's case. Require a reviewed commit **different from the recorded base**, not merely
the existence of a worktree/review. Add the unchanged-worktree case to API/persistence
coverage and exercise actual delegation/review with a temporary Git repository, without
new model work. Validate the correction against the saved live task, preserving its archive.
That live check now passes at desktop and all three phone sizes after restart/reload;
saved task, conversation, event and run records still exactly match the pre-update backup.

Lesson: distinguish task completion, retained output and permission to integrate. Inspect
the existing authoritative records and real lifecycle before choosing test examples or
adding new state. A green presentation test can still encode the implementation's wrong
assumption; verify the owner-visible case before calling a change finished.

## ORCH-003 — Form input is not blanket tool approval

Recorded 2026-09-08 with Codex 0.153.4. Standard MCP forms now use the existing pending
request lifecycle, while original tool consent remains a separate decision. Malformed
consent cannot be treated as an ordinary form. Unknown schema extensions fail explicitly.

Two focused checks corrected assumptions during implementation. The schema library can
discard a raw `__proto__` key before validating a record, so inspect raw keys before
parsing; do not mistake a sanitized result for proof the input was acceptable. Recovery
correctly appends an interruption notice, so compare the exact old archive prefix and
the expected new notice, not an unchanged total row count.

The real fixture proved browser decline and typed phone submission, then reused the
same history for one native-terminal-originated request. Require the browser's recorded
decision **before** testing a duplicate reply: a harness fallback must not secretly answer
the request and hide a broken UI. Check new-run-owned tool results and fixture effects,
not matching markers in older history. False, zero, empty enum values and labels that
differ from values are useful cases. No credentials or external service were involved.

## ORCH-004 — Opening a URL, allowing a request and completing a flow are different events

Recorded 2026-09-08 with Codex 0.153.4. Explicit URL elicitation now uses the existing
approval lifecycle, not a new authentication subsystem. Keep the original tool consent,
page visit, URL permission and actual tool effect distinct. Only the last establishes
completion; a resolved approval or saved link is not evidence of successful sign-in.
Retain accepted links privately for handoff, but do not copy temporary URL tokens into
model-facing inspection. Old links may expire; never auto-open or replay them on recovery.

Two fixture assumptions needed correction. App Server changed empty response content on
the way to MCP (omitted on decline, `{}` on accept); assert each protocol boundary at its
own layer. The already-successful decline did not need another model turn. Separately,
the fake page's `no-referrer` response policy made its own form POST Origin `null`, so its
same-origin check rejected completion. A no-model browser probe reproduced the 403 and
verified a page-local `same-origin` policy fix. The app's outgoing link still has no
opener or referrer. Do not weaken the application's boundary to repair a test page.

The failed acceptance remained correctly interrupted, with its permission and link
retained but no recorded fixture effect. After inspecting that evidence, an explicit
new request completed once in the same saved session. Old IDs/history stayed unchanged.
The smoke distinguishes old markers from new-run-owned results. This proves local
transport and handoff, not a real provider login or secure remote phone access.

One actual integration defect remained: the native CLI's copy of a URL request was
immediately declined, racing the owner's card on the host connection. Leave URL-mode
requests to the already-subscribed host and keep ordinary native approvals unchanged;
do not turn an automatic decline into an automatic accept. The native tab now directs
the owner to Conversation. One new native request on the same fixture passed permission,
completion and restart. A terminal run before an expected prompt should end the harness
wait with its retained result, not consume the full observation timeout.

## ORCH-005 — A safe-looking default can silently remove a core capability

Recorded 2026-09-08 with Codex 0.153.4. While inspecting remaining terminal integration
gaps, the provider was found to force web search off for every worker. Continuing rare
form/desktop compatibility probes would not close this ordinary research-workflow gap.
One typed worker setting now controls the supported search modes; managers stay disabled.
Previously saved workers retain their old setting, while new workers use cached search.

Official documentation distinguishes hosted web search from command networking. A
read-only filesystem sandbox does not mean all external queries are blocked, and enabling
search does not require granting shell network access. Apply the intended setting at both
provider startup and context transitions. A saved dropdown value or requested config is
not evidence that the tool actually works: require new-run-owned search activity and a
cited answer. Cached chat and live native `/new` passed after phone selection, followed by
exact history/context restart; indexed enforcement has configuration, not live-network,
coverage. Keep that distinction explicit rather than expanding the compatibility matrix.

Two initial unit-test failures were harness assumptions: sharing one fake provider between
distinct agents reused a thread ID, and exact expected native configs still omitted the new
field. Correct those assertions without weakening role or ownership checks. Preserve the
real fixture for no-model re-verification instead of repeatedly paying for the same searches.

## ORCH-006 — Tool availability and retained results are separate requirements

Recorded 2026-09-08 with Codex 0.153.4. A broad "desktop integrations" flag group hid
a supported CLI capability: image generation. Official documentation distinguishes it
from the desktop-only browser. Do not infer capability from an enabled flag or recreate
a separate host just to make a terminal-parity checklist look complete.

One actual image generation succeeded, but the generic text archive truncated its encoded
result. Retain bounded raster bytes separately, keyed to the real agent/tool item, with
atomic metadata persistence and no raw filesystem-path access. A successful model turn
or a saved filename is not evidence the owner can inspect the result after restart.

The original protocol bytes were preserved, so a no-model recovery enriched the same
entry instead of regenerating the image. Its first assertion compared differently ordered
JSON object fields; matching the envelope validator's order closed that harness finding.
One subsequent native-origin generation proved actual capture, and both images passed
real preview/download/restart checks. The stubbed browser download was not treated as
proof of delivery: assert that against the actual server. Short-window screenshots also
caught an oversized preview; fit it to available height and provide explicit full-size access.

Keep the original failed/limited evidence, bound binary sizes, and distinguish an output
archive from external publication, source integration, hidden context or OS permissions.

## ORCH-007 — An acceptance checklist can become a compatibility loop

Recorded 2026-09-08 with Codex 0.153.4. After the core workflow passed, the status list
still mixed ordinary missing tools, optional provider extensions, unverified legacy
combinations and already-completed everyday checks. Treating every entry as an unfinished
product requirement would recreate the old non-converging loop without any plan reviews.

Classify each gap using actual evidence. Forced-off web search and unretained image
bytes affected ordinary worker outcomes and needed fixes. Extended OpenAI forms were
different: official documentation requires explicit client opt-in, and a no-model
private-socket probe captured the installed CLI's handshake without that capability.
Agent Dock does not opt in either. Leave unexpected requests explicitly declined; do
not invent a schema or spend model turns proving a feature that this CLI did not request.
This version-specific finding does not establish universal future compatibility.

Match original outcomes to existing real evidence, then verify a fresh source clone can
install, build, register an empty project and run without private maintainer state.
That check passed alongside 101 backend and 44 browser checks. It reused the existing
host's toolchain/login, so do not call it a clean-machine certification. No core workflow
was removed to finish, and no permission or integration gate was relaxed.

The bounded decision was to hand off local v1 for actual use with its limits visible.
Unverified legacy combinations remain unverified; remote phone hosting remains v2.
Missing optional checkpoints do not require replay, and missing exhaustive coverage is
not automatically a blocked goal. Reopen a small task for a concrete user-visible defect
or needed integration, not merely another possible permutation. See STATUS.md for the
acceptance mapping and VERIFICATION.md for the checks rather than growing this incident
into a new implementation plan.

## ORCH-008 — A developer setup check is not a usable first-run journey

The owner clicked Add a project and received `pnpm` instructions. The prior smoke had
registered a project from a terminal; the UI test actually expected those commands.
Both passed while the ordinary user action remained unimplemented. A clean checkout and
passing automation do not establish that someone without technical knowledge can use it.

Replace the dead end with a real name-and-description form and automatic private project
setup. Verify the actual HTTP endpoint and Git workspace, not just a success stub. Lose
the successful response intentionally, reload the form and retry: the same request must
resolve to one manager/project, without a second initial commit or automatic model work.
Keep filesystem choices generated and private; simple UI must not create arbitrary shell
or path access. Keep native/advanced capabilities available rather than deleting them.

The rendered check also exposed an unnamed shared dialog. Bind the visible title to the
accessible dialog name instead of weakening the test. Short-window screenshots showed
the Create action below the fold; keep actions visible while fields scroll. The resulting
107 backend and 52 browser checks pass. The broader nontechnical experience still needs
journey-by-journey review; this project-creation fix is not a packaged installer or proof
that every advanced integration has guided setup.

## ORCH-009 — Development previews need an owner and an end

Recorded 2026-09-08 after the owner requested no idle browsers or local app servers.
The audit found Agent Dock's intentionally installed background service, but no orphaned
development Chrome processes. Stop and disable that exact login service during development
so it cannot return at next login. Keep its installation and private history intact.
The remaining listeners belonged to macOS/editor services and were deliberately untouched.

Treat every preview/test browser and server as an owned temporary resource. Use teardown
on failures as well as success, verify the exact process/listener exits, and do not leave
the app running as a handoff convenience without the owner's request. Playwright now sends
its server group SIGTERM before its bounded cleanup fallback so the gateway can close
providers and clear its lock. The native folder chooser also aborts during gateway shutdown;
its focused test passed. This rule concerns development resources, not terminating the
owner's persistent agent sessions during normal use or killing unrelated Chrome/Node apps.

## ORCH-010 — An error behind a dialog is effectively invisible

Recorded 2026-09-08 during the owner-requested nontechnical usability pass. Shared action
handling put failures in a global banner while task/manager/integration dialogs stayed
open over it. Show the same failure inside the active form, retain its values, prevent
parallel submissions and preserve request IDs for retries. Keep exact reviewed versions
even when the visible action becomes the plainer "Apply changes". Do not replace a safety
gate with friendly prose or claim success merely because an HTTP request was sent.

Real creation acknowledgement-loss checks now prove one manager/task after retry. The
browser integration refusal fixture checks the unchanged exact source/target and same
retry ID; existing backend tests retain the actual Git gate coverage. New terminal help
first failed at 915x412 because an existing media rule hid footer notes. Move help to an
always-present control and keep alerts visible, then rerun that same journey. All 60
browser checks pass. Both failure and success runs cleaned up their browsers and gateway.
This closes those bounded findings, not all advanced setup: MCP connection creation and
authentication still use Codex's own setup and remain an explicit usability follow-up.

## ORCH-011 — Enrollment lifetime is not unlock lifetime

Future wiki material, 2026-09-09. The owner rejected phone account login/MFA and automatic
unpairing. Treat that as a corrected product requirement, not a missing authenticator to
keep requesting. Implement separate durable approved enrollment and short server-enforced
passkey unlock. Off/on closes unlocks but keeps devices; explicit removal revokes. Browser
storage can still disappear, and a synced passkey must not enroll an unapproved browser.
Phone biometrics/fallback stay on the phone. Background lock delivery is best-effort;
enforce finite server sessions and close open streams, not just a visual cover.

Real cryptographic tests found that passing a base64url challenge as a string to the
options generator encoded that string again. Generate bytes and pass the decoded byte
array while retaining the expected encoded challenge; test signed client data rather than
mocking verification. The confirmation path also called a non-nestable transaction helper
inside another transaction. Use a local savepoint for enrollment closure so confirmation
remains atomic. Persist a revision across lock/off-on to reject asynchronous stale unlocks.
Eight focused security/recovery checks pass; real browser/phone acceptance remains pending.
Retain the legacy gate until bounded replacement verification and controlled migration.

## ORCH-012 — Effective capabilities and misleading cache failures

Future wiki material, 2026-09-09. Standing owner authorization remained, but this resumed
session could edit source while Git staging was denied, Chromium failed before navigation,
and read-only Cloudflare MCP execute required approval under an approval-never profile.
Do not call these OAuth failures, ask for another blanket yes, change OS/security controls
or try alternate drivers/tokens. Record the exact capabilities together for the next owner
check-in. The agent continued backend, attention, queue and reproducibility slices instead.
Source is saved locally but not committed/pushed; a tool catalog is not proof of execute access.

npm also printed its generic root-owned-cache advice after a sandbox refusal on the global
cache. That is not evidence for `sudo chown`. Use project-local ignored package caches and
the pinned lockfile. Moving pnpm's store can require a normal dependency reinstall, not a
project/history wipe or version upgrade. A fresh source-only copy downloaded dependencies
and built. That is not a clean-machine or UI acceptance check. Close owned test processes
on all outcomes and keep current limitations visible instead of carrying old test counts
forward. See OWNER_CHECK_IN.md, CONTRIBUTOR_SETUP.md and VERIFICATION.md.

## Adding a future incident

Use an `ORCH-###` heading with date/version, symptom, observed evidence, bounded action,
verified outcome, unresolved limits and a general lesson. Update an incident when its
outcome changes; do not erase the earlier failure or turn the note into a task backlog.
