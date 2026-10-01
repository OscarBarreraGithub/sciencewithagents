# Design decisions

Current decisions, consolidated 2026-10-01. Implementation gaps belong in [Status](STATUS.md),
not in another build plan. Detailed interface requirements are in [Design](DESIGN.md).

## Native agents, thin supervision

Codex and Claude retain their native tools, skills, hooks, configured integrations and
explicit choices. QUARK observes logs, tool activity, helper identities and usage; host
hooks supervise admission and stopping. Avoid a second scheduler, external Jira dependency,
generic RPC gateway or tool-by-tool reimplementation of either provider.

Use supported native unattended permissions: broad reads/network access, with writes scoped
to the project/worktree where the provider supports it. Read-only roles remain restricted.
Routine unsupported operations should fail visibly rather than wait indefinitely for approval.
Real account sign-in, human questions and external policy requirements remain meaningful.
External MCP services are not made safe by a filesystem prompt instruction.

## Durable project work

Managers coordinate small assignments, with high-level plan review and atomic implementation
reviews. Two correction rounds are the default bound. Then the manager records a disposition,
or the project can require stopping for human input. Do not force a giant plan through endless
review. Research can finish with evidence without manufacturing a code branch or merge.

Managers apply independently reviewed code by default, validating the exact reviewed source
and target. An optional human-review policy waits for confirmation instead. Workers use
isolated worktrees; closing obsolete tasks preserves evidence and is not a fabricated approval.

Each manager keeps durable internal work, human action items, decisions and checkpoints.
Human summaries are one or two readable lines. One blocked item does not stop independent
work. Claude uses native 60% compaction with saved handoffs; Codex manages its context naturally.

## Shared budgets and computer capacity

QUARK shares account/model windows across projects, including independently reported model
allowances. Do not invent a weekly window for accounts that do not report one. Store expected
cost/time/resources and compare them with actual evidence. Expose estimated attribution honestly;
no validated 2–3% error bound or exact provider-enforced token ceiling is claimed.

Managers need host-signed leases before orchestration. Workers share admission and independent
supervision without managing lease renewal themselves. Forecast overruns notify managers;
only authorized owner choices can increase caps or reduce reserves. Hard guards retain files
and histories while stopping owned work. Bounded grace is not unlimited overspend.

Use a conversation plus a simple status board, with project/task budget sliders and priorities.
Detailed accounting remains queryable by agents. Automatic five-hour utilization is unfinished.
Context-cache warming is off and deferred; do not send keepalive prompts as routine behavior.

## Models and customization

One central policy supplies all app-managed launches. Manager selection is independent of
worker provider mix and Light/Default/Tokenmax spending. Global preferences seed project
snapshots; changing them does not silently rewrite existing projects. Defaults resolve the
latest available family version, while explicit version/reasoning pins remain exact.

The corrected recommendations and role floors live in [Model policy](MODEL_POLICY.md).
Users can restore recommendations or choose any supported catalog model. New family names
need a central mapping change, not edits in each feature. Imported/native sessions stay native.
Updates to locally customized installations are agent-assisted, preserving local work and data.

## Conversations and phone use

Home prioritizes Chats, Apps and QUARK. Phone chat uses a compact header, message bubbles,
grouped tools and a usable expanding composer. The full-page notepad shares its draft with
chat, autosaves versions, and can minimize without sending. Native steering/queueing support
must be described accurately; uncertain sends retain their original receipt.

Separate personal/editor chats from app-created helper/resource contexts using provenance,
not guessed names. Do not erase native history to hide helpers. Eligible finished workers
can be consulted through a separate discussion without reopening their assignment or review.

The VS Code control belongs at the top of Chats and opens setup status/instructions. It does
not open another chat list. There is no separate editor authentication. Native producer access
is loopback-only; authenticated browser/phone consumption remains protected.

Phone pairing uses a temporary invitation, passkey creation and exact computer confirmation.
There is no app lock or repeated unlock prompt. Turning access off blocks it temporarily;
Remove device revokes approval. Browser data loss or a changed trusted origin can need pairing
again. The app is not protection against physical access to an approved device.

## Packaging and public presentation

sciencewithagents is the product; QUARK is **Queued Usage, Agent Routing Kernel**.
The shared branding asset is the drawn alien. A Mac Applications launcher opens the local
browser app; optional background launch requires the person's choice. Keep private data outside
Git and authenticate the private phone entry rather than exposing the local development port.

The source uses MIT. sciencewithagents.com currently redirects to the public repository;
the short README is the landing page. Dedicated website design, news and a personal-agent
Home destination are deferred. Keep only the redirect/link fallback and existing direct graph
routes in the deployment; the old design remains in Git history. Never publish private prompts,
drawings, deployment receipts or device history.
