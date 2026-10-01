# Design decisions

## 2026-10-01 — remove app locking, retain secure pairing

The owner explicitly removed physical-device security from the app. This supersedes all
older repeat-lock, unlock-session and Stay signed in decisions below. Keep the temporary,
attempt-limited code, passkey registration, exact computer confirmation and closed enrollment.
Only an approved browser's random credential authorizes private routes. Keep HTTPS,
host/origin checks, protected cookies, revocation and remote-admin restrictions.
Remove unlock routes, UI, preferences, inactivity/background timers and obsolete session
tables. Migrate approved devices without changing their credentials or setup/history; revoked
devices remain revoked. Turning access off closes connections while off; turning it on
restores approved access without verification. Remove device remains the explicit revocation.
Passkey creation may ask for phone verification once during enrollment; ordinary app use does
not. Browser storage loss can still require pairing again. Never promise an unhackable app.

## 2026-10-01 — general model preferences and project choices

Extend the existing revisioned model policy rather than maintain competing task editors.
Save general worker mix, spending and per-purpose overrides there; use one shared snapshot
function in setup and project registration. Manager provider/model/reasoning remain independent
of worker sliders and pins. Snapshot both manager and worker choices when creating a project,
so later general edits do not rewrite projects. Latest families still follow available versions;
explicit version pins stay exact. Legacy projects retain prior behavior until explicitly edited.

Seed recommendations from the owner's corrected matrix, Balanced + Tokenmax, adapting to Only
for single-provider installs. Restore recommended defaults fills the form; Save applies it.
Retain enabled subscriptions, native conversations and existing projects. Keep ordinary app
assistant choices separate from project workers while reusing the same central model mappings.

## 2026-09-30 — separate personal chats from app-created helpers

Preserve explicit project `internal` metadata in snapshots. Development/service projects
stay out of Managers, Projects, Home counts and QUARK project navigation; accounting and
saved evidence remain available. Do not infer ownership from project names.

New app-created Codex contexts carry `threadSource: sciencewithagents` plus a durable
local ownership record. Native subagent ancestry and that provenance are excluded from
our shared/history pickers. Imported and personal editor sessions retain native ownership.
On existing finished-task/resource/finder cleanup, archive proven app-owned Codex sessions
using native `thread/archive`, retaining transcripts. Explicit reuse restores an archived
owned context before resuming; never automatically restore an imported personal chat.
Archive failure records an event and does not fail finished work.

The installed Codex App Server still reports custom-client contexts as `source: vscode`.
Its analytics tag does not change native picker visibility. Native subagents are normally
excluded by source filtering, but active standalone helpers can still appear in the native
VS Code picker until archived. Do not claim an always-hidden native flag, use ephemeral
history, patch vendor UI, or rewrite Codex's database to conceal that boundary.

## 2026-09-30 — setup status and obsolete task closure

The owner clarified that Home’s VS Code button shows setup status and extension
instructions. It must not navigate to a chat list. Existing conversations stay in Chats.
A missing live connection does not establish that the extension is uninstalled.

Add an owner task-closing action for assignments superseded outside the normal manager
flow. Save a reason, cancel only that task’s queued agent replies and retain the task,
worktree, conversations, review and quota history. Refuse running work and unresolved
subtasks. Closed workers cannot resume their old implementation; a saved-evidence discussion
remains available. This is an explicit closed disposition, never a fabricated independent
review or source integration. Reuse the existing receipt, task status and event mechanisms.

## 2026-09-30 — supported existing Codex shared sessions

Use the current native daemon’s supported Unix WebSocket protocol for already-running Codex
conversations, including compatible terminals. Reuse the existing chat pages, transcript mapper,
paging and durable send/Stop receipts; no generic browser RPC, new runtime launcher or global
hooks. Discover only loaded sessions and preserve native ownership, model and permissions.
Following the native managed socket link is required; validate its resolved same-owner socket.
A known pre-first-turn history limitation is shown explicitly rather than inventing history.
Native and phone input may join one turn; exact-token steering is not an exclusive input lock.
Older isolated terminals remain unsupported. Do not resurrect private-pipe takeover machinery.

## 2026-09-30 — MIT public source

The owner selected MIT for public distribution. The root source and VS Code companion
use the same MIT licence; third-party dependency and font notices remain intact.
Public release remains gated on functional readiness, including reported mobile chat defects.

## 2026-09-30 — release, manager application and bounded review

The owner authorized the public sciencewithagents release and website migration. The main
site follows their Sketchcoded landing page; Syllabusgraph remains under its own tab and
prefixed routes. No public Guide/FAQ is requested yet. Claude Opus 5.5 at xhigh builds the
frontend from the fresh-design drawings; Codex owns backend integration and real UI checks.
Shared Claude pacing reserves 25% and initially admits two workers concurrently.

Manager-applied reviewed changes become the default. A project can instead require a human
review before merging its isolated work. A high-level direction check precedes small atomic
implementation/review slices; never require a giant plan to converge. After two correction
rounds, record the manager's explicit disposition, or stop and notify the human when that
project setting is selected. Preserve the decision for later inspection and guide notes.

Native unattended launches keep native tools, skills and connections. Codex uses its native
workspace sandbox with network access and no permission prompts; Claude uses native edit
acceptance and the native command sandbox with no unsandboxed retry. Requests outside the
permitted policy are denied rather than queued for routine human approval. Actual questions
remain questions. These are provider controls, not a new tool-by-tool policy engine, and do
not claim to confine arbitrary external MCP services or remove account/OS consent.

## 2026-09-30 — retire intermediate source without losing supported behavior

Remove the stale CURRENT_WORK/BUILD_GOAL/PHONE_ACCESS_PLAN handoffs and the superseded
LIVE_SESSION_ATTACHMENT experiment plan. Current status, feature/requirements maps, phone
contract and dated verification retain their useful material; prior files remain in Git.
Remove the one-off live-attachment probe and redundant Pulsar verification follow-up:
the supported editor bridge has its own probes, and the maintained handoff smoke already
contains the corrected project-wide usage and restart checks.

Production module/import and reference checks found no abandoned backend subsystem.
Retain classic controls, saved permission compatibility, process entry points, shared
contracts, planned features and reusable regression fixtures. Remove confirmed unused
imports, locals, a private argument, a catalog accessor and an unmatched CSS rule. Native
TypeScript unused-code checks now run with the existing build, without another dependency.
Runtime data, conversations, recovery copies and ignored evidence are not cleanup targets.

## 2026-09-30 — QUARK conversation over the existing scheduler

Give the owner a central conversation above a simple status board. Reuse signed leases,
the runtime heartbeat, native provider adapters, accounting and durable queue; do not add
a second scheduler or an always-generating model. Keep coordinator context and saved
decisions outside managed project repositories. Use central native model discovery, latest
Opus by default, with explicit provider/model pins. Event-driven automatic turns are bounded
and cannot grant themselves allowance, reduce the reserve or resume owner-paused projects.

Priority weights affect ordering within urgency, not proportional token/CPU ownership.
Changing priority alone does not switch shared pacing on. Owner caps retain prior spend;
project pauses have separate holds so a project resume cannot erase a budget hold. Managers
receive recent forecast-versus-actual examples, not a claimed accuracy guarantee.

Provider maintenance reuses recognized native installers, waits for app-owned work, preserves
custom installations and shows recoverable failures. It does not become a general shell
endpoint or control unrelated native sessions. The latest permission preference replaces
blanket bypass with broad reads/network and scoped writes; that policy needs native
verification and is not silently enabled by this slice. Retained original messages remain
the source for batch recap and omitted-requirement checks, independent of UI pagination.

## 2026-09-29 — agents adapt updates to customized installations

The owner prefers people freely customizing their local app and having their coding agent
port upstream improvements while retaining those changes. Keep clear provider/UI/settings
boundaries and a short local record of the upstream base and customization intent; do not
make an elaborate plugin framework a prerequisite. The update agent compares both sets of
changes, preserves data and local behavior, resolves conflicts and checks real workflows.
It handles recovery copies during the update and asks only about unresolved product choices.
This is the intended update workflow, not a guarantee that arbitrary edits merge automatically.
The current manual recovery-copy/request UI remains unchanged. See [the runbook](UPDATE_APP.md).

## 2026-09-29 — reuse existing sign-ins and reconnect without extra steps

The owner requested hands-on functional verification and less sign-in friction. Welcome now
checks missing/stale native account metadata automatically, using the existing coalesced
check and five-minute freshness rule. It never starts login or a model turn. Catalog failures
do not establish that a user is signed out.

Use the existing local browser handoff automatically when a trusted reconnect address is
returned. Keep the intended app route and retained drafts. Check current authorization before
skipping a previously completed draft migration, so an expired session waits for app opening
instead of bouncing back to the locked app. Returning to the tab retries the existing check.
No new auth service, stored credential, provider grant or permission bypass is introduced.

## 2026-09-29 — remove editor authentication and bound shared history

The owner explicitly rejected separate VS Code authentication. Remove its code exchange,
companion credential handling and setup UI. Keep the existing native loopback/browser-origin
producer checks and paired-phone/browser consumer boundary; add no replacement trust system.
The earlier local-authentication decision remains applicable to browsers and host gateways.

A real 20 MB conversation froze the phone because every poll transferred/rendered the entire
transcript. Page history and oversized entries through the existing read command; advertise
page support in the companion greeting and trim legacy replies at the server. Keep original
native history, sending/Stop receipts and drafts. Lazy tool bodies and memoized messages bound
rendering work. Verify an actual-history replay on mobile/WebKit, rather than treating a
connected socket or small fixture as proof of a usable long conversation.

## 2026-09-29 — update handoff through existing recovery copies

Keep source updates setup-agent assisted. The Recovery page explains the journey and gives
a copyable request tied to a verified copy, with visible clipboard fallback and links to
readiness/active work. A short tracked runbook covers prerequisites, preserving the same
data/configuration, idle shutdown, build, restart and failed-step retry. Do not create an
automatic updater, browser shell endpoint, new model launch or second backup mechanism.
The copied request is preparation, not a claim that an update or full-machine backup ran.

## 2026-09-29 — bounded recovery of the app-owned phone connector

Reuse the connector supervisor's existing three-second check. An exited or failed owned
connector gets three automatic retries, waiting at least 5, 15 and 60 seconds; a running
connector retains responsibility for ordinary network recovery. Two continuous minutes of
reported readiness renew the retry allowance, so a brief successful probe does not permit
an endless crash loop. Exhaustion exposes the existing manual Reconnect action. Turning
access off or shutting down cancels pending retries. Invalid private-token permissions still
require setup repair. No pairing/unlock records, route configuration, accounts or external
processes change, and there is no new timer service or login daemon.

## 2026-09-29 — repair only a proven stopped launcher move

The generator previously refused every root-path change, including a genuine move. Accept
matching prior configuration/identity only when the old root is gone, the data location
matches the move or its unchanged external directory, and recorded owner/server processes
are absent. Normalize surviving path parents for macOS aliases, and retain the old generated
configuration before rewriting. A copy, ambiguous marker, permission failure or live process
still stops repair. Do not turn launcher regeneration into filesystem/database relocation,
account migration or an automatic overwrite of the installed app.

## 2026-09-29 — finished work releases processes, not evidence

Reuse the runtime heartbeat and existing provider close paths for finished task workers.
Check the owning native family, pending requests/reads, approvals and holds before releasing.
Keep original thread identities, task reviews, saved messages and worktrees; restore does not
reconnect a finished assignment. Managers, open tasks and retrospective discussions have no
idle timeout. File copies are retained because later questions may need their original context;
automatic worktree removal needs an explicit retention choice, not an inferred cleanup policy.
No additional daemon, model or process-name kill is introduced.

Coalesce scheduler wakeups that arrive while it awaits a provider. Queue controls must retain
the exact uncertain write and offer an explicit retry; a late status read cannot reinterpret
that retry as the opposite action. Reuse the existing server receipt, not another transaction
or retry framework.

## 2026-09-29 — pause reasons follow newly verified budget evidence

Keep the existing shared allowance decision and typed holds. When confirmed transient work
cannot recover because the fresh report establishes an exhausted cap, promote the hold to
`budget`, preserve its original timestamps/stop receipt and latch the grant. Resetting the
provider window or increasing a cap does not release a budget hold automatically. Reuse the
existing explicit continuation path; no separate recovery scheduler or provider polling.

## 2026-09-29 — link native helper parents only from explicit dispatch evidence

Reuse the existing native child records and hook result adapter. A fresh completed Agent/Task
call with prompt metadata can prove the caller/callee relationship; lifecycle arrival order
cannot. Preserve the first recorded parent through resumes, reject cycles and links outside
the owning session, and retain a small evidence receipt. Unknown/background relationships
remain session-owned. This updates the visible work tree only: root budget attribution,
lease authority, process ownership and stop scope stay unchanged. No new hierarchy service,
log scanner, speculative parent inference or model call.

## 2026-09-29 — return project workers to native defaults

Use the existing project tools record and save receipt to select native inheritance or
optional restrictions. An absent record means native; an older saved record/request means
restricted. Restoring native defaults changes future delegations only and retains the old
ceiling for explicit restricted requests. Ignore dormant allowance changes in a native save
so no inventory probe or silent extra grant is required. Existing contexts and grant history
stay intact. Keep this compatibility surface while saved restrictions/receipts depend on it;
do not extend it into a second Claude capability policy.

Provider readiness already separates account and catalog state. Native model discovery is
no-turn metadata, and inherited launches skip legacy tool-policy probes. Correct the old
compatibility guide rather than adding another discovery system.

## 2026-09-29 — source-backup setup uses the existing exporter

Project pages may preview a new dedicated private GitHub destination or connect an existing
private writable repository. Confirmation is bound to the observed native account, exact
repository and branch; existing destinations are not replaced. Persist creation intent before
calling GitHub. Recovery checks the same unique name and marker, so a lost acknowledgement
cannot produce a second guessed destination. Native GitHub CLI owns credentials and sign-in;
the app opens its Mac login window only on an explicit request and preserves a working account.

Atomically update the existing private configuration file and activate the existing reviewed
checkpoint queue. Preserve other mappings and refuse external configuration changes. No new
backup service, model, global Git setting or automatic source application. Connection status
is distinct from a remotely verified checkpoint. Native metadata was checked live; creation
and login recovery use controlled fixtures, not a newly provisioned owner repository.

## 2026-09-29 — optional private phone setup reuses existing controls

New phone setups may explicitly choose Tailscale without a purchased domain. Native readiness
and HTTPS capability produce a short-lived exact-address preview; confirmation saves initial
settings only. Tailscale retains sign-in and HTTPS consent. The existing phone listener,
passkey pairing and lifetime-pipe connector host handle the connection. Foreground Serve ends
with its owned process; no public Funnel, global route reset or permanent background service.
Existing Cloudflare configurations are preserved, including this owner's live installation.
The unanswered optional Tailscale preference does not authorize changing the owner's network.
Live private-network and physical-phone acceptance remain separate from fixtures.

## 2026-09-28 — resume with native observation and existing supervision

The owner authorized implementing the simplification account and continuing the full build.
Start by extending existing provider adapters, receipts, activity history and QUARK decisions;
do not add another collector service or per-tool permissions framework. Native hooks check
admission without granting tool permission. The existing supervisor still owns interruption.
Provider model/effort catalogs are data, not enums embedded in each feature. The historical
pause below no longer describes the authorized work; full migration is still in progress.

## 2026-09-28 — owner stops implementation and requests simplification

The owner rejected expanding the app's per-tool restrictions into Claude web/MCP/plugin
parity. Preserve native capabilities and use logs, tool events, subagent identities and
hooks to feed QUARK. Managers receive useful status; the host independently supervises
and stops owned work. Apply this to both providers and the rest of the application.

[SIMPLIFICATION_ACCOUNT.md](SIMPLIFICATION_ACCOUNT.md) records the source-backed account,
including removal of blanket tool overrides, native child observation, shared controls
and what must remain. This supersedes the **future direction** of the tool-ceiling decision
below; its deployed behavior has not been removed. Signed manager admission, budgets,
original permissions, retained histories and exact review/apply still matter. The goal
is paused. No runtime refactor, hook installation or deployment was performed by the audit.

## 2026-09-28 — owner ceilings for new worker capabilities

Keep project tool allowances separate from model routing and existing conversation settings.
A manager requests a subset at delegation; recheck after asynchronous preparation and record
the selected capabilities and revision atomically with the worker. Omission requests none.
Preserve exact delegation receipts after later allowance edits. Do not switch providers to
make unsupported tools appear available. Codex is the current external-tool implementation;
Claude parity and native automatic-approval choices remain separate work.

Save owner edits with revision checks and durable receipts. Catalog discovery reads only
configured names through a disposable native client, without a model turn or credential
projection. Removals do not require a healthy provider catalog. Existing workers keep their
explicit controls; this ceiling is not a retroactive revocation mechanism. Preserve original
native approvals, histories, and context identities rather than silently replacing a saved
manager context just to update its tool schema.

## 2026-09-28 — scoped local authentication and retained browser reconnects

Use an OS-account-owned 0600 installation file, distinct owner/editor/gateway capabilities
and a one-use challenge bound to the role, request method and exact path. Clients first
verify that the responder knows their key; normal authorization sends a one-use proof, not
the durable key. A local browser receives an HttpOnly SameSite session from a short-lived
native-file form handoff, keeping credentials out of URLs. A distinct local hostname avoids
sharing that browser cookie with ordinary localhost services. This is loopback/OS-account
protection, not isolation from a malicious process already running as the same OS user.

Move existing browser drafts with top-level, purpose/source/destination-bound one-use form
tickets, never a cross-origin iframe or automatic message replay. These fixed local transfer
pages use origin-only referrers so browsers retain the Origin header checked by the server;
normal pages keep no-referrer. Original storage remains untouched. Copy missing entries,
archive conflicting text, and never resurrect an intentionally cleared shared pending receipt
after its first migration. The old tab must reconnect itself for its own session storage.

Preserve the existing phone boundary, limited QUARK client and durable operation receipts.
An editor connection code grants only the editor role, saved in VS Code SecretStorage.
Once a workspace is pinned, a claimed older protocol cannot downgrade its authentication.
Gateways use their own credential and the destination enforces the same typed route allowlist;
they cannot issue browser/editor credentials or change that computer’s phone access.
Normal startup now enables the guard, and the native launcher/advanced CLI authenticate.
The owner rollout preserves the current editor process; companion updates activate only
at a safe reload, followed by their one-time connection. Original provider accounts and
native conversation identities are not migrated.

## 2026-09-28 — distinguish research source from installation runtime

Configured private source backups may include research data, logs and databases. Refuse
credential filenames/token patterns and the actual runtime directory when it falls inside
the exported project; retain the `data/` exclusion for this app's source clone. Count distinct
path/object versions across newly exported commit trees, not repeated unchanged entries.
Check aliases before reusing content scans so renaming a known blob to a sensitive filename
cannot bypass the guard. Keep bounded inspection and verify the remote after every push.
Allow a push two minutes, with shutdown cancellation and uncertain-result reconciliation.
These are guardrails, not a guarantee that arbitrary research files contain no private data.

## 2026-09-28 — optional phone startup cannot strand the desktop

Require the local listener before runtime reconciliation or queued work. Treat malformed
phone configuration and an unavailable phone listener as separate, visible repair states;
do not start a connector when that listener failed. Incomplete phone startup must not be
interpreted as an owner request to remove saved trust, enrollment or enabled intent. A
later healthy startup still validates the original authentication identity normally; an
actual trust change retains its revocation behavior. Never take over an occupied listener.
The app reports the bounded repair state without returning configuration or token contents.

## 2026-09-28 — shared pacing is a visible new-install default

Initialize shared pacing on only for an empty, unconfigured installation, before Runtime
constructs model policy or starts collectors. Keep the schema's legacy fallback and every
saved pacing/model choice unchanged. Demo mode retains its explicit simulation behavior.
Welcome reads the existing cache to show pacing and missing usage; it links real controls
without silently changing policy. Protected work waits for verified capacity. Explicit caps
and signed manager leases remain independent of this optional scheduling switch.

## 2026-09-28 — explicit local tracking for ordinary folders

The native chooser is the only source of a filesystem path. Persist its canonical root,
filesystem identity and selected provider. A plain folder receives an in-app preview;
only explicit Start tracking creates local history. Retain an owned initialization marker
and retry the same work after failure/restart. A later native selection may resume known
partial initialization; never adopt unrelated unfinished history or a substituted root.
Exclude common environment/dependency files through private repository defaults without
rewriting user files or `.gitignore`. Preserve existing ready repositories as-is. No upload,
manager turn or permission escalation is implicit. Browser confirmation accepts only a
saved UUID and confirmation, never a path. The host Mac owns this local folder workflow.

## 2026-09-28 — compact conversation events and source-mode local jobs

The entries table owns complete conversation/tool text. New append-only entry-change events
carry identity/status only, matching the existing UI invalidation stream. Do not copy the
whole accumulated reply into every event or rewrite old history to recover space. Read a
streamed entry by its exact scoped ID, not by scanning the latest page; interleaved tools
must not truncate a continuing reply. Saved history/search/export still read complete entries.

Use the source TypeScript supervisor under Node 24 in development and the compiled JavaScript
supervisor in built apps. Retain the same private IPC/process-group ownership and cleanup.
Do not inherit arbitrary parent debug/load flags or kill unrelated host processes.

## 2026-09-28 — atomic requests from outside agents

Expose a bounded local CLI adapter for cached reports and new capped tasks. Use a private,
OS-account-owned installation capability; never expose provider credentials. No arbitrary
command/RPC forwarding, new provider polling loop or self-issued manager lease. The client
has no budget-increase, resume, permission or integration action. Retain existing provider
identities, project ownership, shared reservations and task ancestry. Each cap is explicitly
provider/window-specific, not a cross-provider allowance promise.

Synchronize usage before a single synchronous task/caps/queue/receipt transaction. Failed
transactions must discard observer notifications as well as persistent events; otherwise
clients can see ghost work. Exact accepted requests recover their original receipt after
restart. Default external task priority is background. Optional pacing being off never
disables explicit allowance admission. Broader local-browser/companion authentication and
per-worker capability grants remain distinct corrections.

## 2026-09-28 — installer-managed executable entries survive upgrades

Capture stable Node/Codex/Claude executable entries instead of resolving them to disposable
version targets. Automatic Node aliases must match the running runtime; explicit selections
are executable-checked and the chosen Node must be 24+. Preserve installed-tool directories
for Finder, plus standard host locations; no global PATH, package upgrade or shell-profile
change. Optional launcher fields remain backward-compatible. Invalid explicit selections
fail before replacing the working configuration.

Source setup checks Node/Git/Codex before dependencies. An optional usage reader's download,
checksum or platform failure leaves a visible incomplete step without discarding a built app.
Unknown usage retains its admission limits. Warn about synced source folders without moving
files. The fresh-source smoke uses a version-only fake CLI, never an owner's account.

## 2026-09-28 — explicit provider defaults and native readiness

A clean empty workspace defaults to Codex only; older saved policies without an enabled-provider
field retain both providers, without rewriting owner settings. The selected provider set governs
automatic defaults, not native identities or explicit per-conversation choices. Unattended
providers and task overrides must use that set. Catalog/authentication failure never permits
fallback to a different provider. Model pins survive disabling an automatic provider.

Welcome is the empty workspace's initial view; explicit routes, including shared editor entry,
remain intact. Metadata checks are explicit and coalesced. Do not mistake a catalog or stored
credential for verified model access. No account email, organization, token or native diagnostics
enter the readiness response. Codex device-code sign-in uses its typed native auth API, refuses
replacement of an existing account, retains a credential-free durable receipt, and bounds its
owned runtime to 15 minutes. Codes live only in memory and disappear on completion, cancellation,
transport loss or expiry. Restart never replays authorization. Native Claude sign-in and initial
installation/phone provisioning remain separate bounded work.

## 2026-09-28 — advanced controls retain receipts and compaction obeys admission

Reuse the existing native terminal/settings/import paths in the main shell. Context commands
need explicit descriptions and retained retry receipts; metadata reads never imply a turn.
Task and manager creation keep the exact uncertain payload across reload rather than allow
an edited request to duplicate a confirmed-but-unseen creation. Separate literal chat text
from native command execution so absolute paths remain usable.

Compaction can spend allowance and emits ordinary provider turn events. Admit it through the
same QUARK reservation/lease path, but mark it as maintenance before execution. Preserve task
review, checkpoints and automatic-turn bounds; forbid orchestration and completion reports.
Automatic telemetry recovery clears a maintenance hold without launching assignment work.
Codex history in a Claude-managed project uses a temporary metadata client, closed after the
read, with no provider alias or model execution added to the Claude manager.

## 2026-09-28 — connect operational screens and reconcile through a reviewed follow-up

Expose the existing queue, pacing, local work and original permission workflows in the
new responsive shell. Use shared controls and durable backend receipts. Review pages show
exact source/target versions and actual patch content before a separate apply confirmation.

A divergent two-tip diff can falsely label another task's additions as deletions. Use the
common base to show only the reviewed task's contribution and prohibit application until
reconciled. The owner can request one new child task from this screen; retain the original
review/worktree and assign the same manager, including allowance ancestry for its first
manager turn. The follow-up needs independent review and exact owner confirmation. Do not
silently rewrite a reviewed branch, implicitly approve a merged result or require the user
to leave the app for Git commands. Final integration remains a clean, exact fast-forward.

## 2026-09-28 — distinguish temporary monitoring holds and admit native turns

A collector error must not be confused with an exhausted grant. New admission fails closed
immediately; already admitted work can use the last verified reading for at most its
three-minute lifetime, without crossing an expired reset or overriding a known cap. Typed
monitoring/reset/headroom holds recover only after a provider-confirmed stop and a new
successful report. Persist the acknowledgement; host restart alone cannot create it.
Never replay an interrupted request, clear deliberate/legacy/budget/lease holds automatically,
reset automatic-turn limits or let cache maintenance create an indefinite conversation pause.

The managed native relay reserves capacity and signs the manager lease before forwarding
Codex turn input. Keep exact native model precedence, queue/task ownership and active
monitoring. A lost acknowledgement keeps authority blocked and its capacity reserved until
its actual turn is known. Provider starts outside that gate do not earn retroactive authority.
No global provider hooks or independent editor-session interception are installed.

## 2026-09-28 — connect the AI-built board and preserve finished work

The owner requests the full backend connected to the AI-built Sketchcoded design, with
web/mobile polish and later aesthetic revisions. This supersedes the home-only rebuild
boundary. Keep the existing 30-screen built board as navigation/design input and deliver
verified vertical slices; do not equate a board preview with an implemented backend.

The first slice connects projects, tasks and conversations using shared existing durable
chat controls. A completed worker cannot restart execution or clear its review. Explicit
Ask about this work creates a separate read-only, evidence-based discussion, preserving
source/model/account attribution and original task allowance accounting. Block lifecycle
writes, coordination, elevated permissions, native control and cache nudges for it. Native
history forks remain a distinct follow-up; never label evidence reconstruction as a fork.
Keep useful guide material in WORKFLOW_BUILD.md and product claims tied to verification.

## 2026-09-27 — enforce orchestration through signed manager leases

The owner wants managers to obey QUARK before orchestrating and workers to remain unaware
of lease plumbing. Add a host-signed per-turn lease before managed inference, renew only
from QUARK, and validate at coordination writes and after asynchronous preparation. Keep
the signer in host memory; bind identities/model and invalidate old signatures on restart.
All managers share existing admission and budgets, with no second scheduler or model monitor.
Give managers an owned-worker pause tool, but retain the independent host interruption path
so an idle or paused manager is never the sole spending protection. Preserve exact-turn
receipts, pending input, histories and owner continuation. Saved Codex tool-catalog limits
are explicit; never replace a conversation silently to advertise the new tool.

## 2026-09-27 — automatic allowance accounting and retained quota pauses

The owner accepts approximate attribution and requested automatic spending caps and cache
refreshes. Add a per-run token ledger, append-only allowance intervals, conservative shared
reservations and project/task caps that managers can tighten but only the owner can extend.
Guard running work as well as admission, interrupt the exact owned provider group, retain
queued messages/history/files, and require explicit continuation. Do not renew a grant at
reset, replay interrupted input, or let scheduling overrides bypass it. New All usage/Work
controls make the feature available without terminal commands. Cache refreshes are bounded,
same-context/model jobs under QUARK; unknown Codex expiry stays unknown by default. Vendor
cache lifetime and 2–3 percentage-point attribution accuracy remain unvalidated, not marketing
guarantees. See QUARK_ACCOUNTING.md for scope, weights, native-child overlap and external-use limits.

## 2026-09-25 — centralized task tiers and model policy

The owner supplied four model tiers and provider presets. Implement one versioned policy,
installed-catalog resolution, editable families/exact pins and a working Settings destination.
Route managers, workers, personal agent and computer checks through it. Freeze queued choices;
refresh opted-in defaults between turns without moving a saved provider identity. Native
helpers receive resolved defaults; explicit native choices and original editor sessions remain
their own authority. Routine/bulk work does not launch native helper trees. An undergrad may
request one grad consultation through QUARK, retaining resource caps and original approvals.
Do not claim tier labels measure accuracy or promise unknown future provider compatibility.
The website story and complete acceptance checklist are in MODEL_POLICY.md and PRODUCT_STORY.md.

## 2026-09-25 — a local resource watcher and an occasional IT assistant

The owner requested better computer diagnostics and bounded Sonnet/Terra checks. Add one
15-second read-only watcher, a rolling local history and Computer health as the first
working destination after the home rebuild. Reuse QUARK for every diagnostic turn; do not
add a model polling loop, monitoring service, external dashboard or process-killing agent.
Group executable names without arguments and distinguish memory pressure from RAM usage.
Use exact installed model choices, durable retry receipts, persisted cooldown/daily caps,
sustained triggers and a bounded one-turn runtime. New installations leave automatic
checks off; the owner has requested their activation here. See RESOURCE_WATCH.md.

## 2026-09-25 — name the scheduler QUARK

The owner chose **QUARK — Queued Usage, Agent Routing Kernel**, replacing the PULSAR
working name. Use QUARK in the app, manager instructions and current documentation.
sciencewithagents remains the umbrella product; the conversation app's separate name is
still undecided. Preserve internal `pulsar` API paths, storage keys and identifiers so the
rename requires no queue or history migration. Readers accept the earlier status name
during an update; new hosts report QUARK. Earlier dated decisions retain their original name.

## 2026-09-24 — rebuild the home first, preserve the engine

The owner explicitly set aside the old mobile interface and requested a polished landing
screen with explanatory placeholder destinations. Build phone first, then adapt to desktop;
do not reattach old dialogs behind the new navigation. The default root mounts a read-only
home. Original account/phone gates and manual lock remain; histories, native integrations,
queue and workers are retained. The previous UI is lazy-loaded only for deliberate maintenance.

Use actual shared API readings and label unknown/stale data and estimated project reservations.
Keep generated browser output and runtime under ignored data/. Group maintained browser
checks by current home and retained classic interface; a clean clone contains neither an
owner's workspace nor accumulated demonstration projects. See UI_REBUILD.md for the exact
bounded surface and the next owner review.

## 2026-09-24 — one PULSAR queue, shared usage, local processes and a new product name

The owner requested an agentic SLURM and Codex-to-Claude continuous background work.
Extend the existing durable dispatcher; do not introduce Jira or a competing queue.
Use account-reported usage plus explicit rough reservations, never a made-up token-to-quota
conversion. New managers get typed scheduling/inspection/transcription tools automatically.
Provider/task budgets remain admission controls; original approvals/review/integration remain.

Reuse the MIT standalone CodexBar reader for Codex. Claude’s native read preserves Fable
scoped windows that the installed helper omitted. It shares the same polling/cache/backoff
service, verifies native account identity and retains no credentials. Harvard FAS no-weekly
is the owner’s account-specific statement, never inferred for every Enterprise account.
Fable’s observed weekly meter is checked alongside normal usage, not added as extra capacity.

Whisper transcription is the first owned local compute workload. Pause/resume uses the
exact supervised process group; parent IPC loss cleans it up. Restart records interruption
and requires an explicit retry. Unrelated processes are never killed for capacity. CPU/RAM
estimates and an ETA do not imply cgroup isolation or a guaranteed deadline.

The product becomes **sciencewithagents**; **PULSAR** is Priority, Usage and Local-resource
Scheduling for Agent Runs. Keep pairing, storage keys, extension/command IDs and internal
package names stable. Rename user-visible surfaces and generated launchers without deleting
old installations. The conversation app’s separate name and future promotional website
remain explicit TODOs; PRODUCT_STORY.md holds the nontechnical capability inventory.

This is a dated decision record. Newer decisions supersede older descriptions of unfinished
slices; the latest follow-ups appear first. [STATUS.md](STATUS.md) is the current readiness
summary and [FEATURES.md](FEATURES.md) is the feature-and-limit map.

## 2026-09-17 — tolerant Codex hook and exact-turn editor control

Extend structural/runtime compatibility checks to Codex as well as Claude. A compatible
provider update or minifier rename does not need a new release allowlist. Retain original
byte-exact backups, guarded restoration and the legacy hook's undo path; genuinely missing
capabilities stop sharing, never native activation. Maintenance is still expected.

Expose only **Stop reply** as the next editor control: bind it to the original provider,
thread and visible native turn, persist the operation before dispatch, and resolve uncertain
delivery through read-only receipts. Do not target a newer desktop turn, equate interrupt
acknowledgement with idle, auto-retry or interfere with native drafts/approvals. Advanced
native controls remain in VS Code rather than being represented by a generic remote RPC.

## 2026-09-17 — small native Claude adapter, shared coordination, honest recovery

Enable Claude managers/workers through the installed, unmodified Claude Code CLI, using
the computer's existing subscription sign-in. Do not emulate Codex RPC, copy credentials,
use an API-billing fallback, or add another scheduler. Provider choices belong to new
projects/managers/workers; existing contexts keep their provider and local account affinity.
Cross-provider delegation requires an explicit model and thinking level from that provider's
installed catalog. Automatic difficulty/quota/fallback rules remain the owner's TODO.

Managers receive only typed coordination tools. Claude workers use the existing task
worktree and a restricted native tool list; original permission requests retain their exact
input and identity. External Claude MCPs/plugins, native helpers and terminal attachment
remain in the native client/VS Code, not falsely advertised as managed capabilities.
Administrator-enforced policy is outside this restriction boundary; this is not OS isolation.
The Codex native terminal and its existing capabilities remain available unchanged.

Keep Claude restoration lazy: opening saved views starts no model work; explicit input
resumes the exact recorded UUID. Store delivery intent immediately before crossing the
native write boundary. Known pre-write cancellation must not strand a later owner message;
uncertain writes never become permission to retry. Guard incoming results, approvals and
visible entries by original session/run identity. Report last-turn Claude counters without
inventing cumulative totals, quotas, billing or preserved hidden caches.

The real mixed-provider check exposed numbered file-display output being mistaken for an
extra newline. Give assigned workers the existing clean-checkpoint Git diff through
`dock_inspect {taskId, changes:true}`; managers still delegate code inspection. Refuse dirty,
changing or actively written workspaces, label truncation, and retain read receipts.
Peer messages cannot restart workers in tasks awaiting a manager disposition or already
closed; the review limit must apply to continuing old workers, not only spawning new ones.

Expose private, verified **Recovery copies** in the app. They are local database snapshots,
not off-device or full-machine backups. Serve metadata only; no database download or live
overwrite endpoint. Restoration uses a separate private directory and a trust review before
exposing restored phone access. The owner must never be told GitHub backs up conversations.

## 2026-09-17 — native recovery is required; VS Code remains a lighter live view

The owner confirmed Claude sharing works well and explicitly removed automatic crash
recovery from the VS Code requirement. Native Agent Dock conversations retain saved provider
identities/history and reconnect after manual app restart; interrupted actions and the old
terminal process are not replayed or resurrected. VS Code sharing may require reopening the
editor and original chat. Do not build a second native-session manager merely to make its
mirror match the managed workspace. Keep that distinction visible in UI/help and tests.

Continue the remaining integration/reliability work in small slices, preserving native
controls, pairing and existing sessions. Physical other-computer setup, owner routing rules
and marketplace publication decisions remain separate handoffs, not reasons to halt
independent implementation. The user's successful Claude handoff supersedes older notes
that still call initial Claude activation pending; hardware-restart/Home Screen acceptance
is not implied by that confirmation.

## 2026-09-17 — tolerate compatible Claude updates instead of pinning every release

Claude auto-updated from 2.1.273 to 2.1.274 and the exact-version guard blocked sharing
although the private connection contract was unchanged. The owner explicitly rejected
this maintenance model. Supersede the Claude release/checksum allowlist with structural
feature detection; keep Codex's separate adapter unchanged in this bounded correction.

Parse the installed JavaScript without executing it. Find one host class with the required
collections and one construction using the native extension context, regardless of generated
names or unrelated bundle edits. Wrap only that construction, evaluate it once, and isolate
hook failure from native activation. Runtime checks validate loaded channels, history,
transport, approvals and busy-state fields before sharing/sending. Missing or ambiguous
features stop sharing, not native Claude. This is tolerance, not a promise of compatibility
with every future semantic change. Do not disable automatic provider updates.

Retain exact original backups, atomic/check-before-replace writes, byte-recognized undo,
and the legacy 0.2.0 restoration path. Hashes remain evidence/restore guards, not permission
to use a new Claude version. Native session ownership, approval requests, separate drafts
and uncertain-delivery rules are unchanged. The fixture follows VS Code's actual registered
Claude installation rather than a hardcoded version folder.

## 2026-09-17 — live editor conversations belong in the chat navigation

The owner confirmed the original mirror works and asked to replace its floating panel
with a normal central conversation, then requested Claude Code in the same companion.
Keep the existing gateway and pairing. This is a presentation/in-process adapter change,
not another orchestration engine, imported Agent Dock manager or second provider process.

Show shared editor chats in the sidebar and central pane with provider and connection
status. Hide the unrelated managed-project team panel while viewing them. Navigation is
per browser tab and computer; returning to a project preserves its existing workspace
state. Remember at most 50 chat summaries, not transcripts, in session storage. Offline
views retain already-loaded messages in memory; after reload they clearly wait for the
editor's original saved history. No new archive/cache durability promise is introduced.

Key chat identity and drafts by computer, provider and thread, not transient window ID.
A reconnect can replace the connection ID without changing the chosen conversation.
A desktop sharing change must add another chat, never redirect the phone's current draft.
Keep the original Codex draft and receipt wire format compatible. A Claude send includes
its provider; the gateway refuses cross-provider dispatch even for identical thread IDs.
Late receipts resolve only their own saved submission, including after navigation away.
No input is queued for automatic replay on reconnect.

Make the companion's existing actions discoverable through one Agent Dock status/menu.
Native approvals, slash commands, model/permission controls and attachments remain in the
original editor; the menu is not arbitrary remote command execution. Claude mirroring is
separate from the deferred Claude **managed-worker** runtime/model-routing feature.
Exact provider compatibility and actually executed checks belong in VSCODE_MIRROR.md and
VERIFICATION.md, not a claim that every installed version works.

## 2026-09-17 — explicitly authorized, reversible VS Code mirror

The owner accepted maintaining a monkeypatch and narrowed the feature to one existing
conversation: retained transcript, text submission and submitted-message synchronization
with a human using the native sidebar. Use a separate VS Code companion, not another
Codex runtime, MCP server, manager or context reconstruction. This supersedes the earlier
stop/resume-only external-session disposition for the supported VS Code build.

Expose one private in-process connection reference with an exact-checksum patch. Keep a
byte-exact backup, refuse unsupported/modified builds, and restore only recognized bytes.
Initial activation needs a deliberate window reload when work is safe; ordinary handoff
does not. The owner chooses the shared thread locally. Installation alone shares nothing.
The original extension continues to own authentication, tools, permissions and approvals.

Reuse Agent Dock's existing phone pairing. The extension connects outward to loopback;
the phone receives typed read/send operations, never arbitrary RPC. Saved intent and
delivery receipts prevent duplicate submissions after uncertain transport. Separate
drafts prevent clipboard/focus interference. Busy checks include native activity at the
single write boundary and cannot be overwritten by a stale idle history response.

This is a private review preview, not universal Codex UI parity or a marketplace release.
Approvals, attachments, slash menus and advanced controls stay in VS Code. The phone
inherits last-applied loaded-thread settings, not unsubmitted native picker changes.
Unsupported activity is labeled; hidden reasoning/cache state is not reconstructed.
See VSCODE_MIRROR.md for maintenance, licensing/publication gates and evidence boundaries.

## 2026-09-14 — successful Safari pairing, optional repeat lock and visible setup

The owner confirmed connection; the sanitized host status now has an approved enrollment
with no expiry. This supersedes the earlier no-enrolled-device observation, not the still
pending Home Screen, cellular and restart checks. Preserve that working pairing.

Repeat passkey unlock is a per-device choice, **on by default**. After initial passkey
creation, computer confirmation and unlock, **Make this phone yours** offers **Ask for
Face ID or screen lock** or **Stay signed in**. The latter retains an already-verified
session, not anonymous access or a way to skip initial enrollment. **Continue** shows the
Home Screen guide; **Open my workspace** saves completion whether or not an icon was
installed. Server-persisted `requireUnlock` and `setupComplete` survive restart. Only an
authenticated active session may save them; old records keep the secure default.

Default unlock remains at most 15 minutes with background locking. Remembered sessions
have no automatic server expiry. Explicit lock/off invalidates either mode, requiring a
passkey next time while retaining enrollment/preferences. Tightening back to default must
not leave old indefinite sessions valid. Offline manual locking hides the view and saves
deny-only local intent, never an access grant; it warns that server sessions may remain
active until confirmation. Storage-unavailable cannot guarantee that intent after closing.

Enrollment has no automatic server expiry. Enrollment/remembered cookies request 400 days,
renewed on visits; actual browser retention is not guaranteed. Lost session means unlock;
lost enrollment storage, removal or trust/origin reset can require re-pairing. Do not call
those different events all “unpairing.” [PHONE_WORKFLOW.md](PHONE_WORKFLOW.md) is the
consolidated behavior/redesign contract, including installation caveats and the capabilities
that onboarding must preserve. Physical acceptance remains separate from setup completion.

## 2026-09-14 — one pairing input per screen; QR skips code entry

Historical observation: the later successful-enrollment decision above supersedes this
entry's no-enrolled-device check-in; the separate-screen workflow remains current.

The owner requested separate code-entry and phone-naming screens. Manual entry now opens
**Enter pairing code**, showing only **Connection code**; **Continue** moves locally to
**Name your phone**, showing only a blank **Phone nickname** field. Scanning a valid QR
opens the nickname screen directly, with its code held in page memory and no code field
or autofill notice. This supersedes the preceding visible-autofill presentation, not the
QR fragment scrubbing or browser-first installation order.

The nickname screen's **Continue** uses the existing preparation request, followed by
explicit **Save passkey** and matching-number computer confirmation. Screen navigation
does not send a pairing request. **Use a different code** and server-rejected codes return
to code entry while retaining the nickname. No new authentication endpoint, automatic
submission or change to the single 15-minute deadline is introduced.

The owner reported that the physical QR code handoff worked. The sanitized host status
still showed no enrolled device at this check-in, so this is not acceptance of completed
passkey enrollment, confirmation or home-screen unlock. Record those later outcomes
separately; do not erase the successful QR observation or extend it to unobserved steps.

## 2026-09-13 — scanning must fill the pairing code; install after pairing

Historical boundary: the newer separate-screen decision supersedes visible code autofill;
scanning now skips directly to the nickname screen, with the same explicit security gates.

The owner requested QR-assisted pairing without typing the code. The preceding visibility
fix still encoded only the address and missed that requirement. Showing a usable invitation
was necessary but insufficient; a manual-entry test could not accept the scan journey.
This decision supersedes the earlier address-only QR and home-screen-first guidance.

Encode the active one-use code in the QR's `#pair=CODE` URL fragment. Capture and scrub the
fragment synchronously before React or API startup, keeping the handoff only in page
memory, never local/session storage. Autofill is not authorization: **Continue**, **Save
passkey** and matching-number computer confirmation remain explicit, within the original
15-minute deadline. Keep the bare address and manual entry as fallback. The QR/link is a
temporary secret; no logging, committed screenshots, auto-submission or claim that external
scanner/browser history is erased.

Pair in Safari on iPhone or Chrome on Android first, then add the paired page to the home
screen. WebKit documents cookie copying into a **newly created** iOS/iPadOS 17.2 web app,
not other local storage or subsequent synchronization with an existing installation.
An icon added before pairing may need adding again from the paired browser.
[WebKit's documented behavior](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/#web-apps)
supports this order, not a claim of successful physical acceptance on this phone. Verify
scan autofill, explicit gates and new-icon unlock separately; keep real evidence in
VERIFICATION.md and the outstanding physical steps in PHONE_ACCEPTANCE.md.

## 2026-09-13 — show a pairing invitation only when it can be used

Historical boundary: the newer scan-to-autofill decision above supersedes this entry's
address-only QR restriction; its invitation-visibility and explicit-consent gates remain.

The owner had not paired a phone and correctly found the always-visible QR confusing:
the computer showed a reachable phone address beside a closed-pairing status. Reachable
transport is not permission to enroll. Keep the inactive panel explicit: choose **Create
a new code** to start. Only show the QR, address and code together when this window has
an unexpired code, the connector is ready, and enrollment permits it. Hide the invitation
on cancellation, expiry, a lost connection, pending computer confirmation or completion.
Reloading does not recover a secret code from server status; offer an explicit fresh start.
Clear the old local invitation before replacing a code, even if the response is lost.
Expose only a local boolean for the phone's unverified passkey-saving stage: show waiting
guidance and explicit Cancel, not a replacement code button or premature confirmation.

This is a presentation correction, not a change to authentication or an automatic pairing
action. QR still opens only the public address; code entry, phone passkey verification and
matching-number computer confirmation remain explicit. A future QR-assisted code handoff
must account for Safari versus installed-app storage and avoid leaking setup secrets; do
not claim scanning alone pairs a phone. No owner code is generated or enrollment altered
by development checks.

## 2026-09-13 — understandable phone pairing and a longer connection window

Historical boundary: the newer scan-to-autofill decision supersedes the address-only QR
description below, not the shared deadline or passkey retry safeguards.

The owner's first physical attempt stopped during browser passkey creation. The old UI
discarded every registration exception and told the person to create another computer
code, so the exact device cause was not retained. Do not call that a Cloudflare sign-in
failure or claim the physical phone is accepted based on Chromium fixtures.

New connection codes last **15 minutes**, including passkey creation and computer
confirmation within the original code deadline. Starting or retrying registration does
not extend it. Single-use codes, five wrong-code attempts, explicit computer confirmation,
permanent approved enrollment and the separate 15-minute unlock remain unchanged.
The QR contains only the public address and is optional: the panel also says to open that
address and type the displayed one-time code. There is no extra password to remember.

Prepare the accepted code first, then invoke passkey creation directly from an explicit
Save passkey click. Retain only unused prepared options in memory for explicit retry;
never automatically resend a signed registration after an uncertain finish response.
Show safe error categories and recovery instructions, not credential payloads or raw
browser exception messages. Supply a nonempty passkey display name. These address known
compatibility/recovery gaps; a real-device retry still establishes the actual result.

README setup begins with the installed local provider and recommended private GitHub source
backup, optional agent-led Cloudflare address, then phone pairing. Project website hosting/
sharing is separate from sharing Agent Dock administration. The requested per-computer
CPU/RAM/disk dashboard is recorded as Deferred/TODO, not fabricated telemetry or a new
scheduler policy. Missing, stale and offline host measurements must remain explicit.

## 2026-09-13 — mixed-provider preparation, not an implicit automatic policy

The owner requested Codex/Claude managers and workers within one project, with explicit
per-task choices and eventual difficulty/usage-aware routing. Their detailed model mappings,
thresholds and fallbacks are deferred by request. This slice implements provider-namespaced
identity, explicit Codex delegation overrides, recorded difficulty/reason and normalized
reported usage. Claude is a disabled catalog entry, not a Claude-to-Codex fallback or a
claim of a working Claude adapter. The current private RPC transport is still Codex-shaped;
MULTI_PROVIDER_ROUTING.md defines the small adapter acceptance needed before activation.

Provider context ownership and observed-history markers are separate namespaces. Legacy
records project as Codex without rewriting archives, and old Codex index/markers remain
readable. A saved conversation cannot change provider. A new worker may choose a different
model/effort from its manager; validate against the installed catalog before allocating its
worktree or queue entry. Save the resolved assignment and reason with the original retry
receipt. Unsupported providers and automatic mode are rejected before dispatch. Difficulty
labels express the manager's assessment only; no relative model ranking is encoded.

Normalize provider-reported cumulative token snapshots instead of summing notifications.
Keep quota observations, stale times, unknown account affinity and missing values separate
from project use or billing. Current-model labels are not historical per-model attribution.
Explicit quota refresh uses only the provider's read API, never a turn, credit reset,
purchase or login. Manager context carries a small self snapshot; peer details require
explicit inspection. Automatic routing, estimated prices and budget enforcement are not
silently inferred from these records. New tool schemas apply to fresh contexts: old saved
Codex threads may retain their original definitions and require an explicit New context
to use the new delegation fields, while their archive remains available.

Official Codex and Claude documentation guided capability/usage distinctions, not hard-coded
Opus/Sol/Terra rankings. A scannable FEATURES.md and audience-based docs/README.md now map
the owner's ideas to code, bounded evidence, human-needed setup and deferred choices.
Historical decision/incident notes remain dated evidence, not current setup instructions.

## 2026-09-13 — owner-resolved multi-account and restart scope

Agent Dock remains a separate thin UI because native same-account Remote cannot combine
the owner's personal, school and family installations. Each computer keeps its own Codex
authentication, tools, project files and runtime history. The first connection adapter
uses configured SSH aliases, strict host-key checking, loopback forwarding and a pinned
Agent Dock host identity. The browser selects registered computer IDs only; typed routes
remain behind the entry computer's pairing/unlock gate. Never send account credentials,
arbitrary RPC/commands/paths, or silently pool histories into another account's model.

Old provider history is explicitly imported for recovery, not live-client attachment or
retroactive agent-tree reconstruction. New orchestration starts fresh. After manual
power-on/login/app launch, saved views reconnect existing provider thread IDs without
turn/start, reconstructed transcript injection or model changes. Interrupted actions need
inspection; provider cache survival is not promised. Streamlined login-item setup remains
an explicit TODO, not a daemon project.

Drafts are per-browser and host-bound, revision-checked and retained through disconnection.
Copying a draft is explicit and retains its source. Unchanged copies share one durable
delivery identity, so two device sends cannot enqueue the same copied message twice.
Editing creates a distinct draft; terminal input remains single-owner and is never replayed.
Saved evidence uses project-scoped paging/search and exact source references, with
host-authored recovery records even when an optional worker checkpoint is missing.

## 2026-09-13 — bounded personal front desk and fresh-provider compatibility

The optional personal assistant is one designated fresh Codex identity per computer, not
another scheduler or implementation manager. It has exactly inspect, route and checkpoint
tools. Visibility defaults to no projects; owner-selected projects and editable preferences
are revisioned in the same local database. Every read rechecks current visibility. A
manager's saved outcome is delivered once with source references, and a report turn cannot
route more work. Removing visibility stops future sharing but cannot erase text already
seen by the provider. No project, approval or integration capability is gained through
its manager-shaped internal storage record; ordinary work APIs reject that private project.

Cross-account assistant memory/routing remains a deliberate future consent choice. The
computer selector does not implicitly authorize school or family history to enter a
personal account's model. This conservative default keeps normal navigation seamless
without turning a UI handoff into a data-sharing operation.

Same-thread restoration is globally limited to two reconnects per host, deduplicated across
devices, and waits for provider startup cancellation during app shutdown. Reopening views
is not a model turn. A duplicate message receipt is checked before any interrupted-state
transition; a delayed retry must never release newer queued work. See the incident notes.

Codex 0.154.0 passed actual delegation/restart, the three-turn front-desk flow and legacy
JSONL import/restart. The installed schema and current official documentation were checked;
old rollout tools cannot be overridden through thread/resume. Preserve their context and
offer explicit fresh orchestration, rather than reconstructing history for an upgrade.
Older native-feature evidence stays version-labeled in PROVIDER_COMPATIBILITY.md.

The Mac restart experience uses a small local launcher for this clone and its installed
runtime, not Electron, a daemon, an account manager or an updater. The native app owns its
started server; closing a browser only closes a view. Streamlined login items remain TODO.

## 2026-09-07: a new v1

The prior repository is preserved at its existing location and remote. Its starting
commit was adb6cba. It has 805 tracked files and about 243,000 lines of TypeScript.
Its STATE.md reports that managers cannot dispatch implementers, the newer console's
Send is inactive, and a source-inactive authority subsystem has 1,091 SQL objects.
The recorded planning failure grew to 31 revisions and a 16,372-line plan.

Reuse the proven ideas: loopback API, same-origin Vite proxy, SQLite, replayable events,
idempotent submission, explicit approvals, project registration, and private history.
Do not import the legacy authority schema, release manifests, phone assistant modules,
VPN/VM management, Cloudflare deployment, or old private runtime. They solve a different
problem and would make the core experience depend on inactive infrastructure again.

## Runtime and client

Use the installed Codex App Server through a server-private Unix socket. The structured
client uses threads, turns, items, approvals and dynamic tools. Keep the adapter small
and validate input/output at the application boundary. The real Codex terminal is the
compatibility surface for native controls; do not pretend a custom chat box implements
every terminal command. Browser access is to registered session IDs, never raw RPC.
See https://learn.chatgpt.com/docs/app-server and https://learn.chatgpt.com/docs/cli.
App Server and dynamic tools include experimental interfaces: pin and test compatibility.

## Ownership

One primary manager per registered project, plus owner-created module managers. Managers
have coordination tools and no execution
tools. They receive current project state and can inspect stored evidence, delegate,
send messages, retain checkpoints and record decisions. They do not write the plan or
implementation. Workers have durable identities and task-scoped workspaces. The host
owns concurrency, task transitions, input validation and approval decisions.

## Bounded planning

A task has one outcome, acceptance criteria and a small scope. Planning is optional for
simple work, and delegated when needed. A review disagreement returns to the manager.
The manager records the finding, causal evidence and resolution before another revision.
After two revisions the same task must be split or brought to the owner. New independent
failure domains cause splitting sooner. Review is evidence, not an endless veto loop;
the manager can accept a documented tradeoff but cannot bypass code permissions.

## Durable history

SQLite is the application source of truth for projects, tasks, agent identities, messages,
items, decisions, approvals and append-only events. Codex owns its provider sessions.
Resume provider history when possible; otherwise explicitly reconstruct from retained
messages and checkpoints. Never claim to restore hidden reasoning or the exact context
cache. Keep interrupted work visible and never silently replay uncertain side effects.

Current task/team evidence uses Codex's separate `additionalContext` field marked
untrusted, not a JSON preamble in the owner's chat message. This keeps native terminal
history readable and prevents repository/worker evidence from becoming developer policy.

## Scope

V1 is a local, single-owner app with a responsive phone layout. Public/private hosted
phone access, an LLM receptionist, SLURM-style scheduling, distributed workers and a
one-click installer are v2. A fresh clone must still have understandable setup and tests.
Create a new private GitHub repository for later collaborator sharing; publish source
only. Do not migrate the old production installation.

## Verified integration choices

The implementation uses the installed CLI, not a second SDK authentication flow.
Official App Server documentation and generated local protocol types guided the
adapter. Codex 0.153.4's Unix WebSocket endpoint requires `/rpc`; websocket compression
must be disabled for this transport. Dynamic tools require the code-mode host feature,
even though managers have no shell tools. Native multi-agent features are disabled so
delegation cannot bypass the stored team and convergence rules.

Legacy provider history renumbers item IDs during resume. App-owned threads are marked
observed and use the durable local archive instead of reimporting each resume. External
sessions hydrate visible history once. Restart resumes the same provider thread when
available; New context is explicit and keeps the previous archive.

An actual native browser turn has exercised a host coordination tool and returned to
the structured archive. The local `dock attach` command shares that same fixed PTY and
ownership rule. Native `/new`, `/fork` and same-agent `/resume` are tracked as described
below. Cross-agent navigation now uses the explicit transfer described below. Remaining native restrictions
are v1 compatibility work, not a claim of complete terminal parity.

Worker writes happen in task Git worktrees. A checkpoint refuses common credential
filenames, runtime databases/logs, oversized files and obvious token/private-key patterns
before staging. This is a guardrail, not comprehensive secret detection or containment
against a malicious process. The host Git helper skips hooks; sandboxed worker commands
still operate with the owner's explicitly approved Codex permissions.

No broad scheduler or policy engine is needed for v1. Four automatic turns may execute
concurrently, with a single writer per task, twelve automatic turns per agent between
owner messages, twelve children per task, and two same-task revisions. Native ownership
pauses automatic execution of that agent and peers sharing its worktree. Async external
operations persist intent first; uncertain outcomes require inspection and a new owner
decision, never automatic retransmission.

The login service is a small macOS launchd helper, not another orchestration daemon.
It binds loopback and supervises this clone. A lifetime pipe stops provider process
groups if the gateway dies, including descendants that ignore the initial termination
signal. Submitted conversations survive service restart; unfinished work is interrupted
for inspection rather than resumed blindly. Drafts are browser-local in v1.

## Standing authorization and partial blockers

The owner clarified that routine approvals should use agent judgement. The earlier
Documents/background-service failure should not have stopped independent implementation
work. Keep that distinction explicit: a feature-specific setup issue is not a reason
to stop the entire build while independent, authorized work remains.

Record the authorization in the repository agent guide and operations document rather
than changing global Codex settings or OS security controls. The now-authorized local
relocation preserves the new clone and database; the original phone-assistant repository
remains untouched. Broader terminal parity and module-manager gaps remain outstanding
v1 work at that checkpoint and must not be called complete just because startup or CI passes.

## Module managers

A module manager is a normal durable manager with a named area of responsibility, not
a second repository or a new orchestration subsystem. The owner creates it from the
team panel. It shares the same project/task/decision archive and sees peer managers'
checkpoints; it retains its own conversation and delegates its own bounded tasks.
Workers report to the manager that dispatched them. Managers have no parent manager
that automatically receives every turn: this avoids incidental manager/report loops.

Every task has one persisted manager ID. Only that manager can delegate or resolve its
reviews. Peers coordinate through recorded messages and can inspect the same evidence.
A split retains ownership. The default project manager is preserved for older tasks
by an additive migration that does not rewrite conversations or historical events.
The module description is organizational scope, not a filesystem sandbox: worker
writes still use the existing task-worktree and approval boundaries. No path input,
new table, scheduler, or duplicate checkout is required to create a module manager.

## Existing-session discovery

Use Codex's documented `thread/list`, `thread/read`, and `thread/turns/list` behind a
small shared CLI/web history adapter. Verify against the installed protocol as well
as official documentation: https://learn.chatgpt.com/docs/app-server. Include App Server
and subagent sources explicitly because the default listing only covers some clients.
Filter to the registered repository root on both provider request and returned records.
The browser gets opaque IDs and display metadata, never provider paths or raw RPC access.

Import is an explicit local handoff, not automatic takeover. It requires owner confirmation
that the original client is stopped, starts read-only, and never starts a model turn.
Read pages before one transaction installs the identity, visible archive and retry receipt.
Recheck source metadata, preserve exact duplicate identities, and reject failed, looping,
or oversized reads without a partial import. The original provider history stays unchanged.
This does not prove cross-process exclusive ownership or retroactively reconstruct an
external native subagent tree. Those are still distinct integration limitations.

## Native context forks

Keep one durable agent identity across native `/fork`; record source and destination
thread IDs in append-only events and preserve the archive without reimporting copied
messages. Require the current idle context and exact manager/task workspace. Refuse
foreign, ephemeral, already-owned or busy contexts. Forks inherit their source label,
so an editor-sourced thread can still be the result of a native CLI action.

A notification-only implementation failed the real browser check: `thread/started`
is observable without subscribing to subsequent turns or host tools. A small private
Unix relay now delays only the native fork acknowledgement until the host's documented
`thread/resume` subscription completes. Ordinary RPC and approval replies pass through
unchanged. Defer inherited goal continuation until the owner starts work; no turn may
race ahead of the host subscription. A failed subscription leaves the recorded fork
available for explicit recovery, not a silent retry. This relay is not a browser RPC
endpoint, general command API, replacement terminal or second scheduler.

Restart verification with browsers still open also exposed a pre-existing shutdown
ordering bug. End SSE responses and terminal views in Fastify's pre-close phase before
waiting for active requests. Database/provider cleanup still follows in on-close.

## Fresh and resumed native contexts

Extend the same private relay for `/new` and same-agent `/resume`; do not replace the
terminal or create a second coordinator. A small SQLite context-to-agent index retains
ownership after a context stops being current. It migrates unambiguous current/retired/fork
provenance without changing conversations or events. Saved-session import reuses this
durable owner instead of creating a duplicate agent for an old context.

`/new` installs the role charter and typed coordination tools before thread creation.
On the tested Codex version, name the empty thread before subscribing another connection:
an immediate resume otherwise fails with "no rollout found". Naming followed by resume
also works for an empty context after provider restart. `/resume` selects a known context
and subscribes the host before forwarding the native resume, so an inherited goal cannot
begin unseen. Selection is recorded separately from a successful resume acknowledgement.
Failed attachment retains the selected context for explicit recovery; loss of the host
connection closes native input rather than permitting untracked turns.

Same-agent context navigation does not change the manager, role, task worktree or archive.
Cross-agent native navigation needs explicit control transfer; it must not silently
run one agent's history under another's tools or permissions. Native plugins/MCP and native child-session integration
remain separate outstanding compatibility work, not silently reclassified as v2.

## Cross-agent native transfer

Intercept a registered foreign `/resume` in the private relay without forwarding it to
the source provider. Prepare the target's own provider and fixed Codex PTY, await its
resume acknowledgement, then move the existing input socket and retire the source PTY.
The browser follows the target identity; the local attach command stays connected.
Source-native model or permission overrides are not copied to another agent. Target
historical contexts use that target's existing ownership/subscription checks.

Reserve input ownership before asynchronous attachment to prevent scheduler races.
Serialize only terminal attachments/transfers, not agent work. Busy targets, unknown
contexts and task-workspace conflicts fail explicitly. A failed startup leaves source
input available; a late exit cannot release a replacement process's lease. An existing
target native view can be taken over at its current context, but must return to chat
before a different saved context is selected. Record source/target/context provenance
without rewriting either archive. No browser RPC endpoint or new scheduler is introduced.

Readiness means Codex acknowledged its managed context, not merely that a WebSocket
opened. Real testing also caught test-harness errors: a missing SQLite query parameter
made an earlier native archive comparison empty, and a browser init script restored the
wrong agent on reload. Correct both, require nonempty source history, and recheck exact
records across transfer and restart. A worker's normal completion report can briefly
occupy its manager; wait for it rather than bypassing busy-target protection.

## Selected worker MCP servers

Reuse Codex's configured servers rather than build a second credential/configuration UI.
The owner selects names for an idle worker; managers remain coordination-only. Apply
default and per-tool `prompt` policies on every managed/native context. Accept only the
documented MCP tool-call consent request with its exact original request ID and empty
consent form. Unsupported data-entry/URL requests are declined, not automatically opened
or accepted. MCP processes are trusted owner integrations, not task-sandboxed capabilities.
See https://learn.chatgpt.com/docs/extend/mcp and the App Server request documentation.

Real Codex testing established three adapter requirements. Read the MCP inventory with
the same feature gates as the runtime: synthesized desktop servers otherwise become
invalid transport definitions when their feature is disabled. Preserve full effective
server definitions privately when overriding a thread: policy-only overrides lose
CLI-injected transports. Omit absent/null options because the JSON-to-TOML conversion
cannot round-trip them. Never expose these private transport settings through the catalog.

Native CLI attachment must explicitly start with the managed sandbox and on-request
approval defaults. Inheriting this computer's global "never ask" default caused a real
MCP call to be declined before an approval could appear. Native controls still work;
choosing never-ask intentionally declines approval-requiring calls. A fixed local fixture
proved non-execution before/after decline, one execution after acceptance, and retained
selection, results and checkpoints across native fresh-context handoff and restart.

## Installed worker plugins

Reuse installed Codex plugins and connected apps with one worker-only opt-in. Do not
build a second marketplace, credential store or per-plugin scheduler. Keep disabled
capabilities disabled and force default/per-tool/per-account prompts. The native CLI
owns its plugin catalog. Agent Dock's structured client does not use the under-development
plugin management endpoints; see https://learn.chatgpt.com/docs/app-server and
https://learn.chatgpt.com/docs/config-file/config-reference.

Real testing showed that rejoining an already-loaded thread does not apply plugin
transport overrides. A late policy refresh let a read-only `list_apps` call execute
without consent during an isolated early check. No app interaction or write occurred.
Discover actual plugin server/tool names in a no-model ephemeral context first, then
apply the complete policy when loading the real context. Preserve the full feature
table so enabling plugins cannot accidentally enable unrelated execution features.
Plugin changes invalidate the loaded provider: reconnect that worker before its next
turn, retaining its thread and archive. Check native turn starts and serialize native
configuration changes against context/turn startup. Ordinary model preferences do not
invalidate plugin policy. Malformed or unavailable inventory fails closed.

Connected apps use original MCP consent on Codex 0.153.4. Their discovered `codex_apps`
server belongs to the opt-in policy, not the standalone MCP selection. A real public
GitHub metadata read proved explicit decline and accept. Tool discovery must be allowed
in the smoke prompt; an earlier over-restrictive test stopped without calling the tool.

Enable plugins in the worker's provider process as well as the thread; thread-only
enablement left the native catalog empty. The tested full marketplace response was
8,529,167 bytes, exceeding the original relay's 4 MiB bound and disconnecting native
input. Raise only provider-to-native responses/backpressure to 16 MiB. Native request
input and the structured adapter remain 4 MiB; catalog data is never a web API payload.
The real native catalog, fresh-context tool decline, checkpoint and handoff/restart
checks passed after these corrections. No plugins were installed or credentials changed.

## Native child observation and shared work groups

Use the provider's reported `sessionId`, parent thread and `source.subAgent.thread_spawn`
provenance, not a guessed relationship between UUIDs. Codex 0.153.4 emits child activity
on the parent's connection without a `thread/started` event; the first child signal can
be `thread/status/changed`. Serialize that connection's notifications and requests so
registration, tool consent and completion cannot overtake one another. Validate project,
current parent context and exact worktree before registering an additive child identity.
The provider tree owns execution; do not launch a separate provider for a child.
See https://learn.chatgpt.com/docs/app-server and
https://learn.chatgpt.com/docs/agent-configuration/subagents.

The real adapter fixture retains child tools, visible replies and a separate checkpoint,
then resumes that same child through its parent after provider/database restart. Native
v2 children do not accept independent direct input. The UI shows their archive and links
to the controlling parent; direct chat/settings/context changes fail explicitly instead
of queuing a turn that cannot run. Native helpers inherit the parent's application role;
they cannot submit an independent review verdict. Ordinary managed peers must address
the controlling parent rather than pretend a queued child message was delivered.

Native writers share their parent's task worktree. Keep the root job busy until every
observed child actually completes, then make one root checkpoint and one manager report.
An early idle status is not a completion acknowledgement. Interrupted/failed child work
cannot complete a waiting write group. On service recovery, interrupt the retained root
and child jobs; never replay a deferred Git checkpoint or an old consent request. The
existing scheduler counts root work groups, not native provider model threads. Global
model-slot scheduling remains v2; a native per-tree limit still needs its activation check.

Readable initial native delegation text is not fully exposed in public child history.
Preserve the visible evidence and label that gap, consistent with the owner's best-effort
context requirement. Do not depend on internal-use raw events or attempt to decode opaque
provider payloads. No hidden reasoning is archived. This checkpoint deliberately leaves
native spawning disabled in normal sessions: `/agent`, real writable groups and child
MCP/plugin policy inheritance still need end-to-end verification before activation.

## Loaded-child native viewing

Treat a known child's native resume as observation within its existing provider tree,
not the cross-agent process transfer used for independent workers. Validate current
ancestry, session ID, exact workspace and the provider's loaded, read-only input capability
before forwarding only the target ID and optional history-exclusion flag. Do not copy
the parent's model, MCP settings or approval policy into an observation request. Retain
both current context identities and the parent's execution lease. Cancelled, stale or
foreign-family transitions fail closed; closing the native view clears observation state.
Return to the parent before starting work, forking or changing native configuration.

The actual Codex 0.153.4 UI, not assumptions about `/agent`, determines the supported
route. Its `/agent` screen lists global root sessions. A loaded child can be viewed via
its known context after work completes. Read-only child views permit bare `/resume`,
not `/resume <id>`; use the picker and search for the exact parent ID to return. This
matches the versioned public implementation in
https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/bottom_pane/chat_composer.rs
and https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/tui/src/resume_picker.rs.
Real desktop, three-phone and local-CLI handoffs retained that view and both archives.
No upstream direct-input restriction was patched or bypassed.

Ordinary native children also passed their original MCP decline/accept and restart check.
A separate custom-agent probe caught a false-positive risk: asking for a custom role did
not select it. Assert reported role provenance rather than trusting the prompt. Explicitly
disabling the v2 feature did not make the tested model's spawn tool expose `agent_type`.
Keep requested classic/v2 fixture flags distinct and record actual capabilities; neither
an enum nor a successful ordinary child proves custom-policy inheritance. Normal-session
spawning stays off pending the remaining plugin/custom-policy and writable-group checks.

## Bounded native compatibility disposition (2026-09-08)

The real writable group and child plugin/app consent checks now pass. Their evidence
belongs in VERIFICATION.md; they should not be rerun as substitutes for normal-session
activation. A declared v1 model plus explicit custom-role registration also proved actual
custom selection and original child MCP decline. A narrow eight-attempt metadata-read
retry fixes the observed initial empty-rollout race, without replaying a turn or tool.

Do not make an optional child `dock_checkpoint` invocation a v1 completion requirement
when its relevant visible history, work and result are retained. Keep it empty if no
call was recorded; do not impersonate the child or assert unavailable tools from silence.
Continuity remains required: a legacy follow-up returned `notFound` because the parent
had not loaded the child after restart. Explicit native resume followed by send/wait
reached the same saved child and retained its exact previous archive. Use that supported
operation through the parent; do not auto-replay work or create a replacement identity.

Stop growing the compatibility matrix. Carry the verified sequence and genuine remaining
limits into the next bounded activation slice, then continue the day-to-day workflow.
Custom-MCP acceptance after restart and legacy native viewing are still unverified; neither
a passing ordinary child nor preserved old history proves those behaviors. The owner
requested reusable lessons: [ORCHESTRATOR_TROUBLESHOOTING.md](ORCHESTRATOR_TROUBLESHOOTING.md)
is explicitly marked as a future wiki seed, not another implementation plan.

## Ordinary worker native activation (2026-09-08)

Enable native tools in ordinary worker provider processes and context configuration;
leave manager native execution disabled. Preserve the effective feature table and custom
role definitions, while setting two open helper threads per worker. Both native feature
gates are available; the installed model capability determines its actual backend. Do not
change global Codex configuration or silently select a different model. These settings
also apply to native new/resume/fork, without changing observation-only child requests.
See https://learn.chatgpt.com/docs/agent-configuration/subagents for the configuration.

The worker charter now permits explicitly requested native helpers within the current
atomic task. They share workspace and application role, cannot act as the independent
reviewer, and finish as one work group. Include saved child provider IDs in parent host
state so recovery does not confuse application IDs with native thread IDs. Carry the
verified legacy resume-before-send guidance into worker instructions. Never synthesize
an optional child checkpoint or recreate completed work merely to obtain one.

Remove fixture-only native enablement from the real write, plugin and child-viewing
checks. All three pass on ordinary production settings, including independently reviewed
exact integration, original child consent, browser/three-phone/local-CLI handoff and
retained identities/archives. Existing group lifecycle and approval code is unchanged;
no new scheduler, public endpoint, credential store or configuration UI was added.

## Completed results versus integration (2026-09-08)

Task `done` means the existing independent review and manager completion gates passed;
it does not mean Git integration is applicable. Derive `hasReviewedChanges` at the public
task boundary from the existing private worktree, base and reviewed-commit records. Require
a reviewed commit different from the task's recorded base. The snapshot,
future task events and manager inspection use the same projection. Do not persist a
redundant flag, migrate historical events, expose paths, or infer output type from a
worker's latest role. Older public payloads default conservatively to false.

Both task panels use one badge component: transcript-only results are "Completed";
completed tasks with new reviewed commits are "Awaiting integration" and retain the action.
The flag is display evidence, not authorization or a filesystem freshness check. Exact
preview, clean-tree, independent-review and confirmation gates remain unchanged. No model
turn is needed to verify this presentation change; API/persistence checks and real rendered
desktop/phone checks cover the relevant behavior.

The first projection only required a worktree and reviewed commit. Live verification
disproved that assumption: every delegated task receives a worktree, and a read-only
review records the unchanged base commit. The corrected projection compares those existing
commit IDs. A real-Git/no-model review regression and the retained live read-only task
verify this case; do not redo the research or rewrite saved task/history records.

## Standard MCP forms (2026-09-08)

Use the existing original-request approval lifecycle for standard MCP typed forms,
with a separate `mcp_form` kind and a shared, bounded schema/value contract. Support
text, numeric/boolean values and the installed protocol's legacy/titled/plain single
and multiple choice shapes. Keep labels separate from submitted values, preserve false,
zero and empty choices, and validate constraints on the server without coercion. No
general JSON Schema engine, remote schema loading or new workflow scheduler is needed.
Official [App Server documentation](https://learn.chatgpt.com/docs/app-server) establishes
the request/response flow; installed generated types establish the exact typed field shapes.

Keep existing tool consent distinct: a malformed `codex_approval_kind` request cannot
be reclassified as a data form. Only selected/opted-in worker servers can request forms;
manager execution remains disabled. Unsupported extended forms and URL flows still fail
explicitly. Defaults never auto-submit. Save an explicitly submitted answer and its decision
atomically before forwarding to the original connection, without replay after uncertain
delivery. A subsequent tool result establishes effect; saved intent alone does not.

The UI names the recipient and warns against credentials/payment data. Submitted answers
belong in private local history; unsubmitted form values stay only in component memory
and reset on reload. Real local checks verified decline/accept, phone-to-desktop response,
native-started form handling, original archive preservation and same-context restart.
This does not claim support for every provider extension or third-party workflow.

## Explicit MCP URL requests (2026-09-08)

Extend the existing approval lifecycle with a validated `mcp_url` request and a retained
owner-only link. The [App Server protocol](https://learn.chatgpt.com/docs/app-server)
defines URL elicitations separately from MCP-server OAuth login. A resolved elicitation
is an answered/expired request, not an authentication-completed signal. Keep original tool
consent separate, preserve worker/server/plugin policy, and forward the exact decision
once. Do not introduce a second credential store, auth daemon or web fetch endpoint.

The card shows the requesting server, canonical destination origin and inspectable full
URL. Opening a page and allowing the request are distinct owner actions; neither alone
proves completion. Allow HTTPS and explicit loopback HTTP only, rejecting credentials,
non-web schemes and ambiguous parser repairs. Open links without an opener or referrer.
Loopback destinations refer to the opening device; this does not implement hosted phone
access. Retain accepted links privately for reload/handoff, with an expiration warning;
omit the structured URL field from model-facing inspection/context, but not owner exports.
Record the decision atomically before forwarding. A later tool result establishes effect;
no automatic opening, retry or replay occurs after uncertainty or restart.

Verification uses a fake local page with no credentials or external service. It proves
protocol transport and handoff, not any real third-party OAuth workflow. The test separates
page visit, permission and one actual fixture completion, preserving failed attempts as
well as successful history. Extended OpenAI forms and built-in desktop tools are separate
remaining v1 work, not reasons to keep growing this URL slice.

The native-origin check exposed a real two-client race: Codex 0.153.4's CLI immediately
declined URL requests before the owner could answer the host card. The private relay now
withholds only URL-mode server requests from that CLI connection. The already-subscribed
host handles the original request through existing validation, consent and expiry. No
response is invented; ordinary forms/approvals and native interruption remain unchanged.
The native tab points to Conversation. A new native-origin request on the same retained
fixture then passed explicit phone permission, desktop completion and exact restart.

## Worker web search (2026-09-08)

The provider previously forced web search off for every role. That blocked an ordinary
research worker's first-party capability regardless of the owner's Codex configuration.
Expose the installed protocol's four modes as one typed worker setting. Managers remain
coordination-only. New workers use cached search; missing fields in old Agent Dock
records project as disabled without migration or archive rewriting. The owner can choose
live or index-gated search, or turn it off, while the worker is idle.

Official [web-search documentation](https://learn.chatgpt.com/docs/web-search) establishes
that hosted search is separate from command networking. Do not widen the command sandbox,
turn search into blanket MCP consent, or infer containment from read-only filesystem access.
Show the outgoing-query/untrusted-result warning next to the setting. Preserve local and
managed restrictions rather than retrying with broader permissions when Codex refuses.

Apply the choice to provider startup and thread configuration, including native context
transitions. Reuse the existing idle reconnect path because loaded provider contexts can
retain configuration; no second runtime or new permission engine is needed. Preserve
identity, old contexts and visible history. Native child records inherit the root's saved
choice; custom provider role overrides are not a claim of universally identical behavior.

Two real public documentation turns passed: cached chat, then live native `/new` after
changing the setting from a phone-sized browser. Require actual new-run-owned search
items and cited answers, not just a stored setting. Exact archive/context and selected
mode survive restart. All four values have API/configuration coverage; these two turns
do not independently prove every provider's indexed-mode network enforcement.

## Native image output, not a second desktop host (2026-09-08)

The earlier "built-in desktop integrations" gap conflated different surfaces. Official
[browser documentation](https://learn.chatgpt.com/docs/browser) explicitly excludes the CLI,
whereas [image generation](https://learn.chatgpt.com/docs/image-generation) is a supported
CLI capability. Keep desktop-host/OS boundaries explicit; do not recreate an undocumented
desktop bridge or keep image generation disabled merely because it shared that flag list.

One worker-only image-generation opt-in reuses the existing idle settings/reconnect path.
It defaults off without rewriting old agent records. Preserve role-specific feature tables
across native new/resume/fork. The built-in tool uses the existing Codex connection; there
is no new provider, API key, image API client or implicit OS approval.

A real probe returned PNG bytes plus a saved path. Generic tool-text truncation would
discard most of the actual result. Decode only bounded canonical base64 PNG data, check
its signature/header/dimensions/end marker, and save an immutable blob keyed to the
original agent/tool item. Never read `savedPath` or fetch a URL. One small SQLite table
keeps metadata and bytes in the existing backup; savepoints make blob/entry persistence
atomic even inside a history import. A replay cannot replace an image with different bytes.
Provider response frames are bounded at 16 MiB to carry encoded output; public request
limits do not change. PNGs are bounded at 8 MiB and 32 million pixels, with 8,192 per side.

Only generated IDs and metadata cross the JSON/SSE boundary. The same-origin image route
validates both agent and image IDs, serves raster bytes with no sniffing/cross-origin use,
and accepts no filesystem path. A short-window preview, explicit full-size link and PNG
download work across clients. JSON exports contain metadata, not a portable blob bundle;
the database backup includes the bytes. Unsupported output is labeled, never regenerated
automatically. Native provider limits and the remaining extended-form gap stay explicit.

## Local v1 handoff, not an endless compatibility matrix (2026-09-08)

Audit the requested outcomes against retained real behavior before declaring completion.
Project/module delegation, bounded review and manager arbitration, exact integration,
visible child/peer work, persistence/recovery and native client handoff have evidence.
Everyday read-only manager work has also completed on this actual repository. A fresh
tracked-source clone installed, passed 101 backend and 44 browser checks, built, registered
an empty project and started independently without copying private history or making a
model call. This supports a local v1 handoff, not another administrative agent turn.

Do not silently remove an ordinary capability: the earlier web-search and image-output
gaps required implementation. Conversely, an optional protocol variant is not automatically
a native CLI requirement. Official [App Server documentation](https://learn.chatgpt.com/docs/app-server)
requires explicit `mcpServerOpenaiFormElicitation` capability for extended OpenAI forms.
A no-model probe received the installed 0.153.4 CLI's actual `initialize` request on a
private fixture socket; that capability was absent. Agent Dock does not advertise it
either. Leave unexpected extended forms explicitly declined rather than inventing a
schema renderer or claiming the current CLI supports this interface.

Unverified legacy combinations remain unverified, not repaired or universally supported.
The optional checkpoint gap, host-only desktop tools and stopped-client import boundary
retain their earlier dispositions. No code or safety gate changes as part of this decision.
Declare the local build ready with these limits visible. Hosted phone authentication,
distributed scheduling, the receptionist and packaged installation remain v2. Reopen a
bounded task when actual use identifies a concrete missing capability or defect; do not
keep a goal active solely to accumulate compatibility permutations.

## Owner correction: an approachable app cannot outsource its normal UI to a terminal

The owner found that Add a project only displayed `pnpm` commands. The previous acceptance
check had registered a repository from the CLI and even asserted that these instructions
were visible. That proved a developer setup path, not usable project creation. Treat
nontechnical, self-contained user journeys as a product requirement, not a cosmetic label.
Keep full native/advanced capabilities; simple defaults must not remove functionality.

New projects accept only a name, optional description and retry ID. The host allocates
a generated directory under private runtime storage, prepares an empty Git checkpoint
and repository-local save identity, then atomically registers its manager. No arbitrary
path, executable, shell command, remote publication, global configuration or model turn
is accepted by this API. Existing-repository CLI registration remains available.

Persist the reserved directory before setup. Serialize matching requests and recover only
that known, empty managed setup; do not follow substituted symlinks or adopt unexpected
files. Repeated requests and restart reuse the same project and initial checkpoint. Keep
drafts/retry IDs across browser reload, show errors in the form, and open the created
manager automatically. A visible dialog title must also be its accessible name.

Existing projects use a host-native macOS folder chooser. Do not add browser path input,
a filesystem explorer API, an arbitrary command endpoint or automatic Git initialization
of an owner-selected folder. Keep the selected repository's files/configuration untouched;
new projects use the separate managed setup route. Reserve the chosen root privately for
idempotent retry and share matching in-flight selections; abort the chooser at shutdown.
Other platforms retain new-project creation and the existing advanced CLI connection route.
The real native chooser's timed cancellation passed, but Computer Use could not attach to
the script-owned dialog for a manual selection check. Record that limit separately from
the passing real-Git endpoint and browser workflow tests, not as a request for OS permission.

Use ordinary language for normal decisions: reviewed work is "Ready to apply", followed
by "Apply changes" and an explicit confirmation. Full source/target hashes remain under
Technical details, with the original backend checks intact. A retry keeps the exact preview
and request ID; it must never silently approve a refreshed version of the work.

Keep errors inside the active form, not only in a page banner behind a modal. Block duplicate
pending submissions without discarding the draft. Keep native Codex itself as the advanced
surface, with readable help available at every supported size rather than reimplementing
slash commands. MCP connection setup still belongs to Codex for now: call this an open
usability gap, not something solved by hiding a command or linking to a guide. No new
credential manager, raw browser command endpoint or alternate tool runtime is introduced.

## Phone access is an active follow-up, with a separate authenticated entry

The owner moved phone access out of deferred v2 and authorized agent-led Cloudflare setup.
Use the official API MCP and human-completed OAuth; recommend the GitHub signup route when
offered. No manual token/DNS checklist, purchases or paid upgrade is part of normal setup.
The Cloudflare skill guided the named-tunnel and Access trust boundary; provider documentation
requires an available domain for this design. Do not promise a free new custom domain or
replace it with an exposed temporary tunnel. Inventory the authenticated account first.

Keep the unauthenticated local app on 127.0.0.1:4330. An optional second loopback listener
shares the exact runtime, SQLite store and terminal ownership. It validates the pinned
Cloudflare issuer, audience, signature, expiry and owner before serving anything, then
requires a paired-device cookie for private APIs and terminal upgrades. Never tunnel the
local entry or enable broad proxy trust. Pairing is an additional gate, not primary login.
Revocation closes already-open event/terminal connections as well as denying new requests.
The app closes streams at the earlier device/Access-token expiry; Cloudflare logout alone
is not claimed to instantly revoke every already-open stream.

Use short-lived, single-use, attempt-limited codes and a random hashed device token in a
Secure/HttpOnly/SameSite cookie. QR links contain only the address. Device controls remain
local-only. No service worker caches private history or queues commands offline. Preserve
all original Codex approvals and the owner's exact integration confirmation on either device.
Cloudflare terminates HTTPS; this is not end-to-end encryption against Cloudflare itself.
Desktop browser fixtures and local JWT/socket checks do not certify real phone deployment.

## GitHub backs up source checkpoints, not private runtime or every keystroke

The owner requested GitHub signup guidance and ongoing clean backups known to managers.
Choose an event-driven hook in the existing process rather than a second scheduler, agent,
filesystem watcher or globally installed Git hook. Once a project is configured, reviewed
task commits go to dedicated backup branches; exact approved integration can fast-forward
its private main branch. No staging-all, auto-stashing, history rewrite, force-push or
automatic integration. Preserve uncommitted owner edits instead of making a directory look clean.

Every export verifies the private destination, checks newly exported history for common
credential/runtime hazards, and confirms the remote commit. Persist intent before a push;
after an uncertain response inspect the remote before retry. Keep per-branch failures
visible across unrelated successes. Publish the same status to UI and manager host context.
Review/integration remain separate from backup, and a local commit is not a confirmed remote
backup. Larger or suspicious histories stop for bounded inspection; the scanner is a
guardrail, not a guarantee that arbitrary source has no private content.

Setup is agent-led and opt-in per project, with host-only ignored configuration. The runtime
uses existing GitHub CLI authentication via a per-command credential helper, not extracted
MCP tokens or global Git configuration edits. New-project creation does not silently create
an external repository. Follow SOURCE_BACKUPS.md for setup and failure handling. Private
database, conversations, uploads, credentials, unsaved edits and provider caches still need
their own backup strategy. The main service stays off during development.

## Cloudflare provisioning and app-owned tunnel (2026-09-08)

The refreshed API MCP works with the owner's effective full-access session. Access's
not-enabled response was resolved through its documented organization-create API without
payment entry or a subscription write. Use the existing authorized domain and a previously
unused hostname; leave other services/DNS untouched. Cloudflare sign-in is restricted to
account members and the application to the exact owner email, with independent MFA.
Retain resource IDs and the scoped runtime token only under private ignored data/.

A configured cloud endpoint is not an approachable workflow if the person must manually
run a second process. When the scoped tunnel-token file exists, the existing app process
supervises cloudflared on the local phone switch, reports actual connector readiness and
offers explicit reconnect after exit. Reuse the lifetime-pipe host for crash cleanup instead
of installing another login daemon. No cloud setup authority is kept by the app: it receives
only the one tunnel's runtime token. No browser path, executable or command is accepted.

Shutdown retains enabled intent and paired sessions for the next app start; turning phone
access off revokes enrollment as before and stops the owned tunnel. Ordinary cloudflared
network reconnects do not replay application messages or approvals. No token file means
external supervision for advanced setups. Tests of readiness are not proof of owner MFA,
remote pairing, Safari/Chrome installation or physical-device handoff.

## Terminal reconnect is an attachment, not a command replay

Phone/network disconnection previously required closing the retained terminal through
Return to chat before reconnecting. Add an explicit reattachment button using the existing
WebSocket ownership and retained-output path. Never automatically steal input from another
device or replay terminal bytes. A moved-control close offers Take control here; other
closed sockets offer Reconnect terminal, including failures before the initial ready event.
Disable input while disconnected. The backend/permissions/context model is unchanged.

## Owner correction: durable pairing, separate phone unlock (2026-09-09)

Accepted product requirement; implemented in the 2026-09-09 workspace, not deployed. This supersedes the earlier
Cloudflare-account/MFA phone journey. The owner has not signed into Cloudflare on the phone
and does not want to. Do not treat that as an owner-authentication blocker or ask them to
enroll another authenticator to finish the obsolete journey.

Enrollment opens only through the local computer, uses a short-lived single-use code and
local confirmation, then closes to additional devices. Approved enrollment has no automatic
expiry. Sleep, cellular changes, service restarts, an expired unlock session, and temporarily
turning phone access off must not remove it. Explicit device removal remains local-only and
must terminate existing private streams and terminal access. Trust-configuration changes
need an explicit migration/recovery disposition, not a silent promise of perpetual access.

Use a separate passkey unlock through WebAuthn, with phone-managed user verification. The
phone chooses Face ID, fingerprint or its supported local fallback; Agent Dock does not
collect biometrics. Require an enrolled browser credential as well: passkeys may sync, and
a synced passkey alone must not enroll another browser. An unlock session can expire without
expiring enrollment. Enforce unlocking on the server, not merely with a visual cover.
GitHub and Cloudflare account management belong to computer setup, not ordinary phone use.

Do not rely on an unverified iOS home-screen app-lock feature as the app's authentication
boundary. Browser storage can be cleared/evicted, and a replacement phone or separate
home-screen storage may require new local pairing; do not promise recovery of deleted
credentials. Keep the current Access gate until replacement authentication, denied-access
checks, restart/revocation and real-device unlock have been exercised in bounded slices.
No public bypass should be installed before the replacement protects private APIs and sockets.

References: [Apple's Safari passkey support](https://support.apple.com/en-gb/guide/iphone/iph37306ae67/ios),
[Apple app locking](https://support.apple.com/en-nz/guide/personal-safety/ipsd0be4c185/web),
[WebAuthn implementation guide](https://simplewebauthn.dev/docs/packages/server).

## Paired-device implementation and safe migration (2026-09-09)

Choose explicit host-only `authentication: "paired"` configuration rather than silently
changing the existing Access setup. Old configuration still defaults to `access`, with
its original fingerprint and checks. Both modes use the same protected loopback entry,
runtime, archive and terminal ownership. Keep the deployed gate unchanged until browser
verification permits a controlled acceptance window; real-device evidence necessarily
follows that activation. If acceptance fails, turn off the connector and restore the scoped
previous trust/routing configuration. Never expose port 4330 as a fallback.

Use maintained SimpleWebAuthn verification, pinned origin/RP, required user verification
and one-use challenges, not custom signature verification. The registration code is 16
characters/80 random bits, five minutes, five attempts and single-use. Local confirmation
checks a matching six-digit number after registration. No private workspace mounts before
an approved enrollment and verified unlock. Store only hashes of random browser/session
tokens; store the WebAuthn public key/counter, not biometrics or account credentials.

Approved enrollment has no server expiry. Its Secure/HttpOnly/SameSite browser cookie is
renewed for up to 400 days when used; that is browser storage, not a promise against eviction,
clearing or loss. Require this cookie as well as the saved passkey so syncing a passkey does
not enroll a new browser. Each verified unlock lasts at most 15 minutes on the server;
opening/backgrounding the app locks its view and requests server lock. Suspension/network
delivery is best-effort, backed by server expiry, not a claim of instantaneous remote lock
while offline. Visible status is refreshed while unlocked. Passkey fallback is phone-managed.

Temporary phone access off closes pending pairing and unlocks but retains approved devices.
Remove device revokes explicitly. Both close existing private streams without interrupting
agent work. Persist a verification revision so lock/off-on/removal during asynchronous
signature checks cannot restore a stale unlock. Changed trust configuration invalidates
old credentials; do not migrate origin/RP silently or promise that a passkey moves hosts.
No service worker caches history or queues commands. Cloudflare still terminates TLS.

## Small v2 coordination controls, not another orchestrator (2026-09-09)

Derive a cross-project attention list from the existing snapshot: original pending
approvals, manager decisions, failed/interrupted work, reviewed changes and backup failures.
It is a navigation view with no stored duplicate flags, automatic approvals or new agent.
Native child recovery points at its controlling parent. Resolved source state removes the
item on refresh/restart; opening it retains the existing review/confirmation flow.

Expose the existing local queue's fixed four-group admission bound as an owner-set 1–4
limit and a persistent pause-new-work switch. Keep per-agent order, task workspace locks,
native owner control and current turns unchanged. Helpers belong to their parent group;
native interactive work is not a queue-controlled spending quota. Save exact idempotent
settings/events, publish them to manager context, and require the normal app authority
to change them. No priorities, model budget promises, distributed leases or LLM scheduler.

## Agent-led reproducibility without machine-wide repairs (2026-09-09)

Pin the existing pnpm version and lockfile; put npm/pnpm caches under ignored project data.
The setup script checks Node/Git, installs and builds only. Account authentication, optional
phone resources and normal background use are separate explicit stages. A fresh source-only
copy downloaded dependencies and built without maintainer runtime data; this is not a native
installer or arbitrary-OS certification. The Cloudflare skill guided tunnel/trust migration
boundaries and the reusable setup runbook; no cloud configuration was changed this turn.

Source edits being allowed does not imply `.git`, browser spawning or MCP execution is
allowed. Record those distinct effective-policy failures once in OWNER_CHECK_IN.md, never
work around their enforcement, and keep independent bounded slices moving. Do not promise
GitHub backup for this uncommitted workspace or grow untested features indefinitely.

## 2026-09-28 — connected settings and recovery identities

The new shell reuses the existing assistant/privacy, shared editor chat, evidence search,
workspace handoff, computer, phone and recovery engines. Settings is now a hub; Models and
roles has its own destination. Phone enrollment is bound to a versioned canonical trust
identity, excluding the private listener port. Only exact legacy fingerprint matches migrate
without revocation. Transient transport/provider errors no longer masquerade as 401 unlock
requests. A forgotten browser registration is replaced without replaying the old pending
workspace request; drafts and its archived receipt remain local. No new account sharing,
model fallback, live data restore or automatic editor takeover was introduced.
