# Slurm work for sciencewithagents managers

Read this once per assignment. It says where cluster rules live, how submission review works
and what belongs on the cluster.

## Where the rules live

- **Owner/lab policy**: the confirmed account(s), default partition and QOS, resource
  expectations and lab rules in the owner's Slurm submission settings. A `dock_slurm_review`
  result reports problems against it. Never infer an account from Slurm's default account or
  from your memberships; ask the owner.
- **Site rules**: dated documentation excerpts in `scripts/cluster/site-rules/<id>.md` of the
  app (refreshed copies in its private `data/slurm-site-rules/`). They are evidence, not live
  limits, and can be out of date.
- **Live native state**: `dock_inspect {cluster:true}` returns the shared cached queue,
  fairshare, associations, QOS and partition limits with their age. Do not poll `squeue`,
  `sshare` or `scontrol` in loops. Fairshare is priority, not remaining budget.
- Native Slurm is authoritative and enforces its own limits when you submit.

## Before you submit

1. When the owner enables submission review, each new or changed `sbatch`, `salloc` or `srun` submission gets a policy review. In managed
   Claude sessions the host holds a recognized submission until it is reviewed. In Codex
   sessions, and for programs, Makefiles or scripts that submit internally, call
   `dock_slurm_review` yourself before running them.
2. Pass the exact command you will run, including any `ssh <alias> '…'` wrapper. When the
   script is on the cluster, generated, looped over or piped, include `scriptContent`.
3. **Pending**: do not poll, sleep or resubmit variants. Continue other work or finish your
   turn; a report arrives when the review ends. Then run exactly the reviewed command. Any
   change to the command, script, policy or native limits is reviewed again.
4. **revise**: apply the correction (or explain why not and ask the owner). **ask_owner**: record
   one concise human work item. **failed/expired**: this is not approval; ask the owner to
   approve that exact submission or retry the review. Do not loop.
5. `sbatch --test-only` validates without submitting and needs no review.

The review is a probabilistic policy check from cached evidence. It does not create quotas,
guarantee start times or prove a job is correct.

## Local and cluster work

- **Local manager** (this app on the owner's computer): reach the cluster with
  `ssh <alias>`. The host can read a bounded script on the configured alias through the shared sign-in.
  Supply exact `scriptContent` when it cannot verify a generated or opaque script.
- **Remote manager** (the project's own backend inside a small development allocation on the
  cluster): Slurm commands run directly and the host reads scripts on cluster storage. `srun`
  inside the runtime's own allocation launches a job step there, not a new job.
- Keep editing, small tests and analysis that need neither the scheduler nor cluster-only data
  or software out of the batch queue. Use the scheduler for work that needs cluster resources,
  start with test/gpu_test-sized runs, then scale.
- Never run compute on login nodes. Never handle passwords or verification codes; the owner
  signs in.
