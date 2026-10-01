# Connected application build

Research/planning tasks now use existing read-only files and can finish with the manager's
recorded evidence, without an automatic branch or review loop. Implementation still creates
isolated work and requires independent review plus exact owner confirmation. Requested reviews
remain binding; a task cannot finish while its workers or local computation are still active
or paused. Existing result/history screens use the same task and decision records.

## First private phone connection — 2026-09-29

- [x] Offer optional no-domain Tailscale setup with native readiness and HTTPS guidance.
- [x] Confirm the exact address before initial save; retain existing configurations.
- [x] Reuse the phone listener, passkey pairing and owned foreground connector lifecycle.
- [x] Recover lost confirmations and retry listener failures inside the app.
- [x] Check API/persistence/process behavior and five desktop/mobile browser profiles.
- [ ] Accept a real private Serve connection and physical phone; no owner network change assumed.

Guide material is in [Phone setup](PHONE_SETUP.md). Existing domain setup remains agent-led.
This uses the existing app lifecycle and introduces no permanent network service or second
pairing mechanism. Live owner Cloudflare is preserved; see dated verification for rollout.

Guide note (2026-09-29): managers receive shared QUARK changes while they are already working.
The update shows remaining room, active/waiting jobs and stop reasons. It coalesces ordinary
changes and does not wake an idle model for each event. Full evidence stays available on
request; QUARK can stop owned work even when the manager has not reached its next update.

Guide note (2026-09-29): each registered Claude helper can retain its native replies/tools,
reported model and observed input/cache usage even when transcript writes arrive late. Ask
about a finished helper uses that saved evidence and reported model; it never silently reopens
the finished task. These are partial counters, displayed separately from the parent team’s
charge. Output placeholders, missing files and nested ancestry are not guessed.

Native question/setup slice (2026-09-29): Claude can ask questions in the existing conversation
and receive selected or written answers once, including multiple choices. The original request
and submitted answers stay local. Long forms open at their first question and do not jump during
reading. Helper completions cannot end the parent turn. Installation now permits either provider
independently, or opening setup before either is present. This uses the existing adapters and UI;
it does not import md2's action framework, scheduler or conversation-in-Git storage. See VERIFICATION.md.

The owner requested the entire backend fitted to an AI-designed, polished web/mobile app,
using the existing **sciencewithagents · built** Sketchcoded board. Aesthetic revisions
come afterward; complete functional journeys first. This supersedes the earlier request
to stop at Home and placeholder destinations. Keep guide material as behavior is verified.

The board is the screen/navigation specification (30 AI-built frames, no drawings needed).
The independent September review remains the defect reference outside the repository;
do not copy private owner prompts or reviewer logs into the public source. Work in bounded
vertical slices and retain histories, identity, quotas, exact approvals and integration gates.

## Initial connected slice — historical evidence

- [x] Read the live board, its five relevant skills and shared build rules.
- [x] Implement projects → project → manager and task → worker navigation in the new shell.
- [x] Reuse durable message/draft/approval controls, with actual API-backed creation and chat.
- [x] Guard finished task workers against new execution and late completion reopening reviews.
- [x] Add explicit read-only follow-up discussions with evidence retrieval and task accounting.
- [x] Verify this slice on desktop/mobile/real tab zoom, new-project creation and lost-send retry.
- [x] Update the built board (revision 19) and capability/guide material.

At this initial checkpoint, the board still contained unconnected journeys and the review
had remaining backend/setup findings. Subsequent slices below and [current status](STATUS.md)
supersede that handoff. The later native-discussion slice extends the original saved-evidence path.
Do not describe all 30 screens, deployment, physical phones, clean installation, native leases,
or transient QUARK recovery as complete based on the first slice's checks alone. The
separate QUARK reliability slice below supplies its own evidence.

## Guide material

**Projects:** Add project creates a private project and manager without starting a model
turn. Existing-folder selection stays a computer-native action. Choose the central provider
default or an explicit provider; work starts only after sending a request. Project pages
show tasks and managers; task pages show the deliverable, acceptance criteria, review and team.
They also collect current jobs, pause reasons, inherited caps, planning estimates, recent token
readings and decisions. Job links open existing controls; budget links preselect the task.
Opening these views creates no work. Missing readings stay visibly unavailable or stale.

**Setup and finding chats:** Model and reasoning controls show their resolved values.
Managers prefer xhigh when supported; explicit saved choices win. Worker defaults open
above the sliders, and priority/usage can be refined later by talking to the manager.
A cap is a share of the whole allowance, not the remaining balance. Back or a right swipe
returns from a QUARK detour to the saved project setup. Home starts a fresh navigation
trail. **Assisted search** opens its own description prompt, separate from the name filter;
it only runs on Search. VS Code status and extension instructions are at the top of Chats.

**Which conversation is which:** **Chats → Shared** contains your shared VS Code and
compatible native Codex conversations. Sharing keeps the original conversation, history
and agent; it does not create a manager. **Managers** lists managers for projects you
create. Inspect a delegated worker through its project/task, and find resource assistance
and past health reports in **Computer health**. Development and service agents do not
count as your project managers.

App-created Codex sessions carry an ownership marker, and native subagents retain their
parent identity. Our shared/history pickers exclude these helpers. Finished app-owned task
workers and released resource/search helpers are also archived in Codex, preserving their
transcripts; explicit reuse of an eligible owned session restores it before continuing.
Imported personal chats are left alone. The native VS Code history picker can still show
an active standalone helper until it is archived, so the guide must not promise universal
invisibility. See [helper visibility and native limits](VSCODE_MIRROR.md#helper-visibility).

**Conversation drafts:** Drafts remain scoped to the browser and computer. Reloading restores the saved text; deliberate
send uses the existing durable delivery receipt. Touch-keyboard Enter inserts a newline.
Approvals display the original request and use the original answer endpoint.

**Ask about this work:** A finished worker opens as a saved record. The explicit action
creates a separate read-only discussion using the recorded provider, model and effort.
It supplies the original checkpoint and recent evidence; the agent can retrieve older
messages, tool results and decisions. Saved evidence is labelled as a new reconstruction.
For eligible workers, **Discussion context → Original Codex/Claude conversation** instead copies
native history through the recorded final reply on the first question. It keeps the selected
native source boundary even if another source turn is later recorded. A missing boundary,
unavailable history or incompatible runtime fails visibly; choose saved evidence explicitly.
For Codex, the original goal must be paused/complete or absent; only the new branch’s inherited goal is
cleared. A lost fork acknowledgement is not automatically repeated. Copied historical token
totals do not become new spending; the initial observed slice can remain partial.
Claude requires the latest completed root reply’s native UUID, captured while that run was
active. Older records and native helpers use saved evidence; a helper does not inherit its
parent’s whole session. A durable target ID and start receipt ensure uncertain fork startup
resumes only the same copy. Missing/compacted-away history fails visibly. Neither path exposes hidden reasoning. Missing evidence stays
unknown. Creating/opening it starts no model turn. Its actual turns use QUARK and count
toward the original project/task caps; they cannot silently refill an exhausted grant.
It cannot contact workers, dispatch jobs, change reviews, widen permissions or open a
native terminal. The original task, conversation and approval remain untouched. Claude
keeps the original recorded account affinity. These discussions receive no cache nudges.

**Layout:** The shell fits the window; content panels scroll with visible scrollbars and
direction hints. The same navigation works on desktop and phones. Screenshots, browser
fixtures and runtime evidence remain under ignored `data/`, outside the shareable source.

## Verification and deployment of this slice

468 backend tests passed; the final admission/cache edits then passed 38 focused regressions.
All workspaces typecheck. The current browser suite passed 71 checks (four duplicate zoom
projects skipped), including 48 real-tab-zoom route/size combinations. The 17 selected
classic checks pass: 16 initially, then the native-child test after correcting its stale
fixture database path. Builds and repository formatting pass. CI now installs WebKit as
well as Chromium; this is a configuration correction, not a claim of a new hosted CI run.

The owned app was restarted from a verified recovery copy with no queued/running jobs.
All 17 checked history/device/draft tables and four policy/settings hashes are unchanged;
SQLite quick_check is ok and the existing phone connection is connected. No paid model
probe, source publication, new pairing or login service was started. Test servers/browser
contexts and the task-owned Sketchcoded server are closed. Private evidence stays under
`data/build-flow/`, `data/screenshots/workspace/` and `data/zoom/`.

## QUARK reliability slice

- [x] Separate budget/manual/lease holds from monitoring/reset/headroom/cache holds.
- [x] Bound use of a last good reading; recover only after a fresh reading and confirmed stop.
- [x] Preserve uncertain restarts, explicit caps, owner pauses and automatic-turn bounds.
- [x] Admit native turns before forwarding input; sign manager leases and monitor exact turns.
- [x] Cover native cancellation, lost acknowledgements and unsolicited manager starts.
- [x] Verify 480 backend tests, 10 focused browser checks, strict types/builds and formatting.
- [x] Deploy from verified recovery copy; preserve all 17 checked tables and four settings.

## Work, attention and exact review slice

- [x] Connect Work, job detail, Attention, Recent Results and local transcription pages.
- [x] Expose shared queue pause, concurrency, pacing, priorities and estimates in the new shell.
- [x] Connect task → exact reviewed changes → explicit apply confirmation with retry receipts.
- [x] Correct divergent previews and provide a separately reviewed reconciliation task in-app.
- [x] Verify 485 backend tests, 86 browser checks and 88 real-tab-zoom route/size combinations.
- [x] Deploy from verified recovery copy with all 17 protected tables/four settings preserved.

**Guide material:** Work controls shared admission; Pause new work lets current replies
finish. A job can wait because of priority, budget, headroom, a task writer or your pause.
Job details retain those reasons and the link to its conversation. All usage holds the
percentage caps and token ledger. Attention opens original requests and review records;
merely opening a card never approves or resumes anything. Recent Results links back to
the task/team or local transcript. Local transcription preserves the video/priority draft
across reload and shares computer resources with agent work.

**Applying work:** Review the outcome, independent review and exact file changes. Apply
opens an explicit confirmation tied to the shown project and reviewed versions. A lost
response retains the same receipt; changed versions require a new preview. When parallel
tasks diverge, the preview shows only this task's branch changes, not false deletions of
other work. Prepare updated changes creates one new task for the same manager, inherits
the original task's allowance ancestry and asks for another independent review. The old
review/worktree stays intact. Nothing is applied by requesting the follow-up. Its task
becomes the attention destination until a new exact result is ready. No terminal Git
instructions are required to request reconciliation.

## Conversations, settings and connection recovery

- [x] Connect the personal assistant and explicit project/privacy settings.
- [x] Connect shared editor chats with original provider/thread identity and retained drafts.
- [x] Connect saved-history search, browser view handoff, computer selection and phone controls.
- [x] Connect recovery copies with verified creation and exact retry receipts.
- [x] Recover obsolete browser registration without replaying requests or deleting drafts.
- [x] Keep transient connection failures separate from a real authentication failure.
- [x] Preserve phone enrollment across transport changes; retain trust-change revocation.
- [x] Verify 488 backend tests, 116 current/45 classic browser checks, then 35 final focused checks.
- [x] Deploy from a verified copy; preserve all 17 checked tables/four settings and phone trust.

**Personal agent:** Creating the conversation starts no model turn. Choose its provider
from the central policy or explicitly, then choose which projects it may inspect and which
preferences, priorities and commitments to remember. It explains saved evidence and sends
bounded requests to visible project managers. Removing access prevents future reads/routing;
it cannot erase information already retained in a conversation. Ordinary project lists do
not count the assistant's internal project. Privacy saves compare revisions and retain an
exact retry receipt; another browser's change is shown for comparison.

**Editor chats:** Share a Codex or Claude conversation from the companion in VS Code. The
same provider/thread opens here; selecting another chat never retargets an old draft.
Reload preserves the selected conversation and draft. If sending has an uncertain result,
Check delivery reads its existing receipt. Offline chats retain their identity and reconnect
without sending anything. Models, tools and permissions stay in the original editor. On
touch devices Enter inserts a newline; the Send button sends. Native editor activity remains
outside the app's complete admission control.

**Saved history and views:** Find projects/agents by name, then choose a project to search
its saved conversations, tool results, agent messages and decisions. Reading evidence does
not start work. Open conversations records browser views; closing one leaves its work and
draft intact. Continue here adopts a chosen browser's views without closing them there.
Drafts remain separate until explicitly copied. If a restored computer forgot a browser,
the browser registers again, retaining local drafts and archiving the old pending view
request instead of replaying it against a new workspace.

**Connections and copies:** Settings exposes computer selection, existing phone pairing,
lock preferences and local recovery copies. Computer selection reloads the document so
an in-flight form cannot change accounts. Copy creation/verification is explicit; retry
checks the same copy. Live restore remains a controlled setup-agent operation into a
separate location. Adding a new computer and provisioning initial phone transport still
need their setup flow; exposing existing controls alone does not finish first-run setup.
Transient 503/HTML connection failures retain the workspace; actual 401 responses request
phone authentication. Phone trust now depends on its public origin and authentication
identity, not the private listener port. Migration preserves an exactly matching old
configuration; an unprovable old configuration still requires re-pairing.

Next bounded slice after advanced controls: first-run/provider readiness and the remaining
setup/review findings. Codex and Claude native-history branches now extend saved-evidence
discussion. Bounded live text-continuity checks pass for both providers with original history
unchanged; missing/compacted histories still fail visibly. The overall goal remains active.

## Session controls, manual tasks and Codex history

- [x] Connect Advanced controls, native Codex, session settings, export and saved-session import.
- [x] Connect project task/module-manager creation with durable drafts and creation retry receipts.
- [x] Admit manual/native context compaction through QUARK and preserve task/review/turn bounds.
- [x] Read Codex history through a temporary metadata client in Claude-managed projects.
- [x] Allow literal absolute paths while retaining explicit native command controls.
- [x] Correct the stale routing-off label; retain exact session model choices on reopening.
- [x] Verify 493 backend/151 current browser checks and 168 zoom combinations; deploy with retained data.

**Starting work:** Project → Add task records an outcome, acceptance criteria, responsible
manager, priority and planning estimates, then queues the manager. Set an allowance cap from
All usage before starting if needed. Add manager gives part of the project its own coordinator
and sends no model request. Both forms retain drafts and freeze submitted details after an
uncertain response. Checking the request uses the same receipt. A confirmed validation error
allows correction. Browser storage failure is explained; keep that page open in that case.

**Advanced controls:** Open a conversation's Advanced controls for session model/effort,
original provider settings, export and existing Codex history. Opening this screen reads
metadata only. Explicit pins stay visible even if a model disappears from the current catalog.
New context retains visible history but retires working context. Continue is a new request
and can spend allowance. Compact is Codex maintenance subject to QUARK; it cannot complete
the assignment. Confirmations retain their exact command receipt across reload. An unresolved
provider operation is not automatically replayed; inspect conversation/work before explicitly
allowing another request. Native Codex opens only on request, and Return to conversation
releases native control. Closing the browser retains the native terminal; reopen its controls
to reconnect or return to chat. Claude's native commands remain in Claude Code/shared editor.

**History and literal messages:** Browse saved Codex sessions in any work project, including
one whose manager uses Claude. Import requires explicit confirmation that its original client
has stopped. Reading/importing does not send a model turn or convert the manager to Codex;
imported conversations begin read-only. Full native historical subagent relationships are not
reconstructed by this import. Unrecognized slash-prefixed messages retain their draft and
provide Send as text for file paths/literal text, alongside the native command route.

Verification: all 21 selected classic desktop checks and 30 final advanced-flow checks across
five browser profiles pass after visual polish. The idle owner deployment retained all 17
checked tables/four settings and the connected phone, using a verified recovery copy.
First-run/provider readiness is next. No live native model or physical phone proof is implied.

## First-run provider readiness

- [x] Add explicit enabled-provider choices to central model policy; preserve saved owner policies.
- [x] Default a new empty installation to Codex only until another provider is deliberately enabled.
- [x] Show metadata-only account/model readiness and retry without starting tasks or copying credentials.
- [x] Connect the board's Welcome/setup progress to providers, model choices and first-project creation.
- [x] Verify single-provider dispatch, stale/missing catalogs, saved pins and first-run recovery.

Keep native and existing conversation identities intact. A transient outage never authorizes
routing to a different provider. Sign-in remains the person's action; initial source/runtime
installation and optional phone transport keep their explicit setup boundaries.

**Guide material:** Welcome and setup opens for an empty workspace and remains available in
Settings. Check this computer reads the existing native account and actual catalog without a
prompt. Missing sign-in, unavailable checks, missing families and stale readings are distinct.
Choose team defaults saves provider choices centrally. With one provider, automatic managers,
workers and routine checks stay there. Exact model pins and original conversations remain
intact. Creating the first project starts no work; sending its first message does. Phone setup
is optional and separately linked.

**Codex sign-in:** A person explicitly requests a one-time device code and completes sign-in
on OpenAI's page. The app uses the [native auth API](https://learn.chatgpt.com/docs/app-server#auth-endpoints),
not copied credentials. Reload/check status recovers the same pending request. Its runtime
expires after 15 minutes; codes can expire earlier at the provider. Cancellation, completion,
transport failure and app shutdown clear the displayed code. An app restart does not replay
sign-in. Existing accounts/custom authentication are not replaced.

**Claude sign-in (Mac):** After a check confirms that Claude is signed out, Sign in with Claude
opens a native Terminal window on the selected Mac. Follow Claude’s browser instructions there,
then choose Check Claude sign-in in Welcome. No command typing or copying credentials into the
app is needed. Passwords/codes stay with Claude. A lost response or app restart reads the saved
attempt, never starts another login; Open another sign-in window is an explicit recovery action.
An unavailable check is distinct from signed-out. Existing/custom accounts are retained. Close
the native window after finishing; the app does not monitor it or promise that opening means
authentication succeeded. Native window opening is Mac-only and disabled in demonstration mode.
Initial source and phone provisioning remain separate work.

Verification: 501 whole-suite backend checks and 29 final focused checks pass; the new-interface
cases total 166 after correcting the old empty-home expectation, with 51 final focused browser
checks and 176 zoom combinations. The idle owner update preserved 17 tables/four settings and
phone trust from verified recovery copy `84c896a4-1cb0-4520-a7b4-5d406f287bf4`.
The overall goal remains active. The subsequent installation/launcher slice below completed
that handoff; current acceptance and verification are in STATUS.md.

## Installation and launcher resilience

- [x] Retain stable Node/Codex executable entries through routine upgrades; validate explicit selections.
- [x] Give Finder launches a bounded host-tool search path for GitHub and the phone connector.
- [x] Check the Codex CLI prerequisite before installation succeeds; keep optional reader failures recoverable.
- [x] Explain cloud-synced source locations and make setup errors retain existing data and choices.
- [x] Verify replacement symlinks, stripped GUI environments and missing prerequisites in owned fixtures.

Do not upgrade the owner's global tools, replace unrelated apps, enable a login service or
change native account credentials. Keep this separate from first phone transport provisioning.

**Guide material:** The setup agent checks prerequisites before installing the app. Keep live
work in a local folder; a cloud-sync warning does not move existing files. A failed optional
usage reader is a retryable setup step, and unknown readings remain unknown. Installed app
launchers retain stable executable entries through ordinary installer updates. They carry
known tool locations into Finder launches, so phone and GitHub controls can find their tools
without changes to the person's shell settings. Old launcher copies remain recoverable.

Verification: 19 focused launcher/setup checks, then a fresh source-only installation with
507 backend and 81 companion checks, strict types and production builds. Its 345-file source
copy and test processes were removed. The updated owner server uses the stable Node entry;
17 protected tables/four settings remain unchanged after verified recovery copy
`df4e8f17-62e8-46fc-a64a-b8bf4287dfcc`. Both verified installed app bundles were updated with
private previous copies retained. The existing native applet stayed alive; its next normal
open loads the replacement bundle. No browser or login service was started by deployment.

## Reusable QUARK access for other agents

- [x] Add a typed local client path for cached usage, resources, job status and bounded task requests.
- [x] Authenticate client requests with an installation-owned private secret; never expose provider credentials.
- [x] Apply requested task allowance caps before queue admission and retain exact retry receipts.
- [x] Provide CLI commands plus a tracked, portable QUARK skill and short agent-facing guide.
- [x] Keep managed manager leases, owner-only budget increases, reviews and exact apply confirmation intact.
- [x] Verify request recovery, cross-project scope, invalid quotas and no-model read behavior.

The bridge requests app-managed work; it does not intercept arbitrary external CLI/editor
agents. The broader local-browser/companion login boundary and delegated-worker tool grants
remain separate corrections, not security claims made by this client adapter.

**Guide material:** Another local coding agent reads the same cached allowance and resource
reports, then submits a request file to an existing project manager. New task caps and the
first queued manager turn are atomic. Exact retries recover the original receipt; they do
not create a second assignment. The client can neither enlarge existing grants nor approve
work. Separate provider/window caps are explicit. Its source-packaged skill needs no global
installation, and app-managed managers continue using their typed tools and signed leases.

Verification: 515 backend checks, all types/builds, ten focused browser checks across five
profiles and skill validation pass. The idle deployment retained all 17 checked tables/four
settings and phone connection from verified recovery `7c6218b7-9c4a-44d1-a9ba-bdf794682026`.
The compiled local client read both cached providers and computer health; no live work was
submitted. The overall goal remains active.

## streamed history and local-process startup

- [x] Store compact entry-change events without copying the accumulated reply on every delta.
- [x] Preserve complete saved entries, history, exports, approvals and live invalidation behavior.
- [x] Start the owned local-process supervisor in both source development and compiled apps.
- [x] Verify persistence, streaming regressions and exact process cleanup; preserve existing archives.

This does not delete or rewrite old events, clean finished worktrees, or close unrelated processes.

**Guide material:** Long conversations keep their complete reply and tool evidence without
permanently duplicating the growing reply in each change event. Replies also stay intact
when many tool results arrive between text fragments. This is prospective storage behavior;
no existing history is deleted. Development transcription uses the same owned pause/resume
and shutdown behavior as the compiled app.

Verification: 518 backend tests, strict types and five browser profiles pass. Both supervisor
modes were exercised as real owned processes. The idle deployment retained protected history,
settings and phone trust; no historical events were rewritten. See VERIFICATION.md.

## existing folders without setup commands

- [x] Native folder selection distinguishes ready projects from folders needing local history.
- [x] Offer explicit in-app Start tracking, preserving existing files and provider choice.
- [x] Retain selection/init receipts across connection loss, failures and restart; reject substituted folders.
- [x] Verify folder initialization and recovery through real APIs plus desktop/mobile UI.

Nothing is published. Existing repository history/configuration stays intact. Browser requests
never supply filesystem paths. This does not provision phone transport or other computers.

**Guide material:** Use an existing project folder opens the native chooser on the Mac.
A ready project opens with its existing manager. An ordinary folder shows its name and an
explicit Start tracking action. It saves a local starting version and creates a manager;
files stay in place and no model or upload starts. Check tracking request recovers an
uncertain confirmation after reload. Known setup failures allow retry or a new folder
selection; partial owned initialization remains recoverable. Existing ignore rules take
precedence over the app's additional local environment/dependency exclusions.

Verification: 521 backend checks, strict types/builds, 21 current-interface checks (including
176 zoom combinations), eight classic checks and five final folder-recovery checks pass.
The deployment preserved every pre-existing checked history row, settings and phone trust.
One already-enabled automatic health check added its new records during startup; no owner
folder was initialized. The overall goal remains active; drawings do not block remaining work.

## visible QUARK setup defaults

- [x] Enable shared pacing for a genuinely new, empty installation before work is created.
- [x] Preserve existing workspaces, provider settings and explicit saved pacing choices.
- [x] Show pacing and missing usage readings in Welcome, linked to working owner controls.
- [x] Verify cold startup, persistence and responsive setup without automatic model requests.

**Guide material:** New installations begin with QUARK sharing provider allowance and computer
capacity across projects. Welcome makes that setting visible alongside missing/stale readings.
Use Review pacing or Inspect usage to open the working controls and wait reasons. Existing
settings are retained; opening setup reads state without enabling work or changing policy.

Verification: 523 backend checks, strict types/builds, 21 Welcome/zoom checks and 176 zoom
combinations pass. The real cold-start fixture has pacing on with zero projects/agents/jobs.
The idle deployment retained all checked owner tables/settings and the phone connection.

## Optional phone startup failures

- [x] Keep the local workspace available when phone configuration or its listener cannot start.
- [x] Retain trust/device records while unavailable; never start a connector to an unrelated listener.
- [x] Explain the repair state in phone settings without exposing diagnostics or credentials.
- [x] Verify malformed config, port conflicts, paired-device retention and local startup/shutdown gates.

The local listener remains required. This does not provision a new tunnel, change accounts,
choose a public domain, or silently substitute an authentication mode.

**Guide material:** Phone settings explain when configuration or the phone listener needs
repair. Desktop work remains available. The app retains pairing and saved enablement but
keeps phone access closed; it never connects a tunnel to an unrelated service. Rechecking
reads status only. After the original settings are repaired, reopen the app to validate and
start that connection. A real trust change still requires new enrollment.

Verification: 525 backend tests, strict workspace types/builds, 15 connection browser checks
and six final recovery/zoom checks pass, including 176 zoom combinations. Small-phone repair
copy was inspected. The idle owner update retained all 17 checked tables/four settings,
SQLite integrity and the connected phone; the verified recovery copy is recorded in
VERIFICATION.md. Test processes and listeners are closed.

## Research source backup checks

- [x] Count distinct path/object versions rather than repeated unchanged tree entries.
- [x] Allow ordinary research data/log/database files while retaining credential checks and
      refusing this installation's private runtime paths throughout exported history.
- [x] Give an authorized push a longer bounded timeout; retain remote verification and retry receipts.
- [x] Exercise real Git research histories, renamed/deleted sensitive files and runtime-path isolation.

No destination, account or publication setting changes. This does not yet add in-app backup
provisioning or make a source backup a conversation/full-computer backup.

**Guide material:** Research folders and databases may be part of explicitly configured
private source backups. Renamed or deleted credential files and the installation's private
runtime remain excluded throughout exported history. Unchanged file versions count once;
large histories/files still need inspection. A slow push gets a bounded two minutes and
an uncertain response is checked remotely before any retry. Backup configuration, approvals,
local edits and destinations are unchanged by this correction.

Twelve real-Git backup checks and the strict server production build pass. Tests used only
local bare repositories. The idle owner update used a verified recovery copy and preserved
all 17 checked tables/four settings; SQLite quick_check remained ok. No backup destination
was created or changed. See VERIFICATION.md for the exact rollout receipt.

## Authenticated local access slice

- [x] Protect local private reads, writes, event streams and sockets with installation-scoped
      credentials while retaining the existing protected phone entry.
- [x] Open a browser through a short-lived, single-use native-app handoff; keep durable
      credentials out of URLs and preserve saved drafts/history through reconnect.
- [x] Give the editor companion its own narrow credential and clear one-time connection flow;
      retain pinned authentication for configured other-computer gateways and the QUARK client.
- [x] Exercise anonymous refusals, credential boundaries, restart/replay, browser handoff and
      responsive reconnect before enabling it in the normal launcher.

Use the signed-in OS account's private installation files. No provider-token copying,
account switching, public entry, global model hook or forced editor reload is part of this slice.

The normal server now enables the local guard. The native app/advanced CLI use private
handoffs or one-use owner proofs. Companion 0.2.4 has a Connect this editor code flow and
SecretStorage connection pinning; configured gateways prove their own narrow authority
before requests, streams and sockets. No reusable key is sent in request headers or URLs.
Existing demo fixtures remain separate from owner data.

The browser migration is now implemented in the optional protected server: top-level,
one-use form handoffs retain shared drafts and the original tab's editor/pending records.
An already-open tab must reconnect itself to retain its own session storage; a new native
tab cannot read that other tab's storage. Conflicting versions are kept separately in the
Recovery page, with readable text and download. Originals are never deleted, current drafts
are never overwritten, and reconnecting performs no model turn or operation replay. Transfers
are bounded at 2 MiB; oversized/unavailable storage offers recovery without removing originals.

Verification: 543 backend and 85 companion checks, strict types/builds, 55 connection/browser
checks and real zoom pass. The actual companion client connects and reads the exact shared
conversation through the protected backend. The installed owner app was updated from a
verified recovery copy with all 17 checked tables/four settings unchanged and phone connected.
Real owner Chromium/WebKit handoffs passed without an operation replay or model turn.
Companion 0.2.4 is installed; the running editor is not forcibly reloaded, so activation and
its one-time connection remain for the next safe reload. Physical phone/other-host certification
and a live provider mirror after that activation are not claimed. See LOCAL_ACCESS.md.

Next bounded work: delegated-worker tool access and the remaining first-run setup journeys.
The overall goal is still active; release decisions and physical-device checks remain separate.

## Delegated Codex worker tools

- [x] Add owner-controlled project allowances for configured MCP servers, installed plugins/apps, web search and images.
- [x] Let either provider’s manager request a bounded subset for each new Codex worker through the shared delegation contract.
- [x] Recheck the allowance before worker creation; retain selected tools/revision and exact retry receipts.
- [x] Preserve saved worker choices and original native approvals; reject unsupported provider/tool combinations without rerouting.
- [x] Provide responsive project controls with stale-edit refusal, catalog retry and retained uncertain saves.

**Guide material:** A project owner chooses the available tool set once. Managers equip each
new worker only with what it needs. Catalog reads do not start a model or reveal credentials.
Existing conversations retain their choices; indexed search cannot become live search without
owner permission. The new request field may need an explicit New context for an older Codex
manager because native tool schemas persist with the context. See WORKER_TOOLS.md.

Managed Claude external tools and opt-in native automatic approvals remain unfinished parts
of the original review item. The overall goal is active; this slice does not certify parity.

Verification: 548 backend checks and production builds pass; the final focused browser/zoom
run passes in 24 seconds after removing an unnecessary fixture refresh wait. The idle owner
rollout retains all 17 checked tables/four settings and the connected phone, with verified
recovery `45ad50d6-b15a-476e-b4af-c47c007690f0`. No owner tool allowance was enabled by deployment.
See VERIFICATION.md for precise coverage and remaining provider/context limits.
