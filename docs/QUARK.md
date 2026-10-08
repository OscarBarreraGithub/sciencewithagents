# QUARK

Open **QUARK** for its conversation, shared status board and live spending sliders.
Managers record owner-requested task caps; the owner can raise or lower them on the cards. Tell it which project to
pause, prioritize or allocate allowance to. Its typed controls save each decision; hard
limits remain independently enforced by the host. See [conversation, controls and guide
notes](QUARK_COORDINATOR.md). Remaining allowances and reset times appear on the board. Detailed accounting remains
queryable by agents; the separate usage screen is removed. Automatic context-cache
refreshes are disabled; [issue #1](https://github.com/OscarBarreraGithub/sciencewithagents/issues/1) tracks future work.

Managers receive a compact current QUARK view at managed turn start and coalesced updates on
existing coordination replies for both providers. Claude also receives updates through its
native post-tool hook. Notices include cached allowances, jobs, partial/measured progress,
remaining grants and pause reasons. Routine changes are limited to one notice per 30 seconds;
new holds/blocked grants bypass that interval at the next available boundary. No idle manager
is awakened solely to read telemetry. Native Codex builtin-only activity receives updates at
its next Dock coordination call or managed turn; independent stopping does not wait for that.
Advisory values are rounded and bounded; `dock_inspect {scheduling:true}` retains full detail.
These updates never issue leases, grant tools, approve requests or release a pause.

**Queued Usage, Agent Routing Kernel** is sciencewithagents’
central admission scheduler. It extends the existing durable work queue across projects,
managers, Codex, Claude and owned local transcription jobs. Jira is unnecessary for this:
tasks, branches, receipts and results already live together in the app.

Internal `pulsar` API paths and storage keys retain their earlier names for compatibility.
Use [current status](STATUS.md) for release blockers and unfinished utilization automation.

Pending manager team messages and worker reports are retained updates, not separate work
assignments. The host coalesces an eligible pending set into one durable review with links to
every original record; its prompt carries bounded metadata and paged evidence, without a
summarizer call. New arrivals wait for the current review. Held jobs and Group Work lineage
keep their own controls. Owner messages stay ahead of automatic coordination. Coalescing
never resumes a stopped manager or changes its automatic-turn limit. Home counts queued
work separately from team updates, and QUARK shows one pending review per manager.
Joint reviews retain source task ancestry: task holds and allowance caps still apply.
The review counts conservatively within each applicable source task cap.

For installation recovery, `GET /api/agents/:id/coordination-review/preview` reads an exact
source preview. Authenticated `POST /api/agents/:id/coordination-review` accepts a UUID `key`
and that preview's `expectedFingerprint`; a stale preview fails and an exact retry returns
the same receipt. Originals acquire a `coalesced` status and retain their text/history;
this is neither task completion nor proof that a model reviewed them. Interrupted or failed
reviews require explicit recovery, and failed writes roll back their sources and receipt.

Queue displays share advisory demand within one synchronous read. Admission still checks
current holds, allowance and reservations for each job. Long rejected queue scans yield to
owner controls after about 20 ms of work or 16 candidates; an individual check can take longer.

## Opt-in manager goals

An app-owned project root manager can retain one explicit owner goal for Codex or Claude.
Creating or replacing it queues an ordinary owner request. A successful admitted turn may
record useful progress and a next action with `dock_goal_update`; the host then saves at
most one automatic report on the existing queue. Model policy, native capabilities,
provider reserves, hourly/window allowances and automatic-turn limits still apply.
Opening or refreshing the goal makes no model call. Shared Codex native goals are unchanged.

Pause holds the same unstarted goal request; Resume reevaluates its saved checkpoint and
admission. Stop cancels only unstarted goal work and does not claim completion or stop a
running reply. Failed or interrupted work requires the existing conversation Inspect/Resume
controls. Wait/blocked checkpoints and unchanged progress produce no polling turns; useful
independent work can continue while another item awaits a worker or human. Adjacent owner
requests remain additive. Completion requires reconciliation of this manager's internal and
human work, responsible tasks and retained owner requests; unrelated owner Notes/ideas are
outside that scope. Typed revisioned owner controls use `GET/POST /api/agents/:id/goal`.
Substantive goal replies stay in the main conversation; generated scheduling inputs stay
in Subagents with the other retained coordination history.

## Direct owner tickets

Home's **Ideas and to-dos** keeps Ideas separate from actionable To-dos. Select several
to-dos and choose **Package** (or one item's **Send to project**) to write one ticket,
choose its existing project, priority and estimated compute, then **Queue with QUARK**.
The project overview uses the same board scoped to its project. **Completed** retains
finished items across reloads; **Undo** reopens them. **Make to-do** preserves an idea's
text, and starting a new-project brief keeps the original sources unchanged.

The typed `POST /api/work-items/tickets` route packages 1–20 actionable owner to-dos into
one existing-project task and queued implementer. It saves the selected text and revisions,
task/source bindings, priority (1 low–5 high) and estimated compute (1 small–5 large).
The source row shows the linked task's current status. Sources stay In progress until the
owner or responsible manager records their outcome; queuing or a worker reply does not
automatically mark them completed.
Ideas stay separate until the owner makes them actionable. Completed items remain retained
and can be reopened; a ticket's source/task binding cannot be removed by an item edit.

Submission requires an idempotency key and each selected item's current revision. A retry
returns the same task and worker. Invalid or stale selections create neither. It consumes
no initial manager permission or delegation turn. Central model policy and project worker
tools still select the launch, and the task worktree is prepared before the worker starts.
The responsible manager receives the ordinary completion report; independent review,
human application policy and the two correction-round limit remain in force.

Background ordering uses `20 × priority − 2 × estimated compute + age in hours`, with age
capped at seven days; direct and other foreground work retain their higher priority class.
Compute ratings are relative queue hints, not provider allowance or CPU entitlements.

## New-install setup

Project rate cards keep current estimates, saved limits, sliders and save/retry controls
visible. **Details** opens the 12-hour chart, allowance-window choices and accounting.
Board cards show a short waiting reason; longer explanations and resource readings are
available through their **Details** button. Expanding details starts no model work.

A new empty installation starts with shared pacing and automatic coordinator checks off.
Enable these deliberately in QUARK when wanted. Existing workspaces and saved choices are
preserved. Welcome shows the current setting; when pacing is enabled, it also points out
missing/stale usage readings. Unknown usage may hold protected work; inspect its reason in QUARK. Merely opening setup does not change policy or start a conversation. Explicit caps
and manager leases remain active even if the owner turns optional shared pacing off.

## Outside agents

The [agent usage/dispatch guide](AGENT_USAGE_ACCESS.md) and source-packaged
[QUARK skill](../skills/quark/SKILL.md) expose shared cached reports and atomic capped task
submission through a private local client. Managed agents already receive typed tools and
charters; the external client grants no orchestration lease and cannot increase caps.

## Slurm cluster (advisory)

QUARK shows a connected Slurm cluster's queue, pending reasons, fairshare, native limits and
recent exits/efficiency to you, its coordinator and managers from one cached collector per
computer. Cluster monitoring is advisory: QUARK imposes no cluster limits, account choice or
submission gate, and native site rules still apply. Fairshare affects priority; it is not
remaining capacity. AI allowance caps never govern cluster resources. Batch jobs outlive the
Mac connection; detected submissions are followed, best effort, by job ID under the alias
configured when they were seen. See [Slurm cluster](CLUSTER.md).

## Managers need a QUARK lease

The manager chat's **… → Follow QUARK** switch controls its whole project, including
workers. It defaults to On. Off skips QUARK allowance caps, reserves, shared work-slot limits, rate/resource pacing
and saved QUARK project pauses; it stays off until the owner switches it back on. Existing
caps, usage and project-pause choices are retained and apply again when On. Held queue edits,
Stop, explicit job/task holds, the host-wide pause, provider sign-in/permissions and native
quota-rejection holds still apply. There is no automatic expiry. Opted-out running work
does not occupy QUARK slots. Same-agent turn order, task workspace ownership and conversation
lifecycle rules remain in place; the host-wide pause still stops new queued/native starts.

The owner-only `GET/POST /api/projects/:id/quark-scheduler` preference uses revision checks
and durable receipts. It affects queued and running work without replacing native sessions.
Acknowledged scheduler stops resume through the existing recovery path; an uncertain stop
or actual native quota rejection is not replayed. QUARK continues accounting while Off but
cannot automatically pause or send scheduling notices to an opted-out project. Explicit
project controls supersede legacy reply-only exceptions. Global pacing is still optional.

Misc manager conversations retain the separate, off-by-default **Ignore QUARK**
preference. Its typed `GET/POST /api/agents/:id/chat-quark` contract saves an enabled value
with a revision and idempotency receipt. Each new literal owner message captures that
choice; an explicit preference save also updates its queued direct replies. A message receipt
retry never recaptures the preference, and running turns keep their captured scope.
It skips allowance caps, reserves and shared pacing for that direct reply. Manual Stop,
job/project/host pauses, native permissions and provider sign-in/limits still apply. It is
unavailable for task workers, native children and terminal-controlled conversations.

When ordinary admission is blocked, the host signs a conversation-only lease. Read-only
inspection, checkpoints and source-linked backlog saves remain available. Manager work-item
saves cannot impersonate an owner answer or dispatch work. Task creation, delegation, agent messages and
other protected coordination recheck ordinary admission at each action; they never inherit
the chat bypass. Fresh headroom can allow coordination during the same reply, upgrading its
signed scope. Every resulting worker remains under normal QUARK protection. Observed active
native helpers suspend the owning conversation's bypass: ordinary allowance guards and
the existing heartbeat/owned-group stopping path apply to the family. Helper observation
and stopping take time; this does not promise a native pre-dispatch gate or zero overshoot.

Native Claude PreToolUse callbacks check the same QUARK hold and signed manager admission.
An admitted hook returns no tool permission grant: native permissions still decide. Helper
activity is retained with the parent, and that run remains open while observed helpers are
active. Native Stop is followed by owned-group closure when helpers share the process; QUARK
also closes its owned group if an interrupt has not ended the work after its grace period.
Files, queued requests, quota holds and original session identities remain for continuation.

Every app-managed manager turn must receive a host-signed, 60-second lease
before its input reaches Codex or Claude. QUARK renews an unexpired lease on its heartbeat
after checking current allowance protection. The signature binds the project, manager,
turn, provider and model. It cannot be transferred, edited or renewed by a model; restarting
the host invalidates old leases. Pacing being off does not remove this gate or explicit caps.

The app's Codex terminal uses the same gate: before forwarding native input, it reserves
capacity, records the effective native model and signs the manager lease. Native choices
keep precedence over app defaults. It respects queue pause, available work slots, task
ownership and allowance caps. The host monitors the running turn even while terminal
control is active. A lost acknowledgement retains its reservation and blocks orchestration;
an unsolicited manager turn is stopped rather than receiving authority retroactively.
This is a hook in the app's private relay, not a global modification of other Codex sessions.

Manual Codex compaction uses the same admission path from both app controls and the app's
native terminal. It reserves a slot and allowance before provider input, signs the manager
lease when required, and records the actual turn's usage. Compaction preserves automatic-turn
limits and model-policy selection. It is context maintenance: coordination calls are refused,
assignment completion/review/checkpoint transitions and parent completion reports are skipped,
and automatic recovery never sends a new assignment continuation. The native API acknowledges
with an empty result; only provider turn events settle the run. An uncertain acknowledgement
keeps the reservation/hold instead of fabricating success. See the official
[App Server reference](https://learn.chatgpt.com/docs/app-server) for the provider lifecycle.

Host hooks check the lease again before task creation, delegation, messages, scheduling,
budget changes, dispositions and personal-agent routing. A delegation waiting for model
selection or workspace preparation must still have its original valid lease when it returns.
Reading evidence, saving a checkpoint, and stopping work remain possible without authority
to start more work. Retrieving an already-completed receipt does not repeat its action.
Managers see lease status through `dock_inspect {scheduling:true}` and their host context.

Workers have no lease ceremony or renewal loop. QUARK admits and monitors their jobs against
the existing shared reservations and budgets even when the manager is idle. A worker already
admitted does not stop merely because its manager finishes a turn. Managers can call
`dock_pause_worker {agentId, reason}` for an owned task worker whose spending forecast or
progress no longer fits. It requests interruption of the exact provider turn/group, records
the reason and preserves files, history and queued messages. Failed stops are retained and
retried by the independent watcher. A duplicate request cannot stop a newer turn. Continue
through the existing owner-facing **Continue saved work** control after inspecting progress.

These are app-host hooks, not global hooks installed into unrelated CLI/editor sessions.
QUARK's automatic stop does not require the manager model to wake, notice an alert, or spend
more tokens. Provider interruption can still take time; this is not an arbitrary OS kill or
an exact provider-enforced spending ceiling. It does not make a locally privileged process
an adversarial isolation boundary.

Compatibility: fresh manager contexts get the pause tool, and managed Claude reloads its
host tools on connection. Existing Codex contexts may retain their original dynamic-tool
catalog. Do not assume `thread/resume` replaces a saved catalog;
do not rewrite saved rollouts or silently replace a context to add it. Such conversations
still receive the automatic lease/quota enforcement; the new manual manager tool becomes
available with a deliberate **New context**. The owner can always use the app's stop control.
See [OpenAI's App Server documentation](https://learn.chatgpt.com/docs/app-server) for the
provider's persisted-tool behavior. No native-session migration is claimed.

## Normal use

Usage is visible as soon as the app opens, including on the phone. Open it for all reported
windows, Fable, reset times, freshness and computer capacity. Both providers’ managers read
this same cache; no per-manager monitoring terminal is needed. See [usage setup](USAGE_COLLECTOR.md).

Queued app conversations show the current queue explanation, including allowance holds.
If the queue cannot be read, the chat says so and keeps the message saved.

Open **Work queue → QUARK** to enable pacing, inspect waiting reasons, choose shared
headroom and worker limits, or pause/release queued work. The message composer defaults to
**Do this soon — I’m waiting**. Task creation and **Change priority or budget** expose
priority, token estimates, allowance reservation, CPU, memory, time and optional
planning cost/deadline. Editing a task-associated job also updates its task’s future budget.
Queued work blocked by an explicit allowance cap appears in Home’s
**For your attention** and links to its QUARK budget card, even before its first admission.
Ordinary capacity waits and deliberate queue pauses do not create budget attention items.
Recent outcomes compare estimated and measured tokens; cache input counts can be large.
A planning cost is optional and is never presented as a subscription bill.

**Job details** reads the saved job directly, including older turns outside the recent queue.
It shows the request, task acceptance, worker and model setting at admission when recorded,
current waiting reason, and up to three bounded saved responses for that turn. Full text,
tool evidence and interruption details remain available through **Open conversation**.
Editing holds and requests for an answer link to that conversation; ordinary queued/running
jobs retain their relevant pause, release and scheduling controls. **Project hourly rate and
caps** opens the project's QUARK card on the selected computer. Estimates are secondary
planning information, not completion promises.

The work queue also links directly to local compute jobs.

New managers automatically receive the tools and instructions. Codex managers can discover
installed Claude models, select an exact reported model/effort and delegate bounded work;
Claude can inspect Codex usage the same way. `dock_inspect {capacity:true}` reads shared
capacity, `{scheduling:true}` reads project jobs, and `dock_schedule` updates an owned task.
An explicit task priority overrides the project's default for that task's future automatic
turns and its existing queued automatic runs. Those queued runs keep their IDs, prompts and
cost estimates; admitted/running turns and direct owner messages keep their own choices.
Inherited task priorities still follow the project default. Priority orders eligible work;
it does not release saved holds, adaptive pacing, reserves or allowance budgets.
Give optional continuous development background priority and leave the app open. The host
waits and resumes admission as capacity changes; managers must not create polling turns.
Work still needs clear assignments and completion criteria; QUARK does not invent a backlog.

## Shared admission rules

- Interactive, high, normal, then background; equal-priority managers share access by last
  admission. An idle conversation selects its earliest direct owner or recovery input ahead
  of automatic coordination turns, under that input's own admission rules. These inputs
  retain FIFO order regardless of saved priority, including editing holds and identical
  timestamps. Recovery input can come from the owner or QUARK's verified stop recovery.
  Automatic coordination remains saved in its own order; active turns finish first.
- One Claude slot by default, three Codex slots, plus the existing overall group limit.
  All managers on this host reserve from the same transactionally saved allowance ledger.
- Separate Codex and Claude remaining reserves default to 20% for new settings. Existing
  saved global reserves become both provider baselines. Two minutes separate background starts;
  five-hour use is released gradually through the window and yields to foreground jobs.
  General and applicable model windows are checked together, never added as spare capacity.
- A reset needs a refreshed provider report; missing/stale data makes automatic work wait.
  Completed reservations remain until a later report can reflect their use. Owner overrides
  can accept an estimate/unknown capacity; a known exhausted or elapsed window still waits.
- Task budgets count worker turns and task-associated manager reports, including reserved
  pending work. Measured counters replace estimates when available. Ordinary manager
  coordination uses its own bounded turn estimate rather than the whole task forecast.
  Optional project/task rolling-hour limits use percentage points of each reported provider
  allowance, alongside window grants. Token estimates never act as admission budgets.
  Unassigned manager conversations have no fabricated task budget.
- CPU, memory and disk observations include other computer activity. Owned jobs also reserve
  resources. macOS available memory includes an explicitly labeled reclaimable estimate.
  These are admission estimates, not OS-enforced CPU/RAM limits or GPU scheduling.
- QUARK allows up to 100 automatic turns per conversation before a progress check by default
  (12 when capacity pacing is off). The owner can set 12–1,000 in the app. Quota and task
  budgets continue to apply; no finished/uncertain action is replayed to keep work flowing.

## Local transcription

This retained advanced/manager workflow accepts a public YouTube link and urgency; it is
not a Home action. The default
is interactive; a manager uses `dock_transcribe` with its task’s priority. The app verifies
its Whisper base model, downloads the selected audio, converts it and transcribes locally.
Read/download the result in the app; a requesting agent receives one saved success, failure
or cancellation report per outcome. Only that report’s model turn consumes provider allowance. Failed steps show their phase
and an explicit retry; submission receipts survive page reload on the same browser tab.

The verified Mac tools are FFmpeg, whisper.cpp and an app-local yt-dlp environment. The
setup agent installs them once, following [contributor setup](CONTRIBUTOR_SETUP.md).
The 148 MB multilingual base model is downloaded and SHA-256 checked on first use.
Current limits: public single YouTube videos up to two hours and 300 MB source audio;
no login/cookie extraction, arbitrary URL fetch, browser-supplied path or executable.
YouTube availability/restrictions can still make an individual download fail.

QUARK can pause the exact owned local process group to let urgent work proceed, then
resume that same process. Paused running jobs retain their memory reservation; jobs paused
before starting reserve none. Stage time limits count active time, excluding pauses. Agent work yields between turns;
use its original **Stop reply** for an active turn. External editor/terminal/OS work is
observed as pressure and provider consumption, not forcibly suspended. Restarted local
jobs become interrupted and require deliberate retry; no saved PID is treated as authority.
Expected finish times are estimates and waiting jobs can explicitly have no known finish.

Upgrades keep the saved pacing choice. Older workspaces with no saved policy retain their
previous off default; the owner can enable it from Work after inspecting old queued jobs.
New empty installations start with pacing and automatic coordinator checks off. Native approvals, task writer exclusion, independent review and exact integration validation
remain. Managers apply by default; the human-review policy requires confirmation. See
[verification](VERIFICATION.md) and [status](STATUS.md).

Native interruption closes the owned provider process group before QUARK acknowledges the
stop. A completed provider turn alone does not prove its terminal children stopped. Files,
conversation identity and unsent messages remain available for explicit continuation.

Raw token counts remain useful for attribution and estimates, but never block admission.
**Project usage rates** shows current estimated Codex and Claude use beside each saved rate,
with the last 12 hours of observed history. Release a slider to save, or type an exact rate and
leave the field/press Enter. Rates use percentage points of the full named allowance per
rolling hour. Ordinary uncapped work remains on shared pace until you choose a limit.
Zero pauses only that project's chosen provider while retaining progress. Raising from zero
permits recovery only after a confirmed stop, fresh readings and room under all other holds.
A typed native Claude primary-window rejection waits for that window's genuine reported
reset before one automatic continuation ([details](QUARK_ACCOUNTING.md)).
Lowering below recent spending can wait for older usage to leave the hour; in-flight work can
overshoot while stopping. **Total allowance caps** remain secondary cumulative controls.
Task caps can also use a rolling hour. See [accounting](QUARK_ACCOUNTING.md).
If ordinary work waits unexpectedly, **Help → Report a bug** preserves its queue reason and
assigns a bounded investigation without raising the owner’s allowance limits.

## Shared reserve controls

Above project rates, separate Codex and Claude sliders save a minimum remaining percentage
of each full reported allowance. Zero is permitted. Saving a reserve does not turn on shared
capacity pacing; **Enable shared protection** explicitly enables the existing saved policy.
Existing project/window caps and owner pauses stay independent.

**Optional timed release** is off by default. Its ready-to-use thresholds are 12 hours before
each actual Codex window reset and 45 minutes before each actual Claude window reset. Enabling
it releases that window's effective reserve to zero only with a fresh successful reading and
a future reported reset inside the interval. Saved baseline and effective reserve are shown
separately. A verified new window restores the baseline outside the interval; stale data or
an elapsed clock cannot establish renewed capacity. A Codex five-hour window is always
inside a 12-hour threshold, while its weekly window is released only in its final 12 hours.
Model-specific windows keep their own resets, and an unreported weekly window is never invented.

Account forecasts compare recent account-wide use, including external/unattributed activity,
with time to the protected reserve, exhaustion and the reported reset. Current zero or unknown
rates do not produce an infinite forecast. History uses bounded half-hour buckets, reports
observed coverage and leaves missing, unattributed and reset intervals as gaps. These are
approximate measurements and forecasts, not a validated 2–3% attribution guarantee.

TODO: adaptive QUARK-directed spending aimed at finishing about 15 minutes before reset is
not implemented. The timed reserve rule is deterministic and does not launch filler work.

## Spare reset-window capacity

**Queue controls → Shared headroom and pacing → Maximize useful Claude work before the
five-hour reset** is off by default. With shared pacing enabled, it releases available
Claude five-hour headroom to eligible queued background work without the normal gradual
release schedule. Foreground work still comes first. Exact models, project provider
preferences, hourly/window caps, owner pauses, worker slots and reserves remain enforced.
The coordinator can advance authorized useful work within those choices; it cannot invent
filler work, lower reserves or switch existing conversations. No full-window utilization is
guaranteed, and a sleeping computer or missing backlog can leave allowance unused.

QUARK compares at least five minutes of fresh readings from the same account window with
time to reset and the saved reserve. The board and manager context show observed and target
rates plus projected allowance remaining. A short window projected to leave more than ten
percentage points above the reserve is marked underused. Reset or stale readings invalidate
that projection; weekly/model-specific limits remain independent.

With useful work present, the coordinator receives coalesced pacing changes through its
existing bounded wake schedule. It can advise managers to advance suitable Claude tasks.
Managers preserve project provider mixes, exact model choices, caps, available computer
resources and owner pauses. No filler tasks, lowered reserves or forced provider switches
are authorized by this signal. Forecasts include external account activity and are estimates.

### Adaptive window pace

Each actually reported general or model window gets its own pace: fresh headroom after the
effective reserve and outstanding admission reservations, spread over the time to that
window's reported reset (aiming about 15 minutes early, an estimate rather than a promise).
The pace is split by project priority weight across projects with active or ready authorized
work on that window. Weekly and five-hour percentages are never pooled or compared. Project
rates show it as an optional `adaptive` suggestion per window: `ready`, `idle` (no work, no
suggestion), `blocked` (pause, saved zero rate, exhausted grant or no headroom) or `unknown`
(stale, missing or elapsed-reset reading).

With shared pacing enabled, admission follows this share only while a window is projected to
reach its reserve before its reset (`fast`). A queued job waits if its project's rolling-hour
attributed use plus reservations, plus the job's estimate, exceeds its share. A project with
no use or reservation in that hour can always start one turn, so a large estimate cannot
deadlock startup. Explicit caps (including zero), reserves, stale/native-limit and manual gates
are checked first. Running turns, direct owner messages and per-job owner overrides are not
paced, and Maximize useful Claude work exempts the Claude five-hour window. On-track or
underused windows are not paced. No cap is saved, no job is created, and nothing consumes
allowance merely because it is available. Whole-percent readings and unvalidated attribution
make shares approximate; the reason text states the reading uncertainty.

Foreground preemption checks run only when a running background conversion or transcription
can actually yield. This avoids unnecessary global queue scans; job admission and owner
allowance, resource and pause checks remain fresh.
