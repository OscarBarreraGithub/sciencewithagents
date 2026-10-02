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
| Manager continuity   | Persistent internal/human work items, notes, checkpoints and concise requests                                    | Managers continue independent work when one item awaits a person                                |
| Context maintenance  | Native Claude 60% compaction with handoff hooks; natural Codex compaction                                        | External native/editor sessions need their own supported integration; no perfect-memory claim   |
| QUARK                | Shared queue, priority/weights, caps/reserves, spending sliders, leases, pauses and coordinator chat             | Estimated attribution and stopping latency prevent an exact provider-enforced spending ceiling  |
| Computer health      | Current pressure, charts, project/job attribution, grouped apps/processes and full-screen Ask                    | Detailed probes are macOS-specific; automatic checks are bounded and off on fresh installs      |
| Phone                | Optional private Tailscale or configured domain, one-time passkey pairing and computer confirmation              | No recurring app lock; physical retention/reconnect needs device acceptance                     |
| Multiple computers   | Select configured hosts with separate accounts/projects/history; two copyable setup prompts                      | Connection is agent-assisted over a verified private route, not automatic discovery             |
| Updates and recovery | Consistent local recovery copies, source-backup controls and agent-led update handoff                            | Git source backup excludes conversations, browser drafts and uncommitted files                  |
| Provider maintenance | Refresh usage, check native connection, supported CLI update paths                                               | Custom/embedded installations and sign-in may require a person; no silent provider substitution |

## QUARK and shared accounting

QUARK means **Queued Usage, Agent Routing Kernel**. One host-owned collector reads the
reported account/model windows and shares cached results with the UI and every manager.
There is no per-agent polling terminal. Tokens, tool activity and provider-window changes
inform project attribution; estimates never become a claim of billing accuracy.

Managers need signed admission leases before orchestrating. Typed dispatch hooks and the
host watcher check limits independently of the manager. Managers can pause owned workers;
QUARK can stop an unresponsive owned run while preserving its files and conversations.
Caps and reserves apply across concurrent projects. Unknown usage holds new protected work;
transient read failures and quota exhaustion have distinct recovery paths.

The coordinator stores its instructions outside project worktrees, uses a selectable central
model and wakes for messages or bounded events rather than consuming tokens while idle.
Saved estimated/actual timing examples help future forecasts; this is evidence, not model
training. [QUARK](QUARK.md), [coordinator](QUARK_COORDINATOR.md), [accounting](QUARK_ACCOUNTING.md).

## Native capabilities and saved evidence

New managed agents inherit native tools, skills, hooks and configured integrations. Supported
native unattended policies provide broad reads/network access and role-appropriate writes;
explicit saved restrictions remain editable. Provider/organization rules and external tool
boundaries still apply. [Worker tools](WORKER_TOOLS.md), [provider compatibility](PROVIDER_COMPATIBILITY.md).

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

## Scope not presented as finished

The Apps gallery, automatic five-hour utilization mode, setup-progress detection and some
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
