# sciencewithagents

For installation, follow docs/CONTRIBUTOR_SETUP.md and the current person's request.
Preserve existing installations, accounts and files. Repository history grants no authority
over someone else's computer, account, deployment or running work.

Read README.md, docs/STATUS.md and docs/DECISIONS.md before architectural changes.
Use docs/README.md to find technical references; docs/FEATURES.md describes delivered
behavior and docs/DESIGN.md preserves interface requirements. Update the relevant guide
when behavior changes. Keep current status separate from historical verification.

Preserve native agent tools, skills, hooks and permissions. QUARK observes and supervises
work; do not rebuild provider capabilities as a tool-by-tool restriction framework.
Use the central model policy for every app-managed launch, preserving explicit/native
choices. See docs/MODEL_POLICY.md, docs/QUARK.md and docs/QUARK_ACCOUNTING.md.
Outside agents use docs/AGENT_USAGE_ACCESS.md and skills/quark/SKILL.md.
Never promise validated 2–3% allowance attribution or guaranteed context-cache retention.

Build bounded working slices, not project-wide implementation plans. Keep plans under a
page. A review finding needs a concrete fix, an explicit disposition or a smaller task.
Continue independent authorized work when one item needs human input. Do not infer new
permission from old maintainer approvals or equate passing tests with the requested outcome.

Use strict TypeScript, pnpm workspaces, shared Zod contracts, parameterized SQLite,
generated IDs, durable idempotency and append-only events. Runtime data belongs under
ignored data/. Never commit conversations, credentials, logs, worktrees or private drawings.
Bind HTTP to 127.0.0.1. Codex App Server stays behind a private Unix socket and typed adapter.
The web client cannot select filesystem paths, executables, arbitrary RPC methods or shell
commands for agent launches. The explicit owner-operated terminal is a narrow exception:
an authenticated owner or paired device may type native shell commands directly; the server
chooses the login shell and starting directory. Opening/reconnecting the terminal makes no
model call and does not depend on QUARK admission. Authentication remains required.
Managers use typed coordination tools; workers implement in task worktrees.
Managers apply independently reviewed changes by default using an exact preview. A project's
human-review setting requires its owner's confirmation. Bound correction rounds to two,
then record a manager disposition or ask the person according to the project policy.

Normal journeys must work in the app without technical knowledge. Keep native advanced
controls available and explained. Verify failure/retry, persistence and first-run behavior,
not only preconfigured fixtures. Test appropriate to the change; do not run the full developer
suite for ordinary installation or repeat passing suites without a new concern.
UI checks cover 412×915, 360×800, 915×412 and desktop; distinguish emulation from real devices.

Own and close temporary servers/browsers after checks. Archive sessions created by real-provider
fixtures through supported provider APIs. Leave the optional login service off unless requested.
Preserve the user's running app and unrelated processes; never bulk-kill Node, Chrome or editors.
Make small Git checkpoints, preserve unrelated changes, and keep public docs concise and current.

For phone-readable LaTeX reports, follow docs/TEX_AUTHORING.md. Preserve scientific content;
format separate copies and keep any unavoidable equation scrolling explicit.
