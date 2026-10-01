# Operations

Keep the local gateway at `http://127.0.0.1:4330`; never point a tunnel at this entry.
The owner authorized implementing secure phone access and agent-led Cloudflare setup.
Normal local APIs now require the installation's scoped authorization. Open the installed
app for its one-use browser handoff; see [local opening and reconnect](LOCAL_ACCESS.md).
The underlying listener stays at 127.0.0.1; the private browser hostname is another local
name for it. Outside agents should use the scoped QUARK client in AGENT_USAGE_ACCESS.md.
Only the separate authenticated entry may receive a scoped tunnel after its security
checks; both listeners stay on `127.0.0.1`. No paid upgrades or purchases. Follow
[CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md). Phone-sized layout tests do not prove hosted access.

## Phone connection after agent-led setup

Open **Settings → Phone access** in the new app. Temporary provider/tunnel failures do not
require re-authentication; a real 401 does. A private listener-port change no longer revokes
pairing. The versioned trust identity includes public origin and authentication identity;
changing those still disables access and invalidates the old trust. Upgrade migration only
preserves an exactly matching old configuration. If the configuration and software change
together before migration, the old hash may be unprovable and require re-pairing.

On the computer, open **Phone access** and choose **Turn on phone access**. The app starts
its configured connector and shows when the connection is ready. Choose **Create a new
code** to reveal the QR, address and pairing instructions. The address being online does
not itself open pairing. Scan the QR into Safari on iPhone or Chrome on Android: the
phone goes straight to **Name your phone**, with the code held out of view. Enter a
**Phone nickname**, choose **Continue**, then **Save passkey**, and confirm the matching
number on the computer. New codes allow 15 minutes for that whole sequence; scanning
does not submit or approve enrollment. Pairing then closes.
Without scanning, the bare address opens **Enter pairing code** with only **Connection
code**. Its **Continue** moves to the separate nickname screen without a pairing request;
the nickname screen's **Continue** checks the code with the server. **Use a different code**
returns to code entry, preserving the nickname. A rejected code also returns to that screen.

After computer confirmation, the Home Screen guide opens. **Open my workspace** finishes
setup even if the person prefers the browser. The server saves setup completion for this
paired browser. Installation help remains available in Phone access. There is no app lock,
inactivity timeout or repeat passkey prompt; existing paired phones are retained on upgrade.

**After pairing**, add the paired browser page to the home screen if wanted and check access there.
An icon installed before pairing may need adding again from the paired browser; an existing
installation is not automatically updated with its later cookies. The new-install cookie
behavior and physical-device acceptance limits are in [PHONE_ACCEPTANCE.md](PHONE_ACCEPTANCE.md).
The QR carries a temporary code in a URL fragment, scrubbed before app/API startup and kept
only in page memory. Do not share or record the QR/link. A reload does not recover that
code from browser storage; inspect pairing status before starting again.

Initial phone-managed passkey registration and computer confirmation remain required; no phone
GitHub/Cloudflare account login is needed. The real hostname's paired boundary is now
verified. The owner confirmed successful physical Safari enrollment; Home Screen,
cellular and restart checks remain. See [PHONE_WORKFLOW.md](PHONE_WORKFLOW.md) and OWNER_CHECK_IN.md.

The app automatically retries an exited owned connector up to three times, with increasing
waits of at least 5, 15 and 60 seconds. It shows Connecting while recovery is pending; after
repeated failure, **Reconnect phone access** retries explicitly. Two minutes of continuous
readiness renew automatic recovery. Running connectors handle ordinary network reconnection;
their processes are not restarted merely because the address is temporarily unready. These
retries preserve approved devices and end when access is turned off or the app closes.
A private-token setup error still needs repair. In paired mode, **Turn off phone access**
closes active connections and pending pairing while retaining approved devices. Turning it
back on lets those browsers reconnect without verification. **Remove device** explicitly
revokes that device and closes its private streams; a removed device needs fresh pairing.
App restarts and backgrounding do not unpair it. The approved browser credential is random,
stored only as a hash on the computer, and sent in a Secure, HttpOnly, SameSite=Strict,
host-only cookie. It requests 400 days of browser retention, renewed on visits; storage
survival is not guaranteed. Browser data loss or a deliberate trust/origin reset can require
re-pairing. There is no app-level physical-device security. Initial registration may use the
phone's verification, but no recurring unlock is requested. A synced passkey alone cannot
pair another browser. The older `access` authentication mode remains rollback-only and
retains its provider sign-in; it is not the normal phone setup.

The setup agent installs the scoped runtime token as a regular 0600 file at
`data/cloudflare-tunnel.token`; no Cloudflare account-level setup credential enters the app.
Without that file, the connector is externally supervised (advanced mode). The host-only
`DOCK_CLOUDFLARED_BIN` override can select an installed binary when PATH does not include it.
Shutdown preserves enabled intent/device sessions for restart. A lifetime-pipe host cleans
up the owned connector after a gateway crash. Readiness only proves the connector reached
Cloudflare, not that the full phone workflow passed acceptance. See CLOUDFLARE_SETUP.md.

## Normal use

### Standing authorization for this build

The owner has delegated routine approval judgement for completing Agent Dock. This
covers reversible source/configuration changes, dependency setup, tests, verified Git
checkpoints to the existing private remote, restarting Agent Dock's own local service,
and relocating this new clone with its history and runtime preserved. Resolve exact
targets, avoid overwrites, verify the result, and record meaningful decisions. Do not
stop merely to ask again about actions already covered by that authorization.

Keep making independent, in-scope progress when one feature has a blocker. Distinguish
a feature limitation, optional setup issue, and a genuinely blocked overall objective.
Ask the owner only when the remaining useful work actually needs new authority or
missing owner information. Never silently reduce the requested scope to make a goal
look complete; tests are evidence for the behavior they exercise, not proof of every
requested capability.

This is not permission to change OS privacy/security controls, expose remote access or
modify credentials beyond the specifically authorized phone OAuth/setup above, delete unrelated user data, perform unapproved consequential
external actions, or relax Agent Dock's code-enforced approval/integration gates.
Authorization from this owner does not grant access to a collaborator's machine or
data. Repository guidance records workflow expectations; it does not change Codex's
technical sandbox settings or macOS access controls.

### Project workflow

In the running app, use **Chats → New → Project manager**, name the project and choose
its manager and worker preferences, then **Spawn**. Describe the project in the saved
full-page notepad; no model work begins until **Send**. No terminal commands or prior Git
setup are needed for a new project.
The host creates a private `data/projects/<generated-id>` repository and manager with a
local save identity; it does not change global configuration or start a model turn.
Back up `data/projects/` separately from the database, alongside task worktrees.
On Mac, **Use an existing project folder** opens a host-native chooser. The browser submits
only a retry ID and optional provider choice, never a filesystem path. Select an existing Git project's main folder
with a first commit; cancel to return to the untouched new-project draft. Existing files,
Git configuration and history stay unchanged. A completed selection is retained privately
for safe retry after a lost response/restart. Only one chooser can be open, and stopping
the gateway cancels it. Demo mode never opens an OS dialog. The `dock add` CLI remains
available for advanced use and platforms without the native chooser.
Each repository has a primary manager. Add module managers from the team panel when
different parts need separate conversations and responsibility. The task form defaults
to the selected manager; the workboard shows its owner. Managers can inspect and message
peers but cannot delegate or decide each other's tasks. Give a manager a result and an acceptance check. It can
delegate research, a short plan, implementation and review. Native capabilities remain
available for inspection/research; task changes still follow the exact review/apply flow.
You can read or message any worker through the team panel.

Existing connected repositories need a first commit and Git author configuration
for worker checkpoints; app-created projects receive both automatically.
Uncommitted owner edits stay in the original checkout and do not enter task worktrees.
Only clean, independently reviewed work can be applied. The manager applies it by default
through exact source/target validation. Enable **Let me review changes before they are
applied** in project settings to require the human path. Choose **Apply changes**,
inspect the preview, then **Confirm and apply changes**. Technical details retain the exact
source/target versions. Connection errors stay visible in the dialog, and retry uses the same
preview and request ID. Integration is
fast-forward only. If the project advanced independently, choose **Prepare updated changes**
in the current reviewed-changes screen. This creates a separate task for the same manager,
preserves the original review and worktree, inherits the task's allowance caps and requires
another independent review before application under that project's policy. It never deletes another task's
changes or applies a merge implicitly.

The manager's knowledge consists of its provider conversation, saved checkpoint,
current tasks/team/decisions, and evidence retrieved from worker transcripts. It is
not magically aware of unreported filesystem edits. Ask it to delegate an inspection
when external changes matter. Inter-agent messages and completion reports are retained.

### Attention and queued work

**Needs your attention** is a cross-project navigation view. Open the original conversation
to answer an approval or ask its manager to resolve a decision; open reviewed changes in
the workboard for the existing exact preview/confirmation. Nothing executes merely by
opening the list. Failed backups remain local and use their existing explicit retry.

**Work queue** controls admission of new queued root-agent turns and registered local jobs. Pause does not cancel
running work, release a native terminal, alter pending approvals or start a second scheduler.
If a change loses its acknowledgement, **Retry queue change** checks the same saved request.
Other queue settings remain unavailable until that request is confirmed, so retry cannot
accidentally reverse a pause because a background reading arrived.
Choose 1–4 concurrent groups and save; settings survive restart and appear in manager context.
Native helpers are part of their parent group. QUARK adds shared allowance reservations,
priorities, task budgets and local CPU/memory admission; see [QUARK](QUARK.md). Inspect
interrupted work before resuming it, even after resuming the queue.
Backend behavior and all four viewport layouts are verified.

### Saved views, drafts and the personal assistant

**Open conversations** stores each browser's saved views on the selected computer. Another
device can explicitly open those views and copy a draft, leaving the original intact.
Same-browser tabs use revision checks; conflicts preserve the unsaved version for visible
comparison. Unchanged copied drafts share a durable delivery receipt. A lost response
does not authorize another message, steer or resume; check its receipt first. Connection
errors clear on recovery without hiding an unrelated failed action.

Reopening saved views resumes the same provider thread IDs without model turns. Two
reconnects at a time are allowed across all browser requests. Interrupted work and old
approval expiry are still visible; uncertain turns are never replayed. Context caching is
provider-owned. Search retained project evidence through **Search saved history**; host
recovery records are retained even when a worker never saved an optional checkpoint.

**Your assistant** creates a fresh coordination-only conversation. Select project visibility
and saved preferences in **Assistant settings**; the default shares no projects. It sends
bounded owner requests to existing managers and returns their source-linked outcomes.
Reports cannot trigger another route loop. It cannot create implementation tasks, use
worker tools, approve requests or integrate changes. Visibility applies on every read;
removing a project stops future sharing but cannot erase text already in provider history.
Each selected computer keeps a separate assistant and privacy scope. Follow
MULTI_COMPUTER_SETUP.md for agent-led host connections; do not copy account credentials.

### Source checkpoint backup

Recommend GitHub signup/sign-in as part of agent-led setup. Configure each project's
private source destination using [SOURCE_BACKUPS.md](SOURCE_BACKUPS.md). Reviewed task
checkpoints and exact approved integration are backed up without changing the checkout.
The sidebar and manager context distinguish waiting, saving, verified remote success and
failed/missing setup. A failed backup preserves local work and offers an explicit retry.
This does not replace private database, worktree or provider-history backups below.

## Stop, update and recover

### Development resource ownership

During this build the owner wants no idle development browsers or localhost servers.
Keep Agent Dock's login service stopped while testing. Start only the temporary server
and browser needed for a specific check; use `finally`/test-runner teardown on both success
and failure. Do not leave a preview running at handoff or reinstall the background service
as a routine final step. Verify owned PIDs and listening ports have gone away. macOS and
editor listeners are not abandoned app servers; never use a blanket Chrome/Node kill.

On this development Mac, `dev.agentdock.server` is also disabled in launchd to prevent
the installed service from returning at next login. When the owner wants background use
again, explicitly enable that one user service with
`launchctl enable gui/$(id -u)/dev.agentdock.server` before `pnpm dock service start`.
This does not delete its installation, projects or history. Ordinary temporary testing
does not need to re-enable it. Playwright owns its isolated server and browser; the server
gets a graceful shutdown before the runner's bounded process-group cleanup fallback.

### Background use and recovery

The app's **Recovery copies** view creates and checks private same-computer database
snapshots without exposing downloads or replacing the live database. It covers conversation
archives/metadata, not project files, provider-native history or full-machine recovery.
Follow [RECOVERY_COPIES.md](RECOVERY_COPIES.md) for a separate-directory restore and phone
trust review. Source checkpoints on GitHub are not conversation backups.

Managed Claude uses the installed native subscription and native capabilities by default;
saved explicit restrictions remain. See [MANAGED_CLAUDE.md](MANAGED_CLAUDE.md). On app startup its saved conversation
handles are inert, and explicit work resumes the original identity. Do not eagerly launch
an interrupted Claude session just to show history. Codex reconnects its saved native
threads without replaying prompts. Neither promises restoration of old PTY screen contents
or exact hidden cache state. VS Code mirrors may require reopening the editor/original chat.

For the required manual Mac workflow, open **sciencewithagents.app** from the user’s Applications folder after login. Its small local
launcher starts the existing server and browser, or opens the matching installation
already running. It refuses an unrelated server/different clone at the same address.
Closing Safari/Chrome leaves the app running for the phone. **Quit sciencewithagents → Stop and
Quit** gracefully stops only its own server, workers and connector; saved work remains.
The owned lifetime pipe also stops the server if the launcher supervisor disappears.
A pre-existing separately started server is not owned or stopped by this app icon.

The setup agent creates/installs the launcher using CONTRIBUTOR_SETUP.md. Runtime logs and
launcher receipts stay private under `data/launcher/`; no Node/SSH process-name cleanup.
Moving the clone or Node/Codex installation needs a launcher rebuild by the setup agent.
Streamlined login items are deliberately TODO, not a requirement for manual restart.

For optional advanced macOS background use, `pnpm dock service install` installs
`dev.agentdock.server` in your user LaunchAgents. It starts after login, not before
login. `service status`, `service stop`, and `service start` manage only that service.
Its stdout/stderr are private files under `data/logs/`. Never commit them.
Stop/reinstall waits for the exact previous gateway process to exit before reporting
shutdown complete. A shutdown timeout leaves that process alone and reports the issue;
it is not permission to kill unrelated processes or change OS security settings.

macOS may deny a background Node process access to Documents/Desktop even when the
foreground terminal is allowed. Installation checks the actual service's HTTP health
and unloads a failed service. Do not keep retrying a privacy denial or weaken privacy
settings automatically. The owner can approve moving the clone to an ordinary development
directory, or grant the intended process access in System Settings. The same consideration
applies to repositories registered under protected directories.

Before updating, let active turns finish or explicitly stop them. For a normal manual-launch
installation, quit Agent Dock with **Stop and Quit**, have the setup agent back up/update/
build the clone, then reopen the app. Do not enable a login item as part of an update.
For installations already using the optional login service, the setup-agent sequence is:

```sh
pnpm dock backup
pnpm dock service stop
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build
pnpm dock service install
```

For foreground use, Ctrl-C stops the app. Reopen with `pnpm start`. A database lock
prevents two gateways from using the same data directory. A stale lock is removed only
when its recorded process no longer exists; inspect a suspicious lock locally instead
of deleting one belonging to a live server.

After a crash, the transcript, job state and events remain. In-flight turns are marked
interrupted and old approval cards expire. Inspect the last visible tool results and
worktree before pressing Resume. The app does not infer whether an uncertain external
side effect succeeded. Retrying the same request key cannot authorize it twice.

If provider history cannot resume, use New context. The next turn includes the checkpoint,
recent messages and current project state; older visible messages remain inspectable.
Hidden reasoning and a byte-for-byte context cache are not part of the archive. Very
large individual tool outputs are bounded and labeled; full provider history may retain
more. Tool output, markdown, filenames and provider responses remain untrusted.

For native-child recovery, direct the controlling parent to reuse the saved
child ID. On the tested legacy backend it must explicitly use native `resume_agent`
before `send_input` after a provider restart. A `notFound` reply to send/wait alone is
not proof that history is lost. Check for a **new child-owned** result before claiming
delivery; do not silently replace the child or replay uncertain work. A missing optional
checkpoint is separate from missing visible history. See the
[orchestrator troubleshooting wiki seed](ORCHESTRATOR_TROUBLESHOOTING.md) for evidence
and version-specific limits. Native-inheriting managers and workers can use native helpers;
saved restricted contexts retain their earlier role/concurrency limits. Native helper
concurrency is provider-owned, while QUARK admits and supervises the owning group. Children
retain their observed identity and workspace; wait for the entire group and any required
independent review before requesting exact integration.

## Native terminal and existing sessions

After a network drop or phone sleep, **Reconnect terminal** reattaches to the retained
terminal without closing it or replaying input. If another device owns input, **Take control
here** explicitly transfers ownership. It never steals control automatically on wake.
Disconnected keyboard controls are disabled; Return to chat remains a separate action.

Send a first chat message before opening the Native terminal. Browser refreshes preserve
the fixed Codex PTY; a new browser or `pnpm dock attach <agent-id>` takes ownership of
its input. Closing the browser does not interrupt a running turn. Return to chat closes
only that CLI view and releases queued work; the managed provider session persists.

Use the application session menu to create context and **Existing Codex sessions** in
the team panel to discover and import saved history. The CLI uses the same history adapter.
Native `/fork` branches the current idle context; `/new` opens a fresh context with role
tools; `/resume <thread-id>` returns to a saved context or transfers to its registered agent.
These retain its identity, archive and task workspace. The host subscribes before the
CLI continues. A forked goal waits for the owner's next turn. Native transfer uses the
target's own Codex process and updates browser selection; local `dock attach` keeps its
input connection. It never loads the target under the source's role or workspace.
Both agents must be idle. A failed target attachment leaves the source usable. An
already-open target terminal must return to chat before selecting a different saved
context. Only one native owner can occupy a task workspace; explicit transfer releases
the source. The team selector remains available as well. A new
context preserves archive continuity, not an exact provider
cache. Model/effort changes in native mode are persisted; managed permission defaults
apply when structured chat resumes. Native mode remains an owner-authority surface.
If a context attachment fails, return to chat and inspect before resuming the recorded
context. The app closes native input when its host connection cannot track work.

### Native capabilities and optional saved restrictions

New Codex and Claude contexts inherit native tools, hooks, skills, MCP/plugins and permission
choices. QUARK adds observation and owned-work supervision without rebuilding those choices.
It does not grant permissions or provide desktop-host capabilities absent from the installed
CLI. Existing contexts keep their saved policy. An idle conversation can choose **Use my native
settings**; **Tools for new workers → Use native settings** changes future project delegations.

The individual Codex settings below apply to explicitly restricted contexts, including older
saved contexts. They are advanced compatibility controls, not required setup for native work.

### Optional web-search restriction

In an idle worker's Session settings, choose Off, Cached results, Index-gated access or
Live web. Return any native terminal to chat first. Saving reconnects the provider but
does not start a turn, change shell permissions or erase the saved context/history.
The choice applies to chat and native new/resume/fork contexts and survives restart.
Restricted legacy managers have no web-search tool. Native-inheriting managers retain theirs.

Restricted workers use their selected search mode. Existing restricted records without this
setting retain their previous disabled behavior; no historical data is rewritten. Cached search uses
OpenAI's index, live search retrieves current results, and indexed mode gates external
web access through the search index. Queries leave the computer and results remain
untrusted in every enabled mode. Do not send secrets as search queries.

Web search is a hosted Codex capability, not shell network access, an MCP server or a
browser-control permission. Existing command sandbox and original approval gates remain
unchanged. Local/managed Codex search restrictions still apply. See the official
[web-search documentation](https://learn.chatgpt.com/docs/web-search).

### Generated images

In a restricted Codex worker, enable **Use built-in image generation** in Session settings.
Older restricted records default to off; native-inheriting contexts use native configuration.
Return native mode to chat before changing it. Saving reconnects without starting work or
losing context. Restricted legacy managers do not have this individual toggle.
Prompts are sent to Codex's image service and generation consumes the Codex allowance;
Agent Dock does not introduce an API-key fallback, external publication or OS permission.

Completed native PNG results are retained as private SQLite blobs, with only metadata
in conversation JSON/events. Preview, open full size, or download through the image's
agent-scoped ID. The app never reads a provider-supplied image path or fetches a result URL.
Images are limited to 8 MiB, 8,192 pixels per side and 32 million pixels. Unsupported,
missing or oversized output gets an explicit retention notice, not automatic regeneration.

`dock backup` includes these image bytes. Conversation JSON exports contain image metadata,
not the bytes; download the images separately when sharing an export. Repositories,
worktrees and Codex's original output storage still need their own backups. No image is
automatically copied into source control or integrated into the project.

The desktop app's built-in browser is a separate host capability, explicitly unavailable
in Codex CLI according to the [official browser documentation](https://learn.chatgpt.com/docs/browser).
Computer Use plugins may require their desktop host and separate OS/app approvals. An
installed plugin or a feature flag alone does not establish that those hosts are available.
Agent Dock does not change those controls or add a remote desktop.

### Optional MCP tools

Configure and authenticate trusted servers with the native provider. Native-inheriting
contexts retain that configuration and its permission rules. For a restricted Codex worker,
select names in Session settings and return its native terminal to chat before changing
selection. Saving reconnects that worker's provider while retaining its context and archive.
Restricted contexts enable only their selected servers; legacy managers have no selector.
The browser receives server names, not transports, commands, environment values or credentials.

In the restricted Codex path, selected MCP calls require a prompt, including calls with
automatic grants in local configuration. Native-inheriting contexts preserve native grants.
Approve or decline its exact pending request in the app or native terminal. A repeated
app reply does not execute it twice; disconnected requests cannot be replayed. Native
attachment starts with on-request approvals and the managed sandbox; deliberately choosing
"never ask" in native controls causes approval-requiring MCP calls to be declined.

MCP server startup and tool execution are outside the worker's filesystem sandbox.
Tool-call approval does not sandbox a server process or approve an authentication flow.
Enable only servers you trust. The extended OpenAI form variant is declined; MCP server
configuration/authentication remains local to Codex. Installed server definitions stay in Codex
configuration; the adapter holds effective settings only in private process memory.
No host configuration or credentials are rewritten by selecting a server here.

Standard typed MCP forms appear in Conversation, including forms requested by a native
terminal turn. They name the recipient server and support text, numbers, booleans and
single/multiple choices. Explicit submission is validated against that original request
on the server. Defaults are suggestions, never automatic submission or tool approval.
Submitted answers are saved in local history before forwarding; the subsequent tool
result is the evidence of delivery/effect. Do not enter passwords, API keys or payment
details. Reload retains the pending request, not unsubmitted form answers. After service
restart an abandoned request expires; inspect before asking the agent to try again.

The form boundary allows up to 32 fields, 100 choices per field and 8,000 characters per
text value, within the existing HTTP request bound. Standard length/range/format and
selection constraints are enforced without coercing types. Unsupported nested schemas,
references, patterns, unknown extensions or malformed constraints are declined explicitly;
no schema URLs are fetched and no server-supplied code is executed by the client.

URL elicitations also appear in Conversation. Inspect the requesting server and actual
destination, then explicitly open the page and allow or decline the original request.
Opening a page does not answer Codex; allowing the request records permission, not successful
authentication or completion. Inspect the subsequent tool result. An allowed link remains
in your private history for handoff, but may expire. Abandoned requests expire on restart
without replay, and an old accepted link is not evidence its external flow can still resume.

Only HTTPS and literal `127.0.0.1`, `localhost` or `[::1]` HTTP destinations are allowed.
Credential-bearing, ambiguous and non-web URLs are declined. The app does not fetch,
proxy or automatically open links; outgoing links have no opener or referrer. A loopback
URL points to the device opening it, not necessarily the computer running Codex. This is
not secure hosted phone access. Temporary URL tokens stay in private local history and
owner exports; the structured link field is excluded from `dock_inspect` and host context.
Keep exports private. Agent Dock does not store new credentials or claim OAuth completion.
For a native-started URL request, follow the native tab's **open Conversation** prompt.
If using local `dock attach`, open this agent's Conversation in the app. The tested native
CLI immediately declines URL-mode requests on its own; the private relay leaves those
requests to the subscribed host UI instead. Original tool consent, ordinary forms and
native interruption are unchanged. No URL approval or completion is synthesized.

### Installed plugins and connected apps

Native-inheriting contexts reuse enabled native plugins and connected apps. For a restricted
Codex worker, **Use installed Codex plugins** is an optional Session setting, off for older
records and unavailable to restricted legacy managers. Treat installed plugin code and server startup as trusted
local integrations, not task-sandboxed code. Native `/plugins` provides the existing
Codex catalog; install/authentication remains an explicit owner action in Codex.

Only the restricted Codex path overrides these grants to prompt and inventories plugin tools
in an ephemeral context without starting a model turn. Native-inheriting launches skip that
probe and retain native permission choices. Changes to plugin configuration
require returning to chat and reopening native mode before another turn. Ordinary model/UI
preferences do not require a plugin reload. Reconnect retains identity, history and checkpoint.
If inventory or policy validation fails, no new turn starts; inspect local Codex setup.
The private native relay and structured provider adapter accept responses up to 16 MiB
for catalogs and generated image results; CLI input remains bounded at 4 MiB. No catalog
payload reaches the web API, and encoded image bytes do not enter conversation JSON.

`pnpm dock sessions <project-id>` pages through matching local Codex sessions from the
registered repository root. CLI, editor, App Server and native subagent sources are
included; sessions saved from a different directory are not silently taken over.
Stop the original client before `pnpm dock import <project-id> <thread-id> --stopped`.
Use `--manager <manager-id>` to assign imported history to a module manager.
Imported sessions start read-only, with no invented parentage from historical logs.
They do not automatically become managed implementations; delegate new writes into tasks.
Discovery and import never start a turn. A reported active or changing source is refused;
the owner must still confirm that an independent original client is stopped because a
separate App Server cannot reliably establish that client's state. Failed paged reads
leave no partial archive and can be retried. Very large histories are refused with an
explicit limit, not silently imported incompletely. Fresh coordination tools require
New context when the original external thread does not contain those tools.

## Backup and sensitive data

`pnpm dock backup` uses SQLite's online backup API. It does not copy credentials.
Back up registered Git repositories, `data/worktrees/`, and provider thread history
separately if full-machine recovery is required. Store all backups privately. To restore
the database, stop the service and preserve the entire current data directory first;
restore into a separate data directory and point `DOCK_DATA_DIR` there. Do not mix old
SQLite WAL sidecars with a restored database.

Never publish `data/`, `.env`, credentials, uploads or logs. Automatic checkpoint checks
catch common secret patterns, not every possible secret. Review the proposed commit.
The app is a trusted single-owner local tool, not an isolation boundary against software
with your OS privileges. Share source by cloning; each collaborator uses their own
Codex installation, login, registered repositories and runtime data.
