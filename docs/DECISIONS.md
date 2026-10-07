# Design decisions

Current decisions, consolidated 2026-10-01. Implementation gaps belong in [Status](STATUS.md),
not in another build plan. Detailed interface requirements are in [Design](DESIGN.md).

## Native agents, thin supervision

Codex and Claude retain their native tools, skills, hooks, configured integrations and
explicit choices. QUARK observes logs, tool activity, helper identities and usage; host
hooks supervise admission and stopping. Avoid a second scheduler, external Jira dependency,
generic RPC gateway or tool-by-tool reimplementation of either provider.

Use supported native unattended permissions. Native writing roles use the provider's documented
full access (Claude `bypassPermissions`, Codex `danger-full-access` + `never`); the project or
worktree is the intended scope, not containment. Read-only and saved restricted roles remain restricted.
Routine unsupported operations should fail visibly rather than wait indefinitely for approval.
Real account sign-in, human questions and external policy requirements remain meaningful.
External MCP services are not made safe by a filesystem prompt instruction.

## Groups v1: shared chats, native local agents

New group creators host the group service in their own Cloudflare account. The app supplies
copyable setup-agent prompts and a short human checklist; the agent handles deployment and
private configuration. Joining members connect to that creator's service by invitation.
No maintainer-issued beta code or automatic maintainer endpoint is part of new setup.
Existing service records and groups remain intact. GitHub is optional for code sharing.
Phone/browser-only laptop setup uses the owner's Workers Free account and a stable free
`workers.dev` address. One HTTP VPC Service fixes the only destination to the paired listener
at `127.0.0.1:4331` through the app-owned named tunnel. The Worker preserves the public host,
same-origin authentication, streaming responses and WebSocket upgrades. No whole-network
binding, domain purchase or phone VPN is part of new onboarding. Existing connections,
including domain routes, are preserved. Groups hosting stays independent.

Groups lives in **Chats → Groups**, with the ordinary list and conversation layout. Group chat
shows shared messages from all members; Group manager directs this member’s own agent in
the shared context. Setup, invitations and management are compact dialogs. The private-chat
and catch-up controls are removed from this journey; their saved records retain private
identities and are never republished or reassigned to the shared context.

Each member uses their own computer, provider account and native tools. Group agents run
through the ordinary local runtime and QUARK. Shared and private conversations have distinct
persisted identities, native sessions, drafts and publication destinations. Personal chat
history is not imported into either one. Only shared content enters the group feed; private
asides and local files require explicit sharing.

The owner enables local group agents once. Incoming group messages provide context; they
do not authorize work on another member’s computer. Ask uses native read-only permissions;
Work is an explicit local-owner instruction using normal native writing permissions.
These are conversation and authority boundaries, not an operating-system sandbox around
files, credentials, hardware or network access. Normal macOS tools remain available.

Linux isolation is not a Groups v1 prerequisite. Existing isolated records remain retained
and are never silently resumed as host-native work. A new host-native request receives a
separate durable execution identity. The hosted service, membership and delivery protocols
are reused; unrelated public setup and provider accounts are never copied between members.

## Durable project work

Managers coordinate small assignments, with high-level plan review and atomic implementation
reviews. Two correction rounds are the default bound. Then the manager records a disposition,
or pauses that item for human input. One decision policy covers this and unclear details;
existing requests to ask the owner are preserved. Do not force a giant plan through endless
review. Research can finish with evidence without manufacturing a code branch or merge.

Managers apply independently reviewed code by default, validating the exact reviewed source
and target. An optional human-review policy waits for confirmation instead. Workers use
isolated worktrees; closing obsolete tasks preserves evidence and is not a fabricated approval.

Notes belong to the owner. Managers can read them for context but cannot write or overwrite
them. Each manager keeps durable internal work, human action items, decisions and checkpoints.
Human summaries are one or two readable lines. One blocked item does not stop independent
work. Claude uses native 60% compaction with saved handoffs; Codex manages its context naturally.
Steering and adjacent questions add to the outstanding work unless the owner explicitly
cancels or replaces it. Handoffs preserve item IDs, assignees, next actions and evidence;
checkpoints and completion reports reconcile earlier open requests, including triaged items.

App-owned Codex and Claude manager goals are explicit opt-in, with durable objective and
progress. Continuations are ordinary queued turns under existing QUARK admission, reserves
and hourly/window limits, never a native automatic-goal bypass or a second scheduler.
Unchanged progress waits without model polling. Completion reconciles the manager's scoped
requests, work items, tasks and active/pending helpers. Pause holds queued goal work; Stop
cancels only unstarted goal work without claiming completion or interrupting an active reply.
Existing managers are not automatically enrolled; shared native Codex goals remain separate.

## Shared budgets and computer capacity

QUARK shares account/model windows across projects on the same computer, including independently reported model
allowances. Do not invent a weekly window for accounts that do not report one. Store expected
cost/time/resources and compare them with actual evidence. Expose estimated attribution honestly;
no validated 2–3% error bound or exact provider-enforced token ceiling is claimed.

One entry app can manage multiple worker computers with separate provider accounts. Each
computer keeps its own QUARK queue, allowance budgets and reservations; linking computers
does not pool their accounts or budgets. This separation is intentional, not a missing global
budget coordinator. A phone or laptop can be a browser client of the entry computer without
running jobs or having a separate provider sign-in.

Managers need host-signed leases before orchestration. Workers share admission and independent
supervision without managing lease renewal themselves. Forecast overruns notify managers;
only authorized owner choices can increase caps or reduce reserves. Hard guards retain files
and histories while stopping owned work. Bounded grace is not unlimited overspend.

Use a conversation plus a simple status board. Primary controls are separate provider
remaining reserves and saved per-project hourly rates, with current estimates and 12-hour
observed history; cumulative allowance caps remain secondary. Zero hourly rates pause only
the selected provider. Ordinary work stays uncapped until an owner sets a rate.

Provider reserve baselines default to 20% for new settings; migrate an existing saved global
reserve into both providers without lowering it. Only explicit owner controls change them.
Optional timed release is off by default, with thresholds of 12 hours for Codex and 45 minutes
for Claude. It lowers each actual reported window's effective reserve to zero only inside that
window's fresh future reset interval; it never invents a refill or weekly meter. New empty
installations start with QUARK pacing and automatic checks off; enabling protection uses 20% reserve baselines. Existing saved settings and off
choices are preserved; an owner explicitly enables protection when it is off.
Spending toward a reset uses the bounded fast-window admission
[pace](QUARK.md#adaptive-window-pace), not a separate finish-before-reset controller.

Detailed accounting remains queryable by agents. QUARK forecasts five-hour capacity and sends
advisory coordinator wakeups; using spare allowance stays agent-led, without guaranteed window
use or forced provider switches. An owner can opt into maximizing useful Claude five-hour
work: eligible background jobs use available headroom without gradual release, while
foreground priority, provider/model choices, hourly/window caps, pauses and reserves remain.
Context-cache warming is off and deferred; do not send keepalive prompts as routine behavior.

Routine work uses shared headroom without a mandatory per-task budget ceremony. Raw-token
counts (including cache reads) are estimates/accounting only, not admission limits. Explicit
provider allowance caps, remaining reserves, resource guards and owner pauses still apply.

## QUARK demand and window pace

Automatic coordinator turns and notices need material, unfinished, authorized work that a
model could affect. QUARK's own notices, owner-blocked work and clock time are not demand.
Adaptive pace is per reported window, weighted by project, and gates admission only while
that window runs fast. Idle projects can start one turn, so the pace cannot deadlock startup.
It never writes caps, switches providers or creates work. Explicit owner caps remain
authoritative. [QUARK](QUARK.md#adaptive-window-pace)

## Slurm clusters

A connected cluster is observed, not governed. QUARK shares one cached reading of native
queue, fairshare, limits and accounting; it adds no cluster limits or submission gate.
Managers use the owner's native SSH account for files and jobs under the site's own rules.
The app never chooses an account, stores passwords or codes, or equates fairshare or cluster
resources with AI allowance.

## Models and customization

One central policy supplies all app-managed launches. Manager selection is independent of
worker provider mix and Light/Default/Tokenmax spending. Global preferences seed project
snapshots; changing them does not silently rewrite existing projects. Defaults resolve the
latest available family version, while explicit version/reasoning pins remain exact.

The corrected recommendations and role floors live in [Model policy](MODEL_POLICY.md).
Users can restore recommendations or choose any supported catalog model. New family names
need a central mapping change, not edits in each feature. Imported/native sessions stay native.
Updates to locally customized installations are agent-assisted, preserving local work and data.

New-project Spawn creates an independent project/manager identity, including when a folder was
used before. A folder is not a conversation identity: projects can share its files while retaining
separate settings and history. Existing-folder connection receipts preserve one result per setup
through retries. Manager removal is archival: stop active work first, cancel its queued work,
retain files and evidence, and reject later launches. Continuing old work is an explicit chat choice.

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

## Future dark interface: research only

Researched 2026-10-05. **Recommendation, not an implemented redesign:** keep React, Vite,
the existing host/API boundaries and screen proportions. Build one small, shared component
layer with **React Aria Components** and ordinary CSS variables for the future dark-only
palette, type, spacing and focus states. Replace interaction primitives incrementally rather
than rewrite QUARK, chats, pairing, drafts or the backend. This choice is an engineering
judgment based on the existing code and the libraries' documented capabilities.

| Free option           | Fit for this app                                                                                                                                                                                                                                              | Recommendation                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| React Aria Components | Unstyled controls with touch, keyboard, focus and selection behavior; suitable for model pickers, dialogs, tabs and sliders. [Documentation](https://react-aria.adobe.com/), [Apache-2.0 license](https://github.com/adobe/react-spectrum/blob/main/LICENSE). | Preferred behavior layer; retain our own compact styling.                                                           |
| Radix Primitives      | Accessible, unstyled controls that can be adopted gradually. [Documentation](https://www.radix-ui.com/primitives/docs/overview/introduction), [MIT license](https://github.com/radix-ui/primitives/blob/main/LICENSE).                                        | Credible alternative if the first mobile prototype works better; choose one primary library.                        |
| shadcn/ui             | Editable component source and ready-made visual conventions. [Documentation](https://ui.shadcn.com/docs), [MIT license](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md).                                                                                | Useful visual reference, but copied components still need maintenance and do not solve viewport bugs by themselves. |

A desktop wrapper is a separate packaging decision. Tauri uses system WebViews, including
WKWebView on macOS; it still renders the web interface and needs platform checks. Keep the
browser/PWA route first. Consider a wrapper later only for a concrete native requirement,
not as a keyboard or layout repair. [Tauri process model](https://v2.tauri.app/concept/process-model/),
[WebView versions](https://v2.tauri.app/reference/webview-versions/).

The main reliability work is consistent ownership of scrolling, viewport height and focus.
The on-screen keyboard and pinch zoom can change the visual viewport independently of page
layout. A new UI library cannot remove that distinction. Keep one chat scroller, an anchored
composer, one full-height notepad scroller, safe-area spacing and stable status-line space.
Preserve readable input text and user zoom; avoid competing body-scroll locks and autofocus
on navigation. [VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport).

Before adopting the proposed library, prototype only a chat/notepad, a model picker and a
queued-message editor with the existing API and saved-draft logic. Require keyboard dismissal,
Back, selection, file upload, reload and scroll restoration to work at all four supported
layouts and large text/zoom. Compare bundle/render costs with the present build. Reuse the
resulting components across manager, QUARK and resource conversations only after that slice
passes. The dark palette and aesthetic changes require the next design task.

Playwright already checks typing, focus, viewport changes and touch layouts in Chromium and
WebKit. It emulates browser/device properties; it is not a physical iPhone keyboard. Keep
real iPhone Safari and Home Screen checks for keyboard open/close, swipe navigation and
orientation changes. [Playwright emulation](https://playwright.dev/docs/emulation),
[device acceptance](PHONE_ACCEPTANCE.md).
