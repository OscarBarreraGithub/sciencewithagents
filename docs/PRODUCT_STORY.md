# sciencewithagents — functionality and website story

## Bring your own account and describe your first project

Give your setup agent the copyable website prompt. It checks your computer, prepares the app
and helps you choose Codex, Claude or both. Phone access, editor sharing and private backups
are optional. Choose your manager independently from its workers, then write the first brief
in the autosaving notepad. Work starts when you send it. New managers already receive the
team defaults, QUARK rules and instructions to keep next steps and human questions up to date.

QUARK groups a task's workers and retries into one card. Open it to see the team and recent
turns; a worker finishing a reply does not falsely mark the whole task complete.

Current interface note (2026-09-30): Home, Projects, Chats, Apps, QUARK, project/task detail,
health diagnostics, history, the prompt notepad, manager work lists and reviewed-change
application are connected in the drawn interface. The inventory below describes current
capabilities and their limits; provider, phone, native computer-use and public-release
acceptance still have separate steps. See [FEATURES.md](FEATURES.md) for evidence and limits.

This is the product wording and capability inventory used by the public-site work. It does
not certify deployment or native/device acceptance. Technical evidence and limits live in
FEATURES.md; new requested work is tracked in QUARK_CHECKLIST.md.

A new project can also begin with files you already have. Choose the folder on your Mac;
if it needs a starting version, the app offers to set that up for you. The files stay where
they are and nothing is uploaded. You can then meet the manager and describe the work.

## The idea

One private home for the work you do with AI, accessible from your computer and phone.
Tell a project manager what you want to accomplish. Follow the people-like team of
specialist agents it brings together and see their work. Managers apply independently reviewed
changes by default; choose human review for a project when you want to confirm the exact preview
yourself. Each computer keeps its own accounts and files.

## Write in a full-page notepad

Start a project by describing it in a full-page notepad. It saves while you type and keeps
earlier versions to preview and restore. **Open notepad** expands an ordinary chat draft into the same workspace
when you need more room, then minimize without sending or losing your place. Phone and computer
drafts remain separate until you deliberately transfer one. The browser keeps an unsent draft
locally; clearing browser data or losing the device can remove it. Shared editor chats also
offer a full-page notepad with browser-local recovery versions and separate drafts per tab. See the
[notepad requirements and storage boundary](CHAT_UI_REQUIREMENTS.md#prompt-notepad--initial-brief-and-later-messages).

Resource diagnoses and routine checks stay together in Computer health, so the main chat
list remains for your project and shared conversations. Their saved reports remain searchable.
An installed phone view offers **Reload app** when a newer interface is available, without
reloading in the middle of writing.

## Your conversations stay separate from background helpers

Sharing a VS Code conversation shows the same conversation on your phone; it does not
turn it into a project manager or create a second agent. **Chats → Shared** holds these
editor conversations, while **Managers** holds the managers of projects you create.
Workers belong with their project's tasks, and resource checks belong in **Computer health**.
This keeps background activity from filling your personal chat list with unfamiliar names.

sciencewithagents records which Codex sessions it creates and recognizes native subagents.
Its conversation pickers leave these helpers out. Finished app-owned task workers and
released resource/search helpers are archived in Codex too, keeping their saved history
available for later inspection. Archiving is not deletion, and imported personal chats
are not automatically archived.

One current limit: Codex's own VS Code history picker can still show a separately launched
helper while it is active. Our app distinguishes it, but cannot promise it never appears
in the native picker. See [helper visibility](VSCODE_MIRROR.md#helper-visibility).

## Managers keep their place

Managers keep durable internal next steps and separate human action items. Home shows concise
requests, links each reply to its original item and lets other authorized work continue while
one question waits. General to-dos can stay personal or be sent to a project. Notes and work
items remain available after restart or compaction. A manager still needs to keep its entries
current; the app cannot guarantee that every model will describe its work perfectly.

Managed Claude uses native compaction configured at 60%, with a saved handoff and project notes;
Codex keeps its native context behavior. In one observed real frontend run, Claude compacted
automatically, the saved handoff remained available, and the same work continued to completion.
This confirms one successful continuation, not the exact threshold reached or that every detail
will be retained in every context. Context use remains separate from subscription allowance
and cache lifetime.

See the [feature boundaries](FEATURES.md#manager-action-items-and-context-continuity).

## Find a chat and focus its project

Search chats by name, or ask for a bounded suggestion from the centrally selected bulk
Luna/Sonnet helper.
The helper checks a limited set of conversation names, saved excerpts and editor-chat titles;
it does not search the complete archive and it never sends a message or opens a result for you.
Focused backend checks passed 21 cases, including three RuntimeDemoProvider cases. Search/focus
browser acceptance passed 10/10 across five profiles: ranking used fixture data, navigation opened
the selected link, and the check confirmed that typing/opening does not launch a model call or
message the selected conversation.

Focus a project to pause other real projects temporarily. A saved receipt lets the app restore
only the project pauses that remain unchanged when focus ends. Manual pauses, QUARK holds and
spending caps remain in force. Project setup offers High, Default or Back burner priority and an
optional cap against a reported allowance window. Priority retries reuse their original request
after a lost response or reload. Focus browser checks exercised the real API and confirmed
lost-response and reload recovery with the same request receipt.

## Start with the accounts you have

A new workspace can use Codex for the entire team; a second subscription is optional.
Enable both providers when you want mixed teams. One settings page holds the team defaults,
role families and exact model versions, so changes do not have to be repeated in every feature.
Existing conversations retain their original provider and explicit model choices.

Welcome automatically finds existing native sign-ins and checks real model choices without
sending a prompt or opening a login window. There is no separate sciencewithagents account.
Connected local browser tabs resume the screen they were opening, retaining unsent drafts;
expired browser access has an app-opening recovery step. Sharing from VS Code needs no
separate editor code or sign-in.
It explains missing models and gives a retry after a connection problem. A new Codex sign-in
uses OpenAI's native one-time code; sciencewithagents does not collect your password or copy
its credentials. A readiness check is not proof that every future request will succeed.
Initial software installation still uses a setup agent. On Mac, Welcome opens Claude's own
sign-in when needed. Phone access can guide a new private Tailscale connection without buying
a domain: check the computer, confirm its address, then pair the phone. Tailscale installation,
account sign-in and HTTPS consent are explicit steps; an existing-domain connection is also
available. The private route's live-network/physical-phone acceptance remains open.

Updates have a clear handoff too: make a verified recovery copy and give its ready-to-copy
request to your setup agent. The guide checks active work and keeps conversations, drafts,
phone pairing and team choices in place. Preparing the request does not install software;
source updates remain agent-assisted.

The intended next step is to make updates fit a customized installation: ask your coding
agent to bring over the latest improvements while keeping the providers, layout and behavior
you chose. The agent preserves a recovery copy, adapts the changes and checks your workflows.
The [guide](UPDATE_APP.md) records that approach; seamless arbitrary-customization upgrades
and an entry point that handles all preparation are not implemented product guarantees.

## Keep the tools you already use

Your agents should bring their native tools, skills and connections with them. QUARK follows
their activity and shared spending without requiring another setup page for each new tool.
New Codex and Claude conversations now work this way; saved restrictions remain until deliberately
changed. A project can return to native settings with one saved choice for future workers;
existing conversations keep their settings and history. Claude helpers now have their own saved identities, tools and reported closing text,
while finer token accounting and complete native histories are still in progress. Provider updates can still require adapter changes. You keep permission
requests, saved work and control over final changes.
See [worker tool scope](WORKER_TOOLS.md) before describing this as cross-provider parity.

When a helper calls in another helper, the app can retain that relationship from Claude’s
reported delegation. You can follow the chain of work, then return directly to the conversation
that controls the group. Missing relationships are left unknown; they are not guessed from
which message arrived first. The whole group still shares its project’s usage controls.

An optional model setting should not make a model disappear. Claude models without a
reported thinking level remain available with **Provider default**; exact versions and
reported thinking levels stay selectable. The central policy uses the same catalog everywhere.

Research does not need the same steps as changing code. A manager can return an answer with
its evidence, and local transcription can return its result, without creating a code branch
or an automatic review loop. Code changes keep independent review; managers apply by default,
unless the project is set to require human confirmation of the exact preview. Both use the same
shared queue, usage controls and saved history.

## Know what is slowing the computer

Computer health shows which app-owned project team or transcription is using CPU and memory,
including its tools and helpers. It also groups the other apps, so a low overall CPU reading
need not hide memory pressure or one busy core. Ask for a short diagnosis when needed; the
resource assistant runs for the check and then stops. The watcher shares QUARK's readings.
External work is not always attributable, and memory totals are approximate.

Completed task workers can let go of their running processes without losing their work.
Their conversations, decisions and files remain available for later questions. Paused or
unfinished work stays protected, so freeing resources does not mean discarding progress.

## A team whose work you can return to

The useful result is more than the final answer. sciencewithagents keeps the assignment,
conversation, visible tool activity, changes, reviews and handoff notes for each worker.
You can see who investigated a question, who built a feature and who checked it.
For finished work, **Ask about this work** opens a separate read-only discussion. Eligible
Codex and Claude workers can bring their original saved conversation into that discussion; either provider
can use retained evidence instead. It can explain recorded choices and look up the original
messages and results. The completed task and review stay intact, and the discussion uses
the same shared allowance controls. Creating or opening it does not spend model tokens.

The native option copies history through the worker’s recorded final reply when you send
the first question. The original conversation stays intact. Missing/incompatible history is
reported; it never silently substitutes a reconstruction. Saved-evidence discussions are clearly
labelled. Claude needs a recorded final root reply; older records and native helpers use saved
evidence. Missing or compacted-away history has an explicit fallback, never a silent replacement. Neither path can recover hidden reasoning, freeze a retired model version,
or guarantee an exact historical memory snapshot. See WORKFLOW_BUILD.md for limits.

Usage readings are shared by every project, manager and device on the computer. If a provider
is unavailable, the app keeps the last reading visibly dated and explains when it will try
again. It distinguishes a throttled usage check from an exhausted allowance, without asking
every agent to query the provider separately.

You can also inspect a Claude helper's delivered report and its reported token total when
Claude supplies one. The app keeps that separate from the team's total, so the same work is
not counted twice. Missing detail is labelled, rather than presented as zero spending.

## Functionality inventory

- **Projects from an idea:** create a project in the app or connect existing files.
- **Project and area managers:** give separate parts of a project their own responsible manager.
- **Specialists on demand:** managers delegate bounded research, planning, building and independent review; team members can exchange recorded messages.
- **Visible subagents:** native Codex helpers and Claude helpers identified by native hooks keep their own identities and available evidence under their owning team. Resuming a Claude helper reuses its record. Claude's exact nested parents, unlinked text and individual token counters are not always available. Helpers share the team's budget; they are not automatically independent reviewers.
- **Codex and Claude together:** choose either for managed project roles and explicitly delegate between providers using their existing local sign-ins.
- **Keep using VS Code:** share a live Codex or Claude editor conversation in the central phone/desktop chat, without importing it into a new managed agent.
- **Pick up an existing Codex terminal conversation:** compatible native sessions appear under Shared. Read, reply, guide current work or ask it to stop from the phone, while the original terminal keeps its model, tools and history. No replacement agent or new sign-in is involved. Simultaneous input can join the same reply; older isolated terminals remain outside this connection.
- **Follow and stop a reply:** watch the shared conversation and stop the specific reply you are seeing, with delivery checks after connection loss.
- **Your approval matters:** answer original permission requests. Managers apply independently reviewed code by default; projects can require your confirmation of the exact preview.
- **Find the reason later:** search retained conversations, tool results, decisions and checkpoints; open the original evidence.
- **Pick work back up:** restore saved conversation identities and views after opening the app again. Interrupted actions are shown for inspection, not automatically repeated.
- **Phone and computer handoff:** keep separate drafts, explicitly copy a draft, reconnect and transfer native input control without duplicate sends.
- **A private phone address:** pair with computer confirmation and initial passkey verification, then open directly without recurring prompts. Remove a paired device from the computer to revoke access.
- **Phone access can reconnect itself:** the app makes a few attempts after its connector stops, keeping pairing and the saved lock preference. Persistent problems ask for attention; reconnection never replays chat messages.
- **A phone problem needn't stop desktop work:** invalid phone settings or a busy connection leave the desktop usable and keep saved pairing. The app explains that phone setup needs repair, with phone access closed until it is fixed.
- **Your computers, your accounts:** switch between configured computers while each retains its own history, sign-ins and files.
- **An optional personal assistant:** share selected projects, preferences and priorities with a front desk that routes requests and returns evidence-linked reports.
- **Native power when needed:** retain supported Codex terminal commands, models, skills, plugins, connected tools, web search and image output; Claude's advanced controls remain available in its original tools.
- **Work and attention views:** see queued jobs, approvals, stopped work and changes ready for review.
- **Source and recovery copies:** connect a private GitHub backup from the project page, inspect the exact destination before confirming, and track which reviewed checkpoints were saved. Create checked local conversation-database copies separately; full off-device recovery remains a separate setup need.
- **Reconnect without losing drafts:** opening the installed app connects a private local browser view. Unsent text and pending request records stay intact, conflicting versions remain in Recovery, and nothing is automatically resent. Editor connections use a one-time code; existing provider accounts and conversations stay where they are.
- **Agent-led setup:** a setup agent handles technical configuration; the person completes their account sign-in and device consent.

## Parallel work without a terminal detour

When another task reaches your project first, the remaining reviewed result may need an
update. The app explains why it cannot be applied yet. Choose **Prepare updated changes**
to give the same manager a separate follow-up, with the same spending boundaries and a
fresh independent review. The original result and review stay available. You see the new
exact changes before confirming them; nothing is applied merely by asking for the update.

## Deliberate controls, retained work

Give a project one clear task, or add a manager for a particular area. Drafts survive a
reload. If a creation confirmation disappears, the app checks the same request so a second
click does not create a second team or assignment. Creating a manager starts no model work;
creating a task queues its first request through QUARK.

Advanced controls explain what Continue, New context and Compact actually do before you
confirm. New context keeps the visible record. Codex compaction also needs shared capacity
and allowance; tidying context cannot silently finish the task or launch more assignment
work. Your original native Codex tools remain one explicit action away. Saved Codex history
can be brought into a project whose manager uses Claude without changing the manager's
identity or starting a model turn.

## A team that grows with the models

Choose the kind of help a job needs, without keeping model names in your head. Uncles handle
simple batches, undergrads handle routine check-ins, grad students handle demanding work,
and postdocs manage projects. An undergrad can ask a grad student for a bounded second opinion.
The defaults express the owner's preferences; they do not make any answer infallible.

One settings page connects those roles to Codex and Claude. Choose **Codex heavy**, **Claude
heavy**, or **Pick as I go**. Under the last option, you choose each new manager's provider;
managers explain worker choices using the shared policy and available allowance. Scheduled
checks have their own saved choice. QUARK keeps teams from spending the same headroom twice.

Defaults follow the latest available model in each chosen family. Prefer a particular older
version? Pin it. A family changes its name? Update one mapping. You keep both convenient
defaults and precise control, without rebuilding every workflow. Existing conversations keep
their provider and history, and missing models are clearly reported. Native editor sessions
keep their own settings. [Model policy](MODEL_POLICY.md) records the exact implemented scope.

## QUARK: patient background work, room for urgent requests

**Queued Usage, Agent Routing Kernel** coordinates work against
available provider allowances and computer capacity. Usage is visible on first opening the
phone, and every manager sees the same capacity report. Give work a priority and an
estimated budget. Background projects can advance slowly while leaving room for something
you need now. See why a job is waiting, change its priority, pause it appropriately or
allow it to use reserved capacity. Reported model allowances, including Fable, stay
visible separately; separate meters are not assumed to mean extra capacity.

A brief interruption in the usage monitor does not strand a project. QUARK distinguishes
waiting for a fresh reading from spending the approved budget. Once the provider confirms
a stop and fresh capacity is safe, temporary holds can continue from saved progress.
Budget limits and deliberate pauses stay in your hands. The app's native Codex terminal
uses the same admission and monitoring rules; it cannot give a manager permission to
dispatch outside QUARK.

Local work shares the queue too. Paste a public YouTube link, choose how soon you need it,
and read the transcript produced by Whisper on your computer. Background transcription
can pause for urgent work and continue from the same process. Agent turns instead yield
between replies. Recent jobs compare estimated with measured tokens where the providers
report them. This is scheduling for work managed by the app, not control over every program
on your computer. Verified paths and provider/device limits are in [QUARK](QUARK.md).

A temporary problem reading usage need not end a night of work. QUARK can continue from saved
progress once it has a fresh reading and confirms the old run stopped. If that reading shows
the task has spent its allowance, it explains the budget pause and waits for you to continue.
It keeps the files and conversation; a subscription reset does not silently refill your task’s
spending grant.

## A quiet IT desk for your computer

See more than a CPU percentage: understand memory pressure, swapping, apps with many
helpers and how that relates to queued work. Keep a day of local history. Open the Resource
assistant for a full-screen conversation: it can inspect relevant logs and system state when
a snapshot cannot answer your question. Periodic and pressure checks stay brief and appear
in health history, keeping the main chat list clean. It never quietly closes your apps. Exact scope and
platform limits are in [Computer health](RESOURCE_WATCH.md).

## Give work a share of your allowance

**Implemented:** Bring another coding agent into the workflow through a shared QUARK client.
It can see the same remaining allowance and computer health, then ask a project manager to
carry out bounded work. The budget is saved before work can start. Retrying after a lost
connection finds the original request instead of creating a second assignment. This covers
work submitted to the app, not every agent running independently on the computer.

**Implemented:** Give a project or task a budget such as “use at most 10% of my weekly
allowance.” QUARK keeps a shared ledger across projects and their agents, estimates each
project's share, and pauses managed work as it approaches the cap. Your files and
conversations stay in place. Increase the budget and explicitly continue the saved work
when you are ready. Managers can tighten a cap but cannot give themselves more allowance.

**Implemented:** Spending controls sit with the work on the QUARK board. Managers are
instructed to estimate and save starting task budgets before delegation. Each saved project
or task cap has a slider with estimated spending and remaining budget; release to save an
adjustment. The board refreshes automatically. Changing a cap keeps the spending already
recorded, and conflicting edits from another device are surfaced. Help/setup stays focused
on its copyable setup prompts, without unrelated settings, computer or allowance shortcuts.

Open the details to see provider-reported tokens per run, agent and project, including
cache use and missing readings. Percentage shares are estimates, not a bill; 2–3 percentage-
point accuracy has not been validated. Claude now feeds QUARK input/cache activity while it
works, then team totals including helpers where reported. Replayed messages and restored
session totals are not counted again as new work. Incomplete readings are labelled, and
separate spending records for each native Claude helper remain in progress.

Other activity on the account can affect the estimated project shares.

**Implemented with limits:** Keep useful task conversations warm with estimated cache
timers and a small, bounded refresh before expiry. Refreshes use the same model and respect
the same budgets. Expiry never deletes the conversation. Claude starts with a configurable
60-minute estimate; Codex expiry is unknown until configured. The app cannot guarantee
provider cache retention. [Exact scope and controls](QUARK_ACCOUNTING.md).

**Implemented:** Managers need QUARK's permission to orchestrate. The app grants a short
lease and checks it again when a manager dispatches work; the model cannot approve its own
spending. Workers concentrate on their assignments while QUARK watches their shared budget.
A manager can request a pause, and the app can stop spending even while that manager is
idle. Progress remains saved for deliberate continuation. This applies to app-managed work;
saved native tool catalogs and interruption limits are explained in [QUARK](QUARK.md).

## Names and sharing TODOs

- Umbrella/repository-facing product: **sciencewithagents**.
- Scheduler: **QUARK — Queued Usage, Agent Routing Kernel** (chosen by the owner on 2026-09-25).
- Other naming ideas retained for future use:
  - **AXION — Agent eXecution, Integration, Orchestration Network**
  - **HADRON — Hierarchical Agent Dispatch, Resource Operations Network**
- TODO: choose a separate name for the WhatsApp-style conversation app.
- TODO: approve the public repository/license/support choices and companion marketplace
  release details. The requested repository currently exists as private staging; no source
  has been pushed.
- Keep the public site and this inventory aligned with the current implemented features,
  release state and limits.

## Tell QUARK what matters — guide and website material

“Put the website on hold and give the analysis more room.” QUARK keeps that instruction,
coordinates the shared queue and shows what is working, waiting or needs attention. Its
conversation sits above a simple project board, with estimates and saved allocation choices.
It follows your allowance reserve even when several managers are working. You can change
its model, and it does not spend tokens just to sit idle. It is available while your computer
and the app are running. Estimates improve through saved examples of actual work; they remain
estimates. See QUARK_COORDINATOR.md for implemented scope and boundaries.

Your original requests stay useful. Unloading older messages from a phone screen does not
erase saved app-managed conversations. Ask a bulk worker to search those original prompts,
recap what you asked for, and flag things that may have been missed. Its findings should link
back to your words, and the manager should verify them. Drafts and externally shared native
chats have separate retention; local source-code backups are not conversation backups.

## Release guide notes: control without a review treadmill

Each project has two independent choices: how work is shared between Codex and Claude,
and Light, Default or Tokenmax spending. The manager is selected separately. Defaults name
model families and resolve their current available versions; people can pin an exact model
and thinking level. Project configuration uses actual model names. The owner's recommendation
is: “If you have FAS Claude, I recommend Balanced or Claude heavy for default usage.
I personally use Balanced + Tokenmax.”

Managers maintain saved internal next steps and a separate list of short human asks. An
answer stays linked to its question and reaches the responsible manager once. General to-dos
can stay personal or be sent to a project. One blocked question does not stop independent work.
Project notes and work lists survive a fresh context. Claude uses native compaction at 60%,
with a saved handoff and restored project state; Codex retains its natural native compaction.

Reviewed work is applied by the manager by default. A one-line project option keeps changes
on their own branch until a person reviews them. Review the direction at a high level, then
review small implementable pieces. After two correction rounds, the manager records a clear
judgement, or the project can require stopping for a human answer. Do not keep repackaging the
same unresolved review into fresh loops. Decisions remain available for later inspection.

Drafts save locally as the person types and keep server-side versions when connected. A full
notepad and compact composer share that draft and its exact send receipt. Restoring an older
version makes a new editable draft; it never sends an old message again. Separate devices keep
separate drafts and offer deliberate handoff instead of overwriting one another.

Claude usage checks are shared and paced to avoid the provider's rate limit. A transient
failure blocks new protected admissions; already admitted work has only the remaining bounded
reading lifetime. Prolonged failure pauses work and fresh evidence enables temporary-hold
recovery. This is not a guarantee that the provider endpoint will never fail. Percentage rates
remain estimates of each named allowance window, not a combined currency or a precision claim.
