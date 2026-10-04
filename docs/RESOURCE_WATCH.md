# Computer health and the resource assistant

sciencewithagents is the central app. QUARK schedules work. **Computer health** is its
small IT desk: a local watcher plus a resource assistant that wakes only for a diagnosis.
Open the computer card on Home, then **Open Resource assistant** for a full-screen
conversation. Add a symptom, read the findings, stop a pending check or return to the charts.
Projects and jobs appear above Apps and processes. Past readings are inspected through the
graphs; the page has no history list or conversation archive browser. Resource conversations,
reports and their evidence remain saved and available to the resource assistant and history
APIs, outside the normal chat list. Existing saved-conversation links still work.
Model settings and the other core workspace destinations are connected; see FEATURES.md.

## What matters

- **CPU over time and the busiest core:** whole-computer averages can hide a busy core.
- **Memory pressure:** use the OS pressure signal, not a nearly full RAM bar as a verdict.
- **Swapping now, allocated swap and compression:** sustained movement to disk is a useful
  warning; existing swap and compression alone are not proof of a problem.
- **Apps as groups:** Chrome and editor helpers roll up under their enclosing app. Show
  measured interval CPU (a share of all cores together), summed resident memory, process count and change since the last
  sample. Many helpers are normal. RSS can double-count shared pages and omit compression;
  it is not exact physical memory attribution or proof of a leak.
- **Storage headroom and QUARK context:** free space on the workspace volume, running/waiting
  jobs, reasons and planning reservations. Reservations are not measured project CPU/RAM.

Computer health consumes QUARK's existing CPU, volume and VM readings. It does not query
those counters a second time. Its additional read-only macOS process/pressure/swap probes
run every 15 seconds with timeouts and no administrator access. Swap rates use the actual
VM-reading timestamps, even when the watcher samples at a different cadence.
A one-minute local history retains the last 24 hours; API/chart history is downsampled.
CPU rates compare cumulative counters and process start identities. Sleep/restart gaps
reset intervals and alert persistence. Unknown/stale readings stay explicit. Detailed
process/memory probes currently support macOS; GPU, thermal, disk I/O and network diagnosis
remain unmeasured. The app does not promise to identify a particular Chrome tab.

**Your work on this computer** groups measured CPU and resident memory by each app-owned
agent or local job and its project. Existing supervisor handles establish ownership; process
ancestry includes tools and native helpers without guessing from executable names. Helpers
sharing a root stay in that group. Each process is counted once, and start identities prevent
a reused PID from inheriting old CPU counters. Closed supervisors drop out on the next sample.
External/editor sessions, short-lived and orphaned processes may be absent; RSS remains
approximate. The busiest processes retain PID, parent, start identity and interpreter script/module names.
They link to supervised jobs by ID; processes outside those trees are labelled untracked,
which does not mean unwanted. QUARK reservations remain
separate planning estimates. No new collector, service or process-control path is introduced.

The existing runtime checks finished task workers every 30 seconds and releases their idle
provider processes. It preserves native identities, replies, reviews and files for later
questions. Pending approvals/input, QUARK pauses, active helpers, native control and history
reads prevent release; open tasks, managers and retrospective discussions are not retired
just because they are idle. Restarting the app does not reopen finished worker processes.
Task worktrees remain on disk to preserve their file context; this is memory/process cleanup,
not automatic deletion of saved work.

## Agent workflow and limits

The two reusable charters live in `apps/server/src/resource-watch.ts`. Managers can use
`dock_inspect {resources:true}` without waking another model. Explicit owner questions use
native diagnostic tools and the provider's normal workspace-write boundary. The assistant
can inspect relevant system state or logs; it must distinguish actual findings from guesses.
A question about failed login or switching users does not authorize logging out, restarting,
killing processes or changing OS/account settings. Low CPU alone never proves a service works.

Central [model policy](MODEL_POLICY.md) selects Sonnet or Terra for routine assistance, or
the owner's exact model choice. In an idle conversation, open **Model & provider → Change model**
to choose any available model and reasoning level on that provider. The next question uses it
with the same saved history. Switching providers starts a separate conversation. Automatic checkpoint/pressure checks remain snapshot-only:
no execution, filesystem, network or process-control tools. They can refresh the same
process/change/QUARK evidence with `dock_inspect {resources:true}`. Both kinds receive
job IDs, project/task names, scope, estimates and expected finish times for comparison
with measured process use. Either kind may request one
bounded grad consultation, which cannot escalate again. Automatic consultations count against
the same daily limit. Finished provider processes are released while saved history remains.
No provider/model is silently substituted.

An explicit owner question about a known saved report upgrades that same conversation to native
assistance; merely opening it does not. Older reports that already contain owner questions also
allow model changes without losing history. Unattended automatic reports, unknown legacy origins
and grad consultations retain their bounded roles.
Durable origin metadata separates automatic reports from owner conversations, including
older reports outside the recent history window. Resource-owned records with unknown origins
also remain saved outside the normal chat list; no conversation is deleted.

Automatic checks are configurable and off on a fresh installation. Defaults: checkpoint every **6 hours**, plus persistent CPU ≥85%,
OS memory warning/critical, swap-out ≥10 MiB/s, or disk space <10 GiB / <5%.
It also compares recent readings: a CPU rise of 25 percentage points to at least 50%,
a drop in available memory of at least 2 GiB or 10% of RAM (whichever is larger),
or an app group growing by at least 1 GiB and 50%, or doubling with 20 additional processes.
Changes must persist for one minute, ordinary pressure for two minutes, and critical pressure
for 30 seconds. These are inspection triggers, not diagnoses: expected numerical work can
justify high usage. The assistant compares the earlier reading, current processes and QUARK
tasks before deciding. Each sustained finding is handled once until it clears; sleep gaps
reset the comparison. Routine checkpoints are a fallback. One automatic diagnostic chain (an undergrad and at most one grad consultation)
may be pending alongside one explicit owner question. Distinct incidents have a five-minute
cooldown; routine checkpoints have a 30-minute cooldown. Six automatic attempts per rolling
24 hours bound spending. Failed attempts count. Missed checkpoints coalesce.
Settings, receipts, cooldown and attempts survive restart; interrupted checks are not replayed.
Each request also retains the readings that prompted it, so a delayed diagnosis can compare
the original slowdown with current conditions.

Checks use the existing QUARK queue. Direct owner questions go first; sustained-change and
pressure checks get high priority. They share one extra diagnostic slot alongside normal
project/provider slots. High CPU usage alone cannot block these diagnoses. Queued automatic checks yield to the question; an automatic report already running
may finish. Shared allowance caps, deliberate pauses, memory and disk protection still apply.
Routine checkpoints retain background pacing. Checks in other conversations never disable the question box. A queued snapshot check expires after 15 minutes; a running snapshot check is stopped
after about three minutes. Interactive native assistance uses ordinary QUARK supervision
instead of that three-minute cutoff, and can investigate even when cached readings are stale. Estimates are 6,000 tokens and 1% allowance, not measured cost or a hard provider
token cap. The local readings remain useful while the agent waits. Turning automatic checks
off cancels queued automatic checks; an already running check may finish within its limit.

## Privacy and interpretation

Collect executable/app names, selected process identities, entry-point names and counters.
For busy interpreters, a bounded local probe reads command lines in memory and retains only
the script basename or module name (inline code is labelled, never copied). Full command
lines, script arguments, URLs, environment and file contents are not retained or sent to
the provider by the watcher. PID start identities prevent attributing a recycled PID to old work. Local samples expire after 24 hours; diagnosis conversations/reports retain
their history. Asking or enabling automatic checks sends selected measurements and QUARK
status to the selected signed-in provider. Interactive assistance may inspect additional data
using native tools for the requested diagnosis. Automatic reports only advise. Interactive
assistance needs an explicit owner request before changing apps or OS/account settings. Monitoring runs while sciencewithagents is running, including without
an open browser; it is not a new login service and cannot monitor a sleeping/off computer.

Apple describes [memory pressure](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac)
as a combination of memory conditions rather than a RAM percentage. The macOS
[pressure sysctl](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c)
exports dispatch flags (1/2/4), which differ from the kernel’s internal enum. Missing or
unrecognized values are unknown, never interpreted as healthy.
