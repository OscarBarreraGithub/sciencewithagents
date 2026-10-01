# Managed Claude conversations

**Unattended native execution (2026-09-30):** new inherited launches use native scoped
execution and do not queue routine permission prompts. Managers/write-enabled workers
approve Bash through Claude's own permissions while its strict sandbox enforces command
writes; file edits use native edit acceptance. Read-only roles retain plan permissions.
Residual permission requests are denied, and actual human questions remain answerable.
The older pending-approval descriptions below apply to saved restricted contexts. See
[current controls and live evidence](WORKER_TOOLS.md).

**Current update (2026-09-25):** [Model settings](MODEL_POLICY.md) now centralizes tier/provider defaults, latest-family resolution, exact pins and bounded undergrad escalation. It is a working home destination. Earlier descriptions below that defer automatic routing or describe inherited manager models are superseded by that policy. Original native editor sessions retain their own choices.

**Native capability migration (2026-09-28):** new conversations inherit Claude configuration,
tools, skills, plugins, hooks and connections. Saved conversations keep their old restrictions
until explicitly changed in Advanced controls. QUARK hooks check admission without granting
tool permission. See [migration and limits](WORKER_TOOLS.md) and current VERIFICATION.md.

## What this gives you

Claude can be a project/module manager or a task worker in the same Agent Dock project
as Codex. It uses the computer's installed, signed-in **Claude Code**, not a replacement
model API client. Each conversation stays with its original provider and local account.
Computer selection still chooses a separate installation; it does not move history or
copy subscription credentials between personal, school and family accounts.

Choose Claude when creating an empty conversation/project, then use its ordinary chat,
model settings, permission cards and session actions. Existing conversations cannot switch
providers. Managers delegate through the central model policy, preserving explicit model
choices and sharing the QUARK queue and allowance readings.
The existing queue, task worktree, independent review and manager arbitration remain shared;
there is no second Claude scheduler. Managers apply exact reviewed changes by default.
Projects may require human approval instead through their workflow setting.

This is different from [sharing a live VS Code chat](VSCODE_MIRROR.md). A mirrored chat
remains owned by the original extension. A managed conversation is owned by Agent Dock's
native provider lifecycle and durable archive. Editor sharing does not import a manager.

## Supported roles and controls

| Surface                                          | Managed Claude behavior                                                                                                                                                                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager                                          | Native configured capabilities plus typed QUARK/project tools. Delegate bounded implementation and independent review in task workspaces.                                                             |
| Planner, researcher, reviewer; read-only worker  | Native plan permissions plus its permitted Dock tools; explicit restricted contexts retain their old tool policy.                                                                                     |
| Write-enabled implementer                        | Native configured tools in the existing task workspace, with original permission requests. No second Claude-created worktree is requested by the app.                                                 |
| Stop / resume / new context                      | Typed app actions, exact saved identity and explicit new-context choice. Interrupted work is not automatically resubmitted.                                                                           |
| External MCPs, plugins, native helpers           | Inherited from native configuration. Hook-identified helpers have separate retained records; unlinked text/team totals stay with the parent. Helpers share its budget and process-group stop control. |
| Claude native terminal / advanced slash commands | Not attached here. Use original Claude Code or its shared VS Code chat for those native controls.                                                                                                     |
| Provider web/image tools                         | Available when the installed native provider/configuration supports them; the app does not recreate or separately enable them.                                                                        |

Codex retains its existing native terminal, plugins/MCPs, helper and advanced-control paths.
Unsupported Claude options fail visibly instead of widening permissions or selecting Codex.
Workers' task directories and permission prompts are not OS containment against malicious
software already running as the owner.

## Authentication, billing and local setup

Sign in through Claude Code's own flow on the selected computer. Agent Dock reads its
native authentication-status projection and stores an account-affinity hash, not an email,
organization identifier, OAuth token or API key. It requires an identifiable first-party
subscription login. Missing authentication, missing historical affinity or an account
change stops managed continuation without replacing the conversation.

The adapter rechecks affinity before each submitted turn. It rejects conflicting API-key,
bearer-token, alternate-provider, endpoint/header and OAuth-environment overrides before
authentication checks or spawning a model process. It does not unset them, change the
account, use paid API billing as a fallback or provide an Agent Dock sign-in broker.
The native executable is selected by host setup (`DOCK_CLAUDE_BIN`), never a browser path.

This distinction matters: in noninteractive CLI mode an environment API key can override
an existing subscription. `--bare`/`CLAUDE_CODE_SIMPLE` also excludes the usual OAuth/keychain
sign-in, so this adapter does not use bare mode.
[Claude environment variables](https://code.claude.com/docs/en/env-vars),
[programmatic CLI usage](https://code.claude.com/docs/en/headless)

Anthropic's current terms distinguish end users signing into an **unmodified Claude Code**
binary from a product collecting subscription credentials or providing its own Claude login.
Agent SDK product guidance separately calls for API authentication unless approved.
This implementation hosts the native binary without modifying it or extracting credentials;
it does not establish permission to resell/intermediate usage. Recheck distribution terms
before publishing a hosted service or changing that boundary.
[Native hosting and credential conditions](https://code.claude.com/docs/en/legal-and-compliance),
[Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview)

## Isolation and original permission decisions

Inherited contexts append the coordination charter and Dock MCP tools to native configuration.
They do not use the old blanket restricted flags, empty builtin/skill/agent catalogs, or
Dock-only MCP policy. Saved restricted contexts retain those limits until deliberately changed.
No browser endpoint accepts a command, executable, arbitrary RPC method or MCP transport.

Built-in worker requests carry their original request and tool-use IDs and exact inputs.
Approval replies allow or deny that single pending request; suggested persistent grants
are not applied. The owner decision is retained before forwarding. Cancellation, completion,
disconnect or restart invalidates pending requests. Lost replies are uncertain outcomes,
not permission to replay an approval. Unfamiliar native tool requests use the same exact
permission path; tool names are evidence, not a separate app capability catalog.

Native administrative policy remains in effect. QUARK callbacks use the private SDK control
connection and compose with native hooks; no global hook file is installed. If a parent reports
completion while helpers are active, the run remains open until their stop events. Stop closes
the owned group when helpers are active. QUARK also closes an owned group that remains active
after its interruption grace period. Files, queued input and original session IDs are retained.
Native hook IDs now retain separate helper identities and runs, tool evidence and reported
closing text across resume. A helper ID is not a standalone session UUID; the owning session
controls it. Registered native transcripts now retain helper replies, deduplicated input/cache
counters and reported models, with delayed-write/restart catch-up. The reported model can enable
a separate saved-evidence discussion. A recognized completed Agent/Task call can now link an
existing helper to its invoking helper: the owned tool hook identifies the caller and the
structured response identifies the callee. Only a fresh invocation with prompt metadata is
eligible; resumes do not rewrite the first recorded parent. Cross-session links and cycles
are rejected, and the existing root still owns admission and stopping. Missing/background
results and older unlinked records retain session ownership without guessed nesting.
Full helper output breakdowns and absent/unregistered transcripts can still leave gaps. Child counters are not added to
the owning session’s team totals.
A nested helper page offers **Open invoking helper** separately from **Open controlling
conversation**. An evidence discussion needs a known model; otherwise use the controlling
conversation. Opening either link is navigation, not a new model turn.
Lifecycle fields follow the [native hook reference](https://code.claude.com/docs/en/hooks#subagentstart),
without installing global hooks or granting helper permissions.

## Saved sessions, restart and cache limits

The host records a generated native session UUID, provider/account affinity and original
delivery receipt before submission. It records attempted submission immediately before the
native user-message write. A known cancellation before that write is not confused with a
possibly delivered turn; an uncertain write never permits automatic resend or a replacement
identity. A successful native initialization separately records that the session exists.
Reopening saved views creates an inert conversation handle; metadata discovery may run a
separate no-turn process. The saved Claude session is launched/resumed only for explicit
submitted work. Missing native history fails visibly, without injecting an old transcript
into a new provider session behind the owner's back.

On host restart, interrupted work remains available for inspection and old approvals expire.
The owner explicitly continues after inspecting the result. App startup never resumes native
work or replays user input; continuation behavior can vary with the installed native version.

Visible text and tool evidence use stable IDs in Agent Dock's archive. Terminal results
are deduplicated and matched to original submissions when the provider reports them, so an
old result cannot complete a newer delivery. Thinking/signatures and unrelated authentication
frames are not archived. Provider-owned history remains in Claude's local storage; back it
up separately from the app database. Exact hidden context and cache-hit continuity are not
guaranteed. The owned process supervisor stops only its invocation and tool descendants when
the app closes or its lifetime pipe disappears.

## Models and reported usage

Model discovery initializes a disposable fresh native session without a user prompt. It
does not resume an existing owner conversation. The picker uses returned aliases and supported
thinking levels, including bracketed aliases such as `opus[1m]`. Models without reported
supported effort levels remain selectable with **Provider default**, which omits the native
effort override; it is not an invented CLI level. That default remains selectable when a
later catalog adds effort support. Saved explicit unavailable levels are not silently removed.
Saved selection remains
the chosen alias; the actual resolved model is retained separately as connection evidence.

Usage records retain reported input/output and cache-read/cache-creation observations,
bound to native result and host delivery IDs. Missing values stay unknown, not zero;
replays and older runs cannot refresh the current observation. These are not a computed
conversation bill or cross-provider token sum. The separate shared usage collector supplies
subscription readings; QUARK estimates project shares and enforces saved budgets. See
[accounting limits](QUARK_ACCOUNTING.md). No validated 2–3 percentage-point accuracy is claimed.

## Evidence and implementation map

Native transport, restart and mixed-provider work have isolated live evidence in Git history.
For the current release decision and required rechecks, use [Status](STATUS.md) and
[Verification](VERIFICATION.md). Do not extend an older check to every provider version.

- [Native transport](../apps/server/src/claude-session.ts) and [owned stdio supervisor](../apps/server/src/claude-session-host.ts)
- [Managed lifecycle](../apps/server/src/managed-claude.ts), [shared runtime](../apps/server/src/runtime.ts), [provider assignment](../apps/server/src/providers.ts)
- [Usage normalization](../apps/server/src/usage.ts) and [usage checks](../apps/server/src/usage.test.ts)
- [Transport tests](../apps/server/src/claude-session.test.ts), [managed lifecycle tests](../apps/server/src/managed-claude.test.ts), [runtime integration tests](../apps/server/src/claude-runtime.test.ts)
- [Mixed-provider routing](MULTI_PROVIDER_ROUTING.md)

Developer-only focused check: `./scripts/pnpm --filter @dock/server exec vitest run src/claude-session.test.ts src/managed-claude.test.ts src/claude-runtime.test.ts`.
These tests use isolated fixtures; they do not send real model prompts.
