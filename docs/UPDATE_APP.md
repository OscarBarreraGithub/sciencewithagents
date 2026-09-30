# Update an existing installation

Open **Settings → Recovery copies**, create a copy and open **Use this copy before updating**.
Give the copied request to the coding agent that set up this computer. The app prepares a
verified recovery reference; the agent performs the source update. This is not an automatic
updater. Opening or copying the request never sends a model prompt or stops work.

## Intended workflow: adapt updates to each person's app

The owner wants people to customize their local app, including providers and the interface,
then ask their coding agent to bring over an upstream update while preserving that work.
The agent compares the previous upstream base, the new release and the customized copy,
adapts the relevant changes, and checks the person's actual workflows. A clean merge alone
does not establish that the customization still works. Maintain a short local record of the
upstream base and intentional customizations, including their purpose and useful checks.

Keep provider code, presentation and persistent settings reasonably separate so this work
is easy to understand. A general extension marketplace or guaranteed compatibility for
arbitrary source edits is not a prerequisite. If an update and a customization require a
real product choice, preserve the existing behavior and explain the specific choice.

The update agent should handle the precautionary source/configuration and database copies
as part of the update. The person should not need a separate everyday backup ritual merely
to receive updates. The current UI still starts with a manually created recovery copy and
copied request; simplifying that entry point is requested, not implemented here. Copies on
this computer remain distinct from a backup protecting against loss of the computer.

## Setup-agent runbook

1. Resolve this installation's source root, data directory, launcher and selected computer.
   Read its AGENTS.md and current setup instructions. Check `node scripts/setup.mjs --check`;
   preserve the selected provider, native sign-in, model policy and phone configuration.
   Inspect the configured source remote, previous upstream base and exact intended revision.
   Read the installation's local customization notes and inspect actual differences, including
   uncommitted work. Preserve local changes; do not reset, clean, overwrite, or update a
   different clone. Record the current revision and the behavior the person expects to keep.
2. Inspect **Work** and pending permissions. Let work finish or obtain an explicit stop;
   do not terminate work merely to update. Recheck the supplied copy using **Check this copy**.
   Make a fresh copy if records changed. A lost creation response uses **Try again** with the
   same request, including after reload. A failed copy must be repaired before proceeding.
   See [coverage and integrity checks](RECOVERY_COPIES.md): project/task files, native provider
   history, browser-only drafts and host configuration need their own private preservation.
3. Record baseline project/task/agent identities, conversation counts, saved model/QUARK
   choices, paired devices and the existing connection state without printing private content.
   Close only this app using its recorded launcher (**Stop and Quit**) or existing service
   control. Wait for its owned server to stop. Preserve its current private data/configuration
   and source separately; never mix database sidecars or copy credentials into the repository.
4. For an unmodified installation, apply the inspected source revision (a clean configured
   branch can use `git pull --ff-only`). For a customized installation, compare upstream
   changes against its previous base and port them into a separate working copy/branch,
   preserving the local behavior and resolving both code conflicts and behavior conflicts.
   Do not aim tests at the owner's live data. From the resulting clone run
   `sh scripts/pnpm install --frozen-lockfile`, then `sh scripts/pnpm build` and focused checks
   for the changed functionality and local customizations. Retry a failed step after correction;
   do not reset data, repeat model requests or rerun successful live-provider checks. Existing
   launcher paths need no change unless tools or source moved; use CONTRIBUTOR_SETUP.md for
   that explicit repair. Keep login-service intent unchanged.
5. Reopen through the same launcher/service and data directory. Verify readiness, baseline
   records, retained drafts, model choices, QUARK holds and existing phone pairing/connection.
   Inspect interrupted jobs and uncertain deliveries before any continuation; never resend
   them just to test the update. Check the changed feature and retained custom workflows in
   the actual UI, including custom provider displays where present. Record the new upstream
   base, retained adaptations and any deferred changes in the local update notes. Ordinary
   updates do not require running the full developer suite or spending model allowance.
6. If startup or validation fails, report the exact failed stage and retain all copies. Retry
   that stage after correction. Do not point older code at a database migrated by newer code
   or overwrite the live database. A rollback involving data follows the separate-directory
   [restore runbook](RECOVERY_COPIES.md#restore-safely--setup-agent-runbook), with current phone
   trust reviewed before reconnecting. Record what passed and any device-only acceptance left.

Keep receipts/logs under ignored private `data/`. Source backups protect code, not conversations.
Updates preserve existing authority; they do not authorize new accounts, network routes or
publication. Screenshots and test fixtures are development evidence, never user installation data.
