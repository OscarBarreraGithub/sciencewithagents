# Providers, model choices and routing

Codex and Claude can manage projects or implement and review tasks on the same computer.
The app uses that computer's existing native accounts. New installations can use either
provider alone. [Model policy](MODEL_POLICY.md) and the selected project's saved workflow
are the current source of routing defaults.

## Manager and worker choices

Choose the manager's provider, live model and thinking level separately when creating a
project. Worker provider mix (Codex only through Claude only) and spending level (Light,
Default or Tokenmax) select central family defaults for research/coding, review and bulk
work. Exact model overrides remain available. Codex-heavy favors Codex research/coding
with Claude review; Claude-heavy reverses those roles. The full matrix is in
[model policy](MODEL_POLICY.md). No default assigns Haiku; a user can explicitly select any
supported model. Changing worker choices does not switch an existing manager.

Managed agents receive their saved workflow and effective worker-family choices in each
host-state handoff. Managers normally omit provider/model overrides in `dock_delegate`
so the host follows those choices. `execution.taskClass` distinguishes routine, bulk,
reasoning, calculation and orchestration; the reviewer role selects the review default.
Routine checks and difficult calculation/orchestration retain their central policies.
Older projects without a saved project workflow follow their workspace policy. Under its
Pick as I go preset, the manager honors the owner's choice or chooses available fresh
QUARK headroom and records why. It waits if neither provider fits.

Family defaults resolve against the installed live catalogs. `dock_inspect` with
`models: true` and optional `provider` returns real model IDs and supported effort choices.
Explicit pins are preserved. Unavailable models fail visibly before worker creation;
no silent downgrade, account switch or paid API fallback is implied.

## Native capabilities and project work

The existing runtime owns the queue, task workspaces, delivery receipts and archive.
Native Codex and Claude tools, skills, connections and helpers remain available under
native permissions; QUARK observes and supervises them. Saved restricted contexts stay
restricted until explicitly changed. See [worker tools](WORKER_TOOLS.md) for those controls
and [managed Claude](MANAGED_CLAUDE.md) for provider-specific limits.

Managers coordinate bounded work, retain internal and human action items and continue
independent work when one item needs input. Workers implement in isolated task workspaces;
independent reviews cover atomic changes. After two correction rounds the manager records
a disposition or asks the person according to project policy. Managers preview and apply
reviewed changes by default. The human-review option leaves application to the owner.

Cross-provider delegation transfers the task and recorded evidence; it does not clone
hidden native context. A saved conversation keeps its provider and native identity.
Opening history starts no model turn. Claude restores an inert handle after restart and
continues through its native session when work is explicitly resumed. Interrupted side
effects are inspected before retrying. Helpers retain available transcripts and usage;
missing output breakdowns and exact nested ancestry remain explicit limits.

Each computer keeps its own accounts, files and histories. Setup never copies provider
credentials or another installation's runtime. Claude uses the native subscription path;
conflicting API-key/provider overrides are reported instead of silently buying API usage.
Native account and operating-system consent still belong to the person. Broad reads,
network access and scoped writes use provider controls, not a tool-by-tool substitute or
a promise to contain arbitrary external MCP services.

## Usage and supervision

One shared collector reads provider-reported allowance windows, reset times and freshness.
Managers, QUARK and the phone read that same cache. Fable has a separate window when the
account reports one; missing weekly windows are not invented. Unknown or stale usage is
never shown as unused allowance.

QUARK supplies signed manager leases, admission reservations, project/task allowance caps,
priority, resource checks and durable pauses. It preserves files, history and queued input.
Subscription shares are estimates derived from provider changes and measured work, not a
validated token-to-price conversion or a promise of 2–3 percentage-point accuracy. Only the
owner can increase a saved allowance cap. Automatic cache-refresh turns are disabled; no cache retention guarantee is made. See [QUARK accounting](QUARK_ACCOUNTING.md).

## Evidence and limits

A real mixed team completed Claude manager → Codex implementer → independent Claude review;
restart retained identities and histories. Native scoped-read/write/network checks and
editor steering/queue checks are recorded in [Verification](VERIFICATION.md). These do not
certify every future provider release, external integration or physical phone. The
[compatibility boundary](PROVIDER_COMPATIBILITY.md) and [current status](STATUS.md) distinguish
source behavior from device acceptance. Shared editor sessions keep native controls in
VS Code and need no separate editor authentication.
