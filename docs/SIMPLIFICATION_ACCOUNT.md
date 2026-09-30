# Simplification account: native agents observed by QUARK

2026-09-28. **The owner has authorized implementing this account, then continuing the full
vision with this approach.** The original audit made no runtime changes. Checked items and
linked verification will record actual implementation; unchecked items remain outstanding.

The owner corrected the direction: let native agents work, track their subagents, logs,
tool calls and usage, feed that evidence to QUARK, and use hooks to inform managers.
QUARK must independently stop work when necessary. Apply this across the application,
not only to the Claude web-search setting that exposed the problem.

The original audit found a reduced version of each provider with extra settings to restore
individual capabilities. The correction preserves the native environment with a small
observation and supervision layer. Current dispositions below replace those old defaults. Do not replace this with another general framework,
message broker, always-running model, JIRA integration or second orchestration service.

This account covers the repository's execution, scheduling, accounting, history, model
policy, editor integration, resources, UI, setup, authentication, backups and verification
subsystems. Findings below are grounded in the linked code, current docs and the earlier
independent review. It is an architectural audit, not a claim that every line or every
remaining review defect has been reverified. Unchecked items are work still needed.

## The intended arrangement

1. **Native Codex and Claude** keep their existing tools, skills, MCP servers, plugins,
   permission policy and provider-owned histories. Ordinary setup should not require
   enabling each capability again in sciencewithagents.
2. **Small provider adapters and hooks** associate native sessions, turns and children
   with a project/job. They report activity and available token counters. Tool names and
   inputs are evidence; adding a new tool should not require adding a new app feature.
3. **One QUARK decision** combines shared allowance readings, observed/estimated spending,
   reservations, priority and computer pressure. It admits, waits or stops a job and
   explains why. Model routing remains the central user-editable policy.
4. **Managers receive concise updates** at useful boundaries: admission, meaningful
   progress, approaching a cap, a pause, completion or a failure. QUARK does not spend a
   model turn on every tool event. Workers do not negotiate their own leases.
5. **The existing host supervises owned work.** It requests a native interrupt, verifies
   stopping and terminates its own job process group if needed. It preserves files,
   native identities and recorded progress. The app presents this same state on web/mobile.

Observation and enforcement are related but different. Logs can arrive late; a hook
cannot undo a completed action or stop a model request already in flight. Hook coverage
also differs by provider. Therefore a manager's willingness to stop cannot be the final
enforcement mechanism. Keep the independent supervisor and a stopping buffer. This does
not require policing every individual tool or promising an exact subscription cutoff.

An observed editor session is not automatically an app-owned process. Record whether each
job has observation, admission and stop support. Do not label an unregistered/uncontrollable
session QUARK-enforced or stop unrelated processes based on their executable name.

## Changes required

The entries record the original correction and its current disposition. Checked means
implemented or explicitly accepted with the stated limits; it does not mean every provider,
future update or physical device has been tested. Dated implementation evidence is in
[Verification](VERIFICATION.md). Provider evidence gaps stay visible in [Status](STATUS.md);
actual person/device/release handoffs stay in [Owner check-in](OWNER_CHECK_IN.md).

### Native capabilities and provider integration

- [x] **S01 — Remove the blanket Claude capability restrictions.** Implemented for native
      inheritance; saved restrictions remain deliberate compatibility behavior. This is the issue the
      owner caught. [claude-session.ts](../apps/server/src/claude-session.ts) starts Claude with
      restricted settings, disabled ordinary hooks/skills/workflows, Dock-only MCP configuration
      and role-specific builtin allowlists. It denies other tool requests, rejects unexpected
      advertised tools, and throws on native subagent messages. [managed-claude.ts](../apps/server/src/managed-claude.ts)
      rejects web, plugins and external MCP selections. Change launch/configuration to retain
      the native environment and add only the QUARK integration. Pass through native permission
      requests without inventing a separate per-tool approval policy. Preserve explicit owner
      restrictions and administrator policy. Do not implement web search, MCP or plugins one
      feature at a time as substitutes for native configuration.

- [x] **S02 — Apply the same correction to Codex.** Implemented for new/inherited contexts;
      saved restrictions require an explicit idle migration. [codex.ts](../apps/server/src/codex.ts)
      has a hard-coded disabled-feature list including hooks, browser/computer use, plugins,
      native agents and skill dependencies. It disables configured MCP servers before selected
      capabilities are restored. [mcp.ts](../apps/server/src/mcp.ts) and
      [plugins.ts](../apps/server/src/plugins.ts) rewrite server/tool/app approval policies to
      prompt, including native choices. Preserve the supported native configuration and normal
      permissions; add QUARK admission/observation without rebuilding provider configuration.
      Keep App Server's private transport and original approval identities. Native permissions
      must still apply; removing app-imposed restrictions is not bypassing permissions.

- [x] **S03 — Native project defaults with an explicit way back.** New delegations inherit
      native capabilities unless tools are explicitly requested or a saved restriction applies.
      **Tools for new workers → Use native settings** now restores that default for future
      Codex/Claude workers. Saved contexts, grants and pending receipts remain unchanged;
      old-client saves still mean restrictions. The optional Codex ceiling is retained for
      explicit requests, not expanded into a Claude permissions system. Native saves require
      no tool inventory. Manager disposition: keep the small compatibility API and advanced
      controls while existing restrictions/receipts use them; deleting them would lose owner
      choices. Shared policy, delegation, retry/restart and responsive browser checks cover
      this boundary. See [worker controls](WORKER_TOOLS.md) and VERIFICATION.md.

- [x] **S04 — Make provider observations tolerant of extensions.** Effort identifiers now
      follow native catalogs; optional Claude effort/tool metadata can be missing or extended
      without ending the session. Identity/control validation remains strict. The audit found
      exact tool lists and a closed effort list; shared [providers.ts](../packages/shared/src/providers.ts)
      also enumerates effort values. An unfamiliar native capability can become a session-wide
      failure. Validate the identity and fields needed for control, but display or skip unknown
      observational fields without disabling unrelated work. Keep tool names, model IDs and
      provider-reported effort values as extensible data. Malformed control requests must never
      become approvals. Keep version-sensitive parsing in the provider adapter; do not introduce
      a universal provider protocol. Compatibility should be reported per affected operation.

- [x] **S05 — Metadata discovery is separate from restrictive execution.** Claude uses a
      disposable native-inheriting initialization with no submitted prompt, no effort override
      and no saved conversation. Concurrent reads coalesce; central model policy caches the
      catalog. Inherited Codex launches skip plugin/MCP policy probes and approval rewrites.
      Setup checks only enabled providers, reports sign-in separately from catalog readiness
      and never launches discovery behind an unavailable account. Optional inventory failure
      does not erase history or rewrite authentication. Manager disposition: retain no-turn
      probes only for explicitly restricted legacy configurations; they enforce a saved choice,
      not the normal launch path. Keep provider-specific launch/control validation in the
      existing adapters. See [compatibility boundaries](PROVIDER_COMPATIBILITY.md).

### Managers, subagents and their evidence

- [x] **S06 — Observe native children instead of forbidding them.** Both providers retain
      native helper identities/runs in the existing owning family, including native manager
      children and resumes. Codex verifies reported parent-thread provenance. Claude lifecycle
      hooks establish session ownership; completed fresh Agent/Task results can then link a
      known callee to its hook-identified caller. Links survive restart, reject cycles/cross-
      session identities and do not change on resume. Children receive no independent budget,
      lease or invented PID. The root group remains the Claude stop boundary, with both root
      and invoking-helper navigation exposed. Manager disposition: missing/background results
      are unknown ancestry, not permission to infer parents from timing or expand collection
      into unregistered sessions. Wider catch-up stays in S07. See MANAGED_CLAUDE.md and the
      scoped protocol, persistence, stop and browser evidence in VERIFICATION.md.

- [x] **S07 — Small registered-session observation, with bounded catch-up.** Managed
      Codex events and Claude's owned hooks feed the existing Store/activity/usage records.
      Claude helper transcript paths are registered from those hooks, checked against the
      owning session and read incrementally by the existing heartbeat. Durable offsets,
      file identities and API-message receipts handle delayed/partial writes and replay.
      Hooks compose with native configuration and make no model calls. Manager disposition:
      retain the provider adapters and common stored evidence, not a universal event broker.
      Unregistered terminals/editor processes remain outside owned enforcement; the editor
      bridge preserves its own native control contract. Missing fields/logs stay partial.
      No account-wide history scan or global hook installation is needed.

- [x] **S08 — Give managers useful QUARK updates through the same integration.**
      Implemented through compact turn context, shared coordination responses and Claude’s native
      post-tool hook. Updates coalesce without idle model turns; native Codex builtin-only work
      receives its next update on coordination/managed input. Independent stopping remains active.
      [runtime.ts](../apps/server/src/runtime.ts) currently injects a large host-state snapshot
      and exposes `dock_inspect`; [agent-client.ts](../apps/server/src/agent-client.ts) gives
      outside agents cached reads and capped task requests. Keep those working pieces, but use
      one compact status summary plus meaningful change notifications for native managers too.
      Show child progress, spending estimate, remaining grant, queued work and stop reason.
      Coalesce updates; do not wake a manager for every log line or require it to poll providers.
      Keep the full evidence available on demand. A small CLI/MCP facade should call the same
      service, not duplicate accounting or start its own usage collector.

- [x] **S09 — Shorten and correct the manager/worker instructions.** The manager charter
      is 45% shorter, keeps native inspection/research and teaches one shared QUARK workflow.
      Native helper model guidance now covers both providers with on-demand catalog reads.
      The revision/automatic-turn backstops stay as bounded workflow policy, separate from caps.
      [charters.ts](../apps/server/src/charters.ts) forbids managers from planning, researching or
      inspecting code themselves and states that they have no execution tools. It also teaches
      the new per-tool allowance scheme. Keep the requested postdoc managers, preferred delegation,
      central tier choices, shared budgets and recorded decisions. Stop enforcing coordination
      by removing ordinary native capabilities. Describe a short workflow: obtain QUARK admission,
      delegate when useful, observe progress, obey holds and preserve evidence. Retain independent
      review and exact owner apply confirmation for code changes. Review inflexible revision/
      automatic-turn backstops as explicit workflow policy, rather than confusing them with quota.
      Keep bounded protection against runaway automatic work.

### QUARK admission, accounting and stopping

- [x] **S10 — One allowance decision and durable pause state.** `Quark.block` supplies
      allowance decisions to the existing Pulsar admission path, native hooks and running-work
      guard. Pacing overrides/off do not bypass explicit grants; priority/fairness, resource
      checks and background yielding remain in the existing scheduler. Holds keep a typed cause
      and stop acknowledgement for managers and the UI. Confirmed transient holds can recover
      after fresh capacity; exhausted grants, explicit pauses and invalid leases remain explicit.
      A newly verified exhausted cap now promotes a transient hold to a budget hold, preserving
      its receipt and latching the grant. Runtime/lease checks exercise admission and stopping,
      not a bypassing override path. Manager disposition: retain separate resource/pacing and
      accounting modules; do not create a second scheduler or merge unrelated transport code.
      See QUARK_ACCOUNTING.md and VERIFICATION.md.

- [x] **S11 — Signed admission is independent of tool selection.** The one host signer binds
      each manager lease to its actual run/project/provider/model, after admission and before
      managed/native input. The heartbeat renews it; managers cannot self-sign or renew through
      a tool. Hooks and coordination check that same authority. Native-inheriting tool access
      does not select or grant a lease, and helpers share the owning root rather than negotiate
      their own. Expiry, restart and uncertain native input retain a visible hold; no retroactive
      admission or input replay. Existing quark-lease tests cover stale callbacks, asynchronous
      selection, native input/compaction, independent stopping and recovery. No new signer,
      distributed lease service or per-tool permissions framework is required.

- [x] **S12 — Observed tokens first; explicit gaps instead of more estimators.** Codex
      cumulative usage and Claude live API-message input/cache counters feed the same ledger.
      Final provider totals replace partial evidence. Registered helpers retain their own
      counters and recognized completion totals/reports, excluded from inclusive root rollups.
      QUARK reconciles shared allowance deltas with weighted tokens or elapsed work, retains
      unattributed intervals/reservations and uses a stopping buffer. Manager disposition:
      accept unknown helper output/nesting when the provider supplies no reliable evidence;
      do not manufacture counters from tool counts or scan unrelated sessions. Tokens,
      estimated allowance share and account remaining are labelled separately. No validated
      2–3 percentage-point weekly accuracy or exact cutoff is claimed. See QUARK_ACCOUNTING.md.

- [x] **S13 — Owned stop and retained recovery, without a new process framework.** The
      existing Runtime records a durable hold, interrupts the original provider identity,
      retries that same stop and closes its owned group after the grace period if necessary.
      Process-group supervisors also close descendants on parent loss. They never search by
      executable name. Stop acknowledgement, retained native identity/files and uncertain-input
      receipts govern continuation. Local computation can suspend; model work interrupts and
      resumes. Manager disposition: retain the three small transport-specific hosts rather
      than abstract unlike IPC/stdio lifecycles into another service. Runtime, lease and local
      process checks exercise ownership, failed interruption and recovery.

- [x] **S14 — One shared, replaceable usage reader.** Capacity owns collection, cache,
      account affinity and durable retry cooldown. The isolated Claude adapter reads its native
      subscription and normalizes returned windows; UI, managers and outside clients consume
      that shared report. Failures expose fixed explanations and last/next checks, never raw
      credentials or response bodies. Account changes discard a report; there is no paid-API
      fallback or automatic sign-in repair. Model windows remain data. Manager disposition:
      retain the unofficial endpoint as an explicitly qualified dependency; custom profiles
      without a verified reader stay unavailable rather than reading another account. FAS
      no-weekly-limit policy remains account-specific, not a missing-meter assumption.

- [x] **S15 — Bounded cache assistance, separate from conversation survival.** The
      existing QUARK settings expose opt-in/out, estimated per-provider timers and daily refresh
      bounds. Codex expiry is unknown by default; Claude's timer is an estimate. Refreshes use
      the same queue, budget and model, exclude held/completed/external work, preserve original
      approvals and cannot dispatch tasks. Timed-out refreshes do not repeatedly wake a model.
      Manager disposition: retain the requested small bounded refresh path, without expanding
      it or claiming measured cache benefit. Providers own compaction; losing cache reuse does
      not delete history. Missing expiry never requires a separate monitoring model.

### Resources, models and saved work

- [x] **S16 — Reuse one machine sampler and associate owned process trees with jobs.**
      [capacity.ts](../apps/server/src/capacity.ts) and
      [resource-probe.ts](../apps/server/src/resource-probe.ts) both sample machine resources.
      The latter reads PPID but discards it when producing app groups; project figures remain
      reservations. Share measurements, retain owned parent/process identities and use them for
      measured job CPU/memory where possible. Mark shared-process memory/agent attribution as
      approximate. Keep memory pressure, swap rate, CPU, disk and grouped apps. The cheap watcher
      and bounded on-demand/checkpoint diagnosis in [resource-watch.ts](../apps/server/src/resource-watch.ts)
      fit the owner's request; retain them. No always-running IT model, speculative runaway
      diagnosis or automatic termination of unrelated Chrome/editor processes.

- [x] **S17 — Central model policy and extensible provider metadata.** All app-managed
      assignments use one editable tier/family/preset policy with exact pins and native choices
      preserved. Catalog-discovered effort identifiers remain strings; missing optional effort
      metadata keeps a model selectable with Provider default. Defaults refresh between turns,
      admitted work freezes its assignment, and native helper guidance reads the same policy.
      Returned helper model evidence is retained without falsely treating a requested default
      as observed execution. Manager disposition: keep protocol/window parsing in the provider
      adapter and central family matching; do not build per-feature model mappings or switch
      an existing conversation's provider. Unknown future family names need one central update.
      See MODEL_POLICY.md and the tested catalog/assignment boundaries.

- [x] **S18 — Keep native history as the source of session continuity.**
      Codex and eligible Claude retrospective discussions now support explicit native branches
      through recorded final replies, preserving original tasks/reviews and excluding inherited
      token totals. Claude requires an observed completed root boundary; older records and
      native helpers retain saved-evidence discussion. Uncertain Claude startup resumes only
      its durable target. Bounded live text-continuity checks pass against both installed
      providers with unchanged source histories. Missing/compacted and unobserved histories
      remain explicit availability limits, not a reconstructed provider memory system.
      [history.ts](../apps/server/src/history.ts), [sessions.ts](../apps/server/src/sessions.ts)
      and [interviews.ts](../apps/server/src/interviews.ts) retain the source evidence.
      Index/reference saved native sessions, subagent logs, tool evidence and worktree/checkpoint
      identity. Use supported resume/fork for the original-context experience when available;
      keep the evidence-based discussion clearly labelled when it is the fallback. Neither
      should reopen a completed task or wipe its review. Do not reconstruct an entire provider
      memory system or claim access to hidden reasoning. Keep explicit read-only restrictions
      for a deliberately read-only retrospective discussion.

- [x] **S19 — Separate generic jobs from code-integration ceremony.**
      Read-only delegation now uses existing project/task files, creating a branch only for
      implementation. Managers finish research/planning/local-job results with retained evidence;
      no automatic reviewer is required. Requested reviews, existing worktrees and code changes
      retain their gates. Active workers and paused/queued/running local jobs block completion.
      Existing native-child registration uses provider workspaces without making a second branch.
      Project registration itself is unchanged. Focused persistence and integration checks pass.
      [runtime.ts](../apps/server/src/runtime.ts), [workspaces.ts](../apps/server/src/workspaces.ts),
      [projects.ts](../apps/server/src/projects.ts) and [local-jobs.ts](../apps/server/src/local-jobs.ts)
      connect tasks, workspaces, review and local computation. Code edits need isolated work and
      reviewed changes; research/transcription/resource checks should not acquire unnecessary
      Git/reviewer stages. Register native child workspaces instead of automatically creating
      another app-owned layer for each child. Keep the original exact-preview/apply gate and
      avoid multiple writers in the same task workspace. QUARK should see one job relationship
      for each piece of work, regardless of which native mechanism started it.

### Editor, UI, setup and recovery

- [x] **S20 — Optional, contained editor compatibility dependency.** The maintained
      bridge recognizes one compatible native connection shape, preserves original bytes and
      refuses ambiguous layouts/changed files. It adds no replacement provider session. Failure
      explains that sharing is unavailable while native editing can continue. Original chat,
      send/Stop ownership and authentication remain separate from managed QUARK jobs. Manager
      disposition: retain the owner-accepted bridge with its unsupported-internals/platform
      limit; a speculative attachment rewrite would lose the requested live context. Safe
      activation, other platforms and public release remain in OWNER_CHECK_IN.md/VSCODE_MIRROR.md.
      No active editor was reloaded.

- [x] **S21 — One connected web/mobile workflow.** Home, Work, Attention, project/task
      pages and conversations use backend job/hold/evidence state, showing remaining allowance,
      measured versus estimated usage and actionable pause reasons. Native helpers link their
      observed invoker and controlling conversation. Native defaults eliminate ordinary tool
      inventories; explicit older restrictions remain in advanced controls. Exact send/save/
      approval/apply receipts and drafts are retained. Manager disposition: retain the classic
      maintenance route while its advanced controls are reused; do not create another redesign
      or remove a retained control merely to shrink code. Responsive and failure/retry evidence
      is recorded by journey in VERIFICATION.md. AI Fieldnotes awaits its requested later source.

- [x] **S22 — Provider-first setup using existing installations.** Welcome chooses
      providers before checking sign-in/catalog readiness, defaults empty installs to Codex
      only and preserves saved settings. Native sign-in remains provider-owned; no-turn discovery
      needs no optional tool inventory. Stable launcher entries and GUI paths survive routine
      upgrades; source setup supports either provider and optional-dependency failures. Project
      backup setup is in-app. Optional domain-free phone setup reuses existing pairing and the
      owned connector, with exact address confirmation. Manager disposition: source installation
      and another-computer provisioning remain setup-agent assisted, as documented; do not add
      an installer/auth broker. Physical phone/Tailscale consent, editor activation and actual
      other hosts require the person and stay explicitly unverified in OWNER_CHECK_IN.md.

- [x] **S23 — Retain scoped local access; no authentication rewrite.** Browser access
      uses one-use handoff into a standard HttpOnly session; local owner, editor and remote-host
      requests share typed authorization helpers with distinct scopes. Private installation
      files stay under the OS account, provider credentials are not copied, and hooks use their
      existing owned channel. Manager disposition: the challenge/proof boundary avoids handing
      reusable owner authority to another local listener; replacing it adds migration risk
      without removing a required trust distinction. Keep the bounded legacy-origin draft
      handoff while saved drafts may need it. Local/host/phone tests cover separation and replay;
      this is not protection against a malicious process with the same OS privileges.

- [x] **S24 — Keep backup/recovery responsibilities clear and limited.**
      Disposition: retain the existing separation, not another synchronization system.
      Recovery copies explicitly list included app records and excluded project/worktree,
      native-session, browser and credential files in RecoveryBackups.tsx and RECOVERY_COPIES.md.
      Source backups cover reviewed source only; native histories remain provider-owned.
      Exact copy/retry behavior and checked record preservation have current deployment evidence.
      Separate off-device setup/whole-machine restore remain explicitly unverified, not implied
      by a verified database copy or a private GitHub checkpoint.
      [recovery-backups.ts](../apps/server/src/recovery-backups.ts) saves app state;
      [source-backups.ts](../apps/server/src/source-backups.ts) saves configured reviewed source.
      Native session logs are a third provider-owned artifact; neither backup should pretend
      to include them automatically. Show what is covered and make existing backup setup/retry
      understandable. Prefer references and the existing private archive over copying whole
      provider profiles. Preserve optional private export, credential checks, verified copies
      and exact retries. Do not add a second sync/version-control system to solve observation.

### Verification and documentation

- [x] **S25 — Finish the validation checkpoint.** Hosted formatting, strict builds,
      backend, companion and the complete current-interface browser suite pass. The runtime/
      launcher checkpoint passed 650 backend, 76 companion and 267 browser checks, with
      platform-specific skips recorded in Verification. Queue retry and setup recovery retain
      their assertions and receipts. Native-inheritance, helper observation, budget/lease
      stopping and retained-history checks cover the corrected behavior; old restrictions are
      tested only for deliberately restricted saved contexts. Live provider/device evidence is
      distinguished from controlled fixtures. Ordinary setup does not run this whole suite.
      Generated evidence stays ignored. Repeat only checks justified by new changes/failures.

- [x] **S26 — Current instructions separate from historical evidence.** RESUME and STATUS
      identify the current continuation and acceptance limits; FEATURES/PRODUCT_STORY describe
      native capabilities, shared supervision and traceable work. OPERATIONS now labels old
      per-tool controls as optional restrictions, not defaults or manager prohibitions. The
      documentation index links the connected screens; setup uses its own reusable guide and
      AGENTS explicitly limits this owner's standing approvals to this installation. Earlier
      decisions and dated checks remain historical evidence. Manager disposition: keep one
      verification log and current status rather than repeating an obsolete backlog in each
      guide. No marketing claim of exact allowance attribution or guaranteed cache retention.

## What stays

The existing shared collector, native conversations, local evidence store, central model
policy, QUARK caps/reservations/priorities, signed manager admission, worker stop controls,
resource watcher, exact approvals, reviewed application of code, phone pairing and retry
receipts serve explicit requirements. Reuse them. A database transaction or a retained
delivery ID is not over-engineering merely because the code is detailed: it prevents duplicate
work, lost drafts or an approval reaching the wrong request.

Keep the product's requested functionality: slow continuous cross-provider work, all managers
sharing one allowance source, separate model windows, percentage budgets, native child/project
spending, resources and local transcription, configurable tiers, historical questions,
web/mobile use and the guide. Simplification must not redefine these away.

## Provider evidence and remaining uncertainties

Claude documents lifecycle hooks, subagent IDs and subagent transcript locations.
`SubagentStart` can supply context but cannot block creation; admission needs an earlier
supported gate and the supervisor. [Claude hooks](https://code.claude.com/docs/en/hooks).

Codex documents hooks and child events too, but hosted tools such as web search do not use
the local tool-hook path. Its transcript format is explicitly not stable. Consequently use
hooks plus supported provider events, with transcript parsing isolated as a fallback—not
as a complete enforcement or permanent compatibility guarantee.
[Codex hooks](https://learn.chatgpt.com/docs/hooks).

Native stop/resume details must be checked against the installed version. Current Claude
documentation distinguishes ending a turn from terminating a process and describes retained
interrupted sessions. Some older repo prose describes different behavior. Do not build
recovery around an unverified historical assumption.
[Claude programmatic execution](https://code.claude.com/docs/en/headless).

The original audit itself ran no native turns. Later dated checks in VERIFICATION include
real initialization, history continuity and editor exchange, alongside controlled child/hook/
stop checks. These do not prove every native tool or future CLI. Child counters remain excluded
from inclusive rollups, Claude stops its owning group, and editor attachment retains its
qualified compatibility dependency. None justifies removing unrelated native capabilities. Preserve the existing subscription/account
boundary; changing to an SDK or paid API is not implied by this proposal.

## Migration and evidence needed before calling it corrected

The owner has approved this order of work:

1. Establish one native-session observation and owned-stop path using the existing host/store.
2. Apply it to native Claude and Codex children; demonstrate shared accounting and supervision.
3. Remove blanket capability overrides and the normal per-tool allowance flow. Preserve
   explicit saved restrictions, account identity, sessions and pending operation receipts.
4. Feed the same observations to managers, QUARK and web/mobile; consolidate conflicting
   status/control paths. Address the other recorded simplifications without rewriting the app.
5. Migrate documentation and retire superseded code only after the retained journeys work.

Required acceptance evidence:

- A normally configured native tool/skill/MCP remains usable without a new app checkbox.
- An unfamiliar tool name or optional event does not break the provider or model picker.
- Codex and Claude native child work appears under the right parent/task/project; duplicates,
  resumes and delayed events do not double-charge or create a second child.
- Concurrent projects share one measured allowance source and one set of reservations.
- A manager receives useful progress/cap updates without a model turn per tool event.
- Reaching a cap stops the owned work even with an unresponsive manager, with a recorded
  interruption result and no deletion of histories or files. Overshoot remains honestly bounded
  by observation/stop latency, not claimed to be exactly zero.
- Restart/sleep, collector failure, log gaps and unavailable child controls have explicit
  recovery states. Unrelated processes and unregistered editor sessions are not killed.
- Native permission decisions, exact review/apply, drafts, paired devices and saved model pins
  survive the migration. A new tool default does not silently override an explicit owner deny.
- Web/mobile show the same job tree, spending basis and pause reason; first-run explains how
  native integration is connected without requiring the user to configure each tool.

Use focused behavior checks while implementing and broader checks at checkpoints. Preserve
the existing authorization boundaries for accounts, external actions and native permissions.
