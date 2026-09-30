# sciencewithagents: owner's complete brief and acceptance checklist

Captured 2026-09-24. This is a requirements ledger, not a claim of completion.
Checked boxes require the evidence noted alongside them. Earlier deferred scope is
superseded only where this brief explicitly requests it. Runtime/private account evidence
belongs under ignored `data/`, never here.

## 2026-09-29 addition: manager continuity and human action items

Requested behavior below is not implemented merely because tasks, checkpoints and the
existing Attention view are present. This is a focused requirements record, not a new
implementation plan or an instruction to begin unattended work.

- [ ] Every manager maintains a durable, current work list while its goal is unfinished:
      completed and running work, next actions, dependencies, blockers and the responsible
      agent. Save it outside the model's working context and restore it after compaction,
      reconnect or restart. Update it as work, decisions and results change.
- [ ] Separate the manager's internal work from items that actually need the person:
      decisions, missing information, access or an explicit approval. Routine progress,
      recoverable internal failures and waiting on another worker do not automatically
      become requests for human intervention.
- [ ] A human-blocked item blocks only its dependent work. Continue other authorized,
      unblocked items within QUARK's limits. Pause the whole goal only when all useful
      work is blocked or the person requests it; do not spend turns polling for an answer.
- [ ] Each human item has a one- or two-line plain-English summary explaining what is
      needed and why. Keep project context and a direct route to answer/approve. Technical
      evidence is available in detail, not required to understand the request; no commit
      references or internal identifiers in the short summary.
- [ ] Show these outstanding human items prominently on first opening/Home. Keep the
      original request and response linked, remove resolved items and avoid duplicate asks
      after compaction or reconnect. Preserve native approval and answer semantics.
- [ ] Across app-managed Claude agents, trigger context maintenance at **60% of the
      context window used**. This is not a subscription allowance or cache-expiry threshold.
- [ ] Before Claude compaction, have the same agent write a durable handoff to itself:
      goal, constraints, decisions, evidence locations, completed/running work, internal
      next steps, outstanding human requests, dependencies, budget/hold state and uncertain
      actions. Confirm that it is saved before requesting native compaction.
- [ ] After compaction, restore the handoff with explicit continuation instructions: read
      current host state, reconcile in-flight work, continue the next unblocked item, retain
      spending limits and approvals, and do not repeat completed or uncertain actions or
      re-ask already answered questions. Keep the same agent's identity and work records.
- [ ] Use reliable current context-window telemetry and native compaction support. Do not
      infer context fullness from cumulative subscription tokens or create a fresh identity
      as a hidden substitute. Missing telemetry or an unconfirmed compaction stays visible.
      External/editor Claude sessions need their own supported integration before coverage
      can be claimed; do not silently change unrelated native configuration.
- [ ] Leave Codex's natural context management in place; apply no new 60% rule to Codex.
      Both providers use the durable manager plan and human-action continuity requirements.
- [ ] Explain the working list, human-action inbox and provider-specific compaction behavior
      in the guide, clearly labelled as planned until the complete flow is verified.

## Sharing, identity and the story

- [x] Rename the public-facing product from Agent Dock to **sciencewithagents** without losing existing installations, pairing, history or integration identifiers.
- [x] Maintain a comprehensive, nontechnical functionality inventory for a future website promoting the GitHub repository; create the file now, do not publish a website or the repository.
- [x] Explain VS Code sharing, provider integration, manager/worker delegation, native subagents and how the team is populated.
- [x] Give special prominence to retained worker identity, assignments, work, decisions and checkpoints: return to the original available conversation to ask why it made a decision; explain archived evidence and unavailable-context limits honestly, without promising hidden-reasoning recovery or an exact historic model snapshot.
- [x] Give the agentic scheduler an acronym: **QUARK — Queued Usage, Agent Routing Kernel** (chosen by the owner on 2026-09-25).
- [x] Keep a visible naming TODO for the WhatsApp-style conversation app, distinct from sciencewithagents and QUARK.

## 2026-09-27 addition: manager leases

- [x] QUARK signs a short-lived per-turn manager lease before managed provider input; only its host heartbeat renews it.
- [x] Gate orchestration tools on the original lease, including after asynchronous preparation; reject tampering, expiry, stale turns and old-host leases.
- [x] Workers do not manage lease protocols; existing independent admission and quota monitoring continue while managers are idle.
- [x] Managers can pause owned workers; retain files, history, unsent input, durable reasons and exact retry receipts. Host retries failed stops.
- [x] Document native-session scope and saved Codex tool-catalog limitations rather than silently replacing conversations.

## 2026-09-27 addition: automatic accounting and guarded spending

- [x] Automatically retain per-run counters and agent/project rollups, separating native overlap and missing data.
- [x] Estimate project allowance shares across concurrent work; keep gaps/unexplained usage visible and adapt model weights when identifiable.
- [x] Owner-facing project/task percentage grants; managers may create/tighten owned task grants, never expand them.
- [x] Inherit task caps through descendants and associated reports; project caps cover general manager overhead.
- [x] Enforce at admission and interrupt active owned provider groups; retain unsent input, files, conversations and durable holds.
- [x] Explicit same-context continuation, fresh-capacity checks, no reset-based grant renewal, no ordinary override bypass.
- [x] Estimated cache countdowns, configured Claude lifetime and unknown-by-default Codex expiry.
- [x] Bounded same-model refreshes for eligible workers and managers of unfinished work, under quota and resource controls; no quota-pause keepalive bypass.
- [x] Working phone/desktop controls and promotional inventory, with explicit accuracy/provider limits.
- [ ] Validate a 2–3 percentage-point weekly attribution error bound against independent ground truth; not claimed by this implementation.
- [ ] Authoritative provider cache-expiry telemetry and guaranteed retention; not exposed by current adapters.

See [accounting controls and boundaries](QUARK_ACCOUNTING.md) and [verification](VERIFICATION.md).

## Shared usage, both providers, independent allowances

- [x] Codex managers can delegate real bounded work to Claude workers, with existing review and approval protections.
- [x] Codex managers can inspect Claude subscription usage; Claude managers can inspect Codex subscription usage.
- [x] Poll regularly from one host-owned collector, share one cached source with every manager and browser, coalesce concurrent refresh requests; do not launch a terminal/poll per agent.
- [x] Display usage prominently on initial app opening, including the phone layout, with reset times, observation freshness, failures and retry.
- [x] Research CodexBar reuse/fork/bundling and choose an approach that can replace the owner's need to keep its menu-bar app running; document provenance/license, installation and maintenance.
- [x] Keep provider subscription percentages/windows separate from conversation tokens, estimates and monetary cost.
- [x] Represent Harvard FAS's owner-reported five-hour recurring allowance and no weekly cap as account-specific policy; verify the live report, never silently infer unlimited allowance from missing data.
- [x] Temper Claude dispatch because five-hour capacity can disappear quickly, while allowing useful slow continuous work across resets.
- [x] Report Fable separately, including any reported five-hour/weekly windows; clarify the owner’s assumption of independent capacity, whether it is a model or account/profile, and bind it to the actual report. Verified: Fable is a scoped model window; this account reports Fable weekly, no separate Fable session. Both general and model limits apply.
- [x] Astra and other managers receive this capability automatically through installed role instructions/tools; retain exact model identity and do not guess aliases.

## Central agentic scheduling

- [x] Conversation above a responsive status-column board; save owner instructions and project priority weights.
- [x] Central configurable Opus coordinator outside project workspaces; bounded, durable event-driven wakes.
- [x] Owner-message-only project allowance/reserve edits; automatic checks cannot spend beyond them.
- [x] Project-wide pause/resume and manager timing examples using the existing runtime and accounting.
- [x] Usage-card refresh, connection checks and supported native-installer updates with app-job admission coordination.
- [ ] Verify the latest requested scoped/unattended native permission policy for both providers; do not claim blanket containment.

- [x] Extend one durable central queue for all managed jobs across projects/managers/providers; avoid competing manager-local quota decisions.
- [x] Decide whether an external tracker such as Jira helps; keep tracking usable inside the app without requiring a new service.
- [x] Each development task/branch has a priority, crude expected tokens, expected compute/duration and an optional monetary estimate with its basis; compare estimates with measured outcomes where available.
- [x] Add task/development token budgets, reservations and admission accounting so simultaneous managers cannot each spend the same capacity.
- [x] Sort by priority, preserve fair access across managers, and run low-priority background work only when it will not crowd out active work.
- [x] Reserve headroom for owner-interactive requests and active managers; queued background jobs yield and slow work can wait for refreshed capacity.
- [x] Allow managers to set priority/budgets for subtasks of a larger goal; let the owner specify/override priority in the normal UI.
- [x] Show why each job is waiting, its estimate/expected completion or an explicit unknown, and pause/resume/cancel controls appropriate to its lifecycle.
- [x] Never claim every process is safely suspendable: explicitly model resumable local processes versus cooperative agent turn boundaries and non-preemptible work.
- [x] Preserve delivery receipts, original approvals, single task writer and exact reviewed-change confirmation; never replay uncertain interrupted effects.

## Finite local compute and the transcription example

- [x] Observe actual machine CPU/memory/disk capacity and external background pressure, timestamp it and expose it in app/manager scheduling views.
- [x] Reserve resources for admitted owned jobs and include local compute workloads alongside provider-backed jobs.
- [x] Support the example journey of an owner requesting a YouTube/video transcription using local Whisper: select urgency, queue/run visibly, return a transcript, show failure/retry.
- [x] A transcription requested by a manager as part of a larger task follows its assigned priority/budget; a direct owner request should have a quick interactive default.
- [x] Implement safe pause/resume or explain/estimate waiting for non-preemptible operations; let the owner override resource scheduling without bypassing security/approval gates.
- [x] Do not kill or suspend unrelated computer processes to make capacity; only control explicitly owned workloads.

## Completion and polish

- [x] Exercise real cross-provider handoff and slow continuous admission over capacity/reset changes; preserve existing account sign-ins and sessions.
- [x] Test meaningful queue persistence/restart, quota reservations, priority/fairness, stale/error data, cancellation and local job recovery.
- [x] Verify first-run, failure/retry and ordinary workflows at desktop, 412×915, 360×800 and 915×412.
- [x] Update feature/status/decision/setup/resume documentation and the nontechnical inventory; label implemented, verified, estimated and device/account limitations precisely.
- [x] Make small source checkpoints, preserve private runtime and unrelated changes, close owned test processes, and deploy the reviewed update through the authorized app lifecycle when safe.
- [x] Report completion only when the checklist's required behavior works; carry unresolved requirements forward explicitly rather than redefine the request.

## Completion — 2026-09-24

All required checklist behavior is implemented and verified. Strict builds, 415 backend and
81 extension tests pass; 332 browser checks passed across all four layouts, followed by 20
focused checks after final navigation polish. Real Codex→Claude→Codex work and real public
YouTube→Whisper output are retained privately. The owner’s updated app runs with QUARK
and the account-bound Harvard FAS note enabled; histories, drafts and phone trust survived
the rollout unchanged. Source is privately backed up, and owned test processes are closed.
See QUARK.md for controls/limits and VERIFICATION.md for exact receipts.

## Evidence and interpretation

The live account currently reports general five-hour usage, no general weekly window and
Fable weekly. “Independent” means a distinct reported meter, not extra pooled capacity;
Anthropic documents overlapping normal use. No Fable five-hour meter is fabricated.
The owner’s unlimited-general-weekly statement applies only to their identified account.

The real handoff retained the worktree, worker identity, checkpoint, exact review and
manager report. Its first verification script incorrectly scoped Claude usage to the
Codex manager; the corrected project-wide, read-only follow-up passed without new turns.
A real task exceeded its crude budget and waited; raising that disposable task budget
released review. Source/physical-device claims remain separate from this evidence.

“Every process” is implemented as all app-managed agent groups and the registered local
transcription workload. Unrelated OS/editor jobs consume observed capacity but are not
suspended. Agent work has original stop controls and cooperative turn boundaries; owned
local processes have real pause/resume. No hardware isolation or guaranteed ETA is claimed.
