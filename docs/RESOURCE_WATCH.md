# Computer health and the resource assistant

sciencewithagents is the central app. QUARK schedules work. **Computer health** is its
small IT desk: a local watcher plus a resource assistant that wakes only for a diagnosis.
Open the computer card on Home, or the health link below it, then **Ask what’s happening**.
You can add a symptom, read the report in place, stop a pending check and change watcher settings.
Model settings and the other core workspace destinations are connected; see FEATURES.md.

## What matters

- **CPU over time and the busiest core:** whole-computer averages can hide a busy core.
- **Memory pressure:** use the OS pressure signal, not a nearly full RAM bar as a verdict.
- **Swapping now, allocated swap and compression:** sustained movement to disk is a useful
  warning; existing swap and compression alone are not proof of a problem.
- **Apps as groups:** Chrome and editor helpers roll up under their enclosing app. Show
  measured interval CPU, summed resident memory, process count and change since the last
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
approximate. PID/parent/start details stay inside the sampler. QUARK reservations remain
separate planning estimates. No new collector, service or process-control path is introduced.

The existing runtime checks finished task workers every 30 seconds and releases their idle
provider processes. It preserves native identities, replies, reviews and files for later
questions. Pending approvals/input, QUARK pauses, active helpers, native control and history
reads prevent release; open tasks, managers and retrospective discussions are not retired
just because they are idle. Restarting the app does not reopen finished worker processes.
Task worktrees remain on disk to preserve their file context; this is memory/process cleanup,
not automatic deletion of saved work.

## Agent workflow and limits

The reusable instructions live in `resourceCharter` in `apps/server/src/resource-watch.ts`.
Managers can use `dock_inspect {resources:true}` without waking another model. The app’s
Ask action creates one read-only **undergrad** diagnosis using the central
[model policy](MODEL_POLICY.md): Sonnet or Terra by default, or the owner's exact override.
It has no execution, filesystem, network or process-control tools. It may use one
`dock_escalate` call for a **grad student** consultation, then finishes. The separate grad
report cannot escalate again, uses QUARK and counts against automatic daily limits. Both
processes are released after completion. Reports explain likely causes, evidence,
uncertainty and reversible owner actions. No other model/provider is silently substituted.

Automatic checks are configurable and off on a fresh installation. The owner requested
them for this computer. Defaults: checkpoint every **6 hours**, plus persistent CPU ≥85%,
OS memory warning/critical, swap-out ≥10 MiB/s, or disk space <10 GiB / <5%. Warnings must
persist for two minutes; critical signals for 30 seconds. These are application heuristics,
not vendor guarantees. A pressure episode gets one diagnosis; routine checkpoints can
review it later. At most one diagnostic chain is pending (an undergrad and at most one grad consultation), with a 30-minute automatic cooldown and six
automatic attempts per rolling 24 hours. Failed attempts count. Missed checkpoints coalesce.
Settings, receipts, cooldown and attempts survive restart; interrupted checks are not replayed.
Each request also retains the readings that prompted it, so a delayed diagnosis can compare
the original slowdown with current conditions.

Checks use the existing QUARK queue: owner questions are interactive, automatic checks are
background. They obey shared provider/machine limits and may wait when the machine is too
busy. A queued check expires after 15 minutes; a running check is stopped after about three
minutes. Estimates are 6,000 tokens and 1% allowance, not measured cost or a hard provider
token cap. The local readings remain useful while the agent waits. Turning automatic checks
off cancels queued automatic checks; an already running check may finish within its limit.

## Privacy and interpretation

Collect executable/app names and counters, never process arguments, URLs, environment or
file contents. Local samples expire after 24 hours; diagnosis conversations/reports retain
their history. Asking or enabling automatic checks sends selected measurements and QUARK
status to the selected signed-in provider. Reports advise; they never close another app or
change its settings. Monitoring runs while sciencewithagents is running, including without
an open browser; it is not a new login service and cannot monitor a sleeping/off computer.

Apple describes [memory pressure](https://support.apple.com/guide/activity-monitor/view-memory-usage-actmntr1004/mac)
as a combination of memory conditions rather than a RAM percentage. The macOS
[pressure sysctl](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus_notify.c)
exports dispatch flags (1/2/4), which differ from the kernel’s internal enum. Missing or
unrecognized values are unknown, never interpreted as healthy.
