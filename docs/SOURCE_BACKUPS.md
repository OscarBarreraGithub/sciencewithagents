# Private GitHub source backups — agent runbook

## Person-facing setup

Open the project and choose **Private source backup → Set up source backup**. Choose a new
private destination or enter the owner/repository of an existing private GitHub repository.
**Preview private backup** checks the computer's native GitHub account and the destination;
it creates nothing and uploads no source. Review the exact address and main branch, select
the confirmation, then choose **Confirm private backup**. Existing project destinations are
never redirected by this initial setup flow.

GitHub CLI must be installed on that computer. On Mac, **Need to connect GitHub? → Open
GitHub sign-in** opens the native Terminal/browser flow only when requested; a working
account is reused rather than replaced. Finish GitHub's prompts, then preview again. The
app receives no login code, password or token. A setup agent handles installing a missing
native tool or another platform's native sign-in. Never ask the person to paste credentials
or Git commands. GitHub and Cloudflare authorization remain separate.

Confirmation connects the existing exporter without an app restart. It can queue earlier
reviewed task checkpoints as well as future ones. **Connected** means the destination is
configured; only the subsequent remotely verified **backed up** status confirms a checkpoint.
The same project card offers **Retry source backup**. An interrupted setup keeps its exact
destination: **Check connection** reads current state, and **Continue this connection**
rechecks it before proceeding. A creation retry uses the same unique GitHub name, never a
second guessed destination. Reloading preserves the preview/attempt in the private app store.

Each project needs its own explicitly configured private source destination. Local projects
work without it, but show **Private GitHub source backup is not configured**, not a misleading
saved indicator. Managers receive the same verified status in their host context and must
include missing/failed backups in handoffs. A private repository is not a secrets vault.

## Advanced setup-agent fallback

1. Inspect the project's registered root, current Git history and existing remote. Reuse an
   appropriate owner-controlled private GitHub repository; do not redirect an unrelated
   repository or publish to a public fork. If a new private repository is required, create
   it within the owner's authorized setup scope with a collision-safe name.
2. Reuse the owner's authenticated GitHub connection. The current runtime transport uses
   Git and GitHub CLI (`gh`), so verify those locally and let the person complete supported
   browser/device sign-in if needed. An MCP login alone does not authenticate this CLI.
   No token extraction, credential copying into project files, or global Git configuration
   change is required. The transport uses a per-command `gh` credential helper.
3. Inspect the initial source and history locally. `.gitignore` protects untracked files,
   not secrets already committed. Resolve questionable history with the owner; never
   rewrite history or disable protection to make a backup pass.
4. While the app is stopped, preserve other mappings and write ignored
   `data/source-backups.json` as an array of
   `{ "projectId": "<registered UUID>", "repository": "owner/private-repository", "branch": "main" }`.
   These are host-only settings, never arbitrary browser paths/URLs. Use restrictive file
   permissions. Start the app only for active verification or requested normal use.
   Prefer the app's initial setup for normal users. It atomically updates this same file,
   retains other mappings and rejects external configuration changes; there is no second
   source-backup configuration store or exporter.
5. Verify a real reviewed source checkpoint and remote commit. No model turn or fake owner
   approval should be added to the owner's project just to trigger a test. Use a clearly
   disposable fixture for transport checks. Confirm the UI and manager status agree with
   the remote, and record the sanitized result. Local/bare-remote tests are not a live
   GitHub test. New projects need their own setup mapping; this release does not silently
   create repositories whenever someone presses Add a project.

## Deterministic behavior

The hook listens for completed, reviewed code tasks and approved integration. It runs
inside the existing app process, with a serial queue and startup reconciliation; there is
no extra agent, timer, daemon, file watcher or Git hook to install. Unreviewed work and
transcript-only tasks are not exported. Local checkpoints are still the worker's duty.

- Reviewed work goes to `agent-dock/task-<task-id>`, preserving unfinished integration.
- Exact policy-authorized integration goes to the configured main branch, fast-forward only.
- Every attempted export checks the GitHub repository is private and checks its remote
  branch. Only a remotely confirmed commit counts as backed up. Existing verified receipts
  avoid duplicate work; an explicit Retry source backup rechecks current remote state.
- New history is scanned, including earlier commits whose files were later deleted.
  Known credential paths, this installation's private runtime paths and common token formats
  are refused. Ordinary research `data`, `logs`, `uploads`, database and log files are allowed
  within the same content/size checks. This app's own source clone still excludes its `data/`
  history, even if the active runtime is elsewhere. Each distinct path/blob version counts
  once, so unchanged files across commits do not exhaust the file allowance. Blob contents
  are scanned once per backup attempt; all path aliases are checked before reusing that scan.
  Larger histories (>128 new commits), file lists (>20,000 distinct path/object versions), individual blobs (>4 MiB) or new
  content (>32 MiB) require a bounded local inspection instead of an automatic upload.
  These checks are guardrails, not proof that arbitrary source contains no private data.
- A lost push acknowledgement is an uncertain result, not permission to repeat blindly.
  Reconcile from the remote on retry/restart. Never force-push, stash, reset, stage all
  files or change the owner's checkout to make a backup succeed. A push has a two-minute
  timeout and remains cancellable at shutdown; remote inspection commands stay bounded.
- Failures remain visible even if a later task backs up successfully. Source stays local.
  Corrupt configuration disables exports and reports the problem without stopping local work.

This is continuous checkpoint backup while the app runs, **not every-keystroke sync**.
Unsaved edits, arbitrary terminal-created commits outside managed task completion, database
records, conversations, provider caches, uploads and credentials require separate private
backup/recovery. Do not claim GitHub makes the whole machine recoverable.

## Troubleshooting

- **Offline, expired GitHub login or uncertain response:** retain source and receipts;
  inspect authentication/connectivity, then use the explicit retry. Status reports a
  sanitized explanation, never command stderr that might contain a credential.
- **Divergent branch:** preserve both histories. The manager delegates a bounded inspection
  and reports the conflict; normal review/integration still apply. No automated force-push.
- **Sensitive file removed but still refused:** the earlier commit still contains it. A clean
  latest tree is not sufficient. Inspect history privately without dumping secret contents.
- **One success hides another failure:** keep outstanding issues per destination branch,
  not just the last job's result. This has a regression test.
- **Queue appears idle while status says saving:** store notifications run in microtasks.
  Deduplicate pending checkpoints and wait for a stable drained queue in verification.
  A regression test caught this during implementation; it was not a failed secret detector.
- **Service lacks GitHub tools:** a login service may have a different PATH/auth environment
  than the interactive agent. Verify its actual environment; do not copy credentials into Git
  or silently claim the foreground test proves background operation.

## Verification evidence

In-app setup has focused checks for preview/confirmation, account or destination changes,
private/write-access enforcement, exact creation recovery, atomic mapping preservation,
restart and existing export-queue behavior. Browser checks exercise setup/retry and native
sign-in handoff on five desktop/mobile profiles. The installed GitHub CLI's read-only account
and existing private-repository metadata were checked. New repository creation and sign-in
were exercised through controlled fixtures, not against a newly created owner repository.
See the dated [verification record](VERIFICATION.md) for counts and deployment evidence.
Native commands follow GitHub's [repository creation](https://cli.github.com/manual/gh_repo_create)
and [sign-in](https://cli.github.com/manual/gh_auth_login) interfaces; neither is a credential
broker owned by sciencewithagents.

Twelve backend checks exercise real local Git, research histories, private runtime/credential
exclusions, failure recovery and manager/API status. The latest checks use disposable local
bare repositories and do not imply a new live GitHub export.
Four browser checks cover status/retry at all supported sizes. A production-transport check
also succeeded against this build's existing private GitHub repository, using a disposable
app store and a unique source-only branch; only that branch was removed afterwards.
For an authorized agent to repeat it after building, use
`node scripts/verify-source-backup.mjs owner/private-repository --confirm-private-backup`.
Inspect the exact destination first. This publishes the current committed source history
to one temporary branch; it never creates an owner task or starts a provider. See
[VERIFICATION.md](VERIFICATION.md) for the recorded commit and remaining boundaries.
