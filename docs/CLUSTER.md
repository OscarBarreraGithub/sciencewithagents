# Slurm cluster

Compute runtimes sample CPU and filesystem capacity in one background worker so slow host
CPU-frequency or shared-filesystem reads do not block chat connections. Pending or failed
samples retain their original observation time; allocation CPU and memory limits still apply.

Connect a Slurm cluster you already reach with SSH from this computer. QUARK shows its
state to you, the QUARK coordinator and your managers. Managers do the real cluster work
with your normal SSH access. The app observes; it does not add cluster limits.

## Connect

1. Make sure `ssh <alias>` works in this computer's terminal. A shared sign-in session
   (`ControlMaster`/`ControlPersist` in `~/.ssh/config`) lets agents reuse one sign-in.
2. Open **QUARK → Slurm cluster · not connected** and enter that SSH host alias. Choose how
   many recent days of accounting to show (sites often reject week-long ranges).

The alias, label and readings stay in this computer's private app data. Nothing about your
cluster account is stored in source.

## What QUARK shows

One collector per computer reads, through one bounded SSH session per refresh:

- your queue: state, pending reason, Slurm's start estimate, resources and nodes;
- pending priority factors (`sprio`) and your fairshare per account (`sshare`, only your row
  and the account totals);
- native limits: your own associations, the account-level rows of your accounts and their
  parents (other members' rows are dropped on the cluster), QOS per-person and per-account
  limits, partition limits, access and idle CPUs, and the site's `MaxArraySize`, `MaxJobCount`,
  enforced limit types and priority settings from `scontrol show config`;
- recent accounting (`sacct`): exit state, elapsed and limit time, CPU and memory efficiency,
  and output/error file references expanded from Slurm's patterns.

It runs every two minutes while you have jobs, five minutes otherwise, and refreshes limits
every fifteen minutes. **Refresh** reuses the same session if one is running. Readings are
cached across restarts and show their age; a failed reading keeps the last one visible. A
section the cluster refused, does not support or left out is listed as not read, with its
message, instead of being shown as current.

A blank limit means none was reported at that level, not that none applies: association,
account, parent, QOS, partition and site limits combine, and Slurm enforces them. Limits a site
keeps outside these commands (submit filters, reservations, policy pages) are not visible here.

The collector only runs Slurm status commands with `BatchMode=yes`,
`StrictHostKeyChecking=yes` and `ControlMaster=no`. It never prompts, accepts host keys,
starts a sign-in session, lists directories, reads files, submits or cancels jobs.

Fairshare is sshare's 0–1 factor per account under the site's own algorithm (the panel shows
`PriorityFlags`; `LevelFS` only means something under Fair Tree). A higher value adds more to
a job's priority but does not guarantee an earlier start. It is not remaining capacity, a
completion-time promise or a reason to choose an account. Cluster resources are separate
from AI allowance.

## Saved project setup

Computers with the cluster workspace and project routes can show compact saved-folder,
account, development-job and source-review settings in QUARK. Unsupported computers keep
the existing monitoring, sign-in and notebook controls. Opening setup makes no model call,
starts no SSH sign-in and submits no job. Folder choices use the server's saved IDs.

When both typed workspace and project reads succeed, New project also offers the saved
cluster folders and Chats lists saved cluster projects. Spawn retains the exact create
receipt and opens a Notepad for the unsent first request; explicit open can request a
development allocation. The controller must verify readiness before cluster chat loads.
Each tab keeps its controller and project scope for requests, uploads, drafts and saved
chat copies. Return to controller preserves that scope's drafts and other tabs' choices.
These client controls require the controller's saved workspace, reviewed runtime-source pin
and target provider setup below. Partial or unavailable controller routes leave the local
journey in place. See [Status](STATUS.md) for installation and acceptance limits.

Before choosing a cluster manager, verify the **target cluster's** installed Codex or Claude
CLI version, signed-in account and native model catalog with metadata-only checks. The local
computer's catalog does not establish cluster model support. Update the target CLI through
its existing installation method when needed; the app does not update it automatically.
Preserve explicit model and reasoning choices, and ask for a different choice if necessary;
never silently substitute another model. Keep native provider homes, credentials and SQLite
history in place. An owner-pinned executable can differ from the default cluster CLI; current
acceptance used a side-by-side Codex executable and does not certify an older default CLI.

For a setup agent:

```text
Prepare my cluster project using docs/CLUSTER.md. Before choosing the manager or sending
its first request, verify the target cluster's native provider CLI version, signed-in
account and model catalog without a model turn. Update through its existing installation
method if needed, preserving native accounts, homes and SQLite history. Keep my explicit
model/reasoning choice; ask only if it is unavailable, without a silent fallback. Saving
a folder or draft must not allocate compute or send a model request. Preserve running
work, site rules and saved submission-review policy. If I require review per submission,
configure it explicitly before an app-managed allocation; account defaults do not enable
review. Report startup, retained-history and idle-release checks separately.
```

On a controller with these services enabled, project managers and QUARK can use
`dock_cluster_workspace` to inspect cached folders and the saved connection deadline.
An admitted writing manager may renew the app-owned SSH holder for 1–72 hours, or stop
that holder. Retrying the same tool request does not extend the deadline again. This
does not sign in, stop the shared SSH master, or cancel a compute job. Existing native
conversations keep their original tool catalog; the capability is advertised on new
conversations when available.

## Optional submission review

Slurm submission review starts Off and preserves saved policy choices. In the cluster panel,
open **Submission review** to enable it, confirm an account, select dated site rules and
choose its reviewer model. The authenticated `/api/slurm-review/policy` route exposes the
same settings to setup agents. Workspace setup updates those confirmed
defaults without enabling review. `dock_slurm_review` requests a bounded review and reports
its result through the normal work queue; pending reviews do not need polling.
The reviewer receives the bounded proposal, saved owner rules and native Slurm reading
together as untrusted evidence, without tools to retrieve missing information.

When enabled, the controller reviews its exact development-allocation proposal before
submission. Approval continues the same explicit Open request automatically, using its saved
allocation token and configuration. Corrected policy, changed native evidence or expired approval
can receive a fresh review without replaying a submission. Status reads never start a review or
allocation. Controller restart or connection Stop requires another explicit Open; an uncertain
submission remains reconciliation-only. Automatic review continuation is bounded to two attempts.
Managed Claude hooks hold recognized `sbatch`, `salloc` and `srun` commands.
Computed commands, programs that submit internally, Codex and the owner terminal are not
intercepted; managers request the typed review explicitly. Native Slurm remains authoritative.
The compact settings and review results have local fixture and emulated layout coverage.
Owned FASRC acceptance also exercised a real native submission reviewer; provider/site setup
for each installation remains required. See
[manager guidance](../scripts/cluster/MANAGER_SLURM.md).

The source has real cold/warm startup, native Continue and retained-history
evidence using an owner-pinned Codex CLI. A separate fresh allocation naturally released with
an explicit one-minute idle policy and a private zero-work barrier. The default 20-minute policy
has local fake-clock coverage; earlier real 20-minute observations did not prove release. After
release, cached account/history records remain and admission polling waits for explicit reopen.
These checks do not establish owner installation, native fixture archival or real-phone
acceptance, and do not certify an older default CLI.

## Managers on the cluster

Managers use the native terminal: `ssh`, `scp`/`rsync`, `sbatch`, `salloc`/`srun` and their
own scripts. Your account, partition, QOS and site rules apply, along with submission review
when you enable it. Managers read the shared reading
with `dock_inspect {cluster:true}` instead of polling. They pick accounts from the project's
instructions or ask you, keep compute off login nodes, and never handle passwords or codes.
Read-only reviewers may inspect but not change cluster files or jobs.

Writing roles reach SSH through their provider's native permissions, described in
[worker tools](WORKER_TOOLS.md); read-only roles keep their restrictions. Both providers need
the shared sign-in to be running; agents cannot sign in.

## Job tracking

A completed tool output containing `Submitted batch job N` links job N to the conversation
that submitted it, with its native session and the alias configured at that moment. The
collector follows that job by ID, so batch jobs survive this computer sleeping or disconnecting.
When it finishes, its manager receives one report with state, exit code, efficiency and output
path. Nothing is resubmitted.

This is best-effort observation for the configured cluster, not authoritative provenance. A
submission through another SSH alias or host is still recorded under the configured alias, so it
may never be seen or may match an unrelated job with the same ID. The app does not parse shell
commands or gate submissions to tell these apart.

Job IDs are unique only within one cluster. Changing the alias starts a fresh reading, drops
any reading still in progress for the old alias, and pauses following the old alias's jobs;
they stay listed under their alias and resume if you switch back.

## Interactive notebooks

Managers (or you) copy [`scripts/cluster/notebook.sbatch`](../scripts/cluster/notebook.sbatch)
to the cluster and submit it with the project's account and partition. It refuses to run
outside a Slurm job. Jupyter runs inside the allocation on its compute node's cluster
IPv4 interfaces, protected by a random token passed through the environment rather than the command
line. The job writes a private connection file (`~/.sciencewithagents/notebooks/<job>.json`,
mode 600) and removes it on exit.

The template selects a free port from 6818–11845, following the
[FASRC notebook guide](https://docs.rc.fas.harvard.edu/kb/jupyter-notebook-server-on-cluster/).
For another site's permitted range, set `SWA_NOTEBOOK_PORT_MIN` and
`SWA_NOTEBOOK_PORT_MAX` in the environment submitted to Slurm. Jupyter listens on
`0.0.0.0` inside the compute allocation because login and compute nodes may resolve
the node's name to different interfaces. Its token still protects access; the app
forwards only to the node Slurm reports for the running job.

Jupyter prints an environment token as `token=...` in its startup URLs and hides it in request
logs, but an error on a request whose URL carries the token can still print it. Before Jupyter
starts, the template therefore makes the job's open output and error files mode 600, wherever
`--output`/`--error` put them, and stops without starting Jupyter if it cannot. Pipes and
devices are left as they are. Files Jupyter or your code write elsewhere follow your own
permissions.

When the job runs, **Open notebook** on it in QUARK adds a forward to your shared sign-in
from `127.0.0.1` on this computer to that node. The app first checks that the connection file
names the node Slurm reports for the job, so it never tunnels to a login node or another host.
For local opening, the token is read into a normal Jupyter link for this computer’s browser.
The app does not store it; it can remain in that local tab’s address. Open tunnels
are restored after a new sign-in and closed once a complete, successful queue reading shows
their job ended; failed or truncated readings keep them. Each tunnel belongs to the alias it
was opened through: changing the alias closes it through that alias's sign-in, and it is never
reissued through another host. Repeated taps share one tunnel. Closing a tunnel leaves the job
running; stop the job itself with `scancel`.

Notebook pages run their own code and must use a different hostname from every app entry.
For phone or selected-computer opening, the computer connected to the cluster can have a
private `data/notebook-access.json` (owner-only file, mode 600):

```json
{ "origin": "https://notebooks.example.org", "port": 4332 }
```

`origin` is an exact HTTPS origin without a path or external port. `port` is the optional
loopback listener port (default 4332), separate from app and phone ports. Arrange HTTPS routing
for that notebook-only hostname to `127.0.0.1:4332` on this computer, including WebSocket
upgrades. A different port on the app’s hostname is unsupported because cookies share a
hostname. Configuring this file does not publish an address or configure hosting. Invalid
configuration or a failed optional listener leaves the app and saved views available.

The current notebook template uses `/notebooks/<job>/` as Jupyter’s native base URL, following
[Jupyter Server’s base_url setting](https://jupyter-server.readthedocs.io/en/latest/other/full-config.html#ServerApp.base_url).
Older jobs still open locally; phone access asks for the current template. A paired browser
receives a 60-second one-use launch handoff, then a notebook-only HttpOnly cookie. The launch
page waits up to 90 seconds for Jupyter startup before opening Lab, with a retry action if
the job takes longer; revoked access stops the wait. Native
Jupyter HTTP and kernel WebSocket traffic go through the validated private forward; app,
phone, host and provider credentials are never forwarded. The gateway preserves native
Jupyter authentication and XSRF checks. Its launch URL contains no Jupyter token; authorized
notebook code may still see Jupyter’s own notebook token through native Jupyter behavior.

Notebook sessions last at most 8 hours and end when their tunnel closes, its alias changes,
or a successful queue reading proves the job ended. Removing a paired device or disabling
phone access revokes directly issued sessions. For a selected computer, the entry app renews
an exact-launch 90-second lease every 30 seconds; failed revocation delivery or an entry-app
crash stops renewal, so the selected host closes HTTP/WebSocket access after the remaining
lease (about 90 seconds at most). Notebook data never relays through the entry app: each selected
computer needs its own reachable notebook origin. Restarting either gateway requires opening
a new launch. Closing access leaves the Slurm job running. Until hosting is configured, other
devices can still see and close saved tunnels; local notebook opening remains available.

## Sign-in and reconnecting

If the shared sign-in has expired or the computer restarted, QUARK shows **Sign-in needed**
and keeps the last reading; Home lists it under **For your attention**. Managers see the
connection state in their context and record the blocker instead of retrying. Running batch
jobs are unaffected.

Choose **Sign in** in the cluster panel, on this computer or a paired phone. The app runs
native `ssh -M -N -f <alias>` in a private terminal on this computer with strict host-key
checking and shows only the prompt's name, such as `Password:` or `VerificationCode:`. Each
answer you send is typed into that prompt once and cleared from the page. It is not saved,
logged, returned by the app or shown to agents; from a phone it travels over your paired
connection. The result is the same shared sign-in a terminal would create. `ControlPersist`
sets how long the connection stays open after its last client closes; it does not guarantee
24 hours of access. Sleep, a network interruption, a server disconnect or a restart can
end it sooner. Repeated taps and devices share one
attempt; changing the alias cancels it so an answer never reaches another host's prompt. The
alias needs `ControlMaster` and `ControlPath`; the app does not edit SSH settings. A changed host key is never accepted:
check it yourself in a terminal. Signing in with your usual SSH command also works.
