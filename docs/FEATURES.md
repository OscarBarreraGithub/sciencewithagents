# Feature map

This describes connected source behavior, not a blanket release certification.
[Current status](STATUS.md) lists open failures, unfinished features and device limits.

| Area                 | Available behavior                                                                                               | Boundary                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Home                 | Remaining allowances, computer snapshot, running projects, general to-dos and human action items                 | Readings show freshness; missing data is not zero usage                                         |
| Projects             | Choose a new/existing folder first, configure manager/workers and budget, then Spawn at the bottom               | Folder selection creates no manager; Spawn saves setup and the first brief is sent explicitly   |
| Model preferences    | Shared user defaults, project snapshots, editable task/family mappings, latest available versions and exact pins | Native/imported choices stay native; unavailable models need a visible correction               |
| Chats                | Managers, shared editor sessions and saved Misc conversations; compact phone chat and grouped tool details       | Internal helpers/resource reports stay out of the ordinary chat list                            |
| Prompt notepad       | Full-page editing, autosave, local versions, minimize and return to chat                                         | Unsent drafts are browser/device-local; erased storage cannot be guaranteed recoverable         |
| Active messages      | Codex steering, supported Claude follow-up queue, Stop and durable retry receipts                                | Support depends on the native session; uncertain sends are not blindly replayed                 |
| Delegation           | Managers assign Codex/Claude workers, inspect tools/results and coordinate bounded reviews                       | Native helpers share parent supervision; partial helper counters are labelled                   |
| Completed work       | Separate questions using saved evidence or an eligible copy of the original native conversation                  | Does not reopen the finished task/review or recover hidden reasoning                            |
| Manager continuity   | Persistent internal/human work items, checkpoints and concise requests; owner-only Notes                         | Managers continue independent work when one item awaits a person                                |
| Context maintenance  | Native Claude 60% compaction with handoff hooks; natural Codex compaction                                        | External native/editor sessions need their own supported integration; no perfect-memory claim   |
| QUARK                | Shared queue, priority/weights, caps/reserves, spending sliders, leases, pauses and coordinator chat             | Estimated attribution and stopping latency prevent an exact provider-enforced spending ceiling  |
| Computer health      | Current pressure, charts, project/job attribution, grouped apps/processes and full-screen Ask                    | Detailed probes are macOS-specific; automatic checks are bounded and off on fresh installs      |
| Phone                | Optional private Tailscale or configured domain, one-time passkey pairing and computer confirmation              | No recurring app lock; physical retention/reconnect needs device acceptance                     |
| Multiple computers   | Select configured hosts with separate accounts/projects/history; two copyable setup prompts                      | Connection is agent-assisted over a verified private route, not automatic discovery             |
| Updates and recovery | Consistent local recovery copies, source-backup controls and agent-led update handoff                            | Git source backup excludes conversations, browser drafts and uncommitted files                  |
| Provider maintenance | Refresh usage, check native connection, supported CLI update paths                                               | Custom/embedded installations and sign-in may require a person; no silent provider substitution |

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
caps and reserves apply across concurrent projects. Unknown usage holds new protected work;
transient read failures and quota exhaustion have distinct recovery paths.

The coordinator stores its instructions outside project worktrees, uses a selectable central
model and wakes for messages or bounded events rather than consuming tokens while idle.
Saved estimated/actual timing examples help future forecasts; this is evidence, not model
training. [QUARK](QUARK.md), [coordinator](QUARK_COORDINATOR.md), [accounting](QUARK_ACCOUNTING.md).

Computer health links busy processes and script/module names to supervised QUARK projects
and tasks. Sustained CPU, memory or process-group changes wake a bounded check; the assistant
compares the change with expected work instead of treating high usage alone as a fault.
Untracked processes remain distinguishable from app-owned work. See [resource monitoring](RESOURCE_WATCH.md).

## Native capabilities and saved evidence

New managed agents inherit native tools, skills, hooks and configured integrations. Supported
native unattended policies provide broad reads/network access and role-appropriate writes;
explicit saved restrictions remain editable. Provider/organization rules and external tool
boundaries still apply. [Worker tools](WORKER_TOOLS.md), [provider compatibility](PROVIDER_COMPATIBILITY.md).

Managed turns include short work-item/Notes previews; `dock_inspect {}` retrieves their full
details when needed. Current instructions and accepted host-tool names accompany managed
turns; Claude reconnects its saved session at the next turn if its charter/tools changed.
Native tool catalogs may still retain old tool names, which the backend rejects explicitly.

Stored app conversations and worker records remain searchable in project history even when
the screen pages old messages. Managed chats show up to 200 entries per page; **Latest messages**
returns to current replies without changing the draft. The Chats finder excludes background
helpers and resource checks using saved identities before candidate limits; a matching title never
hides a personal chat. Finder coverage remains partial: up to 20 recent projects, 32 saved chats,
and 8 connected editor titles, with no editor transcript search. A bulk worker can recap requests
with source references for a manager to check.
Independent native/editor histories, unsent drafts and private reasoning have different
retention boundaries. Original VS Code chats retain their native identity and model choices.
The optional companion needs no separate editor login. [Companion](../apps/vscode-mirror/README.md).

## Documents on a phone

Apps keeps GitHub and Cloudflare sign-up instructions behind **Set up publishing accounts**.
You can hide this shortcut once set up; that display preference is saved for this browser and
selected computer. The full instructions remain in **Help and setup**. Hiding the shortcut
does not verify or change account sign-in.

All chat views render inline and displayed LaTeX equations automatically, including saved
and shared VS Code messages. Wide equations scroll within their message; code remains literal.

Apps includes a LaTeX/PDF reader with computer-side compilation, folder browsing, recent
files, selectable text, page navigation and zoom. Manager links open over chat and return
to the same reading position and draft. Failed builds retain the previous PDF; existing
LaTeX-backed reports also have adjustable, reflowing Reading mode: phone-width text, figures and individually scrollable equations. Saved local report links open inside the chat. PDFs need no compiler. See [LaTeX](LATEX.md) for setup and conversion limits.

## Scope not presented as finished

Custom project-app registration, automatic five-hour utilization mode, setup-progress detection and some
update/UI refinements remain incomplete. Personal-assistant and transcription backend
capabilities are retained for existing/advanced use, but are not advertised Home destinations.
The legacy workspace is maintenance-only. See [Status](STATUS.md) before planning a rollout.

## Implementation map

| Concern                     | Code/reference                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| UI and responsive journeys  | `apps/web/src/home/`, `apps/web/tests/home/`, [design](DESIGN.md)                                   |
| Runtime, tasks, persistence | `apps/server/src/runtime.ts`, `apps/server/src/store.ts`, [operations](OPERATIONS.md)               |
| Provider/model routing      | `apps/server/src/model-policy.ts`, `packages/shared/src/model-policy.ts`, [policy](MODEL_POLICY.md) |
| Queue and quotas            | `apps/server/src/pulsar.ts`, [QUARK accounting](QUARK_ACCOUNTING.md)                                |
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
automatically imported during setup.

To remove a manager, open its chat configuration and choose Remove manager. Stop running work
first. Removal cancels queued messages and unfinished tasks, hides the manager from normal
lists and prevents further work. Project files, completed results and saved history are retained.
