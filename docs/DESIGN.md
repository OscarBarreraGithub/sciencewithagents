# Interface requirements

Current product decisions, consolidated from the drawings and subsequent corrections.
This is a behavior/design reference, not a completion checklist. See [Features](FEATURES.md)
and [Status](STATUS.md) for implementation and gaps. Private drawings are not distributed.

## Home and navigation

- Chats, Apps and QUARK come first on mobile, with compact allowance/computer information.
  Use the available desktop width and height; avoid a narrow, left-aligned working area.
- Show remaining allowance, reset/freshness detail and the selected computer. On mobile,
  allowance scrolls away instead of consuming space throughout the page.
- Keep For your attention and General to-do compact when empty, growing with content up to
  a bounded height. Their lists then scroll independently. To-do entry is multiline.
  Opening the phone keyboard must not shrink the cards above it or change those list caps;
  keep their content sizes stable while the outer viewport makes room for typing.
- Human items have a short explanation, project context and a direct route to answer.
  The running-project table shows the actual request; both its link and arrow open that item.
  Human questions open their answer form in Notes, with the request above the other notes.
  Internal manager work is separate. Display unresolved questions, not a wall of status boxes.
- Running projects show usage-rate estimates, activity and manager links, with sortable
  columns. Use readable precision and the title “% usage / hour”; avoid a redundant rate legend.
- Keep a small, low-compute interactive orb beside the computer/allowance area. Tap selects
  varied shapes at random, with no pointer outline. Idle behavior should be quiet and respect
  reduced motion; do not trade phone responsiveness for decoration.
- The persistent Back control has padding. Revisiting a page truncates the app's route trail:
  A → B → C → B → C returns through B → A, not repeated loops. Home clears that trail.
  Native browser history is separate. Preserve drafts and sensible return locations.
- No persistent mobile bottom bar, promotional slogans, news or personal-agent Home tile.
  Keep recovery preparation in update/support workflows rather than a Home promotion.

## Chats and project setup

- Distinguish Managers, shared VS Code chats and saved Misc conversations by provenance.
  App-created helpers/resource reports are not personal chats. Never delete their evidence
  merely to clean a list. The VS Code control at the top of Chats opens setup/status instructions.
- Use compact WhatsApp-like phone conversations: message bubbles, a short header, grouped
  expandable tool activity and an expanding composer with a maximum height. Keyboard opening,
  Latest messages and attachment controls must not cover input or cause large scroll jumps.
  Manager names wrap across the phone header; tools use a separate row instead of squeezing
  the name into a clipped single line, including with larger text.
  When zoomed text and a keyboard leave too little height, the composer tools fold into one
  sideways-scrolling row, then the message area gives way, so Back, input and Send stay visible.
  Closing the keyboard, including while pinch-zoomed, then changing screens or swiping back
  returns the full screen without reopening the app. Native pinch zoom stays available.
- During a running Codex reply, the composer offers “Steer now” or “Queue next”; priority
  applies only to queued messages. The notepad uses the same choice. Claude follow-ups queue.
  Timing is a small secondary control beside the other composer tools, not its own full-width
  row. Explain attachment limits when needed rather than permanently beside the input.
  Sent steering appears as an ordinary user message, not a system notice.
  Keep the queue closed as one compact summary row; opening it shows a full-height list
  of short previews, with full text available on demand and each item's actions reachable.
  App-owned entries offer Edit: opening an individual
  item holds it before writing. Native editor queues expand under their provider ownership.
  Minimize keeps it held; Save and queue or Discard edits and queue original explicitly releases it.
  Saved edits survive refresh, and another browser must explicitly take over the held version.
  Codex offers explicit Steer now; uncertain steering stays held for inspection without replay.
  Lost acknowledgements retain the exact action receipt across reload for explicit inspection.
  Native editor queues remain visible under their provider ownership. Changed queued wording
  returns linked owner-request triage to pending review and retains searchable original text.
  Failed or uncertain sends keep the draft and delivery receipt; do not show a blanket wait restriction.
- Conversation Archive hides a chat only in this app. Archived lists and Restore retain drafts,
  history, files and running work; shared editor/provider conversations remain native.
  Put Archive in one small three-dot conversation menu, without a duplicate chat-list button.
  Undo must remain reachable on a phone after archiving.
  Manager removal remains a separate action that cancels its queued work. Home chat counts
  follow the visible list; active jobs and attention remain visible independently.
- Project shortcuts open its folder, configuration, Notes and Subagents. A worker row shows
  assignment, activity, timing and token evidence. Completed workers offer a separate
  Ask about this work discussion without reopening the task/review.
- Configure lays out readable controls according to its own panel width, including at larger
  text and zoom. Keep useful model, reasoning, tool and permission choices; omit generic
  adapter availability, routing and missing-delegation explanations from the default view.
- Notes contains owner-written notes alongside separate human actions and internal work.
  Managers may read the notes but cannot edit them; their plans belong in internal work items
  and checkpoints. Referencing an item fills the composer without sending or marking it
  complete. Managers continue unblocked tasks.
- Search has an explicit assisted-search prompt, not a message to an arbitrary existing chat.
  Report bounded/partial coverage. No model call on each keystroke.
- New can create a project manager or a saved Misc chat. The native terminal option preserves
  native ownership and does not create a misleading saved contact; current support is Codex-only.
- New projects begin with New folder or Existing folder. Existing folder immediately opens the
  in-app folder browser on the selected computer, including from paired phones and other hosts.
  Use familiar locations, a clickable ancestor path, back/forward navigation and folder-name
  search including subfolders. Keep the folder list scrollable and selection controls reachable.
  Search limits must be visible; hidden folders are an explicit option. Show the selection
  beside those choices without creating a manager.
  Existing folders suggest their folder name as an editable project name; the display name
  does not rename the folder. Keep that choice through reloads and setup retries.
  Then choose the manager/provider/reasoning and workers; one Spawn action sits at the bottom.
  Spawn always starts a fresh manager and initial brief, including for a previously used folder.
  Earlier managers stay in Chats. Keep removal in chat configuration, with confirmation that
  queued work is cancelled while files and history are retained; require running work to stop first.
  New folders have a replaceable name. Use real catalog names, not academic role labels here.
- Worker provider mix and spending are separate sliders. Research/coding, Review and Bulk
  each have a bordered, tappable model row with a visible Change control and expansion arrow.
  Keep the current choices on separate readable rows and the defaults explanation above them.
  Exact model overrides remain available; edited choices must be visibly custom.
- Use one decision setting for unclear details and unresolved issues after two review rounds:
  let the manager decide and record why, or pause that item and ask the owner. Other unblocked
  work continues. Plan review and approval before applying changes remain separate choices.
- Populate effective reasoning defaults, preferring supported xhigh for managers. Global model
  preferences seed new projects; project customization does not overwrite those preferences.
  Restore recommended defaults is always available. [Model policy](MODEL_POLICY.md).
- Priority and optional allowance caps can be refined later through the manager or QUARK.
  Label the optional cap “Set token budget”; its amount is still a percentage of AI allowance.
  Explain that “10%” means a share of the full allowance, not 10% of the remaining balance.
- Spawn opens the initial notepad immediately and prepares the project while the owner writes.
  An early Send waits visibly for setup, keeping one durable send receipt. Preserve setup and
  text through errors/reloads. The first successful Send opens normal chat.

## Prompt notepad

The initial project description and optional long chat messages use the same full-page
notepad. Typing autosaves local versions, with visible saving/error state and restoration.
Minimize returns to the previous screen without sending (project setup for the initial brief,
chat for later messages). The page scrolls the text rather than leaving a
small textarea above unused space. Versions and Send remain reachable.

Drafts are separated by computer/conversation/browser. Do not silently overwrite one device's
text from another device. Explicit transfer must preserve conflicting versions. Sent history
lives in the app archive; browser drafts cannot be guaranteed after storage/device loss.

## QUARK

Put full-screen coordinator chat above a simple task/project board. Show backlog, queued,
running, paused/needs-input and bounded completed views. Each card needs an understandable
outcome, project, actual model, priority, estimated usage/resources and waiting reason.
Do not fabricate deadlines, completion or available allowance.

Show shared remaining windows, reserve controls and live spending sliders with the board.
Allow owner instructions to change project priority, weight, pause and allocation. Caps/reserves
still constrain automatic decisions. Provider actions are Refresh, Check connection and
supported update checks. Detailed accounting stays available to agents without a separate
technical usage page. No cache-warming settings; that work is deferred.

Five-hour pacing must use actual reset/rate evidence, suitable pending work, shared reserves,
independent model windows and computer pressure. It must not override explicit model choices
or invent work to spend allowance. Capacity forecasts and coordinator wakeups are advisory;
managers choose eligible work. Fully automatic utilization is not implemented, and neither
exhausting a window nor force-switching conversations is guaranteed.

## Computer health, setup and Apps

Start Computer health with the current snapshot, prominent selectable-model resource chat,
then plots and details. Projects/jobs precede apps/processes. Show historical evidence through
charts and assistant queries, not a long snapshot list. Default routine choices resolve through
the central Terra/Sonnet mappings; exact alternatives are selectable. Automatic checks stay bounded.

Direct resource questions take priority over background health checks. Existing interactive
resource conversations show a compact model button; provider, model and thinking choices
open in a dialog without shrinking the chat. New conversation clears the visible transcript
and stays new after reload, while earlier history and drafts remain saved. Stronger models
remain available from the provider catalog. Automatic reports in other conversations never disable the direct question box.

Setup guides use numbered steps and readable, copyable prompts with a selectable-text fallback.
Only actual checks can establish completion. Optional GitHub/Cloudflare setup is not a local-use
prerequisite. Connecting another computer provides prompts for that computer and the main host.
Phone pairing remains protected; no repeated app lock or separate VS Code authentication.
QUARK opens cluster notebooks in a separate tab on their configured private notebook origin.
Phone and selected-computer launches retain the QUARK view; blocked popups offer a short-lived
link and explicit fresh launch when it expires. Notebook handoffs never enter app draft storage.

Apps uses rounded icons and titles. LaTeX opens a simple file/recent-document library and
a full-screen PDF reader. Fit width, pinch/button zoom and page navigation must remain usable
on phones. Document links open over mounted chats; closing or swiping out preserves the exact
reading position and draft. Managers register project web apps; tiles show whether each is
running and open loopback addresses only where they are reachable. See [Apps](APPS.md).
For LaTeX sources, Reading reflows prose at a comfortable adjustable size. Format equations
to fit before resorting to individual horizontal scroll regions with visible overflow cues.
Optional AI formatting creates a separate copy with a selectable model, never replaces the original.

Use readable body text, large controls, consistent spacing and wrapping. Verify 360×800,
412×915, 915×412 and desktop, enlarged text/zoom, long labels and content growth. Default,
loading, empty, failed and retry states are part of each screen, not later polish.
