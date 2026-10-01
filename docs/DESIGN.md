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
- Human items have a short explanation, project context and a direct route to answer.
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
  When zoomed text and a keyboard leave too little height, the composer tools fold into one
  sideways-scrolling row, then the message area gives way, so Back, input and Send stay visible.
- Further instructions during work use supported steering or a labelled queue. Failed or
  uncertain sends keep the draft and delivery receipt; do not show a blanket wait restriction.
- Project shortcuts open its folder, configuration, Notes and Subagents. A worker row shows
  assignment, activity, timing and token evidence. Completed workers offer a separate
  Ask about this work discussion without reopening the task/review.
- Notes has general notes, concise human actions and internal work. Referencing an item fills
  the composer without sending or marking it complete. Managers continue unblocked tasks.
- Search has an explicit assisted-search prompt, not a message to an arbitrary existing chat.
  Report bounded/partial coverage. No model call on each keystroke.
- New can create a project manager or a saved Misc chat. The native terminal option preserves
  native ownership and does not create a misleading saved contact; current support is Codex-only.
- New projects offer Start fresh or Connect a folder, a replaceable name, then separate manager
  provider/model/reasoning choices. Use real catalog names, not academic role labels here.
- Worker provider mix and spending are separate sliders. Research/coding, Review and Bulk
  choices each occupy a readable line. Put the defaults explanation prominently above them.
  Exact model overrides remain available; edited choices must be visibly custom.
- Populate effective reasoning defaults, preferring supported xhigh for managers. Global model
  preferences seed new projects; project customization does not overwrite those preferences.
  Restore recommended defaults is always available. [Model policy](MODEL_POLICY.md).
- Priority and optional allowance caps can be refined later through the manager or QUARK.
  Explain that “10%” means a share of the full allowance, not 10% of the remaining balance.
- Spawn saves the project and opens the initial brief; it does not send work. Preserve setup
  choices through errors. The first Send opens normal chat.

## Prompt notepad

The initial project description and optional long chat messages use the same full-page
notepad. Typing autosaves local versions, with visible saving/error state and restoration.
Minimize returns to chat without sending. The page scrolls the text rather than leaving a
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

The intended automatic five-hour mode must use actual reset/rate evidence, suitable pending
work, shared reserves, independent model windows and computer pressure. It must not override
explicit model choices or invent work to spend allowance. This mode is not yet implemented.

## Computer health, setup and Apps

Start Computer health with the current snapshot, prominent selectable-model resource chat,
then plots and details. Projects/jobs precede apps/processes. Show historical evidence through
charts and assistant queries, not a long snapshot list. Default routine choices resolve through
the central Terra/Sonnet mappings; exact alternatives are selectable. Automatic checks stay bounded.

Setup guides use numbered steps and readable, copyable prompts with a selectable-text fallback.
Only actual checks can establish completion. Optional GitHub/Cloudflare setup is not a local-use
prerequisite. Connecting another computer provides prompts for that computer and the main host.
Phone pairing remains protected; no repeated app lock or separate VS Code authentication.

Apps will use a spaced grid of rounded icons and titles, with real registered destinations.
Until registration is connected, keep an honest empty state. Do not add unrelated action tiles.

Use readable body text, large controls, consistent spacing and wrapping. Verify 360×800,
412×915, 915×412 and desktop, enlarged text/zoom, long labels and content growth. Default,
loading, empty, failed and retry states are part of each screen, not later polish.
