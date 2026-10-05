# Update an existing installation

Open **Settings → App updates** (also under **? → Check for updates**). The selected computer
checks the public GitHub source without using a model or changing its working files.
Choose **Update with an agent** to prepare a verified database recovery copy and assign one
internal work item to the existing maintenance manager, using the central model policy and QUARK.
**Open update conversation** shows its progress, questions or queue blocker. Lost responses
reuse the same request instead of starting another turn. A failed copy prevents assignment.

The agent preserves local changes, prepares and reviews the update, and builds it. It does
not restart the app hosting its own conversation. Once it reports **Ready to reopen**, quit
and reopen through the existing launcher after active work finishes; have the agent verify
the running app afterwards. This is an agent-assisted update, not a silent automatic installer
or a guarantee that arbitrary customizations will merge without a decision.

**Use my own setup agent** supplies a complete copyable request if the installed app is older
or its provider is unavailable. No manually supplied recovery reference is required. The older
Recovery copies handoff remains usable. Opening or copying instructions starts no model work.

## Keep local customizations

People may customize their app, including providers and the interface. To carry them forward:

- Keep a short local record of the upstream base and each intentional customization, with
  its purpose and a check that shows it still works.
- Compare the previous upstream base, the new release and the customized copy; port the
  upstream changes into the customized copy instead of overwriting it.
- Check the person's actual workflows afterwards. A clean merge does not prove that a
  customization still works.
- If an update and a customization need a real product choice, keep the existing behavior
  and explain the specific choice.

Source code can change, and an update may replace or delete obsolete code. The saved private
workspace must stay: never delete, reinitialize or replace it to make an update pass. The app
prepares the initial database copy and the agent makes any fresh copies, so no separate
everyday backup ritual is needed. Copies on this computer do not protect against losing it.

## In-app maintenance manager

Use the pinned revision supplied with the request, not a changing branch name. Follow the
runbook below for inspection, preservation and isolated preparation, but **do not execute
its stop/reopen steps from a manager running inside this app**. Keep the live server running;
stage and test in a separate worktree, preserve existing served web assets while building,
and prepare activation instructions for the existing launcher. Mark the internal item done
only when the reviewed source/build is ready; that status does not certify activation.
Keep a short private receipt of the previous upstream base, retained customizations, target,
checks, data directory and remaining restart/verification step under ignored `data/app-updates/`.
If work or a customization blocks activation, record a concise human action item and retain
all copies. Never stop unrelated processes or replay interrupted model requests.

## Setup-agent runbook

1. Resolve this installation's source root, data directory, launcher and selected computer.
   Read its AGENTS.md and current setup instructions. Check `node scripts/setup.mjs --check`;
   preserve the selected provider, native sign-in, model policy and phone configuration.
   Inspect the configured source remote, previous upstream base and exact intended revision.
   Read the installation's local customization notes and inspect actual differences, including
   uncommitted work. Preserve local changes; do not reset, clean, overwrite, or update a
   different clone. Record the current revision and the behavior the person expects to keep.
2. Inspect **Work** and pending permissions. Let work finish or obtain an explicit stop;
   do not terminate work merely to update. Recheck any supplied copy using **Check this copy**,
   or prepare and verify one yourself if none was supplied.
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
