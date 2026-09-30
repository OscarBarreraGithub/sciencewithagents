# Previous workspace reference

This describes the retained interface before the home-screen rebuild. It is not the
current default phone experience. See [the current home](UI_REBUILD.md).

Formerly Agent Dock. Existing app installations, private data, pairing and internal integration identifiers remain compatible. The separate conversation-app name is still a TODO.

Read the [nontechnical product story](PRODUCT_STORY.md) and [QUARK requirements checklist](QUARK_CHECKLIST.md) for the new sharing and scheduling work.

A private home for Codex and Claude conversations, across your computers and accounts.

**QUARK** coordinates background Codex/Claude jobs and local Whisper transcription with
shared usage, priorities, budgets and room for urgent work. See the [user guide](QUARK.md)
for controls and precise limits. The phone shows allowance readings immediately on opening.

## First-time setup

1. **Set up your computer and source backups.** Have Codex installed and signed in on
   this computer. Open this project with your coding agent and ask it to follow the
   [setup guide](CONTRIBUTOR_SETUP.md). A [GitHub account](https://github.com/signup)
   is recommended: ask the agent to connect [private source backups](SOURCE_BACKUPS.md)
   for each project. These save reviewed code checkpoints, not your conversations.
2. **Get a private phone address — optional.** Create or sign into your
   [Cloudflare account](https://dash.cloudflare.com/) on the computer, choosing GitHub
   sign-in when offered. Your agent connects Cloudflare and follows the
   [phone setup guide](CLOUDFLARE_SETUP.md); you do not copy tokens or configure
   networking. The agent checks for an available hostname. Setup does not include buying
   a domain, a paid upgrade or a promise of a free new domain.
3. **Pair your phone — optional.** Open **Phone access** on the computer and choose
   **Create a new code**, then scan its QR on your phone. Open it in Safari on iPhone
   or Chrome on Android; scanning takes you straight to **Name your phone**, without
   entering a code. Type a **Phone nickname**, choose **Continue**, then **Save passkey**,
   and confirm the matching number on the computer within 15 minutes.
   After unlocking, choose whether to keep the default phone lock or **Stay signed in**,
   then follow the Home Screen guide. No GitHub or Cloudflare login is needed on the phone.
   Without scanning, open the address, complete
   **Enter pairing code**, then name your phone on the next screen.
   An icon added before pairing may need adding again from the paired browser; see the
   [phone workflow](PHONE_WORKFLOW.md) for lock choices, installation and recovery.

Local use needs neither Cloudflare nor a phone; skip steps 2–3. For phone access, the
computer must remain on, awake, online and running sciencewithagents.
Next, [create your first project](#start-using-the-app). You can optionally
[connect other computers and accounts](MULTI_COMPUTER_SETUP.md) with your setup agent.

Cloudflare can also be part of future hosting for websites you build. **Hosting or sharing
project websites is a separate, deferred feature**, not permission to share this private
sciencewithagents management workspace. See the [feature map](FEATURES.md), including selected-computer CPU, memory and disk reporting; an aggregate cross-computer
dashboard remains a TODO.

For a scannable inventory of every feature, idea and known limit, start with the
[feature map](FEATURES.md). The [documentation index](README.md) separates normal
use, agent-led setup, current status and historical troubleshooting.

Talk to a project manager. It delegates bounded work to planners, builders, researchers
and reviewers. Follow each conversation, inspect changes, resolve permissions and keep
the reason behind a decision. The same responsive interface works at desktop and phone
sizes. Computer-approved phone pairing and passkey unlock are implemented, and the hosted
authentication boundary is verified. Physical Safari enrollment succeeded; Home Screen,
cellular handoff and restart acceptance remain separate. See
[setup status](STATUS.md) and the
[current check-in queue](OWNER_CHECK_IN.md).

## Start using the app

On a Mac after agent-led setup, open **sciencewithagents** from your Applications folder. It
starts this installation and opens the app in your browser. After a computer restart,
log in and open sciencewithagents again; no terminal command or login item is required.

Choose **Add a project**, give it a name, and optionally
describe your idea. Pick **Codex** or **Claude Code** as its manager, using that provider's
existing sign-in on the selected computer. Choose **Create project** to meet its manager.
The app prepares the project for you; you do not need terminal commands, Git setup or a detailed plan.
Nothing starts until you send a message. Your project and conversations stay on this
computer, and a connection retry does not create a duplicate project.

Closing a browser does not stop your agents or phone connection. Choose **Quit sciencewithagents**
and confirm **Stop and Quit** to stop the app; conversations remain saved. If an existing
server was started separately, the launcher opens it without claiming permission to stop it.

On a Mac, **Use an existing project folder** opens the computer's folder chooser instead.
Choose the main folder of an existing Git project with at least one saved commit. Its files
stay where they are; connecting it does not change its files or start an agent. To start
from an idea without Git setup, use **Create project**. A connected project's existing
manager stays unchanged; the provider choice applies when creating a new project.

Want to keep working in an existing editor chat instead? Use **VS Code chats** with the
[optional companion](../apps/vscode-mirror/README.md). It shares the original Codex or Claude
conversation; it does not import it into a new manager.

## Set up with your agent

Open this clone with your coding agent and ask it to follow
[the setup guide](CONTRIBUTOR_SETUP.md). It handles the technical steps; you complete
your own account sign-in when requested. The setup agent places the generated local Mac
launcher in Applications. Initial phone pairing needs a passkey and computer confirmation;
repeat phone unlock is on by default and can be changed to **Stay signed in**. No phone
GitHub/Cloudflare login is required. This clone-bound launcher is not a packaged installer
or automatic updater.

### Advanced source setup

You need Node 24+, Git, and [Codex CLI](https://learn.chatgpt.com/docs/cli) installed
and signed in with `codex login`. No API key is stored by this app.
For managed Claude conversations, also install and sign into Claude Code on that computer;
the app uses its native subscription, not a paid-API fallback. See [managed Claude](MANAGED_CLAUDE.md).

```sh
node scripts/setup.mjs
./scripts/pnpm dock doctor
./scripts/pnpm start
```

Open **http://127.0.0.1:4330**. No global pnpm installation is needed; use `./scripts/pnpm`
where the advanced examples below say `pnpm`. Create new projects in the app.
The existing-repository CLI remains available to advanced users:
`pnpm dock add /absolute/path/to/your/repository --name "My project"`.
That separate connection route currently requires an existing Git repository with a
first commit. Source installation is still technical; it is not a packaged installer.

Optional advanced macOS login service (not required for the manual launcher, and left off
during this build). Stop any foreground/launcher-owned server before using it:

```sh
pnpm dock service install
pnpm dock service status
# pnpm dock service stop        # unloads it; history is retained
# pnpm dock service start       # loads the installed login service again
```

The service uses this clone and its current Node/Codex executables. After moving the
clone or changing those installations, rebuild and rerun `service install`. Do not run
the foreground server and login service against the same data directory.

For a no-model-call preview, run `node apps/server/dist/main.js --demo`. The example
project and conversations are explicitly labeled demonstration data and kept separate.

## Working with agents

For a first task, select your project manager and try:

> Delegate a read-only inspection of this repository. Identify one useful, small next
> change, get an independent review of the recommendation, and return the result here.
> Do not implement anything yet.

Follow the workers in the team panel and their task in **Workboard**. For an implementation,
give the manager one outcome and an acceptance check; inspect the reviewed diff before
choosing **Apply changes**, then **Confirm and apply changes**. Exact saved Git versions
remain available under Technical details. You do not need to design the whole project first.

- Talk directly to the manager or create a task with an outcome and acceptance check.
- Use **Add module manager** in the team panel for a part of the same repository.
  Give it a name, area of responsibility and provider. Each manager has its own conversation
  and checkpoint; all managers share project evidence and can message each other.
  New tasks belong to the selected manager, shown explicitly in the task form and board.
- Select any worker in the team panel to inspect its messages, tools and checkpoint.
  Workers can also send recorded messages to each other within the project.
- Codex workers can use native Codex helpers when their assignment requests them. Helpers
  appear beneath their parent with their own visible histories. They share the same
  task workspace and role; the parent controls their turns. Each worker allows up to
  two open helper threads. Managers still delegate independent tasks through sciencewithagents.
- Queued turns continue when the browser closes. Reloading restores history.
- **Needs your attention** gathers approvals, manager decisions, stopped work, changes
  ready to apply and backup failures across projects. Opening an item does not approve it.
- **Work queue** can pause new queued work and limit concurrent agent groups to 1–4.
  Running work continues; original approvals, task ownership and native terminal controls
  remain unchanged. Helpers belong to their parent group. This is not a spending limit.
  Both screens have backend and four-size browser acceptance.
- **Open conversations** restores your saved views. The computer and phone keep separate
  drafts; copy a draft explicitly to continue on another device. Unchanged copies share a
  delivery receipt so simultaneous sends do not duplicate the same message. Edits made
  offline or in a stale tab remain visible for comparison, never silently overwrite.
- **Search saved history** searches retained messages, tools and decisions beyond the recent
  preview, and opens the original evidence. Managers have the same paged evidence tools.
- **Your assistant** is an optional personal front desk. Choose which projects it may see
  in **Assistant settings**, and save your preferences, priorities and commitments. It
  routes requests to those project managers and brings back source-linked reports; it
  cannot implement, approve or apply changes. No project is shared by default.
- Use the session menu to resume, start a new context, or export history. Codex also offers
  explicit compaction; Claude manages its own compaction.
- The model picker uses the selected provider's installed catalog. Implementers can use their task
  workspace; managers only have coordination tools and remain read-only.
- A manager can choose a different model/reasoning level for each new worker, with a
  recorded difficulty assessment and selection reason. Ask it for the choice in chat;
  omitted choices inherit within the same provider. Choosing another provider requires its
  explicit model and thinking level. Codex and Claude managers/workers use the same project,
  queue and review rules; existing conversations never switch providers. **Session settings**
  shows provider, original assignment and reported usage. See [managed Claude's supported
  controls](MANAGED_CLAUDE.md) and [routing choices](MULTI_PROVIDER_ROUTING.md).
  Automatic selection awaits your rules; no Opus/Sol/Terra ranking or quota fallback is assumed.
- Usage distinguishes conversation tokens from account limits. Claude shows only the latest
  reported turn's counts when conversation totals are unknown; its account limits remain in
  Claude Code. Codex can explicitly refresh reported limits without sending a message.
  Missing/stale values stay labeled; reports are not added together or presented as a bill.
  This is not a spending cap.
- The native-terminal tab attaches the real Codex CLI to the same provider session.
  It is the compatibility surface for native slash commands and permissions. Closing
  the browser leaves that terminal alive. **Return to chat** releases it.
  Send the first chat message before attaching. Only one browser or local terminal
  owns an agent's native input at a time; **Take control here** explicitly transfers control.
- Review exact requests in approval cards. Approval is forwarded to the original provider once and
  belongs to the original pending request. Prompts cannot approve an action.
- Choose **Web search** in an idle Codex worker's **Session settings**: Off, Cached results,
  Index-gated access or Live web. New workers start with cached search; previously saved
  sciencewithagents workers stay off until explicitly changed. Managers delegate web research.
  Search queries leave this computer and results are untrusted. This setting is separate
  from shell network permissions; saving reconnects the worker without deleting history.
- Enable **Use built-in image generation** for an idle Codex worker to use Codex's own image
  tool. It uses your Codex allowance, not a separate API key, and is off by default.
  Generated PNGs are retained with the conversation, including native-terminal results.
  Open the full-size image or download it from any connected client after reload/restart.
  Managers delegate image work; no OS or desktop-app permissions are granted by this setting.
- Enable already-configured MCP servers for an idle Codex worker in **Session settings**.
  Servers are off by default; managers cannot use them. Each tool call requires approval,
  including tools your Codex configuration normally auto-approves. Enable only trusted
  servers: their processes and external actions are outside the task sandbox. Configure
  and authenticate servers locally with Codex, not through a browser command endpoint.
- Standard MCP forms support text, numbers, booleans and single/multiple choices.
  Submit or decline the named server's request explicitly. For a native-started request,
  open **Conversation** to answer the form; the native turn receives that same response.
  Submitted answers are retained in your local history. Do not enter credentials or
  payment details; unsubmitted form answers reset on reload.
- MCP URL requests show the requesting server and actual destination. **Open requested
  page** and **Allow URL request** are separate actions; neither proves sign-in succeeded.
  Allowed links remain in private local history for handoff and may expire. The app never
  opens or fetches them automatically. HTTP links are limited to explicit loopback addresses,
  which refer to the device opening them, not a remote phone-access service.
  Native URL requests are answered in **Conversation**, including when using `dock attach`;
  the native tab shows a prompt to switch there. Ordinary terminal approvals are unchanged.
- Select **Use installed Codex plugins** for an idle worker to reuse its enabled plugins
  and connected apps. Managers cannot enable these. Native `/plugins` remains Codex's
  catalog; sciencewithagents does not build a second marketplace or store credentials. Tool
  calls require their original approval. After changing native plugin configuration,
  return to chat and reopen the terminal to reload it; history is retained.
- Implementation happens in `data/worktrees/<task-id>` on a `dock/<task-id>` branch.
  The platform checkpoints changes when a builder finishes. An independent reviewer
  records findings; the manager resolves them. The owner confirms an exact, clean,
  reviewed commit before a fast-forward integration. Diverged branches require local
  Git reconciliation; the app does not guess how to merge conflicts.
- The workboard distinguishes **Completed** transcript-only results from reviewed code
  **Ready to apply**. Open the task's worker conversations to inspect its result.
  Only completed tasks with a reviewed commit beyond their recorded base offer integration; the server
  still checks the current exact commit and clean working trees before confirmation.

The manager does not write detailed plans or implementations. Plans are delegated,
optional for small work, and limited to the current task. Review disagreements require
an explicit manager disposition. The same task allows at most two revisions; splitting
or asking the owner is required when it stops converging. Automatic agent turns also
have a twelve-turn backstop when capacity pacing is off. With QUARK enabled, the default
is 100 turns, adjustable in Work queue, while task budgets and provider headroom still apply.

Managed Claude supports chat, project roles, original permission requests, model settings,
Stop, resume and new context. Its native terminal, advanced slash commands, external MCPs,
plugins and web/image controls remain in Claude Code or the shared VS Code chat; unsupported
controls are not offered as if they worked here. The separate personal assistant remains Codex.

## Existing sessions

For a conversation that should **stay live in VS Code**, the new optional
[sciencewithagents Mirror preview](../apps/vscode-mirror/README.md) shares one chosen conversation
with the phone. The same companion supports **Codex and Claude Code**, separately or
side-by-side, using reversible maintained patches. Both detect compatible connection
structure rather than rejecting every new version; incompatible changes disable only the
affected bridge without changing the native chat. Companion **0.2.2** adds Codex structural
compatibility and **Stop reply** for both providers. Its reviewed package and isolated live
checks are ready; installing that update is a separate deliberate editor reload.
Click **sciencewithagents** in VS Code's bottom bar to share a conversation, open the app,
stop sharing or find the provider's native controls. **Stop reply** targets the observed
reply; **Check stop status** checks a lost confirmation without repeating the action.
The original sidebar stays usable; sent messages synchronize and drafts remain separate.
Native approvals and advanced controls stay in VS Code. This is a private
review preview, not yet a marketplace release. Shared chats appear under **VS Code chats**
in the normal navigation and open in the main conversation pane, not a floating panel.
On a phone, open the chat menu to switch conversations; **All chats** shows setup help.
Offline chats remain recognizable; open/share the same conversation in VS Code to reconnect.
Automatic editor crash restoration is not required: reopen its original conversation and
share it again. No message is automatically sent on reconnect. Drafts and selected views
are kept per tab and computer, separate from what someone is typing in the original editor.
The stopped-client import below is a
different recovery workflow and is not required for a mirrored conversation.
Managed Claude is a separate workflow with its own role and recovery limits; sharing an
editor conversation does not turn it into a managed worker.

Open **Existing Codex sessions** in the team panel to browse saved sessions for the
registered repository. Choose one, select its responsible manager, and confirm that
you have stopped the original client before importing. Listing and importing history
do not start a model turn. Already-imported sessions open their existing conversation.

```sh
pnpm dock list
pnpm dock sessions <project-id>
pnpm dock import <project-id> <codex-thread-id> --stopped
# Optional: --manager <module-manager-id>
pnpm dock attach <agent-id>
```

Stop the original Codex client before resuming an imported session here. Discovery is
limited to non-archived sessions saved from the registered repository's root (including CLI, editor,
App Server and subagent sources). It is not live attachment to every external client.
There is no arbitrary JSONL-file upload. Imports begin read-only and preserve visible history;
they do not retroactively reconstruct missing agent relationships. New implementation
work should be delegated into a task worktree.

History import is paged and atomic: a failed read leaves no partial imported identity.
Very large histories are refused rather than silently truncated (32 MiB or 5,000 turns,
with a 500-page safety limit and the provider adapter's per-message bound). The original
Codex history is unchanged. Exact hidden context and historical team relationships are
not reconstructed. Start new orchestration with a fresh project/module manager; keep the
imported conversation as an explicit recovery path. **New context** is always a deliberate
choice, not an automatic upgrade of an old thread's context or tool definitions.

## Your computers and accounts

After [agent-led connection setup](MULTI_COMPUTER_SETUP.md), use **Computer** to switch
between personal, school or family installations. Each computer keeps its own provider sign-ins,
tools, projects, queue and history. The same paired phone can use the selector. Switching
never moves a conversation to another account or mixes drafts between computers.

Computers must be on, logged in, running sciencewithagents and reachable through the configured
SSH route. The entry computer also needs to stay on for phone access. Connection failures
offer an in-app retry without replaying input. The personal assistant's visibility is
per-computer; cross-account memory sharing is not automatic. Three isolated app instances
and four-size browser handoff are verified; the owner's other physical machines still
need their setup/acceptance check.

## Storage and recovery

`data/dock.sqlite` contains projects, tasks, agent identities, visible conversations,
tool results, retained generated PNGs, decisions, checkpoints, approvals, idempotency records and append-only
events, host recovery evidence, saved views and revisioned per-browser drafts. Runtime
files are private and ignored by Git. Codex and Claude retain their own provider
sessions in their normal local storage. A provider session is a continuity aid, not the sole
record of the work. Hidden reasoning and an exact context cache are not recoverable.

Projects created in the app have private folders under `data/projects/<generated-id>`.
Their initial version history and local save identity are prepared automatically, without
changing global Git settings. Back up these folders too: the SQLite backup contains project
metadata and conversations, not project files or task worktrees.

After manually powering on, logging in and reopening the app, saved views retain the
same provider identities without starting a model turn or rebuilding the transcript.
Codex reconnects saved contexts, bounded to two at once. Claude keeps an inert saved view;
its native session resumes only with explicit work. Interrupted turns remain visible and
old approvals expire: inspect the last result before continuing. A deliberate new context uses saved
evidence; an unavailable old context is never silently replaced. The app never retries
an uncertain external action. Local draft fallbacks and server-saved revisions preserve
edits through disconnection; submitted conversations are shared on the selected computer.
Provider cache hits cannot be guaranteed. Streamlined login-item setup is deferred.

Open **Recovery copies → Create recovery copy** to save and check an extra database copy
on the selected computer. It includes managed conversation records, decisions, saved images
and app state—not project files, task worktrees, original provider histories or credential
files. A copy on the same disk does not protect against losing that disk. Ask your setup
agent to arrange separate private off-device backup; that is not automated here. Restore
is agent-assisted into a separate location, never an in-app overwrite of live work. See
[recovery copies](RECOVERY_COPIES.md) for coverage and safe restore instructions.
The advanced `dock backup` command remains separate. See [operations](OPERATIONS.md)
for updates and recovery.

For source-code backup, use GitHub during agent-led setup. Configured projects automatically
back up reviewed checkpoints and approved integration to a private repository. The manager
and sidebar show whether GitHub actually received the checkpoint. Missing setup and failed
pushes remain visible; uncommitted edits and private history are not uploaded. See the
[source-backup setup guide](SOURCE_BACKUPS.md) for configuration and limits.

The gateway only binds `127.0.0.1`, checks exact Host/Origin, and does not expose raw
App Server RPC, arbitrary filesystem operations or a general shell endpoint. Native
terminal mode is an owner control surface for the fixed Codex process. Treat it with
the same authority as your local Codex CLI. This is a trusted, single-owner local app,
not a security boundary against malicious software running under your OS account.
Never tunnel the local app port. After agent-led setup, **Phone access** starts/stops the
configured secure connector and shows connection health/retry; no separate terminal command
is needed. The replacement paired mode keeps enrollment when phone access is temporarily
off; **Remove device** is the explicit revocation action. Default phone-managed unlock
lasts at most 15 minutes; **Stay signed in** is an explicit per-device option after initial
verification. **Lock app** or turning phone access off still requires passkey unlock next
time. Enrollment has no automatic server expiry; browser cookies request 400 days, renewed
on visits, without a guarantee against storage loss. The configured hostname uses app-owned
pairing, without phone-side GitHub/Cloudflare login. Physical Safari enrollment succeeded;
Home Screen, cellular and restart checks remain pending. See the
[phone behavior contract](PHONE_WORKFLOW.md) and
[agent-led Cloudflare setup guide](CLOUDFLARE_SETUP.md) before enabling it.

## Development

```sh
pnpm dev                         # UI at 127.0.0.1:5178, same-origin /api proxy
pnpm verify                      # types, focused tests, production build
pnpm --filter @dock/web exec playwright install chromium
pnpm test:e2e                    # desktop + 412x915, 360x800, 915x412
```

`packages/shared` holds the contracts, `apps/server` holds the runtime and SQLite API,
and `apps/web` holds the UI. Configuration is local: `DOCK_PORT`, `DOCK_DATA_DIR`, and
`DOCK_CODEX_BIN`. Keep source and credentials separate. See
[design decisions](DECISIONS.md) for the repo audit and tradeoffs.

## Current scope

The local platform includes Codex/Claude project/module managers, a deterministic work queue, a thin
personal assistant, durable evidence and conflict-safe saved views. Core real-provider
delegation, assistant routing and legacy JSONL recovery were verified with Codex 0.154.0
on macOS; older native-feature evidence remains version-specific. App Server and dynamic
tools include experimental interfaces. See [provider compatibility](PROVIDER_COMPATIBILITY.md).
Managed Claude has real native transport/approval/resume checks and scoped UI acceptance.
A real Claude manager, Codex builder and Claude reviewer completed a disposable task and
retained their identities on restart; current-source regressions remain separately recorded.
See [managed Claude](MANAGED_CLAUDE.md) for its deliberately smaller capability surface.
See [build status](STATUS.md) for the acceptance decision and
[verification](VERIFICATION.md) for actual checks and unverified combinations.

Native mode runs the actual Codex CLI, not a recreated slash-command interface.
Model/reasoning changes are retained. Managed-role permissions are reapplied on return
to structured chat. Native `/new` opens a fresh context with the agent's role tools;
`/fork` branches the current idle context; `/resume <thread-id>` restores a saved context
or transfers control to its registered agent. The browser follows the selected agent;
local `dock attach` keeps the same terminal connection. Each agent keeps its own role,
provider process, workspace, checkpoint and visible archive. Busy targets are refused;
failed attachment leaves the source terminal available. A private CLI relay coordinates
host subscriptions before the CLI continues. Return an already-open target terminal to
chat before selecting one of its other saved contexts. Only one native owner can use a task workspace.
External sessions require **Existing Codex sessions** import first. Selected worker MCP servers
work in chat and native mode, including fresh contexts and restart. Native attachment
starts with the agent's sandbox and on-request approval defaults; native permission
controls remain available. MCP tool-call consent and standard typed data-entry forms are
supported, as are explicit URL requests with retained owner links. This is not an OAuth
credential manager or proof that every third-party sign-in works. OpenAI's extended form
variant is not enabled and is declined if received. The tested native CLI does not
advertise that optional capability either; this is not a promise about future versions. Installed
worker plugins and connected-app tools are opt-in, including native catalog browsing.
Native helpers are enabled for workers, not managers. Their whole work group must finish
before one Git checkpoint and manager report; a helper cannot provide its own independent
review verdict. Built-in image generation is a separate worker opt-in. The desktop app's
[built-in browser is not available in Codex CLI](https://learn.chatgpt.com/docs/browser);
sciencewithagents does not recreate that host or change OS Computer Use permissions. Opted-in
installed plugins use the consent path above. This is not unrestricted parity with every independently
configured Codex terminal.

The native-child adapter has passed isolated real-provider resume/archive, ordinary MCP
and child-plugin consent, read-only viewing/handoff, and independently reviewed combined
parent/child file integration. These checks also pass through ordinary worker settings,
without fixture-specific enablement. See [build status](STATUS.md) for
legacy-provider limits and the supported v1 boundary.
Native child records retain visible activity and checkpoints when actually saved, not hidden
reasoning or all initial delegated prompt text. Their parent controls their turns. A tested
legacy child resumed after restart by explicitly resuming it before sending follow-up;
its optional checkpoint tool was not invoked, but its visible results/history were retained.
See the [orchestrator troubleshooting wiki seed](ORCHESTRATOR_TROUBLESHOOTING.md)
for the incident, evidence and decisions.
In the verified loaded-child native view, return through the bare `/resume` picker;
the tested CLI blocks `/resume` arguments in read-only child views and blocks that
command entirely while work is running. These are provider controls, not an independent
child runtime. Hosted phone access remains separate from local phone-layout handoff tests.

Physical phone and other-machine setup/acceptance remain separate from fixture evidence.
Private GitHub source checkpoints are implemented, not backups of conversations or all
unsaved edits. Future scope: distributed task placement/migration, cross-account assistant
sharing with explicit consent, stronger isolation, a packaged installer and streamlined
login-item setup. The old phone-assistant repository and its services remain separate.
