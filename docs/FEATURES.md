# Feature map

This describes connected source behavior, not a blanket release certification.
[Current status](STATUS.md) lists open failures, unfinished features and device limits.

| Area                 | Available behavior                                                                                               | Boundary                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Home                 | Remaining allowances, computer snapshot, running projects, Ideas, To-dos, Completed/Undo and human action items  | Readings show freshness; missing data is not zero usage                                             |
| Projects             | Choose a new/existing folder first, configure manager/workers and budget, then Spawn at the bottom               | Folder selection creates no manager; Spawn saves setup and the first brief is sent explicitly       |
| Model preferences    | Shared user defaults, project snapshots, editable task/family mappings, latest available versions and exact pins | Native/imported choices stay native; unavailable models need a visible correction                   |
| Chats                | Managers, shared editor sessions and saved Misc conversations; compact phone chat and grouped tool details       | Internal helpers/resource reports stay out of the ordinary chat list                                |
| Prompt notepad       | Full-page editing, autosave, local versions, minimize and return to chat                                         | Unsent drafts are browser/device-local; erased storage cannot be guaranteed recoverable             |
| Active messages      | Codex steering, native follow-up queues, held editing for app-owned queued messages, Stop and durable retries    | Native editor queues keep their supported controls; uncertain sends are not blindly replayed        |
| Delegation           | Managers assign Codex/Claude workers, inspect tools/results and coordinate bounded reviews                       | Native helpers share parent supervision; partial helper counters are labelled                       |
| Completed work       | Separate questions using saved evidence or an eligible copy of the original native conversation                  | Does not reopen the finished task/review or recover hidden reasoning                                |
| Manager continuity   | Persistent internal/human work items, checkpoints and concise requests; owner-only Notes                         | Managers continue independent work when one item awaits a person                                    |
| Context maintenance  | Native Claude 60% compaction with handoff hooks; natural Codex compaction                                        | External native/editor sessions need their own supported integration; no perfect-memory claim       |
| QUARK                | Shared queue, priority/weights, caps/reserves, spending sliders, leases, pauses and coordinator chat             | Estimated attribution and stopping latency prevent an exact provider-enforced spending ceiling      |
| Slurm cluster        | Shared cached queue, pending reasons, fairshare, native limits, recent efficiency and submitted-job tracking     | Advisory only: no app cluster limits; native SSH sign-in and site rules apply                       |
| Cluster notebooks    | Open running compute-node Jupyter notebooks through the existing private SSH connection                          | Phone/selected-computer access needs that worker's separately configured notebook HTTPS address     |
| Computer health      | Current pressure, charts, project/job attribution, grouped apps/processes and full-screen Ask                    | Detailed probes are macOS-specific; automatic checks are bounded and off on fresh installs          |
| Phone                | Optional private Tailscale or configured domain, one-time passkey pairing and computer confirmation              | No recurring app lock; physical retention/reconnect needs device acceptance                         |
| Notifications        | Opt-in push per device and project when approvals, decisions or failed runs stop work                            | Simulated checks only; physical iPhone delivery needs acceptance                                    |
| Multiple computers   | Select configured hosts with separate accounts/projects/history; two copyable setup prompts                      | Connection is agent-assisted over a verified private route, not automatic discovery                 |
| Updates and recovery | GitHub update check, automatic pre-update database copy, maintenance-agent assignment and source backups         | Agent handles customizations; quit/reopen is explicit. Source backup excludes private conversations |
| Provider maintenance | Refresh usage, check native connection, supported CLI update paths                                               | Custom/embedded installations and sign-in may require a person; no silent provider substitution     |

**Computers → Open terminal** runs your own shell on the selected computer even at zero AI
allowance; the app must remain running. See [local access](LOCAL_ACCESS.md#run-your-own-commands).

## Report a bug

Open **? → Report a bug**, describe the problem, then **Save and assign**. The selected
computer saves a private report under `data/bug-reports/<id>/report.md`, with the page and
a bounded queue snapshot. One maintenance manager receives an internal to-do and a message;
it delegates a bounded fix and independent review using the normal model/project policy.
Reports never become public GitHub issues automatically. Existing running work is preserved;
publishing, external permission grants and app restarts are not automatic.

A report survives connection loss without duplicate assignments. A failed folder write can be
retried while the database and manager retain the report. **Open maintenance chat** shows
progress or the actual queue/connection blocker; saving a report does not guarantee a fix.

## QUARK and shared accounting

QUARK means **Queued Usage, Agent Routing Kernel**. One host-owned collector reads the
reported account/model windows and shares cached results with the UI and every manager.
There is no per-agent polling terminal. Tokens, tool activity and provider-window changes
inform project attribution; estimates never become a claim of billing accuracy.

Managers need signed admission leases before orchestrating. Typed dispatch hooks and the
host watcher check limits independently of the manager. Managers can pause owned workers;
QUARK can stop an unresponsive owned run while preserving its files and conversations.
Routine work uses shared headroom without an invented per-task cap. Raw token counts, including
cached context, are accounting evidence and never an admission limit. Owner-set allowance
caps and reserves apply across concurrent projects. Optional per-project/task rolling hourly limits share reservations across simultaneous and
pending work, separately for Codex and Claude's reported windows. Resets/restarts retain
recent spend; hourly waits can recover after confirmed stopping and fresh capacity.
The board shows current project rates and 12-hour history beside separate Codex/Claude
controls; a zero hourly rate pauses that provider's project work. Separate reserve controls
accept 0–100%, with opt-in timed release near reported resets. Depletion forecasts use observed
account activity, including work outside the app; unknown intervals remain gaps.
The compact overview links work counts to their board columns and shows remaining windows
and resets. Account forecasts, refresh and connection actions expand under Details; old
readings are labelled and do not support fresh-looking projections.
Unknown usage holds new protected work; transient read failures and quota exhaustion
have distinct recovery paths.

Home and project boards keep Ideas separate from actionable To-dos. Select one or several
to-dos and package one background ticket with priority and estimated compute sliders (1–5).
QUARK queues a worker without an initial manager turn; existing project review/application
policy still applies. Background ordering considers priority, relative compute and queue age;
foreground work comes first. Source items remain linked. Completed items have an Undo action.
An idea can seed a new project's first notepad without deleting or completing the idea.

Job details read the saved request, waiting reason, responsible worker, task and attributed
outcomes even after the job leaves the recent queue. Links lead to its conversation, task,
project and hourly controls. Long evidence is previewed with access to the retained text.

The coordinator stores its instructions outside project worktrees, uses a selectable central
model and wakes for messages or bounded events rather than consuming tokens while idle.
QUARK and the resource assistant receive compact current evidence and retrieve saved detail
on demand. Managers use concise accounting totals and report provider/worker token breakdowns
with cached and incomplete counters labelled.
Automatic QUARK checks start fresh; idle owner conversations renew after an hour without owner
input. Saved decisions and conversations remain available, without replaying the entire archive
into each model turn. Resource diagnoses preserve the selected model when they renew.
Saved estimated/actual timing examples help future forecasts; this is evidence, not model
training. Managers receive comparable project/provider/model turn examples with duration,
token basis and estimated allowance attribution; inherited task forecasts are labelled.
An optional Claude five-hour policy advances eligible background work without gradual
release while retaining foreground priority, exact choices, caps, pauses and reserves.
[QUARK](QUARK.md), [coordinator](QUARK_COORDINATOR.md), [accounting](QUARK_ACCOUNTING.md).

Computer health links busy processes and script/module names to supervised QUARK projects
and tasks. Sustained CPU, memory or process-group changes wake a bounded check; the assistant
compares the change with expected work instead of treating high usage alone as a fault.
Untracked processes remain distinguishable from app-owned work. See [resource monitoring](RESOURCE_WATCH.md).

## Native capabilities and saved evidence

The composer’s **/** menu and **/goal** open goal controls without sending a model message
or replacing an unsent draft or its attachments. Supported shared Codex chats expose their native **Goal**: the objective,
status, elapsed work and token accounting, with controls to set, pause and resume it.
These operate on the same conversation as VS Code. A goal does not move the conversation
into QUARK or override provider limits. Older companions need a safe update before their
controls are available. Claude and app-managed goal continuation are separate capabilities;
the app does not substitute a new goal or an unsupervised loop when they are unavailable.

App-managed Claude chats expose discovered native commands in the composer's **/** menu,
including **/compact** and **/context** when available. Commands run in the existing native
session and retain the unsent draft and attachments. Interactive commands that require the
native terminal or editor remain there; the app does not claim complete native interface parity.

App-owned Codex and Claude project managers offer a separate, explicit opt-in **Goal**
through **/goal** or the composer’s **/** menu. The compact **VS Code** action in a manager’s
header opens its registered project folder on that computer in a new editor window.
An unconfirmed launch keeps its receipt; **Open again** deliberately starts a new request
and may open another window.
Unsupported goal connections explain their capability and keep drafts. The command menu
also exposes the currently connected session controls; other native commands still need
the original provider session. Manual Claude compaction is not connected to the app yet.

The manager goal’s objective and progress persist through reloads and restarts. First and follow-up turns
use the manager's ordinary model and QUARK admission, including existing reserves and
hourly/window limits; native automatic goals are not used to bypass admission. Reading the
goal starts no model turn, and unchanged progress does not generate polling turns.
Adjacent owner asks add to outstanding work unless explicitly cancelled or replaced. Completion
requires reconciling scoped open requests, work items, tasks and active/pending helpers.
**Pause goal** holds queued goal work, and **Resume goal** reuses that receipt under QUARK.
**Stop goal** cancels unstarted goal work without claiming completion; an active reply
continues until the separate **Stop reply** action. Failed or interrupted work needs the
existing chat inspection/resume path. Existing managers and standalone chats are not
automatically enrolled, and there is no additional raw-token budget.
Older Codex manager conversations retain their native identity and tool catalog. Their next
admitted turn receives a typed local-client route for recording goal progress when its original
catalog lacks the new tool; saved requests retain the original turn and retry receipt.

The compact **Queued messages** row opens a full-height list of short previews; **Read full
text** expands a message. App-managed messages and
follow-ups queued here for shared VS Code chats can be held and edited in the notepad
before dispatch; minimizing, reloads or another message completing never
release the edit hold. **Save and queue** waits for an in-progress autosave before releasing
the hold explicitly; a failed save keeps the message held for recovery. Supported Codex sessions
also offer an explicit **Steer now** action. Lost acknowledgements stay available for
inspection rather than being silently resent. Messages queued directly in the native editor
or already handed to it remain under that editor's supported controls. Original wording
and saved edits remain retained; material changes to app-managed messages reopen earlier
source-message triage.

New managed agents inherit native tools, skills, hooks and configured integrations. Supported
native unattended policies give writing roles full native access (files, browsers, SSH) with
the project folder as intended scope; read-only roles stay sandboxed and explicit saved
restrictions remain editable. Provider/organization rules and external tool
boundaries still apply. [Worker tools](WORKER_TOOLS.md), [provider compatibility](PROVIDER_COMPATIBILITY.md).

Managed turns include short work-item/Notes previews; `dock_inspect {}` retrieves their full
details when needed. Current instructions and accepted host-tool names accompany managed
turns; Claude reconnects its saved session at the next turn if its charter/tools changed.
Native tool catalogs may still retain old tool names, which the backend rejects explicitly.

Stored app conversations and worker records remain searchable in project history even when
the screen pages old messages. Manager chats keep internal team/QUARK exchanges and routine
replies in **Subagents → Team activity**. Owner messages, replies to owner-steered turns,
approvals and human action items remain in the main conversation. A provider-marked
commentary phase joins the collapsed activity row and an explicit final reply stays in the
timeline. Without a phase, only earlier replies of a completed turn followed by tool activity and
a later reply on the same page join the row, labelled Earlier replies and still readable; imports,
running/stopped turns and replies after owner steering stay in the timeline. Routine draft autosave keeps one stable status line; failures alert with Retry. The saved history is retained;
the two views page their own entries using recorded run provenance.
Managed chats show up to 200 entries per page; **Latest messages**
returns to current replies without changing the draft. The Chats finder excludes background
helpers and resource checks using saved identities before candidate limits; a matching title never
hides a personal chat. Assisted model coverage remains partial: up to 20 recent projects,
32 saved chats and 8 connected editor titles. Its **Search saved text** expansion separately
pages full retained app text across all projects, plus selected available editor transcripts,
including long messages and grouped tool activity. Empty pages retain continuation; offline or
unshared native history remains an explicit omission. See [archive review](ARCHIVE_REVIEW.md).
A bulk worker can recap requests
with source references for a manager to check. Managers receive paged untriaged owner-message
IDs after steering and compaction; work items retain structured source links and explicit
dispositions. A bare link remains pending review; an explicit whole-message disposition records triage,
not that every independent ask has been completed.
Independent native/editor histories, unsent drafts and private reasoning have different
retention boundaries. Original VS Code chats retain their native identity and model choices.
The optional companion needs no separate editor login. [Companion](../apps/vscode-mirror/README.md).

## Documents on a phone

**Attach files** opens the device's file picker in chat and the first-project notepad. Attach
several files at once, up to four per message and 8 MB each. A selection that exceeds the
remaining slots or contains an empty/oversized file is rejected before uploading. Interrupted
batches retain completed attachments; Retry upload resumes the remaining files without
duplicating them. Discard remaining uploads leaves completed attachments in the draft.
Sending waits until remaining uploads are retried or discarded. You can remove attachments before
sending. Images retain previews and native vision support. Documents and other files are stored privately on the selected computer and handed to a capable native
agent by reference. Completed attachments in drafts survive reloads; unfinished selections
must be chosen again after closing or reloading the chat. Attaching a file does not execute it or
guarantee the selected assistant can interpret every format; coordination-only QUARK reads
bounded text previews and can refer other files to an appropriate manager.

Apps keeps GitHub and Cloudflare sign-up instructions behind **Set up publishing accounts**.
Native GitHub and Cloudflare sign-in checks collapse completed steps; missing tools or
sign-in retain copyable instructions. A browser-local hide preference remains available,
and the full instructions stay in **Help and setup**. Hiding does not change account sign-in.

Project managers can register a local app and an optional published HTTPS address in Apps.
Tiles report whether its local port responds. Registration does not deploy the site or make
a local port accessible from a phone; remote devices need the published address.
See [project apps](APPS.md).

All chat views render inline and displayed LaTeX equations automatically, including saved
and shared VS Code messages. Wide equations scroll within their message; code remains literal.

Apps includes a LaTeX/PDF reader with computer-side compilation, folder browsing, recent
files, selectable text, page navigation and zoom. Manager links open over chat and return
to the same reading position and draft. Failed builds retain the previous PDF; existing
LaTeX-backed reports also have adjustable, reflowing Reading mode: phone-width text, figures and individually scrollable equations with visible overflow cues. An explicit **Format for phone** request creates a separate reading copy using a selectable model, defaulting to the live Sonnet family; originals stay unchanged. Saved local report links open inside the chat. PDFs need no compiler. See [LaTeX](LATEX.md) for setup and conversion limits.

## Scope not presented as finished

Automatic reset-window exhaustion is not guaranteed; agent-assisted updates and physical
phone behavior retain the acceptance limits in Status. Personal-assistant and transcription backend
capabilities are retained for existing/advanced use, but are not advertised Home destinations.
The legacy workspace is maintenance-only. See [Status](STATUS.md) before planning a rollout.

## Implementation map

| Concern                     | Code/reference                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| UI and responsive journeys  | `apps/web/src/home/`, `apps/web/tests/home/`, [design](DESIGN.md)                                   |
| Runtime, tasks, persistence | `apps/server/src/runtime.ts`, `apps/server/src/store.ts`, [operations](OPERATIONS.md)               |
| Provider/model routing      | `apps/server/src/model-policy.ts`, `packages/shared/src/model-policy.ts`, [policy](MODEL_POLICY.md) |
| Queue and quotas            | `apps/server/src/pulsar.ts`, [QUARK accounting](QUARK_ACCOUNTING.md)                                |
| Slurm cluster               | `apps/server/src/cluster.ts`, `apps/server/src/cluster-slurm.ts`, [cluster](CLUSTER.md)             |
| Native editor bridge        | `apps/vscode-mirror/`, [maintenance](VSCODE_MIRROR.md)                                              |
| Setup and local opening     | `scripts/setup.mjs`, `scripts/create-launcher.mjs`, [setup](CONTRIBUTOR_SETUP.md)                   |

Source is MIT licensed. Runtime data, credentials, private conversations, drawings and
screenshots are excluded from the distributable repository. The public domain redirects to GitHub.

Existing project folders can be selected in the app from a paired phone, desktop browser or
connected-computer view. Familiar locations, clickable breadcrumbs, back/forward navigation
and folder-name search make it possible to explore the selected computer. Search can include
subfolders; broad searches are bounded and incomplete results are labelled. Hidden folders
are optional. Selection creates no manager; Spawn connects the folder and preserves its files.
Give the project a separate display name during setup; the selected folder stays in place
with its original name. Spawn creates a fresh project and manager even if that folder already
has a manager. Settings and conversations are separate; files in the chosen folder are shared.
Open an earlier manager from Chats to continue its conversation. No local transcript is
automatically imported during setup. Spawn opens the notepad immediately while setup runs in
the background. Sending early waits for setup; failures and reloads retain the draft and retry
the same message receipt rather than sending twice.

**Archive chat** hides an app conversation or shared editor thread from the ordinary list.
Open **Archived** to restore it, including a shared thread that is currently offline. This
keeps drafts, history, active jobs and native provider state intact.

To remove a manager, open its chat configuration and choose Remove manager. Stop running work
first. Removal cancels queued messages and unfinished tasks, hides the manager from normal
lists and prevents further work. Project files, completed results and saved history are retained.

## Availability and pacing

Saved views and drafts remain available when providers cannot start work. Temporary model
discovery failures keep messages queued for retry; another provider can start independently.
A reconnecting browser exposes its retained local draft for copying. Sends use durable receipts
so retry does not silently resend accepted work. This does not make a powered-off computer
available or cache the whole chat archive on the phone.

A manager's Configure panel offers **Ignore QUARK for my replies**. It applies to existing
queued and future direct owner messages; running replies retain their current choice. Manual
pauses, edit holds, native permissions and provider limits still apply. Workers and observed
native helper families remain under ordinary QUARK supervision.

QUARK also reports spare capacity before a reset and projected reserve depletion. Its bounded
coordinator wake-ups advise managers to advance suitable work while keeping provider choices,
project caps and machine limits. Forecasts are estimates, not a promise to exhaust a window.
