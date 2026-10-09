# QUARK conversation and board

The connected coordinator and board use the same host scheduler and accounting as managers.
See [Status](STATUS.md) for unresolved release checks and automatic utilization work.

QUARK is the cross-project allocation desk. Its conversation sits above a simple board:
waiting, working, paused/needs input and completed. Show the task, project, actual model,
priority, allowance/resource forecast, measured progress and reason for waiting. Budget
feasibility is an estimate, never a guarantee. Retain detailed queue/accounting controls.
Long project and column lists are bounded with a count-labelled **Show more**. Budget and task
links reveal and focus their card behind a filter, search or bounded list.

The owner can say “pause A, prioritize B, give B 20% of this weekly allowance.” Save the
instruction and its concrete changes. Priority weight changes ordering; it does not create
allowance. Only an owner-message turn can increase caps or reduce the shared reserve.
Automatic decisions stay inside those bounds. A floor such as 20% remaining applies across
projects and reported provider/model windows. Do not invent a weekly limit for FAS Claude.

The owner can also request separate Codex/Claude project limits in percentage points per
hour, choosing a reported allowance window. The budget action uses `period:"hour"` and
`enabled:false` turns off an hourly limit through owner controls. The default `period:"window"`
keeps the saved grant semantics. Hourly edits preserve the rolling spend and use the same
revision/retry protections. Project cards offer these controls without starting an AI turn.

Use the existing local runtime and queue. Store QUARK identity, instructions and decisions
under private runtime data outside project worktrees. An unconfigured coordinator uses current
Opus when Claude is enabled, or current Sol for a Codex-only installation. Opening it freezes
that provider choice; saved explicit models and existing conversations remain unchanged.
Keep it available while the app runs, waking on relevant events with bounded frequency and
turn length, never an idle token-burning loop. Recover saved work after restart; a sleeping
or stopped computer cannot run it. Project managers retain implementation responsibility.

Forecast overruns should notify the manager, who can slow, pause or revise its plan. Never
silently increase an owner cap. A small agreed allowance extension remains bounded by the
reserve and hard cap. Existing host guards stop owned work if the manager fails to respond;
pausing retains files and conversations. Capture illustrative estimated/actual timing and
usage cases for managers, distinguishing active work, queue time and parallel worker time.

Read-only diagnostic roles remain appropriate. Routine execution should use native
unattended settings instead of per-tool restrictions. Authentication or external policy
failures must be visible, not an endless hidden permission wait. This does not grant models
permission to raise budgets, approve integration, or bypass provider/organization controls.

## Provider maintenance and permissions

The usage card offers Refresh usage, Check connection, and Check & install updates.
Use native installers, preserve sign-in, wait for active app work and refresh discovery.
Unsupported/custom installations get an explicit explanation; never replace an embedded
CLI or wait on an invisible administrator prompt. Rechecking native sign-in/catalog can
recover transient connections; account consent still needs the owner. Keep a copyable
repair prompt for a working AI account and basic Terminal checks when neither works.

Writing native managers, workers and requested resource investigations use the provider’s
supported full-access unattended settings. The assigned project remains their intended scope,
not a promised filesystem sandbox. Explicit read-only and restricted choices remain in effect.
QUARK itself keeps its typed coordination-only tools. Arbitrary MCP/remote tools require their
own enforcement; a prompt instruction is not a filesystem sandbox. The supported launch policy is described in [Worker tools](WORKER_TOOLS.md); no universal
containment claim is made.

## Guide material: revisit every original request

Sent prompts and saved app-managed conversation entries remain in the local archive when
the screen pages history or unloads old messages to reduce phone memory. Managers can use
saved-history search/paging and exact source reads to recap original requests, reconcile a
checklist against delivered work, and identify forgotten details. A Luna worker is suitable
for the first bulk extraction; a manager verifies conclusions against the cited originals.
Explicitly report missing records and continue in batches across context boundaries.

This is retained evidence, not perfect memory: unsent drafts have their own browser/device
storage, and VS Code/native histories are separately sourced/imported. Remote tools, private
reasoning and unobserved messages are not promised. A source-code Git backup does not back
up the conversation database. Never delete original prompts merely because the UI pages them.

## Operation and limits

Open Work, then Open QUARK conversation. Creating it does not spend a model turn. It wakes
for your messages or relevant changes in active work. Model & settings selects a current
catalog model/provider and can enable or disable automatic checks. New installations leave
these checks off until the owner chooses them; missing settings also default to Off.
Saved On or Off choices are preserved and remain switchable. A provider change retains the old
conversation; project instructions stay in the host database. Defaults follow Opus when
Claude is enabled, or Sol for a Codex-only policy;
select an exact catalog entry to pin a different available model. Missing models fail visibly.
Model-setting retries reconnect only the original idle native generation. A settled retry
cannot close later work; an uncertain native close is retained for inspection, never repeated.

Priority weight (1–10) orders jobs within the same urgency class; interactive/high priority
still wins over normal/background. It is not a percentage entitlement or proportional CPU
share. A project pause covers its current and future owned runs, preserving files and chats.
Resuming releases only project-pause holds after the provider confirms stopping. Independent
budget/permission holds still require their own resolution. The shared reserve and owner
caps override scheduling preferences; increasing a cap never erases prior spend.

Each project also has a saved priority: High, Normal, Background, or inherit each job’s
priority. An owner can change it directly without spending an AI turn or starting QUARK’s
conversation; QUARK can record the same change when the owner asks. Automatic coordinator
turns cannot change it. Retry receipts and revision checks keep a lost response or an old
browser from duplicating or overwriting a newer choice.

The project choice applies to queued automatic manager/worker turns. Explicit per-turn
configuration takes precedence, and direct owner messages/resumes stay interactive. An
inherited choice retains the task’s priority (normal by default). Already admitted agent
turns keep their original reservation; changing priority does not reset spending, caps,
holds, estimates or enable pacing. Managers receive the saved project policy in their
normal QUARK context. Urgency orders queued work even with pacing off; background admission
and yielding guards use the existing pacing setting.

Manager-dispatched local transcription follows its project priority too. Direct owner
transcription keeps its chosen priority. With pacing enabled, background local work yields
through the existing owned-process pause/resume controls; the same process and retained
memory reservation survive the pause. No unrelated process is controlled.

API: `GET /api/projects/:id/quark` reads the complete saved project policy.
`POST /api/projects/:id/quark` accepts only `{key, expectedRevision, priority}`; `key` is a UUID
and `priority` is `"high"`, `"normal"`, `"background"` or `null`. It returns the saved policy
with its new revision. The original response is replayed for the same request key; refresh
the GET after a conflict or to see a later edit. Host forwarding supports these exact routes.

The coordinator uses the existing runtime, signed leases and cached usage collector. Global
queue pause, provider update and exhausted headroom can also delay QUARK's replies; the
ordinary queue and usage controls remain available without an AI account. Automatic wakes
need material demand: queued or running work of a real project that only the owner cannot
unblock. QUARK's own notices, paused/zero-rate/exhausted-grant work, live percentages, worker
slot changes and elapsed reset time are not changes. A wake follows new work, a new forecast
overrun, or a window turning fast/underused (or a new reported reset) for that work; its prompt
states the reason. Wakes are coalesced, at least five minutes apart and at most four per hour;
a turn ends at three minutes. Automatic notices are rejected for paused, finished or
owner-blocked projects, including a zero rate on the manager's own provider, and while an
earlier notice to that manager is still queued. Owner-directed notices are delivered as asked.
Existing queued notices are never deleted automatically. Failed/interrupted turns need inspection, not blind replay. The private
TIMING_EXAMPLES.md and manager context contain recent measured active turn durations,
forecasts, token basis and attributed allowance by reported window. Selection favors the
manager's project/provider/model while retaining representative provider/model/role variety.
Inherited task forecasts are labelled and cannot be compared with one turn as proof of
forecast error. Missing/delayed allowance evidence is unknown, not zero. They are examples,
not model training or validated percentages.

Verification and limits: [current status](STATUS.md) and [checks](VERIFICATION.md).

Update paths follow [OpenAI's supported CLI installers](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
and [Claude Code's installation/update instructions](https://code.claude.com/docs/en/setup).
“Current” means the chosen installer reported success and the executable version was verified;
organization policies, unavailable networks or custom packaging can prevent an update.
The updater does not control independently running VS Code/terminal sessions.

The coordinator receives a compact current overview: reported allowances and resets, provider
reserves, active work, blockers and recent saved decisions. It does not preload finished runs,
full timing examples or whole decision text each turn. `dock_quark_inspect` reads bounded detail
pages with `view`, optional `projectId`, `offset` and `limit` (up to 20). Views are `projects`,
`jobs`, `budgets`, `decisions`, `timing`, `cluster` and `conversation`; an empty request reads the overview.
Omitted counts and truncated flags identify retained detail. Decision pages reach older records
beyond the board’s recent preview. Validation failures explain the rejected fields; QUARK
should correct its input instead of blindly repeating a failed command.
The conversation view pages this coordinator's owner messages and assistant replies without
tool blobs. Use a returned `entryId` with `textOffset`/`textLimit` (up to 8000 characters) to
retrieve full retained text, including replies from an earlier native context.

Automatic checks start with an independent native context at an idle turn boundary. A queued
owner follow-up retains the current context. Owner conversations start fresh on the next send
after one hour without owner input; assistant activity does not reset that clock. The app keeps
the same coordinator identity, saved messages, decisions, permissions and browser drafts.
Previous native thread IDs remain in saved session records; older evidence is read on demand,
not replayed as a complete transcript. Cluster counts retain their observation times and stale
status, even when the connection is healthy.
