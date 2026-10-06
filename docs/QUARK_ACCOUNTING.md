# Automatic accounting and allowance caps

Open **QUARK** from Home, on the computer or paired phone, for the conversation, shared
work board, remaining allowances/reset times and spending sliders. Old usage links redirect
there. The separate technical accounting page is removed; managers retain detailed
project/agent/run token counters and pause evidence through the shared backend. Opening the
board makes no model calls.

Managers also need a signed, host-renewed QUARK lease before orchestration. The lease and
owned-worker pause hook are described in [QUARK](QUARK.md#managers-need-a-quark-lease). Workers
do not manage those leases; the host enforces their budgets independently of manager turns.

## Set and use a spending budget

Routine tasks do not require an invented per-task cap. QUARK admits them using shared
allowance headroom and machine capacity. Managers use `dock_budget` for an owner-requested
allowance allocation, using each provider's actual reported window. Raw token counts remain
accounting evidence; the legacy `tokenBudget` field (0 accepted) is no longer an admission gate. Cached
context rereads must not produce requests to approve millions of tokens.
Existing task caps appear on task cards; cumulative project caps appear under **Total allowance
caps** on project cards in **QUARK**.
Move a slider up or down; release it to save. Estimated spent/remaining amounts refresh
from the shared ledger every ten seconds while the page is visible. Provider readings can
be older or unavailable; these are not instantaneous billing figures.

Each slider names its provider and allowance window. A **10%** cap grants ten percentage
points of the full allowance from the time the cap is
saved; it is not ten percent of the remaining balance. Weekly and five-hour caps are
separate. A plan without a reported weekly meter cannot acquire an invented weekly cap.
Model-specific meters stay separate; they are not extra general capacity. Adjustments keep
the original spending baseline. A lost reply retries the same saved operation; another
device’s edit is reported rather than overwritten. Raising a cap does not resume paused
work by itself: use **Continue work** on the card after checking the remaining allowance.
For a new project-wide cap, tell QUARK what to allocate (or set it during project setup).

**Project usage rates** gives each project separate Codex and Claude sliders, current
estimated percentage points/hour and the last 12 hours of observed coverage. Release to save,
or type an exact rate and leave the field/press Enter. A 5% rate permits five percentage points
of the full named allowance in a rolling 60 minutes; it is not five percent of the remaining
balance. Zero pauses that project's chosen provider; window grants must remain positive.
All managers and workers share the project rate, and task limits include descendants.
Each reported provider/window is checked independently alongside cumulative caps and reserves.
Uncapped work keeps shared pace until the owner chooses a rate. Lowering below already
consumed usage may wait for older charges to leave the hour; stopping can overshoot in flight.

`dock_budget` uses `period:"hour"` for an owner-requested task hourly limit; the default
`period:"window"` retains the existing grant behavior. QUARK's owner-message budget control
can set project limits with the same period. Only owner controls can raise or turn off a
limit. Revision checks and retry receipts preserve concurrent edits and prior spending.
Admission includes jobs reserved before provider startup. Attributed spending replaces
finished estimates after a later positive report; missing/reset reports retain uncertain
completed estimates for up to one hour. Delayed charges enter the hour when observed,
conservatively. A reset or restart does not erase that hour or invent a spending delta.
Running hourly overruns use the independent stop guard. After a provider-confirmed stop,
fresh readings and room in the rolling hour can continue saved progress automatically;
owner pauses and exhausted window grants retain their separate continuation requirements.

A task cap includes its descendants, workers, associated manager reports and cache
refreshes. A whole-project cap also includes general manager conversation overhead.
Unassociated manager messages cannot be attributed to a particular task automatically.
Ordinary manager coordination turns start with a separate 0.5-percentage-point reservation
and two-minute estimate, instead of inheriting the entire task forecast. This lets a manager
reassess saved work within the remaining grant. Explicit turn estimates take precedence;
actual spending and concurrent turns remain charged to the same task/project, and pauses,
stopping buffers and reserves still apply. This estimate cannot guarantee a tiny turn.
Both project and task caps apply when present. Each provider has its own allowance units.
The manager's `dock_budget` tool creates or tightens its owned task cap; it cannot increase
or reset one. A percentage reservation in `dock_schedule` remains a planning estimate and
cannot override these caps. Only owner-facing controls can increase an existing cap.

The host checks admission and running work about once a second, using the existing shared
provider collector (normally once a minute for Codex and every five minutes for Claude).
It protects a default two-percentage-
point stopping buffer, limited to 20% of a small cap. Current and recently finished turns
keep conservative reservations while reports catch up. A cap can therefore pause work
early. Ordinary scheduling overrides and turning pacing off do not bypass explicit caps.
When QUARK pacing is enabled, its shared headroom limit also stops active managed work;
interactive work no longer bypasses that protection. New admission waits immediately when usage fails. Already admitted guarded work may use its
last verified reading for at most three minutes for Codex or six minutes for Claude;
an expired reset, exhausted
grant or known headroom limit still stops it. After that bound, monitoring failure pauses work.

The guard records its hold before requesting interruption of the original provider turn
and native child group. Unsent messages, files, task worktrees, histories and identities
remain intact. Pending provider approvals are never granted automatically. Failed stop
requests remain visible and are retried against the same running identity. The provider
must acknowledge stopping; an interrupt request is not itself proof of an idle process.
In-flight requests/tools can still consume allowance before they stop.

**Continue saved work** requires fresh capacity and sufficient budget. It uses the same
conversation and asks the agent to inspect retained progress; the original interrupted
input is never automatically replayed. Unsent messages remain queued. Budget, owner/manager and invalid-lease holds stay explicit across restart. Neither an
account reset nor increasing a grant releases them automatically.

Monitoring/reset/headroom holds are different: after a **provider-confirmed stop**, a new
successful usage report and all remaining caps allow QUARK to queue a new saved-progress
continuation. Existing unsent messages stay queued with a recovery notice in host context;
the interrupted input is never submitted again. The host records the reason and whether
continuation was automatic. A restart without a stop acknowledgement stays uncertain and
needs inspection. Queue pause, another hold, native-terminal ownership, completed task
ownership and automatic-turn limits prevent unattended continuation. A timed-out cache
refresh releases its own temporary hold after confirmed stopping, without queuing another
refresh or generating an extra task continuation. Old untyped holds remain explicit.
A typed native Claude primary-window rejection keeps its window, reported reset, session
and run as immutable evidence. It resumes once only after the confirmed stop and a later
fresh reading in which that exact window reports a reset beyond the rejected one, plus normal
headroom/reserve and cap checks. Elapsed time, a low same-window reading or a missing window
keeps the hold. Model weekly rejections need that model's exact reported window. Owner,
project, budget and lease holds are not replaced.

If fresh capacity reveals that a cap was exhausted while work was stopping, QUARK changes
that temporary hold to a budget hold. It preserves the original pause and stop acknowledgement,
latches the exhausted grant, and exposes the updated reason to the app and manager. A provider
reset or later cap increase does not silently continue it; the owner explicitly continues
once the budget permits. An outage remains distinct from spending the allowance.

Native turns launched through this app's Codex terminal now use the admission hook and
running-turn watcher too. Independent editor/terminal sessions, other computers and
provider-internal work remain outside the host's complete control. Local transcription does not spend provider tokens and is unaffected
by these provider caps; its existing resource controls remain separate.

## Manager token reports

Project managers track Codex and Claude separately, including workers and native helpers.
The host records workers automatically. Managers read `dock_inspect {accounting:true}`
`totals` once at the start of a reporting period, when relevant to a decision, and at milestone/end:
full project-to-date rows, with `agentId: null` as each provider's project row
plus one row per agent. The recent `runs` list is capped at 200 and is never summed as the
whole project. For a reporting period, the manager saves its scope and baseline totals in
`dock_checkpoint`. A project-period delta can include concurrent work and is not task-only usage. At a finished project, milestone or handoff, it fetches the latest totals
and reports a concise per-provider breakdown (manager and worker/helper rows, or linked detail
for larger teams): input, cached input, cache writes, output, reasoning and total tokens, measured and
incomplete runs, labelled project-to-date or scoped delta with its as-of time. Null counters
are unknown or partial, not zero; `nativeOverlap` rows may overlap parent counters and are shown separately, excluded from
project rollups; do not add them again or claim complete coverage. Tokens are evidence, separate from estimated allowance percentages, and no per-task token
caps are set. The current reply's own tokens can arrive after the report.
Current allowance comes from cached capacity and host notices, not repeated historical totals.
Existing Codex contexts can retain an older strict tool catalog: if `accounting` is unavailable,
use the established `scheduling:true` response's `accounting.totals` at the same reporting points.

## What the measurements mean

Provider events feed a durable per-run ledger, then agent and project totals. Codex uses
cumulative differences from a recorded baseline. Claude records live input/cache evidence
once per native API message, then replaces it with the result's counters. Its per-model
cumulative totals include native helpers: consecutive trustworthy totals yield the current
team's spending, instead of adding the whole session again. A fresh owned session starts
from zero; the first result after reconnect establishes a new baseline because native
versions may restore or reset old totals. That first resumed turn remains partial.

Main-loop-only results, missing/regressing counts and helpers still working after the
parent result remain partial. Failed results retain already observed input/cache evidence;
per-message output placeholders never become reported output. The UI and manager context
distinguish these cases. Mixed-model team totals do not train a rate for the parent's model.
Claude hook identities now have separate helper runs and tool/closing-text histories, while
team tokens remain on the owning session. Child rows receive no new reservation or independent
allowance. Registered native helper transcripts now add deduplicated input/cache counters and
reported model names to their own runs. Those child rows are excluded from project rollups,
which retain the owning session’s team counters. Per-helper output attribution and exact nested
ancestry can remain incomplete. Recognized fresh delegation results now establish observed
nested parent links without changing root budget ancestry or counting descendants again.
Unknown counters are not zeros.

Completed native Agent/Task responses can now supply a helper's own reported run total and
delivered report. QUARK links them only to an already observed helper in the owning turn;
it does not create a new agent or spending grant from a tool response. The total survives
late transcript writes and restart, and replay cannot charge a resumed run. All usage labels
it **reported total · partial breakdown** when individual counters remain unknown. The native
response's separate `usage` object is not assumed to be an aggregate input/output breakdown.
Missing or unfamiliar result shapes keep transcript-based partial evidence; they do not stop
the native conversation. Helper totals are still excluded from the parent's/project's sums.

The existing host heartbeat reads only transcript paths supplied by owned hooks, checking the
native session/helper identity. It retains visible replies/tools, skips private thinking and
inherited pre-registration messages, and keeps byte offsets and API-message receipts locally.
It reads bounded chunks, retries delayed writes for two minutes after activity, and gets a final
catch-up read after sleep/restart before settling. Missing files, oversized records, changed
formats and incomplete trailing records can leave gaps. A new native hook reopens catch-up.
Per-message output values are placeholders and are not reported as measured spend. The Agent
tool’s `totalTokens`/`usage` describe its final request, not the complete helper run; see the
[native Agent hook fields](https://code.claude.com/docs/en/hooks#agent). This behavior uses
native events and the existing ledger, without a second collector or monitoring model.
The adapter follows [Anthropic's token reporting semantics](https://code.claude.com/docs/en/agent-sdk/cost-tracking).

Cache and reasoning subsets are not added again
to a Codex total. Duplicate reports/restarts do not charge twice. Imported/native threads
with no trustworthy baseline get partial observed slices; native helper counters remain
separate from project totals until overlap with parent counters is verified. Missing
counters are unknown. The new ledger starts when this feature is installed, not by
inventing historical measurements from the current model or session.

Allowance attribution reconciles positive changes in each provider window with weighted
token activity (uncached input 1, cached input 0.1, cache writes 1.25, output 4). These are
heuristic weights, **not API prices or a published subscription conversion**. Elapsed-work
estimates fill in when counters have not arrived or output is still unknown. Model-specific calibration learns from
single-model intervals with complete counters; mixed-model intervals cannot identify
independent rates. Calibration is centrally stored, expires after 30 days and is keyed by
the reported model/window, without embedding model versions in individual features.

Completed turns remain eligible through the next valid provider report, including after
restart. No activity to explain a delta, or a sampling gap over three minutes for Codex
or six minutes for Claude, leaves that delta unattributed.
Simultaneous external usage can still be assigned to active projects; the
account signal cannot distinguish it. Changes across reset boundaries are not fabricated
as negative spending. Window charts restart on a changed reset or regressing meter,
while task/project spending grants do not. Hourly rates divide attributed percentage points
of the full named allowance by elapsed sample hours (up to one hour, at least five minutes),
without dividing by the remaining balance or the allowance window's duration.
Account forecasts flag projected exhaustion before reset even when the saved reserve is zero.
Append-only interval evidence, durable observations, bounded display results and incremental
budget totals support inspection and restart recovery without a monitoring model loop.

**Accuracy within 2–3 percentage points weekly is a target, not validated performance.**
There is no ground-truth per-project subscription meter to certify it. The controls are
conservative host enforcement based on estimates, not a provider-enforced exact spending cap
or a monetary billing ledger. Periods with missing reports or external activity need extra care.

## Context-cache refreshes — deferred

Automatic cache-only turns are disabled for new and existing installations. The scheduler
no longer creates them; queued refreshes from older versions are cancelled before provider
startup. Old settings are migrated off, preserving caps, records and other settings. A stale
client cannot turn them back on. The UI has no cache controls or countdown list.

Future work is tracked in [issue #1](https://github.com/OscarBarreraGithub/sciencewithagents/issues/1).
Reintroduction would require evidence of savings and reliable provider behavior, explicit
opt-in, budgets and bounded execution. No cache-retention guarantee or authoritative
subscription countdown is claimed. Cache expiry does **not** erase saved history. Normal
provider caching, reported cache-token accounting, handoffs and compaction remain separate
and unchanged. Historical refresh records remain readable for accurate accounting.
