# Feature map

**Recovery layout (2026-10-01): implemented.** Recovery copies and retained browser drafts
use bounded, independently scrolling lists. Each copy expands for its counts, reference,
verification and update request. Desktop uses the page width with help alongside; phones
stack the panels. Existing copies, retry receipts and draft downloads are preserved.

**Readable app text (2026-10-01): implemented.** Body copy, settings labels, forms, chat
messages and supporting details share a larger text scale that respects browser text sizing.
The three main Home destination tiles keep their existing sizes. Narrow controls wrap, the
notepad's lines scale with its text, and large native Safari fields retain their own text
scrolling. Slider thumbs reach their native endpoints; when stop labels cannot fit at the
chosen text size, the current choice stays visible without splitting words. Automated checks
cover control bounds, overlapping labels and enlarged text in addition to whole-page overflow.
Zoom and phone evidence is recorded in VERIFICATION.md.
Model preferences use aligned provider choices, consistent card/section spacing and fields
that stack with available width or enlarged text. The shared spacing reset also preserves
the intended paragraph/heading gaps on Settings and project setup.

**General model preferences (2026-10-01): implemented.** Settings → Model preferences owns
new-project manager/worker defaults, separate from per-project customization. Model levels in
preferences and Welcome read Postdoc → Grad student → Undergrad → Uncle.
Model preferences separates project defaults and app assistants, with detailed model mappings
under **Model levels and advanced choices**. Assistant menus show their effective provider/model
instead of an opaque preset; computer-health and unattended checks share one choice.
Choosing a manager at project setup preserves independent assistant defaults. The creator's
corrected matrix starts at Balanced + Tokenmax (the provider's Only preset for one-provider
installs), follows live family versions and supports exact pins. Restore recommended defaults
stages the original recommendations for saving while retaining subscriptions and existing
projects. Project registration and previews use the same saved preference snapshot; family
remapping reaches worker dispatch. Project-specific routine/calculation/orchestration choices
keep the project's provider, with stronger calculation requirements. Legacy projects preserve
saved behavior and can explicitly adopt current general preferences. See MODEL_POLICY.md.

**Optional account prompts (2026-10-01): readable and copyable in Apps and Help.** Prompt cards
set both text and background colors, avoiding the shared code-block style that made their
contents appear blank. Copy and manual-selection fallback have focused responsive checks.
These remain setup-agent instructions, not automatic account-readiness detection. Confirmed
unfinished orb and update-flow requests are listed in [Build status](STATUS.md).

**Helper visibility (2026-09-30): implemented with a native-editor limit.** App-created
Codex contexts now carry durable ownership/provenance; native helpers and managed contexts
are excluded from our shared/saved-session pickers. Internal development projects no longer
appear as owner-created managers or project counts. Finished app-owned task workers and
released resource/finder sessions are natively archived, preserving history and allowing
explicit reuse. Imported personal chats are unaffected. Codex's own VS Code picker has no
verified supported hide-active-helper setting in the installed version; separately launched
active helpers can remain visible there until archived. Companion 0.2.7 includes the picker
filter and activates on the next normal editor restart.

**Latest owner corrections:** The VS Code control at the top of Chats opens connection/setup status and
extension instructions, without navigating to a chat list. Shared chats load their first
history in background browsers and refresh on returning to the foreground. QUARK tasks
can be closed with a saved reason when no more work is needed: cancel queued task replies,
retain files/conversations/reviews/allowance records, and keep the closed task out of Active
work. Running work and open subtasks must be resolved first; closure does not approve or
apply changes or release a spending cap.

## New-install prompts and first project — implemented, 2026-09-30

The website and repository offer a copyable setup request. An agent installs the local app,
checks the person's chosen native provider and models, and opens the first project setup.
Phone access, VS Code sharing and private backup remain optional. Single-provider worker
defaults follow the enabled provider; saved preferences are preserved. Managers automatically
receive the project's actual worker defaults, QUARK instructions and durable work-list rules.
Real isolated Codex-only and Claude-only first replies pass on this Mac. Another person's
account sign-in and physical phone still require that person's device/account steps.

QUARK shows one card per saved task, with worker turns grouped behind task detail. Task
completion determines the Completed column; recent finished turns are collapsed separately.
Allowance caps use the accounting ledger, not an incomplete sum of displayed turn history.
Standalone runs and local jobs retain their own entries.

## Project setup and navigation — implemented, 2026-09-30

Assisted search opens a separate prompt dialog; its description and saved result do not
change the chat-name filter. Typing, closing and reopening do not start a model turn.
Project setup shows resolved models and thinking levels rather than a blank default
choice. Unpinned manager defaults prefer xhigh when reported by the catalog; explicit
central/user settings remain authoritative. Worker defaults are a prominent disclosure
above the sliders, with each task model on its own line. Selects have larger touch targets;
review rows keep their controls and wrapped text inside padded boundaries.

Priority/cap help explains that finer choices can be given to the manager later. A 10%
cap measures ten percentage points of the full chosen allowance, from the moment it is
saved; it does not mean ten percent of what remains. Existing quota pauses retain work.
Back stays in the top bar while general pages scroll, with a 44px minimum touch target.
It returns to the previous screen and scroll position, including a project setup → QUARK
detour, and the setup draft survives reload. A short navigation trail resets at Home. Right swipes go back;
vertical scrolling, inputs, sliders and horizontally scrollable panels retain their gestures.
Native browser history remains under the browser's control.

Verified with focused browser journeys at 412×915, 360×800, 915×412, desktop and iPhone
WebKit, plus a live Safari check. Chromium phone tests exercise native touch swipes; the
WebKit swipe check exercises the DOM handler, not a physical iPhone gesture. Backend policy
checks cover xhigh selection, explicit effort preservation and catalog-only fallback.

## Chat navigation and phone refresh — implemented, 2026-09-30

The VS Code button at the top of Chats opens connection status and extension setup instructions.
Shared native Codex sessions remain under Chats. Resource diagnoses, automatic checks,
consultations and internal service contexts no longer become separate main-list rows;
Their history remains saved for the resource assistant and history APIs. Computer health
uses graphs and the assistant instead of a human-facing history browser; saved conversation
links still work. Projects and jobs appear above Apps and processes on every screen size.
The unrequested phone bottom navigation is removed. Chat search uses one compact row with
readable text. No personal-assistant feature is advertised in Settings while it is deferred.

The outer document stays fixed while designated content panes scroll. Full-height visual
viewport movement no longer pans the shell as if a keyboard were open. Keyboard reduction
and pan handling remain. Simulated viewport evidence does not establish physical iOS acceptance.
The entry document keeps no-store and an already-open client offers Reload app when it finds
a new frontend bundle. Reload is explicit so typing is not interrupted; Help also offers it.
Old clients predating this behavior need one reload to receive it. Pairing and running work
are unchanged.

On Home, pull down from the top to refresh the displayed readings and check for an app
update. A small wheel follows the pull and spins until those reads finish; failures offer
a retry message while retaining existing data. Ordinary scrolling remains scrolling.
This reads the shared cached allowances; it does not launch agents or force provider calls.
The explicit Reload app action still protects unsent drafts. Nested panels and editors
keep their own scrolling. Reads time out after 15 seconds so a lost connection cannot
leave the wheel running indefinitely.

Home's orb sits beside the computer and allowance readings, below the phone toolbar,
and uses [Thinking Orbs](https://github.com/Jakubantalik/thinking-orbs).
It starts with a random shape, stays still while idle, and randomly chooses a different
particle pattern on each tap, with varied orientation and gentle speed. Seven flowing
patterns are included; polygon-outline and Rubik-like presets are excluded. Taps have
no button halo or outline; keyboard focus remains visible. Animation stops after 1.8 seconds.
Reduced-motion settings use static shapes; hidden/offscreen animation pauses. It makes
no AI or network requests. On narrow phones the header uses the drawn alien as its brand
mark, leaving room for the 44-pixel controls.

## Home and space cleanup — implemented, 2026-09-30

The Chats, Apps and QUARK tiles together occupy about 42% of the visible phone viewport,
with compact labels and icons. Desktop tiles and resource/running panels expand to fill
the available window height. Attention and general to-dos stay compact when empty, grow
with their content, and stop at the available screen height. Each section then scrolls
independently below its heading. Clearing items shrinks the panel again. The to-do editor
starts with two lines, expands as you type and shows Add when there is text. Verified at
desktop, 412×915, 360×800, 915×412 and iPhone WebKit, including retained drafts and save retries.

Pages use the browser width. Mobile allowance readings are at the top of Home and scroll
away. Attention shows concise requests in its scrolling section; automatic
health reports and completed-worker interruptions stay out, and stopped work groups by
project. General to-dos use an expanding multiline editor with immediate local draft saving.
QUARK starts with active work; completed work is searchable and shown ten at a time.
Computer setup no longer links to recovery-copy chores or the unrelated allowance ledger.
Recovery controls remain in advanced Settings and update instructions. The allowance page
keeps detailed token and cache reports collapsed until requested. No transcription shortcut
is advertised; retained local-job records still have their original destination.

## Shared alien branding — implemented, 2026-09-30

The app header, browser icon, phone install icons, Mac launcher, VS Code companion and
public website use the owner's original curved alien drawing, replacing the pixel-style
recreation. `assets/branding/alien-drawing.png` preserves the original white-ink artwork;
`node scripts/export-web-icons.mjs` embeds it in a tinted SVG and exports the phone, Mac,
companion and website icons. The Mac launcher points directly to its `.icns`, rather than
the generated AppleScript asset-catalog icon. Existing installed phone icons may keep their
OS-cached artwork until the shortcut is re-added. Provider logos still identify their providers.
The conventional Apple touch-icon path serves the same drawing, with an artwork-versioned
link, explicit icon dimensions and app title. Phone setup includes instructions to replace a stale shortcut without clearing
browser data or removing a working connection first.

## QUARK conversation and board — implemented, 2026-09-30

Work opens a responsive board with a QUARK conversation above it. The owner can ask it to
pause/resume a project, change priority weight, save standing instructions, set a project
allowance cap or change the shared reserve. Decisions retain their original owner message;
automatic turns cannot increase allowances, reduce reserve or resume owner-paused projects.
Default: latest native Opus (this installation reports Opus 5.5), with provider/model choice.
Its private workspace and saved decisions live outside managed project repositories.
Relevant queue/forecast changes can wake it up to four times an hour; turns are bounded to
three minutes, subject to the existing queue and provider headroom. Available while the
computer is awake and the app is running, not during sleep or shutdown. Managers receive
recent actual-versus-estimated timing cases; no accuracy or completion guarantee is claimed.

Usage cards open Refresh usage, Check connection and Check & install updates. Recognized
Homebrew/npm/native Claude installations use their own installer after active app work
finishes; new work waits. Custom/bundled installations are left intact with an explanation.
Connection checking refreshes existing account/model metadata; sign-in and deeper repairs
remain explicit setup steps, with copyable diagnostic instructions. No provider was upgraded
on the owner's machine as part of implementation testing.

Sent app-managed prompts and retained conversations remain searchable when old messages
are unloaded from the screen. A bulk worker can extract requests in batches and a manager
can check for missed requirements against original source messages. Draft/native-editor
coverage is separate; this is not a claim of capturing every external conversation.

## Updates for customized installations — documented workflow

**Existing:** recovery copies and an agent-assisted source-update handoff.
**Requested:** the person's agent ports upstream changes into their customized app, preserving
provider choices, local interface changes, settings and saved work, with focused behavior
checks. The [update runbook](UPDATE_APP.md) now describes this process. It is not an automatic
merge service or a promise of compatibility with arbitrary edits. Having the agent handle
the recovery-copy preparation without the current manual UI step remains planned.

## Drawn interface — implemented slices, release acceptance in progress

The [Home/detail-panel requirements](HOME_UI_REQUIREMENTS.md) are connected through the
new Home, icon-grid Apps and setup prompts, Computer health snapshot/charts and prominent
Codex/Claude diagnostic chat with live model choices and retained evidence. Home surfaces
human action items; Subagents opens retained work and separate follow-up discussions. The
QUARK conversation/status board is described above. Native unattended controls are implemented
with the provider and device acceptance limits below; older saved restrictions remain.

**Implemented:** Spawn creates the chosen manager and worker settings without starting a
model turn, then opens the full-page project-brief notepad. The normal composer expands into
that same saved draft. Minimize returns without sending; version restore retains the replaced
text, and a lost send response retries the original delivery identity. Separate browser drafts
reuse the existing conflict and explicit device-transfer controls. Focused creation, reload,
minimize, restore and send-recovery journeys pass on desktop and phone/WebKit at portrait and
landscape sizes. See the
[notepad requirements](CHAT_UI_REQUIREMENTS.md#prompt-notepad--initial-brief-and-later-messages).

**Implemented:** normal and shared chats expose a labelled **Open notepad** control. Shared
editor drafts remain tab-local, with browser-local recovery copies and meaningful version
checkpoints; reopening offers copies without overwriting another tab. These drafts do not
sync across devices, and clearing browser storage removes recovery copies. QUARK and the
Resource assistant open full-screen conversations with a return control, keeping the board
and health charts available underneath instead of squeezing chat into a small panel.
Conversation timelines use the available width in managed and shared chats. Full-page
notepads fill the screen below a compact top bar: the entire remaining surface edits and
scrolls text. Priority, export and draft details open under **Options**, without reserving
an empty footer. Saving failures and conflicts reveal those controls automatically.
On phones, the assistant composer stays bounded so long drafts leave
room for the conversation; saved multiline drafts resize when the conversation reopens.

The [Home drawing requirements](HOME_UI_REQUIREMENTS.md) include implemented general to-do
dispatch, reusable setup prompts, sortable project allowance rates and editor setup status in Chats.
Home titles the rate table **% usage / hour**, without the explanatory rate footer.
Rate readings retain their allowance window and measurement limits. The connected
Sketchcoded board distinguishes actual drawings from undrawn destination frames.

The [chat drawing requirements](CHAT_UI_REQUIREMENTS.md) capture the new chat shell,
New/terminal/contact choices, separate manager and worker settings, corrected model
matrix, QUARK controls and notes/to-do panel. The drawings and their handwritten
functionality are saved in **sciencewithagents · fresh design** in Sketchcoded.

Chats now supports an explicit **Find the right chat** match using the central bulk Luna/Sonnet
helper policy. One bounded request considers at most 40 conversation candidates, 20 projects,
32 saved-history excerpts and 8 editor-chat titles, with a 180-second ceiling. The saved
suggestion is only a result; it does not message, open or change a conversation. This search
samples retained excerpts, not the complete archive. The backend search/focus tests passed
21 checks, including three runtime tests with the real RuntimeDemoProvider. Search/focus browser
acceptance passed 10/10 across five profiles: the ranking transport used fixtures and navigation
opened the actual selected link; checks confirmed no model call on typing/open and no message to
the selected conversation.

**Focus this project** can pause other real projects and saves a receipt for those pauses.
Leaving focus restores only pauses that are still unchanged from that receipt; quota caps and
manual holds stay in force. Project setup now offers High, Default or Back burner priority and
an optional cap based on a reported allowance window. Priority request retry after a lost
response and reload reuses the same receipt. The focused priority check passed on desktop and
iPhone; browser acceptance also verified the real focus API and lost-response/reload recovery.

The remaining native terminal and physical-phone acceptance is separate. An unchecked box in
the design docs does not imply the source is absent.

## Manager action items and context continuity

**Implemented:** persistent project/task records, visible worker state, saved decisions,
conversation history and explicit free-text `dock_checkpoint` handoffs. Current host context
includes saved checkpoints and task summaries. Home shows an attention count and the first
two items, linking to a full inbox. That inbox derives pending permissions, tasks needing a
decision, failed/interrupted agents, reviewed changes ready to apply and source-backup
problems from existing state. Native questions are answerable in the original chat.

**Implemented:** managers can maintain revisioned internal and human work items and project
notes. Current items return in their context after restart/compaction. Human summaries appear
on Home; replies and project assignment retain a delivery identity. Instructions require
continuing independent work while another item needs a person. The app preserves the list;
it cannot guarantee a model always keeps its descriptions current.

**Implemented, one live continuation observed:** managed Claude launches configure native
60% automatic compaction and pre/post-compaction handoff hooks, including saved work items.
In one real frontend run, the handoff was recorded at 05:50 UTC; PostCompact restored a
26,375-character provider summary at 05:52 UTC. After compaction, the agent produced and
recorded 160 tool entries and 44 assistant entries, then finished its work. This confirms that
one run continued through native compaction; it does not prove that the provider restored all
state. The configured 60% value does not measure the exact threshold reached, and this single
run does not prove that every detail is retained in every context. Codex keeps native
context handling. See the
[requirements](QUARK_CHECKLIST.md#2026-09-29-addition-manager-continuity-and-human-action-items)
and [plain-language product story](PRODUCT_STORY.md#managers-keep-their-place).

## Existing access and helper evidence

**Implemented — reuse existing access:** Welcome automatically checks native accounts/models
when readiness is missing or stale, without a prompt or automatic login. Connected local tabs
reconnect and retain their destination/drafts. Expired sessions wait for the desktop app and
retry when the tab regains focus. VS Code sharing needs no extra editor authentication.
Initial provider login, phone pairing, optional backup sign-in and separate-computer setup
remain distinct; see [connection behavior and limits](LOCAL_ACCESS.md).

**Native Claude helper totals:** completed Agent/Task responses now add the provider-reported
run total and delivered report to the existing helper record. Late transcript writes and
replay preserve attribution; helpers remain excluded from inclusive project totals. The backend distinguishes a reported total from an incomplete breakdown; these records
remain available to agents without a separate technical usage screen. Only recognized results
for already observed helpers are linked; no new provider tool, polling service or model turn
is required. Input/output detail and missing native results can still be partial.

## Research without code-change ceremony

**Implemented:** research/planning/review workers read the existing project or task files;
only an implementer creates an isolated task branch. A manager can finish read-only work or
a local-job result with recorded rationale/evidence, without an automatic independent review.
Any explicitly requested review must still be resolved. Code tasks and pre-existing worktrees
retain independent review and exact source/target validation. The manager normally applies
reviewed work; a project's human-review option requires the owner's preview and confirmation.
Active workers or queued/running/paused
local jobs prevent completion. The same task identity, spending ancestry and retained history
remain; no new job kind or scheduler was introduced. Projects still use existing registration.

## Native integration simplification — in progress

Implemented foundation: Claude's private lifecycle hooks feed the existing activity history
and check QUARK before tool execution. A quota/lease refusal also reaches the independent
owned-process supervisor. Duplicate/late events cannot revive a completed tool or attach to
a different run. Hooks preserve native permission decisions. Provider-reported thinking levels
remain selectable even when a new name is introduced; unknown advertised tools do not crash
the conversation. Claude models without thinking-level metadata remain selectable using
**Provider default**, leaving the native effort override unset. New Codex/Claude conversations and unconfigured-project delegations inherit native
capabilities without the blanket disable list, MCP/plugin rewrites or inventory probe thread.
Explicit older restrictions and bounded private/read-only assistants remain. Native manager
children are recorded in their owned family, with original identities and shared caps.
Claude forwards native permissions and questions through the existing conversation panel.
Questions support multiple choices and custom answers, with exact-request validation and
one response. Helper-marked result frames cannot complete the parent or clear its requests.
Claude also retains real helper identities with separate hook
activity/closing-text histories. Resumed helpers reuse their identity and share the owning
session's budget and stop control. Unlinked streamed text/team totals stay with the parent;
unknown models and exact nested parents are not guessed. It waits for active helpers before
completing the root job. Owned-hook transcript references now recover saved helper replies,
reported models and deduplicated input/cache usage, including delayed writes and resumes.
Completed fresh Agent/Task results now establish nested parent links when both native
identities are observed. Helper pages separate the invoking helper from the controlling root;
resumes retain their original link. Missing/background results still leave unknown relationships.
Per-helper output breakdowns and broader workspace continuity remain partial. See
[the approved account](SIMPLIFICATION_ACCOUNT.md) and [verification](VERIFICATION.md).

Claude accounting now reads live input/cache events and consecutive whole-team result totals.
It deduplicates native message IDs, avoids restored-history charges after reconnect, retains
partial evidence after failures and labels missing counts. Team totals include helpers when
the native result and baseline support it. Helper transcript counters stay separate and partial;
missing output is not inferred from native placeholders or final-request totals.
See [accounting semantics and limits](QUARK_ACCOUNTING.md#what-the-measurements-mean).

Managers receive a compact current view of jobs, grants, reservations and pause reasons;
full ledgers, model catalogs and task evidence remain available through `dock_inspect`.
Coalesced QUARK changes now accompany Codex/Claude coordination replies and the supported
Claude post-tool hook. They report cached allowances, caps, jobs, progress and holds during
existing work; they do not start monitoring turns or grant permissions. Ordinary changes wait
at least 30 seconds between notices, while new blocking states bypass that interval.
The default context no longer repeats the manager's own recent conversation. Running-job
status preserves QUARK's actual blocking reason instead of hiding it behind “Running.”

## Current connected-interface scope — 2026-09-28

Computer health and QUARK now share CPU/volume/VM sampling. The watcher adds only its
process/pressure/swap probes. Computer health shows measured owned agent/local-job trees
with their project, CPU, resident memory and process count, separately from reservations.
Tools and helpers share their registered root group; unrelated processes stay in the app list.
External/editor/orphaned processes may be absent and summed resident memory is approximate.
See RESOURCE_WATCH.md for scope; this is observation, not a new process-control system.

Explicitly requested resource assistance now uses native diagnostic tools under ordinary
workspace permissions and QUARK supervision. Automatic checks remain bounded snapshot-only
reports, hidden from the main chat list by their durable origin metadata and retained as
saved resource-assistant evidence. Merely opening a report never starts work or grants permissions.
An owner follow-up to an old requested diagnosis can resume the same history with native
capabilities. CPU readings alone are not evidence that a login or service works.

The new UI now connects **Projects, project/task detail and managed Conversations**,
including new-project creation, manager messages, worker activity, original approvals,
durable drafts and exact send retries. Finished task workers stay closed; **Ask about
this work** creates an explicitly labelled read-only discussion from saved evidence or, for
eligible Codex and Claude workers, a native conversation branch through the recorded final reply.
It retains the source model/provider, charges the original task/project and cannot
reopen implementation or change its review. Native branches are prepared on the first question;
unsupported histories fail visibly with saved evidence available as an explicit choice.
Inherited Codex goals do not continue, and historical token totals are not charged again. Claude
requires an observed completed root reply and the original account; native helpers and older
records without a boundary use saved evidence. An uncertain Claude fork resumes only its known
copy, never the original. Bounded native text-continuity checks pass for both providers,
including unchanged original history. Older/compacted and future native formats retain their
explicit availability limits; this is not a guarantee of every historical transcript.

Task detail also shows current jobs and quota pauses, planning estimates, inherited allowance
caps, recent token readings and decisions. Its budget action opens the selected task on
the QUARK board. Failed readings retain a visible stale-data notice and an explicit retry.

Home, Computer health, Model settings and QUARK accounting/budget controls remain available.
Work/Attention/review, the personal agent, shared editor chats, saved-history search, browser
view handoff, Settings, computer selection, phone controls and recovery copies are connected.
Advanced/native controls and manual task/module-manager creation are connected. Welcome/setup
now presents provider choice before account/model readiness, links saved team defaults and
first-project creation, and
provides native Codex device-code sign-in and an explicit Claude login-window action on Mac.
Claude handles authentication in its own Terminal/browser flow; Welcome checks completion.
Reloads recover the saved opening attempt without opening another window. Failed readiness
checks never authorize account replacement. Fresh empty installations default to Codex only.
Initial source/phone provisioning remain separate work.
Their engine/classic capabilities below do not certify those new-interface journeys.
See [WORKFLOW_BUILD.md](WORKFLOW_BUILD.md),
[UI_REBUILD.md](UI_REBUILD.md) and the dated checks in [VERIFICATION.md](VERIFICATION.md).

Use this page to check the original idea against the actual app. Updated 2026-09-29.
Both Codex and Claude have managed project roles as well as separate [live VS Code
sharing](VSCODE_MIRROR.md). These are different workflows: a shared editor conversation
does not become a managed worker. The owner confirmed Codex and Claude sharing works.
The **0.2.5 companion package** includes Stop reply, structural compatibility checks and
bounded history pages. Sharing connects directly to the local app, without separate editor
authentication. Long conversations and oversized tool results load in explicit pages;
original text and drafts remain. Updated app servers also page older companions’ responses,
so the phone fix does not require interrupting a running editor for a reload.
See [current status](STATUS.md) for the installed version, not just the source/package.
Existing Codex sessions on a compatible running native shared server now appear in
**Chats → Shared**, with reading, sending, exact-turn guidance and Stop. They retain their
native settings and ownership; closing the observer does not stop the terminal. The app
reuses bounded history, drafts and durable delivery receipts. Fresh unavailable history is
labelled explicitly. Simultaneous native/phone sends may join one reply. Older isolated or
`--no-daemon` terminals remain unsupported; this is not arbitrary process attachment.
See [native session sharing](VSCODE_MIRROR.md#existing-codex-terminal-sessions) and the
current dated verification. The earlier independent-client input race is not claimed solved.
This is a capability map, not a new implementation plan. [Start using the app](../README.md)
or open the [documentation index](README.md) for the right setup/recovery guide.

| Status               | Meaning                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| Implemented          | Available in code, with the linked checks/evidence. This does not certify every device or provider version. |
| Needs physical setup | The feature exists; the intended phone/computer or its account still needs setup and acceptance.            |
| Prepared             | Foundations or contracts exist, but the described end-to-end capability is not enabled/accepted.            |
| Deferred             | Deliberately not built as part of the current workflow.                                                     |
| Limit                | Not supported or not something the app can guarantee.                                                       |

Test files show what is checked; [Verification](VERIFICATION.md) records what actually ran,
on which source/version, and what remains unverified. Earlier passing counts do not certify
newer changes. Managed Claude has real native and mixed-team checks, plus four-size UI
coverage; final regressions are recorded separately in Verification. [Check-in](OWNER_CHECK_IN.md) holds
the person-only steps.

## Conversation storage and local jobs

Launcher setup can recognize a stopped moved clone, retain the prior generated configuration
and rebuild for its new location. It refuses still-present source folders, conflicting markers
and running owners/servers. This repairs the launcher only; it neither relocates project/native
history records nor overwrites an existing installed application.

Implemented: new streamed entry events carry compact identity/status metadata while saved
entries retain full text. Long replies remain intact across interleaved tool activity,
reopen and export; existing archives are not rewritten. This avoids permanent event-log
copies of every growing reply, not all storage growth. Owned transcription supervisors now
work in both source development and compiled apps, with the same pause/resume and lifetime
cleanup. Finished task workers now release their idle owned provider processes through the
existing heartbeat. Active/native-controlled work, queued input, approvals, QUARK holds,
history reads and retrospective discussions prevent release. Saved native identities, task
reviews, conversations and files remain; reopening the app does not respawn finished workers.
Task worktrees remain deliberately retained for later evidence/discussion; automatic deletion
is not implemented. This does not retire idle managers or unfinished work by a timer.

Queue changes retain their exact request after a lost acknowledgement. **Retry queue change**
rechecks that request; delayed polling cannot turn a pause retry into a resume. QUARK also
retains wakeups arriving during an asynchronous scheduling pass.

## Ordinary existing folders

Implemented on the host Mac: native folder selection can connect a ready repository or
preview an ordinary folder, then offer **Start tracking this folder**. Confirmation saves
its initial local version and creates a manager without starting work or uploading files.
Existing history/configuration and project identity remain untouched. New setup adds local
ignore defaults for common environment/dependency files, respecting the person's own rules;
it does not classify every secret or rewrite `.gitignore`. Partial setup can resume using its
saved receipt or a new native selection. Substituted roots and unrelated history are refused.

## Session controls and starting work

Advanced controls open from a conversation's **Configure → Advanced controls**. Settings
retains general model preferences, without a separate all-agent picker. Old
standalone Advanced bookmarks open Settings; missing conversation links offer the normal
filtered Chats list. Session-specific links and native terminal/context tools remain available.
Settings also omits Open conversations and Saved history; those are available from each chat's
Configure panel, alongside the chat search tools.
QUARK opens from Home or main navigation, not from the Settings grid.

Implemented in the new shell: project → Add task / Add manager, per-conversation Advanced
controls, exact model/effort settings, worker permissions and installed MCP/plugin controls,
explicit native Codex terminal, export and saved Codex session import. Task/manager drafts
and uncertain creation payloads survive reload; retry reads the same durable creation
receipt. Manager creation starts no model turn. Task creation queues its responsible manager
through QUARK, including its first-turn task allowance ancestry. Absolute-path messages can
be sent explicitly as literal text without becoming native commands.

Manual Codex context compaction now reserves shared capacity and allowance headroom before
provider input, including a signed manager lease when applicable. It retains token accounting,
automatic-turn bounds and task/review state. Context maintenance cannot orchestrate work or
report assignment completion. Monitoring recovery clears its hold without starting a new
task continuation. Native provider/history and physical-device checks remain separately scoped.

## Work, attention and applying parallel changes

Implemented in the new shell: shared queue/pacing controls, per-job detail and estimates,
local transcription, Attention and Recent Results. Task pages open exact reviewed changes
and a separate confirmation. The confirmation retains its retry key after connection loss.
Divergent branches show only the task's contribution; Apply stays blocked. The explicit
Prepare updated changes action creates one task for the same manager, leaves the original
review/worktree intact and inherits its allowance ancestry. The new task must receive its
own independent review and the project's manager-apply or human-review policy. Independent Git or filesystem races still
require fresh validation; the final integration remains a clean fast-forward.

## QUARK, shared allowances and local work

**Implemented:** Spending sliders now live with saved project/task caps on the QUARK board.
Managers are instructed to save initial whole-task estimates before delegation, using actual
provider windows. Owner adjustments save on release, retain spending already recorded,
retry lost replies idempotently and report conflicting device edits. The board refreshes
its ledger readings every ten seconds while visible; provider data and attribution remain
estimated/delayed. Explicit **Continue work** resumes quota-held jobs when allowed.
The separate allowance page is removed; old links open QUARK. Remaining allowances,
reset times and connection actions sit above the board. Detailed accounting stays queryable
by managers; cache-warming controls are removed and automatic refreshes are disabled. Help/setup no longer adds the three unrelated navigation links.

Implemented: QUARK’s account actions explain Claude read failures, retains the last successful time and
shows the next automatic check. Provider retry hints and the existing cooldown are shared
across callers and survive restarts. Throttled usage checks are distinct from exhausted
allowances; failure details contain no provider response bodies or credentials.

Implemented for a new empty installation: shared usage/resource pacing starts enabled before
work can be created. Existing projects, model configuration and saved pacing choices retain
legacy behavior. Welcome shows the current setting, stale/missing provider readings and links
to QUARK. Opening it never toggles policy or starts a model. Unknown readings can
hold protected work; explicit task/project caps and manager leases also apply when optional
shared pacing is off.

Implemented: a private local client lets outside coding agents read the shared cache and
submit new capped tasks to an existing project manager. Task caps and its first queued turn
commit together; exact receipts survive retries/restarts. No model runs for reading reports.
The [agent guide](AGENT_USAGE_ACCESS.md) and [portable skill](../skills/quark/SKILL.md) ship with
source. This does not grant an outside agent a manager lease or owner/browser/editor
authority; those use their separate scoped authentication paths.

Implemented: signed, expiring manager leases at app-chat and app-native-terminal admission and orchestration
tool boundaries; host-only renewal, original-turn checks after asynchronous preparation,
and an owned-worker pause tool with retained progress and exact retry receipts. Workers do
not manage leases. Automatic monitoring remains independent of manager availability and
continues while native terminal control is active. Native admission reserves shared slots
and budgets before forwarding input; uncertain acknowledgements retain the reservation.
Existing Codex contexts retain their native tool-catalog limitation; automatic enforcement
still applies, but the new pause tool may require deliberate New context. See QUARK.md.

Implemented: one periodic host-owned Codex/Claude usage cache; separate reported Fable
windows; first-open phone display; reciprocal manager inspection; shared transactional
reservations, task budgets, priorities/fairness, background pacing and CPU/memory/disk
admission. The owner can change priorities/budgets and inspect recent estimated/measured
outcomes. Local public YouTube transcription uses verified Whisper and shares capacity;
owned local processes can pause/resume. The new [allowance guard](QUARK_ACCOUNTING.md)
adds automatic per-run token accounting, agent/project rollups, estimated allowance shares,
owner-controlled project/task caps, active-turn interruption with durable holds, explicit
continuation. Automatic context-cache refreshes are disabled and deferred in
[issue #1](https://github.com/OscarBarreraGithub/sciencewithagents/issues/1). Monitoring/reset/headroom holds can recover after
confirmed stopping and a fresh successful reading; exhausted grants, deliberate pauses and
uncertain restarts stay explicit. Running work gets at most the remaining three-minute
last-reading lifetime during a collector error; new admission waits immediately. **QUARK** provides budget and pause controls
in the current phone/desktop interface. Ordinary background pacing still yields at turn
boundaries; quota guards can interrupt the original managed turn/group.

Limits: native child overlap is separated from project totals; external account activity
can distort attribution; 2–3 percentage-point accuracy is unvalidated. Native cache-token
accounting remains; no automatic cache warming or guaranteed retention is offered.

Real cross-provider work, real YouTube/Whisper output and the updated owner installation
are verified; detailed rollout evidence is recorded separately. See [QUARK](QUARK.md) for defaults and limits. This supersedes
older quota-pacing deferrals, not the prohibition on guessed model aliases/paid fallback.
Arbitrary OS-process control, hard resource isolation and exact completion guarantees are
limits. The website copy inventory is [PRODUCT_STORY.md](PRODUCT_STORY.md).

Temporary capacity pauses already recover after fresh usage and confirmed stopping. If the
new reading instead reveals an exhausted task/project cap, QUARK now updates the visible reason
to a durable budget hold. Original progress and stop receipts stay intact; reset/cap increases
still require owner continuation for that budget hold. See [pause recovery](QUARK_ACCOUNTING.md).

## Start and manage projects without terminal instructions

| Feature                         | Status      | Actual behavior and boundary                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A clean, shareable repository   | Implemented | sciencewithagents is separate from the old phone-assistant repository. Source setup does not copy an owner's conversations, credentials or runtime.                                                                                                                                                                                   |
| Setup from a clone              | Implemented | A setup agent follows the guide, installs pinned dependencies and builds. A disposable clean-source-install pass at 806f verified pinned installation, full build, usage collector and Mac launcher using fake CLI executables and no owner accounts. This still needs an agent/developer environment, not just an installer.         |
| Open the Mac app                | Implemented | A clone-bound **sciencewithagents.app** starts the correct installation and opens its browser view. Closing the browser leaves work running; **Quit → Stop and Quit** stops only its owned server. Actual native Quit-dialog clicks still need physical acceptance.                                                                   |
| Start a project                 | Implemented | **Add a project → Create project** prepares its private folder/version history and chosen Codex/Claude manager. Provider and request identity survive reload/lost-response retries. No work starts before a message.                                                                                                                  |
| Connect existing files          | Implemented | Mac **Use an existing project folder** opens the local chooser. Existing tracked folders stay untouched; ordinary folders offer **Start tracking this folder** with an exact preview and local confirmation, without uploading files. Reopening a registered folder preserves its manager. Other platforms retain the advanced route. |
| Installer and automatic startup | Deferred    | No packaged cross-platform installer/updater. Streamlined login items and pre-login startup are not required for the accepted manual-launch workflow.                                                                                                                                                                                 |

The source installer checks Node 24+ and Git before dependency work and reports available
Codex/Claude executables. Either provider can be absent; even an installation without either
can open for setup. Invalid explicit executable selections still fail before writes.
Optional usage-reader failures leave an explained incomplete step, not a failed app build.
Generated launchers retain stable Node/Codex/Claude entries and supply known host-tool
folders to Finder launches. Invalid explicit choices preserve a working configuration.
A source-only disposable setup, native launcher compilation and full verification pass;
this does not claim a packaged Windows/Linux installer or authenticate a new owner.

Check: [setup guide](CONTRIBUTOR_SETUP.md), [project code](../apps/server/src/projects.ts),
[project tests](../apps/server/src/projects.test.ts), [launcher tests](../apps/server/src/launcher.test.ts),
[normal UI tests](../apps/web/tests/classic/app.spec.ts), [provider setup/retry checks](../apps/web/tests/classic/managed-claude.spec.ts),
[fresh-source check](../scripts/smoke-fresh-setup.mjs).

## Managers, workers and deterministic coordination

| Feature                                | Status             | Actual behavior and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project and module managers            | Implemented        | Choose Codex or Claude and chat directly; add managers for parts of the same project. They share recorded evidence but retain their own provider, conversation and task ownership. A module is not a separate security sandbox.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Manager awareness                      | Implemented        | Managers inspect current tasks/team, saved messages, tools, decisions and checkpoints. They cannot know unreported filesystem changes; they delegate inspection when needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Atomic plans and independent review    | Implemented        | Managers delegate planning, research, implementation and review. Short plans concern the current deliverable; simple work can skip planning. Review disagreement requires a recorded manager decision, with at most two same-task revisions and a twelve-automatic-turn backstop.                                                                                                                                                                                                                                                                                                                                                                                                      |
| Parallel workers and peer conversation | Implemented        | Workers run bounded tasks in task workspaces and exchange retained messages. A manager can recall their evidence and resume available identities; this is not hidden-memory recovery.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Native helper children                 | Partly implemented | Codex records native children with their own history in the parent's owned task family. Native inheritance preserves provider concurrency settings; older restricted contexts keep their explicit limits. Claude hook IDs now create separate retained helper histories with tools and reported closing text. Resume reuses those identities; registered transcripts recover saved replies, reported models and deduplicated input/cache counters after delayed writes/resume. Fresh completed dispatches link observed nested parents; missing/background results, transcripts and individual output breakdowns remain incomplete. Helpers share root admission and owned-group stop. |
| Queue and attention                    | Implemented        | Host code owns durable state, admission and receipts outside task worktrees. **Work queue** pauses new queued work and allows 1–4 root groups; **Needs your attention** opens original issues without approving them. It is not a model-thread or spending quota.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Apply reviewed work                    | Implemented        | Independent review and exact source/target validation precede application. Managers apply by default; a project can require human preview/confirmation. Integration stays clean and fast-forward; divergence needs a separately reviewed reconciliation.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Distributed SLURM-style orchestration  | Deferred           | No global cross-computer placement, priorities, task migration or budget enforcement. Managers exercise judgment; the existing queue remains deterministic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

Check: [role instructions/tools](../apps/server/src/charters.ts), [runtime tests](../apps/server/src/runtime.test.ts),
[native-child code/tests](../apps/server/src/native-children.test.ts), [queue tests](../apps/server/src/scheduler.test.ts),
[coordination UI checks](../apps/web/tests/classic/coordination.spec.ts), [operations](OPERATIONS.md).

## Keep the evidence and recover old conversations

| Feature                                      | Status      | Actual behavior and boundary                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable visible record                       | Implemented | SQLite retains observed messages, tool results, task/agent relationships, decisions, approvals and append-only events. Large outputs are bounded/labeled. No hidden reasoning or exact context cache is promised.                                                                 |
| Checkpoints and recovery notes               | Implemented | Agent summaries and host-authored recovery records support later inspection; code checkpoints retain the task's saved changes. An optional native child's missing summary is not fabricated or a reason to repeat its completed work.                                             |
| Search and read saved evidence               | Implemented | **Search saved history** provides project-bound search, filters, paging and original retained items. Managers have the same evidence/catalog tools. Session exports remain available.                                                                                             |
| Old `.jsonl` sessions as a backup            | Implemented | **Existing Codex sessions** discovers provider-saved, non-archived sessions for the registered project root. Confirm the original client is stopped; import is atomic, read-only and starts no model turn. Original history remains unchanged.                                    |
| Complete earlier team/context reconstruction | Limit       | There is no arbitrary JSONL-file upload or live attachment to every external client. Old hidden context and missing subagent relationships cannot be reconstructed. Complete app-owned indexing begins with activity observed here; start new orchestration with a fresh manager. |
| Deliberate context changes                   | Implemented | Resume an available saved identity or explicitly start a new context while keeping the archive. Codex offers explicit compaction; Claude manages its own. Unavailable contexts are never silently replaced to make recovery look successful.                                      |

Check: [history code/tests](../apps/server/src/history.test.ts), [history UI](../apps/web/tests/classic/history.spec.ts),
[import tests](../apps/server/src/sessions.test.ts), [real import check](../scripts/smoke-session-import.mjs),
[provider limits](PROVIDER_COMPATIBILITY.md), [native-child incident](ORCHESTRATOR_TROUBLESHOOTING.md#orch-001--native-child-compatibility-became-a-rabbit-hole).

## Computer–phone handoff and restart

An exited app-owned phone connector now gets three automatic retries through its existing
supervisor, with 5/15/60-second minimum waits and a two-minute healthy period before renewing
the allowance. Repeated failure exposes manual Reconnect; off/shutdown cancels pending retry.
Running connectors keep their own network recovery. Approved-device records and the exact
configured route remain unchanged. This does not restart externally managed connectors.

| Feature                            | Status               | Actual behavior and boundary                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Open conversations                 | Implemented          | Saved selections/open views return on the selected computer. **Open conversations** lets another browser explicitly adopt views; devices need not fight over one global selection.                                                                                                                                                   |
| Separate, recoverable drafts       | Implemented          | Drafts are per browser and computer, with local fallback and saved revisions. Copy explicitly to another device; stale/offline edits stay available for comparison instead of overwriting newer text.                                                                                                                                |
| No duplicate copied sends          | Implemented          | Unchanged copied drafts share a durable delivery receipt. Retries and uncertain acknowledgments preserve the exact message/steer identity; edits become a distinct draft.                                                                                                                                                            |
| One native-input owner             | Implemented          | **Reconnect terminal** restores a view; **Take control here** explicitly moves input ownership. Disconnected input is disabled. Terminal bytes are never queued for later replay or automatically stolen on wake.                                                                                                                    |
| Manual app restart                 | Implemented          | Power on, log in and open the Mac app. Codex reconnects saved IDs/settings at most two at once, without new turns. Claude restores inert saved views and launches its original native session only on explicit work. **Reconnect saved conversations** reports individual results and safe retries.                                  |
| Interrupted work and approvals     | Implemented          | Interrupted work remains visible for inspection; stale approvals expire. No uncertain action is automatically repeated. A terminal process or unsent terminal line is not resurrected after power loss.                                                                                                                              |
| Physical restart and phone handoff | Needs physical setup | Five real idle Codex contexts survived abrupt host-process loss and restart without new turns; a real mixed-team check preserved Codex/Claude identities and lazy Claude views after restart. Physical power-off/phone acceptance is separate. Provider caches, hidden context and arbitrary in-flight effects cannot be guaranteed. |

Check: [saved-view UI](../apps/web/src/WorkspacePanel.tsx), [handoff tests](../apps/web/tests/classic/workspace-handoff.spec.ts),
[retry UI tests](../apps/web/tests/classic/workspace-reconnect.spec.ts), [five-context retry test](../apps/server/src/workspace-restore-api.test.ts),
[replay safety tests](../apps/server/src/restoration-safety.test.ts), [real restart check](../scripts/smoke-workspace-restart.mjs).

## Live editor conversations — deliberately lighter recovery

Companion 0.2.6 adds phone guidance during a running Codex turn and acknowledged Claude
queued follow-ups. Both pass real isolated native editor checks, preserving unsent desktop
drafts. Activating an installed update in an existing editor requires one safe reload;
server or phone refresh alone cannot replace its loaded companion. Phone history groups
tool activity below message bubbles, with original details available on demand.

| Feature                               | Status                         | Actual behavior and boundary                                                                                                                                                                                                                                      |
| ------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Central Codex and Claude editor chats | Implemented                    | **VS Code chats** uses the normal sidebar and conversation pane. One selected conversation per provider/window can be shared; desktop messages synchronize while native drafts remain untouched. Original approvals and advanced controls stay in the editor.     |
| Stop the observed reply               | Implemented in companion 0.2.2 | **Stop reply** targets the observed provider reply once. **Check stop status** reads the retained receipt after lost confirmation; acknowledgement is not proof that completed actions were undone. Package installation is tracked separately from source tests. |
| Compatible provider updates           | Implemented                    | Both adapters recognize required connection structure/runtime features, not a blanket version/hash allowlist. True incompatibility disables the affected bridge safely; this is maintained monkeypatching, not guaranteed future compatibility.                   |
| Editor crash/reconnect                | Deliberate limit               | Reopen the original editor conversation and share it again. Offline identity and pending delivery references remain recognizable; no automatic input replay or replacement context. Full editor crash restoration and native-terminal parity are not required.    |
| Marketplace release                   | Deferred                       | The private preview has isolated real Codex/Claude exchange and Stop checks, plus owner-confirmed sharing. Long-history/platform checks, final release metadata and explicit publication approval remain separate.                                                |

Check: [companion user guide](../apps/vscode-mirror/README.md), [bridge maintenance and evidence](VSCODE_MIRROR.md),
[web sharing tests](../apps/web/tests/classic/vscode-mirror.spec.ts), [Codex live check](../scripts/probe-vscode-mirror.mjs),
[Claude live check](../scripts/probe-claude-mirror.mjs).

## Multiple accounts on multiple computers

| Feature                              | Status               | Actual behavior and boundary                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Personal, school and family selector | Implemented          | **Computer** selects an installation, including from the paired phone. Each host keeps its own provider sign-ins, tools, projects, queue and history; account tokens and model conversations are not copied between hosts.                                                    |
| No cross-computer input mix-up       | Implemented          | Browser requests, labels and draft keys are pinned for that document. Switching reloads it; another tab stays on its original computer. Offline targets do not trigger hidden fallback or resend.                                                                             |
| Narrow SSH connection                | Implemented          | A setup agent registers a verified SSH alias and target identity. Exact typed routes cross the loopback tunnel; every request checks the host pin. No browser-selected commands/paths, raw RPC or phone credentials are forwarded.                                            |
| The owner's other two machines       | Needs physical setup | Three isolated app instances and their handoff/transport are tested; the real school/family installations still need authorized routes and local sign-in. The entry and selected target must be on, logged in, running and reachable.                                         |
| Computer capacity                    | Implemented / Limit  | The selected host reports timestamped CPU, available memory and disk in usage details and manager context; QUARK uses these for admission. Missing/stale observations are explicit. An aggregate dashboard across all computers and cross-host job migration remain deferred. |

Check: [setup runbook](MULTI_COMPUTER_SETUP.md), [host adapter](../apps/server/src/hosts.ts),
[three-host safety tests](../apps/server/src/hosts.test.ts), [selector/two-tab tests](../apps/web/tests/classic/hosts.spec.ts).

## Pair once, then open the phone app

**Implemented recovery:** malformed phone settings or a busy phone connection port leave
the desktop workspace available. Phone access shows a repair message, keeps saved pairing
and stays closed. No connector is started against the unavailable listener. Repairing the
original settings and reopening the app restores the existing trust; changed authentication
identity still requires new pairing. A failed listener can now retry inside the app.

**Implemented optional first setup:** Phone access checks native Tailscale readiness, explains
HTTPS setup, previews the exact address and saves a private connection without a domain.
The same listener, passkey pairing and owned connector controls are reused. No existing setup
is replaced, no public Funnel or persistent Serve route is created, and no sign-in is automated.
API/restart/owned-process and five browser profiles are checked; actual live Serve and a physical
phone remain device acceptance. See [phone setup](PHONE_SETUP.md). Existing Cloudflare stays available.

Scan the active QR in Safari on iPhone or Chrome on Android to open **Name your phone**
directly, with only a blank **Phone nickname** field. Enter a nickname, choose **Continue**,
**Save passkey**, and confirm on the computer. The code stays out of view in page memory.
Physical Safari enrollment succeeded. After computer confirmation, the Home Screen guide
opens directly; **Open my workspace** saves setup completion without proving installation.
App locks, recurring passkey prompts and inactivity timeouts were removed at the owner's
request. Existing approved browsers stay connected, including through this upgrade.
Add the icon **after pairing**; an earlier icon may need adding again from the paired browser.
Home Screen, cellular and physical returning-access checks remain separate. Manual fallback
uses a separate **Enter pairing code** screen, then
**Continue** to the nickname screen without a server request. **Use a different code**
or server rejection returns to code entry, preserving the nickname.
The QR's temporary code fragment is removed before app/API startup and retained only in
page memory, never local/session storage; it does not automatically submit registration.
Do not share or retain that temporary QR/link. The [phone workflow contract](PHONE_WORKFLOW.md)
is the redesign checklist; [physical checks](PHONE_ACCEPTANCE.md) remain separate from fixtures.

| Feature                               | Status               | Actual behavior and boundary                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secure private app address            | Implemented          | App-owned Cloudflare connector serves the authenticated phone entry, not the local app port. The real HTTPS locked boundary was checked. The URL itself is not secret, and Cloudflare terminates TLS; this is not end-to-end encryption from Cloudflare.                                                                            |
| Agent-led setup, no phone account MFA | Implemented          | The agent provisions through the configured Cloudflare connection; computer-side sign-in/consent stays with the person. Recommend GitHub signup when offered. Ordinary phone use has no GitHub/Cloudflare login. No purchases are assumed; this named-tunnel setup needs an available domain, not a promised free new domain.       |
| Closed enrollment after pairing       | Implemented          | The computer opens a 15-minute, single-use 16-character code. Saving the phone's passkey and confirming its matching number on the computer must finish within that same deadline. Enrollment then closes; a synced passkey alone cannot enroll another browser.                                                                    |
| Durable paired access                 | Implemented          | Computer-approved, passkey-verified enrollment authorizes only that browser via a random, hashed credential in a Secure, HttpOnly, host-only cookie. No app lock, repeat prompt or inactivity expiry. Cookie retention requests 400 days and renews on visits; browser storage is not guaranteed.                                   |
| Installation setup                    | Implemented          | After computer confirmation, the Home Screen guide opens directly. Open my workspace saves setup completion with safe retry, without requiring or proving installation. Only an approved phone can complete setup.                                                                                                                  |
| Removal, off/on and storage loss      | Implemented          | Remove device or a trust reset revokes enrollment and closes private streams. Turning access off blocks connections while off, retaining approved devices for direct reconnection. Lost browser storage may require re-pairing. Existing approved devices and history survive removal of the former locking system.                 |
| Home-screen Safari/Chrome workflow    | Needs physical setup | Responsive UI and real WebAuthn browser fixtures are checked at desktop, 412×915, 360×800 and 915×412. Actual iOS/Android install context, biometrics, keyboard, cellular and hardware handoff still need the intended phone. No offline command queue/private-history cache is installed.                                          |
| TODO: host and share project websites | Deferred             | An agent-led Cloudflare website-hosting/sharing workflow needs its own publication and access choices. The current phone address opens the private sciencewithagents management workspace; it is not a built-in way to share a project's website with collaborators. A Cloudflare account alone does not configure either workflow. |

Check: [agent-led cloud setup](CLOUDFLARE_SETUP.md), [real-device checklist](PHONE_ACCEPTANCE.md),
[pairing code](../apps/server/src/paired-devices.ts), [pairing/security tests](../apps/server/src/paired-devices.test.ts),
[phone browser checks](../apps/web/tests/classic/paired-phone.spec.ts), [HTTPS probe](../scripts/verify-phone-entry.mjs).

## Thin provider surfaces, not a replacement tool ecosystem

Codex's advanced controls below remain available. Managed Claude intentionally has a
smaller surface: chat, roles, original permission requests, model settings, Stop, resume
and new context. Inherited Claude tools, MCPs/plugins and native helpers remain available
through native configuration. A dedicated Claude terminal and advanced slash-command UI
remain in Claude Code or its shared VS Code chat.
Unsupported controls are hidden with an explanation, not sent to Codex as a fallback.
See [managed Claude](MANAGED_CLAUDE.md).

| Feature                                  | Status      | Actual behavior and boundary                                                                                                                                                                                                                                                                                |
| ---------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex native terminal and slash commands | Implemented | The advanced terminal runs the real Codex CLI on the saved session. Native new/fork/resume and model/reasoning choices retain provenance. A browser chat box does not imitate every slash command.                                                                                                          |
| Models, permissions and approvals        | Implemented | Use the installed model catalog and native controls. Structured-chat role restrictions are reapplied on return. Original requests require their exact owner response; agents cannot answer their own permission requests; manager application follows the saved project policy and exact reviewed evidence. |
| Skills, MCPs, plugins and connected apps | Implemented | Reuse locally configured Codex capabilities. New contexts inherit configured MCPs/plugins; saved restrictions and native consent remain. Native catalogs/skills stay native. Installation, account auth and configuration are not rebuilt as a browser credential manager.                                  |
| MCP forms and links                      | Implemented | Standard typed forms and explicit URL requests retain owner responses. Opening a page and allowing a request are separate; neither proves sign-in succeeded. Unsupported extended forms are declined. Never enter credentials/payment data into retained forms.                                             |
| Search and generated images              | Implemented | Worker settings expose supported search modes and an opt-in image tool. Retained PNGs can be viewed/downloaded after reconnect. These settings do not grant OS/browser-control authority.                                                                                                                   |
| Future Codex capabilities                | Prepared    | Typed adapters provide an extension boundary, not automatic support for new capabilities. Experimental interfaces and version-specific native checks remain qualified. Desktop-host-only features are not recreated; unrestricted parity with every custom terminal is not claimed.                         |

Check: [compatibility/version boundaries](PROVIDER_COMPATIBILITY.md), [native relay tests](../apps/server/src/native-relay.test.ts),
[MCP tests](../apps/server/src/mcp.test.ts), [plugin tests](../apps/server/src/plugins.test.ts),
[forms](../apps/server/src/mcp-forms.test.ts), [URLs](../apps/server/src/mcp-urls.test.ts), [images](../apps/server/src/images.test.ts).

Project overviews expose **Tools for new workers** with native inheritance as the default.
The owner can restore **Use native settings** for future Codex/Claude delegations without
changing saved conversations or needing a catalog read. Optional restrictions grant a ceiling for new
Codex workers; either provider's manager can request a subset through `dock_delegate.tools`.
The host checks the latest revision before creation and retains the actual selection in
assignment evidence. Saves are retry-safe and reject stale-tab overwrites. Catalog reads
are disposable, name-only metadata reads without a model turn. Saved worker choices remain
unchanged. Older saved Codex manager tool schemas may require an explicit new context.
New contexts inherit native tools and native permission preferences; saved restrictions
remain until deliberately changed. This older grant system is optional compatibility behavior; see [worker tool controls and boundaries](WORKER_TOOLS.md).

## Personal assistant, providers and model choices

| Feature                                     | Status      | Actual behavior and boundary                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your assistant                              | Implemented | Optional fresh postdoc assistant on either selected provider per computer. Choose projects in **Assistant settings**; none are shared by default. Preferences/priorities/commitments are editable context, not model training. Direct manager chat remains available.                                                                                                                                   |
| Assistant's authority                       | Implemented | It inspects selected evidence, routes bounded owner requests to managers and returns source-linked reports once. It cannot implement, approve or apply changes. Reports cannot create a routing loop. Revoking visibility stops future access, not information already seen.                                                                                                                            |
| Cross-account assistant memory/routing      | Deferred    | Selecting another computer is not consent to share school/family conversations with a personal model. Any future sharing needs an explicit policy.                                                                                                                                                                                                                                                      |
| Provider identity and per-worker assignment | Implemented | Codex and Claude managers can choose each new worker's provider/model/effort with a recorded difficulty and reason. Same-provider omissions inherit; changing provider requires its explicit installed model and effort. Saved conversations never switch provider/account/context.                                                                                                                     |
| Managed Claude roles and mixed teams        | Implemented | Managed conversations inherit native capabilities by default; saved restrictions remain. Both use the existing queue/worktrees/review/approval/archive. A real Claude manager → Codex implementer → Claude reviewer completed a disposable task and preserved its identities on restart. This is not certification of every provider/model combination; current regression evidence is in Verification. |
| Installed model catalogs                    | Implemented | Settings requests are scoped to the selected agent/provider/computer. Discovery sends no user prompt and does not resume the owner's saved Claude conversation. Errors offer explicit retry; no invented aliases or cross-provider model inheritance.                                                                                                                                                   |
| Reported usage/quota view                   | Implemented | Settings distinguish original assignment, current model and saved usage. Codex can refresh reported limits explicitly. Claude retains last turn/cache counters; shared account/Fable refresh and QUARK admission budgets are now available. Unknown is not zero, and token estimates are not a billing ledger.                                                                                          |
| Central task tiers and model routing        | Implemented | Model settings controls all app-managed assignments: four tiers, provider presets, latest families, exact pins and bounded escalation. Classification is explicit; native editor sessions keep their settings. See MODEL_POLICY.md.                                                                                                                                                                     |

Check: [assistant code](../apps/server/src/frontdesk.ts), [authority tests](../apps/server/src/frontdesk-api.test.ts),
[assistant UI tests](../apps/web/tests/classic/frontdesk.spec.ts), [provider contracts](../packages/shared/src/providers.ts),
[assignment boundary](../apps/server/src/providers.ts), [usage normalization](../apps/server/src/usage.ts),
[assignment/API regression tests](../apps/server/src/providers.test.ts), [usage regression tests](../apps/server/src/usage.test.ts),
[provider/usage UI checks](../apps/web/tests/classic/execution-info.spec.ts), [managed Claude UI checks](../apps/web/tests/classic/managed-claude.spec.ts),
[Claude usage tests](../apps/server/src/claude-usage.test.ts), [managed Claude contract](MANAGED_CLAUDE.md),
[mixed-provider limits and owner choices](MULTI_PROVIDER_ROUTING.md).
New provider/usage execution evidence belongs separately in [Verification](VERIFICATION.md).

## Source backups, private data and development hygiene

**Implemented:** installation-scoped local authentication protects normal local API/event/socket
access. The native app opens a private browser session with a one-use handoff; retained local
and per-tab drafts survive the private-address transition. Conflicting versions stay readable
and downloadable in Recovery. Reconnecting does not resend requests or resurrect cleared shared
receipts. Companion 0.2.4 uses a one-time editor code and VS Code SecretStorage; configured host
gateways and the local CLI authenticate separately. The existing phone boundary and limited
outside-agent QUARK client retain their own authority. See [local access](LOCAL_ACCESS.md).
The owner app is updated; the installed companion activates at its next safe editor reload.

Source-backup checks now allow ordinary research data/log/database files, count unchanged
path/object versions once across history, and retain credential plus installation-runtime
exclusions (including deleted files). Configured exports still require a private destination,
exact reviewed source and remote confirmation. Size/history inspection bounds remain. This
is implemented in the existing export flow. Project pages now offer private destination
preview/confirmation, optional native GitHub sign-in on Mac and exact setup retry. They reuse
the same configuration and exporter; existing mappings remain. See [the runbook](SOURCE_BACKUPS.md).

| Feature                             | Status                     | Actual behavior and boundary                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private GitHub source checkpoints   | Implemented                | Explicit app opt-in or advanced agent setup per project. Reviewed task checkpoints and owner-approved integration are pushed and the remote commit verified. UI and manager distinguish missing setup, failures and success. Retry preserves local work; no force-push or automatic repository publication.                                                                                                                            |
| “Everything is backed up”           | Limit                      | GitHub does not save every keystroke, arbitrary terminal commits, conversations, credentials, caches or worktrees. It is source-checkpoint backup, not full-machine recovery.                                                                                                                                                                                                                                                          |
| Recovery copies in the app          | Implemented                | **Recovery copies** creates/rechecks a private SQLite snapshot on the selected computer, with retained receipts, integrity checks and clear counts/coverage. A separate read snapshot keeps live database writes from interrupting the copy. It includes managed archive/metadata/images and sensitive app security records, not project/worktree/provider-history or credential files. No browser download or live restore-overwrite. |
| Prepare an app update               | Implemented handoff        | Recovery copies exposes a setup-agent request bound to a verified copy, with readiness/active-work navigation and a source-update runbook. The agent checks prerequisites, preserves data and verifies restart. No automatic updater or model request on copy/open.                                                                                                                                                                    |
| Off-device backup and full recovery | Deferred / Limit           | Same-disk copies do not protect disk loss. Separate private off-device backup is not configured automatically. Restore is setup-agent assisted into a separate location, with original provider/project files and a review of old device trust; no full-machine or exact cache guarantee.                                                                                                                                              |
| No abandoned dev servers/browsers   | Implemented operating rule | Own each temporary check and close its exact processes on success/failure; leave the normal app, connector and login service off outside checks until normal use is requested. Never bulk-kill unrelated Chrome/Node/SSH. Closing a browser during normal use intentionally does not stop agent work.                                                                                                                                  |
| Reusable troubleshooting knowledge  | Implemented                | Dated incident notes preserve symptoms, evidence and bounded decisions for a future orchestrator wiki. Old permission/MFA incidents are not new blockers or instructions to repeat account repair.                                                                                                                                                                                                                                     |

Check: [source-backup runbook](SOURCE_BACKUPS.md), [backup tests](../apps/server/src/source-backups.test.ts),
[backup UI](../apps/web/tests/classic/backups.spec.ts), [recovery-copy guide](RECOVERY_COPIES.md),
[recovery API/security tests](../apps/server/src/recovery-backups.test.ts),
[recovery UI checks](../apps/web/tests/classic/recovery-backups.spec.ts), [operations/recovery](OPERATIONS.md),
[process lifetime tests](../apps/server/src/provider-host.test.ts), [troubleshooting wiki seed](ORCHESTRATOR_TROUBLESHOOTING.md).

### Native unattended execution (2026-09-30)

Native managed contexts use provider permission controls: Codex workspace writes and network
with approval policy `never`; Claude edit acceptance, native command sandbox and denial of
requests outside that policy. Actual human questions retain their original answer flow.
Explicit older restricted contexts retain their saved approval behavior. External MCP servers
and native user overrides are not a project filesystem isolation guarantee. Adapter regression
checks pass. A real Claude acceptance run verifies outside-folder reads, public HTTPS,
scoped shell/file writes and rejection of an outside-folder write, with zero permission
requests. Native Bash approval fixes harmless shell-variable refusals while the strict
sandbox stays enabled; read-only roles do not receive that approval. Live Codex checks also
pass for a read-only manager with network access and a scoped-write conversation; neither
waited for routine approval, and outside writes were denied. Physical-device checks remain
separate in VERIFICATION.md.

### Durable project workflow (release integration in progress)

Implemented backend: independent project provider/spending presets with the corrected family
matrix and live-version resolution; exact model/effort overrides; manager-apply versus human
review; bounded review disposition; persistent internal/human/general work items, atomic reply
and project assignment; versioned project notes; paged original draft history with safe restore
through the existing draft save; Claude 60% native compaction with pre-compact handoff and
post-compact state injection; per-project rates for separate allowance windows. Native reset
clock jitter no longer discards a window's accounting. Home/chat screens are integrated with
focused journey checks; backend implementation alone is not complete UI acceptance.

### Drawn release integration (2026-09-30)

Home and its shell are now integrated from the fresh-design drawings: real remaining
allowance menus, Chats/Apps/QUARK, resource snapshot, sortable project rates and durable
attention/general to-dos. Focused browser navigation, read-only opening, connection recovery
and phone locking checks pass at desktop, 412×915, 360×800 and 915×412. Rendered screenshots
were inspected. Native computer-use acceptance is pending an accessible unlocked desktop.
The new chat/notepad and Computer health frontend are integrated. The health journeys pass
focused desktop/mobile checks. Project/notepad create/save/restore/retry passes on desktop,
portrait and landscape; desktop and landscape Spawn/notepad flows and five 44px-target profile
layouts pass. Backend search/focus checks pass 21 cases, including three RuntimeDemoProvider
cases. Search/focus browser acceptance passes 10/10 across five profiles: ranking transport is
fixture-backed, navigation opens the actual selected link, and typing/opening neither launches
a model call nor messages the target. Focus exercises the real API, including lost-response and
reload recovery with the same receipt.

Standalone Misc conversations now have separate private native workspaces, durable creation
receipts and explicit catalog choices. They start no model turn on creation. Terminal-only
records stay outside the normal contact list while remaining in history/QUARK; their native
terminal currently supports Codex. A fresh terminal now creates a named empty native context
without an invented first message; injected opening-failure/retry checks preserve its identity
and start no model turn. Live native terminal acceptance remains separate. Project-folder opening resolves the registered path on
the server. Project settings include optional brief plan review and an ambiguity preference;
neither creates an unbounded review loop or blocks independent work.

The public landing page in site/ is live at sciencewithagents.com and its www domain.
The existing public SyllabusGraph export lives under /syllabusgraph/, with legacy links
preserved. Live checks pass across five browser profiles, and all six datasets retain their
exact contents. The public OscarBarreraGithub/sciencewithagents repository uses MIT and
clean source history, without earlier private history or runtime files. The landing provides
a setup prompt and GitHub link; no Guide/FAQ is published. Device/account acceptance limits
remain explicit in STATUS.md and CONTRIBUTOR_SETUP.md.

Phone chat follows the owner's WhatsApp-style direction: compact message bubbles,
an expanding composer, and grouped activity with original details available on demand.
Companion 0.2.6 implements native Codex steering and acknowledged Claude queued follow-ups;
old loaded companions require a safe reload to gain those controls. Durable delivery receipts
retain the original action across response loss and refresh. Tool bursts count as one display
row so long-running work does not crowd messages out of the current history page. Focused
adapter/gateway and desktop/mobile browser checks pass, with an inspected iPhone rendering.
Live editor activation and physical phone acceptance remain separate. This is useful guide
material, not a claim of complete editor UI parity.

Keyboard layout follows the visible phone viewport, including its vertical offset. The
message list preserves older reading positions while the composer grows, and Latest messages
stays above the composer inside history. Shared-chat following also survives Safari delivering
a layout scroll before its resize notification. Eight focused viewport checks pass for shared
and managed chat, including that event ordering, multiline drafts and visible Send controls. Actual device keyboard
behaviour still needs confirmation; the earlier generic mobile checks did not cover it.
