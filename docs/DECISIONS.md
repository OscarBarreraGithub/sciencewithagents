# Design decisions

Current decisions, updated 2026-10-09. Implementation gaps belong in [Status](STATUS.md),
not in another build plan. Detailed interface requirements are in [Design](DESIGN.md).

## Groups alongside ordinary Claude Code

The 2026-10-12 owner direction keeps full SWA and makes Groups available to an existing
Claude Code conversation through an optional plugin/MCP adapter. This path has no Dock
manager or QUARK admission dependency. The person explicitly selects one native conversation
per group; additive hooks persist that choice through compaction and queue new prompts/final
replies for a separate central-policy bulk model. Other conversations/subagents do not share.
Human messaging and transport remain model-free. Automatic summaries use allowance, have
bounded input/queues and retain exact delivery identities. The existing app-managed group
agent remains available for retained work. See [Claude Groups](GROUPS_CLAUDE.md) for current limits.
Stopping sharing does not prove external work has closed. Checkout mutation waits for an
append-only owner closure confirmation of that stopped selection in the authenticated app;
native agents cannot supply this authority. Selecting a conversation again reapplies the hold.
Ordinary-Claude file sharing uses committed-SHA proposals and an authenticated owner preview,
independent of app Work receipts. Approved immutable remote refs can publish during external
activity because they change no native checkout; incoming checkout mutation keeps its closure,
clean/idle and fast-forward guards. Stale selections/folders/remotes need fresh review.

## Native agents, thin supervision

Codex and Claude retain their native tools, skills, hooks, configured integrations and
explicit choices. QUARK observes logs, tool activity, helper identities and usage. Managed
project hooks supervise admission and stopping; native direct work keeps owner controls
and provider permissions. Avoid a second scheduler, external Jira dependency,
generic RPC gateway or tool-by-tool reimplementation of either provider.

Advanced managed writing roles use supported unattended permissions (Claude
`bypassPermissions`, Codex `danger-full-access` + `never`). Direct conversations and native
folder launches preserve provider configuration and permission prompts. The project or
worktree is the intended scope, not containment. Read-only and saved restricted roles remain restricted.
Routine unsupported operations should fail visibly rather than wait indefinitely for approval.
Real account sign-in, human questions and external policy requirements remain meaningful.
External MCP services are not made safe by a filesystem prompt instruction.

### Direct conversations and connected terminals

The owner requested native-first operation on 2026-10-09. Fresh personal conversations
use direct execution: native tools, configuration and explicit permission choices,
without a Dock manager charter, coordination catalog, lease or QUARK admission hook.
QUARK is advisory for this path; explicit owner Stop, held requests and native quota
observation remain. Central model policy still applies to new app-managed launches.
Save the execution mode with the original conversation and use it during recovery.
Existing managed conversations are not converted or relaunched under a new default.

Connected editor and terminal sessions retain their native ownership. Closing SWA detaches
its terminal clients; it does not stop externally owned agents. Connections use authenticated,
typed adapters and server-issued identities. Terminal input receipts establish delivery to
the pane, not an agent reply, and uncertain input is never automatically replayed.
Native direct edits do not become independently reviewed commits by declaration.

**Start native in a folder** launches a fixed native CLI in a server-issued folder using an
optional local tmux installation. Existing SSH/tmux and Herdr sessions use the connection
path. Native model choice preserves CLI defaults; policy/exact choices use the central
resolver. A creation receipt does not prove sign-in or an agent reply. Recovery reads the
original receipt and never replays an uncertain start. Advanced project setup remains managed.

Fresh dedicated Group sessions also use direct execution, retaining membership, local-owner,
Ask/Work, completion and publication checks. Only their two scoped shared-evidence readers
are added. Native committed files require the owner's exact preview approval before sync;
this is distinct from independently reviewed managed task application. Current delivery and
limitations belong in [Status](STATUS.md).

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
shows shared messages from all members; Your Claude Code connects the member’s existing
native conversation. The saved SWA group agent retains earlier work behind an explicit entry. Setup, invitations and management are compact dialogs. The private-chat
and catch-up controls are removed from this journey; their saved records retain private
identities and are never republished or reassigned to the shared context.

Each member uses their own computer, provider account and native tools. Group agents run
through the local runtime. Fresh dedicated sessions are direct; existing managed sessions
retain their coordination and QUARK policy. Background summary/action helpers retain their
separate managed authority. Shared and private conversations have distinct
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

## Durable managed project work

The following coordination policy applies to advanced managed projects. Native direct
agents use their provider's own tools and subagents without mandatory Dock coordination.

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

A connected cluster's QUARK collector is advisory. It shares one cached reading of native
queue, fairshare, limits and accounting; it adds no blanket cluster limits. Owners can enable
bounded submission review for app-managed development allocations and recognized managed-Claude
submissions. Fresh policy starts Off; saved owner requirements remain authoritative. Native
Slurm still enforces site rules. Codex, computed commands and owner terminals are not intercepted;
managers request typed review explicitly when policy requires it.
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

## Dark interface and delivery

The 2026-10-12 UI direction adopts the earlier React Aria recommendation: keep React,
Vite and the existing host/API boundaries, with a small shared component layer and ordinary
CSS variables for dark-only application chrome. Preserve native provider sessions, tools,
permissions and every existing SWA destination. Original scientific artifacts keep their
source colors. See the [interface system](UI_SYSTEM.md) for component, research and
acceptance guidance; current delivery limits belong in [Status](STATUS.md).

Keep the browser and existing Mac launcher for this slice. A desktop wrapper adds a
platform WebView and native packaging to verify; it is reserved for a concrete native
requirement. The primary reliability concerns remain scroll ownership, visual viewport,
focus, anchored composers and saved drafts. React Aria supplies accessible interaction
primitives but does not remove browser keyboard or layout constraints.
