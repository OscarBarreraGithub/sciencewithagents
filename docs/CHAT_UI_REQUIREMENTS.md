# Chat drawings: recorded requirements and current status

**Implementation status (2026-09-30):** The drawn chat shell, project setup and model
preferences, notes/work-item panels, saved prompt notepad, assisted chat matching, project focus,
phone-style message layout and grouped editor history are integrated. Current implementation
and verification evidence are in [FEATURES.md](FEATURES.md) and [VERIFICATION.md](VERIFICATION.md).
The unchecked boxes below preserve the original drawings; they are not a current missing-work
list. Physical phone and live companion activation remain separate acceptance steps.

Recorded from the six-page `agentdock_chatUI.pdf` on 2026-09-29 and the owner's
preceding model-default corrections. This page preserves the design requirements and
original checklist. Check the status notice and linked evidence for current implementation;
the checkbox marks intentionally remain as they were when the drawings were recorded.

The Sketchcoded board is **sciencewithagents · fresh design**. Pages 1–5 contain
drawings; page 6 is blank. Preserve all six page images in its sketch library.
Pages 1 and 3 describe screens. Pages 2, 4 and 5 are supporting flow/panel diagrams,
not extra navigable app pages. The private PDF, renders and board data stay out of
the shared source repository. The subsequent [Home drawings](HOME_UI_REQUIREMENTS.md)
connect the main entry routes to this chat design. The current integrated screens and mobile
checks are summarized in the linked feature map and verification log.

### Phone clarification — 2026-09-30

The owner wants a sleek WhatsApp-style phone conversation: compact header and back action,
incoming/outgoing message bubbles, an expanding pinned composer, and most of the screen
given to messages. Global app navigation should recede while reading a chat. Tool activity
belongs in compact expandable summaries, with full details retained. Long-running goals
must accept further instructions: native Codex steering or an explicitly labelled native
Claude follow-up queue, rather than a blanket “wait for this reply” restriction. A failed
or uncertain send must retain its draft and original delivery receipt.

## Page 1 — main chat

- [ ] Show the project name and shortcuts for its folder, Notes, Subagents and configuration.
      The folder shortcut opens VS Code at that project's folder.
- [ ] Keep Search and New above compact All, Managers, VS Code and Misc filters.
      Show each chat's name, time, activity/awaiting-response state and indicator.
      Distinguish working, waiting and idle conversations.
- [ ] Let the chat list scroll independently of the conversation. Tint VS Code chats
      light blue and Misc chats yellow; retain readable labels as well as color.
- [ ] Search by chat name and offer an assisted match to the right chat with a
      centrally configured Luna/Sonnet helper. Do not launch a model on every keystroke.
- [ ] Preserve the full normal chat composer, including attachments, slash/native
      controls and Send; do not reduce native capabilities to the sketched icons.
- [ ] Let the normal composer grow with the message up to a screen-appropriate maximum,
      then scroll within it. Keep an **Expand** control available to open the same draft
      in the full-page prompt notepad described below.

## Page 2 — New conversation choices

- [ ] New offers **Project manager** or **Chat**. Project manager opens project setup.
- [ ] Chat offers **Terminal experience** or **Start chat + save contact**.
- [ ] Terminal experience is a fully functional native terminal with continuity and
      input handoff to the phone. It does not automatically become a saved contact
      or conversation in the normal chat UI. This does not request deleting native
      history or QUARK's supervision records.
- [ ] Start chat + save contact creates a retained Misc conversation using the same
      normal chat interface as project conversations.

## Page 3 — new project

- [ ] Autofocus and select the proposed project name so it is immediately replaceable.
      Offer **Connect a folder** and **Start fresh**, defaulting to Start fresh.
- [ ] Choose the manager's Codex/Claude provider, actual model and reasoning level
      separately from the worker settings. Populate supported choices from the live
      installed account/provider catalog. Do not use academic role nicknames here.
- [ ] Provide two independent worker controls: Codex only → Codex heavy → Balanced →
      Claude heavy → Claude only, and Light → Default → Tokenmax. The first communicates
      the intended provider mix to the manager; it does not secretly pick the manager.
- [ ] Show the resulting Research/coding, Review and Bulk task model dropdowns alongside
      the sliders. Slider changes update those defaults. Manual edits dim the preset
      slider and emphasize the Custom panel; never imply a modified choice still
      exactly matches a preset.
- [ ] Add a small **See defaults** explanation, using the corrected matrix below.
- [ ] Offer an explained **Plan–review loop** option. The sketch does not establish its
      default or exact repetition/exit rules; settle those before implementing it.
- [ ] Offer **Should work stop if something is unclear?** If disabled, the manager makes
      a reasonable judgment, notifies the user and continues authorized work. This is
      not permission to bypass genuine approvals or guess indispensable missing inputs.
- [ ] Show QUARK priority choices High, Default and Back burner.
- [ ] Make **Set max usage** optional and off by default. A cap is a percentage of the
      full weekly allowance, not a minimum remaining balance. Read remaining usage and
      reset timing live from QUARK; label estimates/unknowns. This annotation concerns
      the optional cap, not disabling QUARK supervision.
- [ ] Show an already-allocated usage graphic. Clicking it opens QUARK's allocations,
      other projects and computer-resource details. Distinguish reservations from spend.
- [ ] **Spawn** applies the selected settings, creates or reuses the project/manager
      identity, and opens **Describe your project** in the full-page prompt notepad.
      Keep the selections through creation errors; do not begin model work until Send.

### Corrected worker defaults

Each cell lists **Research/coding · Review · Bulk tasks**. These are centrally editable
families resolved to the newest available versions, not fixed version strings. Preserve
explicit choices, including older supported models. A missing family needs a visible
replacement choice; do not silently switch provider or fail the entire settings page.
New model names remain selectable without changing each feature. Renamed/default
families can be patched centrally. Luna replaces Haiku as the lightweight default.

| Usage    | Codex only            | Codex heavy           | Balanced               | Claude heavy           | Claude only            |
| -------- | --------------------- | --------------------- | ---------------------- | ---------------------- | ---------------------- |
| Light    | Terra · Sol · Luna    | Terra · Opus · Luna   | Terra · Opus · Luna    | Opus · Sol · Sonnet    | Opus · Opus · Sonnet   |
| Default  | Sol · Astra · Luna    | Sol · Opus · Luna     | Sol · Opus · Sonnet    | Opus · Sol · Sonnet    | Opus · Fable · Sonnet  |
| Tokenmax | Astra · Astra · Terra | Astra · Fable · Terra | Astra · Fable · Sonnet | Fable · Astra · Sonnet | Fable · Fable · Sonnet |

Recommendation copy: “If you have FAS Claude, I recommend Balanced or Claude heavy
for default usage. I personally use Balanced + Tokenmax.” The personal preference is
not an instruction to change every new installation's default. Manager choice remains
separate. Exact provider proportions beyond these presets are not specified here.

## Prompt notepad — initial brief and later messages

- [ ] After Spawn, offer an entire notepad-style writing surface for the project's goal,
      context and setup instructions. Later messages use the same full-page editor through
      **Expand** in chat. The writing area occupies the available workspace; long documents
      scroll in that area rather than being confined to a small input box.
- [ ] Autosave as the person types, including offline. Do not wait for Send, blur, Minimize
      or an agent/server connection. Preserve the latest text through reload and interrupted
      editing. Only show **Saved** after local persistence confirms it; a save failure keeps
      the text visible and offers a usable copy/export path.
- [ ] Keep recoverable, timestamped versions, including the state before restoring an older
      version and the exact text submitted by Send. Provide readable history, preview and
      restore; restoration creates a new version rather than erasing the newer text. This is
      private draft history, not a requirement to create a Git commit for every keystroke.
- [ ] Start with separate local drafts for each device/browser and project/conversation.
      Use one active editor for a given local draft; another tab must not silently overwrite
      it. Cross-device transfer is explicit, preserves both versions and never merges by
      simply replacing one with the last writer. No live collaborative editor is required.
- [ ] The normal composer and expanded notepad edit the same local draft. Expanding or
      minimizing preserves text, attachment references and editing position; it does not
      create another message or a second competing draft.
- [ ] Keep **Minimize** visible and easy to reach on desktop and phone. It returns to normal
      chat without sending, including when this is the initial project brief. The unsent
      draft remains in the composer and can be expanded again.
- [ ] **Send** records a version and submits exactly that draft to its original manager/chat,
      then opens normal chat with its delivery status. Do not clear the working draft until
      acceptance is confirmed. Keep failed/uncertain sends recoverable and use the same
      delivery identity when checking or retrying. QUARK may queue the accepted request;
      neither opening nor minimizing the notepad starts orchestration.
- [ ] Verify long text, phone keyboard, offline typing, reload/crash recovery, two-tab
      conflicts, explicit device transfer, version restoration and failed/uncertain sends.
      Local autosave is not a promise to recover data after browser storage is erased or
      the device is lost; disclose the actual storage/backup boundary in the guide.

## Page 4 — chat configuration

- [ ] Show tokens spent, allowance usage, subagent information, elapsed time and
      computer resources for the selected conversation/project, with measurement limits.
- [ ] Offer normal QUARK scheduling or an explicit **Pause other jobs** choice to let
      this work finish first. Preserve paused jobs and their files/history. The drawing
      is a request for a priority override, not evidence that preemption already works.
- [ ] For a manager, reopen the project-setup controls populated with current settings
      and allow changes. For a Misc chat, offer model and reasoning choices. Preserve
      original conversation identity and explain changes requiring a new session.

## Page 5 — subagents and notes

- [ ] Subagents opens a list with a one-line assignment summary, spawn time and tokens
      spent for each agent; retain access to its activity and saved evidence.
- [ ] Selecting a completed worker offers **Ask about this work** from that list. Open a
      separate follow-up with its retained evidence or supported native conversation copy;
      do not reopen the finished assignment or change its completion/review state. Explain
      recorded decisions without claiming access to hidden reasoning.
- [ ] Keep result explanations and requested diffs in chat. The redesign does not need a
      separate review/apply dashboard; existing backend behavior is a separate concern.
- [ ] Notes opens a right-hand panel alongside the conversation, containing Notes,
      human To do items and Internal to do items supplied by the manager.
- [ ] Clicking a note/to-do makes it easy to reference that exact item in the chat
      composer. Referencing an item does not itself send a message or complete it.
- [ ] Keep this panel consistent with the [durable manager plan and human action
      requirements](QUARK_CHECKLIST.md#2026-09-29-addition-manager-continuity-and-human-action-items):
      human summaries are concise; a blocked item does not stop independent work.

## Implementation status and remaining acceptance — 2026-09-30

The current source connects the drawn chat, project/provider settings, corrected worker mix
and intensity matrix, high-level plan review, manager notes and work items, versioned notepad,
assisted chat matching and project focus. Search/focus browser acceptance passed 10/10 across
five profiles; see [FEATURES.md](FEATURES.md) for bounds and exact evidence. Do not read the
unchecked historical boxes above as evidence that those implemented paths are missing.

Physical phone acceptance, live activation of companion 0.2.6, and native computer-use
acceptance remain separate. The terminal-only native session is currently Codex-specific, and
the mirror is not full provider UI parity. See [FEATURES.md](FEATURES.md) and
[VERIFICATION.md](VERIFICATION.md) for current limits. Keep the original drawing checklist
intact as a design record.
