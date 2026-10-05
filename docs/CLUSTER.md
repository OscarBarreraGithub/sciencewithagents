# Slurm cluster

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

## Managers on the cluster

Managers use the native terminal: `ssh`, `scp`/`rsync`, `sbatch`, `salloc`/`srun` and their
own scripts. There are no app wrappers per command, no account selection and no submission
gate; your account, partition, QOS and site rules apply. Managers read the shared reading
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
The token is read when you open the notebook and sent only to this computer's browser; it is
not stored, although it stays in that tab's address as with any Jupyter link. Open tunnels
are restored after a new sign-in and closed once a complete, successful queue reading shows
their job ended; failed or truncated readings keep them. Each tunnel belongs to the alias it
was opened through: changing the alias closes it through that alias's sign-in, and it is never
reissued through another host. Repeated taps share one tunnel. Closing a tunnel leaves the job
running; stop the job itself with `scancel`.

Notebook pages run their own code, so they must not share the app's address. Opening one from
a phone, or from another computer's app with this computer selected, needs a separate private
address for this computer, such as a dedicated Tailscale Serve port. Until then, open
notebooks in this computer's browser; other devices can see and close its tunnels.

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
connection. The result is the same shared sign-in a terminal would create, so it lasts for
your `ControlPersist` time but not past a restart. Repeated taps and devices share one
attempt; changing the alias cancels it so an answer never reaches another host's prompt. The
alias needs `ControlMaster` and `ControlPath`; the app does not edit SSH settings. A changed host key is never accepted:
check it yourself in a terminal. Signing in with your usual SSH command also works.
