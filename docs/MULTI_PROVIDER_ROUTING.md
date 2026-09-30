# Providers, model choices and routing

**Current update (2026-09-25):** [Model settings](MODEL_POLICY.md) now centralizes tier/provider defaults, latest-family resolution, exact pins and bounded undergrad escalation. It is a working home destination. Earlier descriptions below that defer automatic routing or describe inherited manager models are superseded by that policy. Original native editor sessions retain their own choices.

Status — 2026-09-24: Codex and Claude managed conversations are enabled in source.
Project/module managers and task workers can use either provider in one project. This
supersedes the September 13 identity-only audit; Claude is no longer a reserved,
disabled adapter. [Managed Claude](MANAGED_CLAUDE.md) describes its actual supported
controls, local subscription requirements and deliberately narrower tool surface.
Installed deployment and dated final regression receipts belong in [Status](STATUS.md)
and [Verification](VERIFICATION.md), not an assumption that every earlier test covers
later source changes.

Automatic difficulty-based model selection remains **deferred**. QUARK now implements
shared quota-aware admission, background pacing, reservations and task budgets; managers
can choose explicit installed models using those shared readings. It never silently changes
a requested model or buys API capacity. See [QUARK](QUARK.md).

## Everyday provider and model selection

- **Create a project** or **Add module manager** offers Codex and Claude Code. It uses
  the selected computer's existing provider sign-in. Provider and request identity are
  retained across reload/lost-response retries, without duplicate managers/projects.
- **Use an existing project folder** applies the choice to a newly connected project.
  Reopening a registered project preserves its existing manager and provider.
- **Session settings** uses that agent's provider/computer model catalog, with explicit
  retry when discovery fails. Discovery sends no user prompt and does not resume the
  owner's saved Claude conversation. Settings do not switch an existing conversation's
  provider or account.
- Tell a manager which provider/model/thinking level to use for a new worker. Same-provider
  omissions inherit its settings. A different provider requires an explicit model **and**
  thinking level from its own catalog; aliases are not assumed interchangeable.
- **Provider, usage and assignment** distinguishes the original recorded assignment from
  current settings and reported usage. Difficulty and selection reason are retained
  evidence, not a hidden ranking or permission to change the owner's requested model.

At the tool boundary, managers use `dock_delegate.execution` with provider, model, effort,
difficulty and reason. `dock_inspect` with `models: true` and optional `provider` reads the
installed catalog. Unavailable models/efforts and automatic mode fail before creating a
worker; Claude requests are never silently routed through Codex. Existing contexts may
have older tool definitions: choose **New context** explicitly when necessary, preserving
the original archive rather than pretending a context was upgraded in place.

## One project, one deterministic host

The host owns one queue, task/worktree model, review loop, archive and durable delivery
receipts. The private Claude adapter translates native lifecycle, visible events,
host-tool calls, original permission requests and usage into that existing runtime.
The Codex transport remains provider-specific; this is not a generic browser RPC,
credential broker, replacement tool ecosystem or second scheduler.

Managers coordinate and delegate; they do not implement or produce detailed plans.
Claude managers receive only their typed Dock coordination tools, not built-in file,
shell, planning or native-delegation tools. Workers use their assigned task workspace.
Review remains independent, bounded disagreements need a recorded manager disposition,
and applying reviewed code still requires the owner's exact preview and confirmation.
Workers can inspect the task's clean-checkpoint diff through `dock_inspect` with
`changes: true`; display formatting is not raw file-byte evidence.

Cross-provider task delegation, peer messages and reports are recorded information
transfers, not transcript cloning or cross-provider native subagents. Preserve the
responsible manager and single task writer. Treat another agent's report as evidence,
not higher-priority instructions. The separate personal front desk remains Codex and
sees only explicitly selected projects; it does not merge accounts' private memories.

## Fixed identity and honest capability boundaries

A saved conversation keeps its original provider and context ID. Claude additionally
checks the original local subscription-account affinity before continuation. Missing
affinity, an account change or unavailable native history fails visibly; it is not
permission to create a substitute session or inject the transcript into another account.
Provider-scoped context ownership, history markers, original requests and delivery IDs
prevent collisions and stale results from completing unrelated work. Existing Codex
records are not reinterpreted as Claude records.

Each computer retains its own installed providers, sign-ins and native history. The
app does not copy account files, extract tokens, pool school/family accounts or offer its
own Claude login. Managed Claude requires the native subscription path and refuses
conflicting API-key/provider-environment overrides rather than falling back to paid API
usage. Native-host distribution conditions still require review before a hosted product;
see the source-backed [authentication and distribution notes](MANAGED_CLAUDE.md#authentication-billing-and-local-setup).

Managed Claude supports chat, role tools, original approvals, model settings, Stop,
resume and new context. Its native terminal, advanced slash commands, external MCPs,
plugins, native helpers and web/image controls are not enabled here. The UI explains
those limits and preserves an unsupported slash-command draft. Original Claude Code
and its [shared VS Code conversation](VSCODE_MIRROR.md) retain their native controls.
Codex retains its existing native-terminal/MCP/plugin/helper paths. Success in structured
Claude chat is not a claim of complete native parity.

On restart, the archive and original identities remain. Codex reconnects saved contexts;
Claude restores an inert handle and launches/resumes its native session only on explicit
work. Opening saved views sends no message, and interrupted actions/old permissions are
not automatically repeated. This prevents native resume from silently continuing an
unfinished Claude turn during app startup. Exact hidden context/cache continuity is not
guaranteed. Editor mirroring deliberately has lighter recovery: reopen the original
VS Code conversation and share it again instead of reconstructing it.

## Usage is not remaining allowance

| Information                       | Current treatment                                                                                                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex reported tokens             | Retain the provider's scoped snapshot, source and observation time. Cumulative updates are not added together.                                                                                     |
| Claude reported tokens            | Preserve last-result input/output and cache-read/cache-creation counts, bound to native session/result and host delivery IDs. Deduplicate receipts; cumulative conversation totals remain unknown. |
| Remaining quota/reset             | Show only actual reported values with freshness. One regular shared collector reads Codex and native Claude, including Fable windows; both managers and the first-open phone view read that cache. |
| Missing/incomplete data           | Unknown, not zero. Stale results cannot refresh a newer delivery; parent/child and cross-provider counters are not combined into an invented total.                                                |
| Cost, billing and spending limits | No computed bill, quota estimate, automatic spending cap or fallback budget. Token counts do not establish subscription headroom.                                                                  |

The usage panel is read-only unless the owner explicitly asks for the supported Codex
limit refresh. Reading saved Claude usage or discovering its models starts no model turn.
It does not reset usage, run an account command or alter the owner's subscription.

## Owner TODOs before automatic routing

- Decide which projects may send information to each provider/account.
- Map **Opus / Sol / Terra** to verified provider model IDs and intended roles/difficulty.
  No relative quality, price or difficulty ranking is assumed.
- Define who labels difficulty, allowed fallbacks, and whether exhausted/unknown capacity
  waits, asks, or creates a new explicitly permitted agent. Never migrate an active context.
- Choose usage thresholds, reserves and any explicitly authorized billing/budget policy.
  Unknown allowance must not trigger API spending, another account or wider permissions.
- Keep other computers' physical setup/acceptance separate from tested host fixtures.
  Selecting a computer is not authorization to share its school/family history elsewhere.

## Evidence and remaining checks

On September 17 a disposable real project completed **Claude manager → Codex implementer
→ independent Claude reviewer**, with the task committed/reviewed/completed, three
histories/checkpoints and Claude usage retained. The original project was untouched.
Restart preserved exact provider IDs and started no new runs; Claude restoration stayed
lazy. This demonstrates a real mixed team, not just a mocked adapter. Later race-hardening
regressions remain separately recorded in [Verification](VERIFICATION.md).

Standalone real Claude checks also cover restricted manager tools, original Write
decline/accept and explicit same-session continuation. Sixteen focused Claude UI checks
across the four supported sizes cover provider selection, lost-response/reload retries,
model discovery failure/retry, native-only control guards and honest last-turn usage;
the combined impacted app/usage suite passed 100 checks. Those fixtures do not certify
physical phone use, every model combination, hardware power loss or full-machine restore.

Implementation/checks: [provider assignment](../apps/server/src/providers.ts),
[managed Claude](MANAGED_CLAUDE.md), [runtime tests](../apps/server/src/claude-runtime.test.ts),
[Claude usage tests](../apps/server/src/claude-usage.test.ts),
[UI checks](../apps/web/tests/classic/managed-claude.spec.ts),
[opt-in mixed-team check](../scripts/smoke-mixed-providers.mjs).
