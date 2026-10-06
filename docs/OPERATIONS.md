# Operations

Install with [Contributor setup](CONTRIBUTOR_SETUP.md). This guide applies only to the
installation and actions the current person has authorized; it contains no standing approval
for other computers, accounts or deployments.

## Open, stop and update

On Mac, open **sciencewithagents** from the user's Applications folder. The launcher opens a
private one-use browser handoff and owns this installation's server/connector. Closing the
browser does not stop agents. Use **Stop and Quit** to shut down deliberately. The computer
must stay awake and online for background work or phone access.

For source use, start with `sh scripts/pnpm start` and open with `sh scripts/pnpm dock open`.
A bare loopback URL is not an authenticated entry. The ordinary listener binds to 127.0.0.1;
never tunnel it. Phone access uses its separate authenticated entry. [Local access](LOCAL_ACCESS.md).

The optional login service remains opt-in. Do not install it, enable it, alter sleep settings
or reboot a computer as an incidental setup step. When updating an existing installation,
inspect active work, preserve local modifications/data and follow [Update](UPDATE_APP.md).
Do not restart an active server merely to serve rebuilt frontend assets.

## Recovery and requests

A database lock prevents two gateways using the same data directory. Inspect the recorded
process before treating a lock as stale; never delete one belonging to a live server.
After a crash, inspect interrupted tasks and their last results before continuing. An uncertain
external side effect is not known to have failed. Retry with its original durable request key
or reconcile status; do not replay model input, terminal bytes or approvals automatically.

Chat and queue use the same browser workspace. A lost registration response retries the
original request, retaining local drafts and the saved browser label.

Provider identities, settings and visible transcripts remain saved. Reopen uses supported
native continuation without sending a turn. If native resume is unavailable, offer an explicit
new context with saved evidence; never silently pretend it is the original context. Retained
evidence does not recover hidden reasoning or guarantee the provider's context cache.

Use consistent [recovery copies](RECOVERY_COPIES.md) and [source backups](SOURCE_BACKUPS.md).
Git saves committed project code, not conversation databases, credentials, unsaved files or
browser drafts. Restore to an unused directory and verify before replacing any live installation.

## Work supervision

Managers maintain internal work and short human requests, continuing independent work when
one item needs input. Workers use task worktrees. Reviews are bounded and exact reviewed
changes are applied according to the project's manager/human policy. Read-only research need
not create a code integration. [Decisions](DECISIONS.md), [QUARK](QUARK.md).

QUARK shares priorities, resources, reservations and allowance caps across projects. Read the
reason before releasing a hold; increasing a cap does not erase prior spending or release all
other holds. Transient usage failure differs from quota exhaustion. Never relaunch a worker
outside supervision just to bypass a wait. Control only the exact owned turn/process group.

Native tools and permissions remain available. Saved restricted contexts preserve their
choices until explicitly changed. Human questions are not routine permission prompts and
must retain their original answer semantics. [Worker tools](WORKER_TOOLS.md), [Claude](MANAGED_CLAUDE.md).

## Phone and other computers

[Phone setup](PHONE_SETUP.md) offers private Tailscale or an agent-configured domain. Pair a
browser using the temporary code, passkey creation and matching computer confirmation. There
is no repeat lock. Turning access off blocks connections while preserving approved devices;
Remove device revokes approval. Browser storage loss or a changed trusted origin may need pairing.
A working browser and an installed Home Screen icon have separate storage/acceptance limits.
[Phone workflow](PHONE_WORKFLOW.md), [Cloudflare setup](CLOUDFLARE_SETUP.md).

Use [Multi-computer setup](MULTI_COMPUTER_SETUP.md) for another host. Keep provider accounts,
projects and history on their original computers. Existing unrelated SSH aliases grant no
permission. Host selection is not automatic job migration or cross-account memory sharing.

## Development hygiene

Use isolated data and repos for tests. Temporary browsers, previews and live provider fixtures
need an owner and an end: close them on success/failure and verify no owned listener/children
remain. Archive fixture sessions using native APIs, retaining genuine user chats. Never bulk-kill
Node, Chrome, editors or connectors. Preserve the normal app when the person is using it.

Keep credentials, runtime databases, prompts, private drawings and generated evidence outside
tracked source. Technical logs may contain private tool output. Publish only the reviewed source
and licensing material. [Verification](VERIFICATION.md) describes checks; historical receipts
are evidence, not authorization for later actions.
