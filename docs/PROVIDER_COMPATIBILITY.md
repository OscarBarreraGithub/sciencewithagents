# Keep the frontend thin

Managed Codex and Claude are implemented through their own native adapters. Central model
policy chooses app-managed roles, preserves exact/native choices and reports unavailable
models explicitly. See [model policy](MODEL_POLICY.md) and [managed Claude](MANAGED_CLAUDE.md).

sciencewithagents does not replace provider authentication, plugin/MCP installation, skills
or native permissions. New contexts inherit native capabilities. It adds durable agent/task
relationships, observations, QUARK supervision, review boundaries and typed controls.
Saved restrictions remain optional compatibility behavior; [worker settings](WORKER_TOOLS.md)
explains migration without losing history or pending saves. Opening archived work does not
require a tool inventory or start a prompt.

Claude model discovery uses a fresh native-inheriting initialization without a user turn;
optional effort metadata may be absent. Codex model discovery reads its native model list.
Setup reports account and catalog readiness separately and checks only selected providers.
Native launches skip the older plugin/MCP policy probes; deliberately restricted contexts
retain the checks needed for their saved policy. Required control/identity fields stay strict;
unfamiliar observational tool names and optional metadata do not disable unrelated work.

New provider capabilities belong behind those small adapters, not an arbitrary browser
RPC/command endpoint. Native support does not guarantee that every future provider release
will preserve its transport or that every native child exposes complete usage/history.
Current scoped checks and limits are in [Verification](VERIFICATION.md) and [Status](STATUS.md).

## Recovery contract

Use saved provider identities and model/effort/settings for native continuation (`thread/resume` for Codex).
Opening views or importing history must not start a model turn, inject a reconstructed
transcript, automatically compact, or silently create a new identity. Provider context
cache lifetime and hidden reasoning are not recoverable guarantees. The local visible
archive and host recovery evidence remain available if provider resume is unavailable.

New orchestration starts fresh. Historical imports preserve their actual provenance;
complete team indexing starts only when sciencewithagents observes the original activity.
In the checked Codex API, `thread/resume` cannot override `dynamicTools`. Existing rollouts retain their
saved tool definitions. Existing project managers receive a typed local-client fallback for
goal progress on their next admitted turn, preserving the thread, model and native tools.
`dock_inspect {}` reads the full goal and the current turn's fallback instructions; writes
require that original turn's manager lease, matching goal/revision and a durable receipt.
Do not force a new context merely to add a feature to an old thread. The optional newly documented
paginated provider history mode is not certified here; unsupported full reads/resume fail
closed rather than manufacturing recovery from list summaries.

## Where a future update goes

| Boundary                                  | Existing code                                          | Required invariant                                                                              |
| ----------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Provider process, typed result validation | `codex.ts`, `provider-host.ts`, `claude-session.ts`    | Private transport, bounded messages, owned process lifetime                                     |
| Thread/turn ownership and dynamic tools   | `runtime.ts`, `charters.ts`, `frontdesk.ts`            | Original approvals; task-scoped code work, independent review and exact policy-authorized apply |
| Native CLI and helpers                    | `native-relay.ts`, `terminal.ts`, `native-children.ts` | One input owner; no replay; retain exact parent/thread identity                                 |
| Saved provider history                    | `sessions.ts`, `history.ts`                            | Atomic bounded import; visible evidence only; truthful provenance                               |
| Another computer                          | `hosts.ts` / `ConnectHost`                             | Pinned account/host and typed routes; never copy credentials                                    |

When an update changes a boundary, generate schemas using the intended binary in an
ignored check directory. Add one focused regression and a bounded disposable real-provider
check for the changed behavior. Keep native controls available; decline unsupported forms
or transitions explicitly. Do not invent a plugin framework, duplicate scheduler, custom
credential manager or generic transport layer for hypothetical future APIs.
