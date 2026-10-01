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

Use the existing local runtime and queue. Store QUARK identity, instructions and decisions
under private runtime data outside project worktrees. The default is current Opus; support explicit model/provider selection centrally.
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

The latest owner correction supersedes blanket bypass: broad read/network access, writes
contained to the assigned project/worktree where the native provider sandbox supports it.
Unattended mode should deny unsupported operations rather than leave a permission prompt
waiting. Read-only diagnostics remain read-only. Arbitrary MCP/remote tools require their
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
catalog model/provider and can disable automatic checks. A provider change retains the old
conversation; project instructions stay in the host database. The default follows Opus;
select an exact catalog entry to pin a different available model. Missing models fail visibly.

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
are coalesced, separated by at least five minutes and limited to four per hour; a turn ends
at three minutes. Failed/interrupted turns need inspection, not blind replay. The private
TIMING_EXAMPLES.md and manager context contain recent measured active turn durations,
forecasts and token basis. They are examples, not model training or validated percentages.

Verification and limits: [current status](STATUS.md) and [checks](VERIFICATION.md).

Update paths follow [OpenAI's supported CLI installers](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
and [Claude Code's installation/update instructions](https://code.claude.com/docs/en/setup).
“Current” means the chosen installer reported success and the executable version was verified;
organization policies, unavailable networks or custom packaging can prevent an update.
The updater does not control independently running VS Code/terminal sessions.
