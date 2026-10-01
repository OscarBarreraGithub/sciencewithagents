# QUARK

Open **QUARK** for its conversation, shared status board and live spending sliders.
Managers set the starting task caps; the owner can raise or lower them on the cards. Tell it which project to
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

## New-install setup

A new empty installation starts with shared pacing enabled. Existing workspaces and saved
choices are preserved. Welcome shows the current setting and missing/stale usage readings,
with a link to QUARK. Unknown usage may hold protected work; inspect the reason
there. Merely opening setup does not change policy or start a conversation. Explicit caps
and manager leases remain active even if the owner turns optional shared pacing off.

## Outside agents

The [agent usage/dispatch guide](AGENT_USAGE_ACCESS.md) and source-packaged
[QUARK skill](../skills/quark/SKILL.md) expose shared cached reports and atomic capped task
submission through a private local client. Managed agents already receive typed tools and
charters; the external client grants no orchestration lease and cannot increase caps.

## Managers need a QUARK lease

Native Claude PreToolUse callbacks check the same QUARK hold and signed manager admission.
An admitted hook returns no tool permission grant: native permissions still decide. Helper
activity is retained with the parent, and that run remains open while observed helpers are
active. Native Stop is followed by owned-group closure when helpers share the process; QUARK
also closes its owned group if an interrupt has not ended the work after its grace period.
Files, queued requests, quota holds and original session identities remain for continuation.

Every app-managed manager turn must receive a host-signed, 60-second orchestration lease
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

Open **Work queue → QUARK** to enable pacing, inspect waiting reasons, choose shared
headroom and worker limits, or pause/release queued work. The message composer defaults to
**Do this soon — I’m waiting**. Task creation and **Change priority or budget** expose
priority, rough tokens, task budget, allowance reservation, CPU, memory, time and optional
planning cost/deadline. Editing a task-associated job also updates its task’s future budget.
Recent outcomes compare estimated and measured tokens; cache input counts can be large.
A planning cost is optional and is never presented as a subscription bill.

The work queue also links directly to local compute jobs.

New managers automatically receive the tools and instructions. Codex managers can discover
installed Claude models, select an exact reported model/effort and delegate bounded work;
Claude can inspect Codex usage the same way. `dock_inspect {capacity:true}` reads shared
capacity, `{scheduling:true}` reads project jobs, and `dock_schedule` updates an owned task.
Give optional continuous development background priority and leave the app open. The host
waits and resumes admission as capacity changes; managers must not create polling turns.
Work still needs clear assignments and completion criteria; QUARK does not invent a backlog.

## Shared admission rules

- Interactive, high, normal, then background; equal-priority managers share access by last
  admission. Input order within one conversation is preserved, even at identical timestamps.
- One Claude slot by default, three Codex slots, plus the existing overall group limit.
  All managers on this host reserve from the same transactionally saved allowance ledger.
- Default 20% allowance reserve and two minutes between background starts. Background
  five-hour use is released gradually through the window, and yields to foreground jobs.
  General and applicable model windows are checked together, never added as spare capacity.
- A reset needs a refreshed provider report; missing/stale data makes automatic work wait.
  Completed reservations remain until a later report can reflect their use. Owner overrides
  can accept an estimate/unknown capacity; a known exhausted or elapsed window still waits.
- Task budgets count worker turns and task-associated manager reports, including reserved
  pending work. Measured counters replace estimates when available. Default planning budget
  is 500,000 tokens, including cache input; it is configurable and not a price or hard
  mid-turn cutoff. Unassigned manager conversations have no fabricated task budget.
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
New empty installations start with pacing on. Native approvals, task writer exclusion, independent review and exact integration validation
remain. Managers apply by default; the human-review policy requires confirmation. See
[verification](VERIFICATION.md) and [status](STATUS.md).
