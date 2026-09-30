# Main-screen drawings: recorded requirements and current status

**Implementation status (2026-09-30):** Home, Chats, Apps, QUARK, the resource snapshot,
sortable project rates, and general/human to-dos are connected. The full source and verification
status are in [FEATURES.md](FEATURES.md) and [VERIFICATION.md](VERIFICATION.md). The unchecked
boxes below preserve the original drawing checklist; they are not a current list of missing code.
Native computer-use and physical-device acceptance remain separate.

Recorded from the three-page `agentdock_mainscreen.pdf` on 2026-09-29. The private
page images and connected design live in **sciencewithagents · fresh design** in
Sketchcoded. This updates the design specification, not the running app. Preserve
the existing chat drawings and their [requirements](CHAT_UI_REQUIREMENTS.md).

## Home

- [ ] Keep the sciencewithagents identity and compact remaining Claude/Codex readings
      in the header. Use the shared QUARK reading, with reset/freshness detail on click.
      Available accounts/meters determine the content; support local customizations
      without assuming exactly two providers or fixed five-hour/weekly windows.
- [ ] Show VS Code connection/sharing status in the header. It is connection status,
      not a separate VS Code subscription allowance. Open the existing Chats view
      filtered to shared editor conversations, preserving their original identity.
- [ ] The question-mark control opens useful help/setup instructions.
- [ ] **This computer** shows connection status and opens account/computer checks and
      management. Keep different computers' accounts, jobs and conversations separate.
- [ ] **Phone** shows actual setup/connection state and opens setup or management in a
      popup. Reuse existing pairing/sign-in where available; an ordinary connection
      outage does not require a new signup. Do not label configured access as a
      currently connected phone unless the observed state establishes that.
- [ ] Keep **Chats**, **Apps** and **QUARK** as the three main destinations. Chats opens
      the previously drawn conversation interface; QUARK opens the shared work queue.
- [ ] The **Resource snapshot** opens full computer pressure details and **Ask** for a
      bounded diagnosis using the configured routine-check model. Idle diagnosis does
      not require an always-running assistant.
- [ ] **For your attention** contains short, project-labeled requests needing a person.
      Surface pending permissions and questions in the Home overview; open the original
      manager/request context to answer, rather than a separate approvals destination.
      Internal agent work remains separate. Pending/answered state survives reloads.
- [ ] **To-do general** accepts manually added items. The person may keep an item
      general or send it to an existing project. Choose the project explicitly, preserve
      the item if delivery fails, and link the resulting manager request without duplicate
      sends. Sending to a project still observes its QUARK budget and priority.

## Currently running (page 2 is the enlarged Home component)

- [ ] Show a row per project, its name, separate provider usage rates, whether it needs
      attention, and a direct button to its existing manager chat.
- [ ] Let the person sort each applicable column, retaining the chosen sort.
- [ ] Define **% per hour** as estimated percentage points of an identified allowance
      window per hour over a displayed observation interval. Different provider/windows
      are not interchangeable. Label estimates and insufficient/stale evidence; do not
      turn allowance resets into negative spend or charge native helpers twice.
- [ ] Keep the row linked to the same project when sorting or opening chat. Queue and
      paused work remain reachable through QUARK even when absent from this active list.

## Apps and setup (page 3 is the reference diagram)

- [ ] Apps uses an iPhone Home Screen-style grid: small rounded-square icons, readable
      titles underneath and generous spacing, with vertical scrolling. Adapt the column
      count to phone/desktop width. Show only actual registered apps and their launch
      destinations, distinct from provider tools/plugins. Start with an honest empty state;
      no pretend apps. Fine-tune the visual arrangement once real apps exist.
- [ ] When an app's required setup is ready, show its gallery/launch action. When missing,
      explain the exact requirement and provide a copyable setup-agent prompt for that step.
- [ ] The drawing's examples are GitHub account/`gh` authorization and Cloudflare setup.
      Reuse working accounts, omit completed steps, and require only what the selected
      app/hosting route needs. These are not prerequisites for all local chats or all apps.
- [ ] Reuse the same setup instructions for phone access when the chosen route needs them;
      retain configured phone access and the existing alternative connection choices.
- [ ] Keep setup prompts selectable if copying fails, show check/retry progress, and require
      real readiness evidence before marking a step complete. Copying is not executing,
      publishing an app, creating an account or granting access.
- [ ] Match the [Harvard Skills page](https://ai.physics.harvard.edu/share-workflows/skills/)
      pattern for GitHub/`gh`, Cloudflare and phone setup: one readable scrolling sequence,
      numbered headings, short explanations, dark rounded prompt cards, a prompt label,
      wrapped selectable text, and **Copy / Copied**. Reuse one component across these
      guides. Keep the app shell fixed and scroll the guide region; make Copy at least a
      44px target. Preserve the site's useful structure without copying its smaller hit
      targets or silent clipboard-failure behavior.

### Setup-style source reference

The old website repository is `OscarBarreraGithub/ai-for-the-uninitiated`, a React/Vite
app formerly deployed to sciencewithagents.com through Cloudflare Pages. Its editable
source is `src/App.tsx`: `SkillsAndAgentsLibraryPage` contains the instructions and
`CopyPromptBlock` implements the copy cards. `src/App.css` contains `.prompt-block-shell`,
`.prompt-block-head`, `.prompt-copy-button` and `.prompt-block`; `src/index.css` supplies
base typography/tokens. `index.html` is only the React entry shell.

The live Harvard page is an **Astro-generated build**, not a verified deployment of that
local React checkout. Its page HTML is served at the reference URL. On inspection, it loads
`/_astro/BaseLayout.BxNabXzH.css` and `/_astro/CopyPromptBlock.CNg0RP5Y.js`; the latter
implements the same label, prompt, Copy/Copied component. These hashed files identify the
observed reference, not dependencies to hotlink. The newer Astro authoring repository has
not been located locally. The fetched page/assets and private source locations are kept
outside tracked source. No changes or deployments were made to either website.

## Computer health

- [ ] Start with the current snapshot: freshness, CPU/busiest core, memory pressure,
      swap activity and storage headroom. Follow it with prominent resource-agent chat,
      then time-series plots, grouped apps/processes and project resource attribution.
- [ ] Replace the long inline list of old checks with **History**: a searchable/filterable,
      bounded list that opens an individual snapshot/report on demand. Keep the latest
      relevant answer near chat; preserve available timestamps, gaps and retention limits.
- [ ] Offer **Ask Codex** and **Ask Claude**, defaulting through the central catalog to
      current Terra and Sonnet respectively. Show actual model names and a model picker
      before sending; allow other available models and exact-version overrides. Do not
      silently fall back to a different provider. Continued questions retain their evidence
      and selected conversation; a provider change starts a clearly identified conversation.
- [ ] Keep periodic/pressure-triggered checks bounded and idle when not needed. Their
      default model remains central. The scoped native-access preference below concerns
      capability; an unsolicited routine diagnosis is not an instruction to modify apps.

## Allowances, attention and completed work

- [ ] Allowance details are a view of QUARK's shared usage/accounting data: remaining
      windows, reset times, freshness, project caps, reservations, estimated spending and
      per-agent token evidence. Reuse the same source from Home and QUARK; no new collector.
- [ ] Do not add a dedicated diff/review/results workflow to the redesign. A person can
      ask their agent to explain a result or prepare a diff in chat. This design decision
      does not remove saved evidence or change the backend's existing apply behavior.
- [ ] Put past-worker questions under **Chat → Subagents → worker → Ask about this work**.
      Preserve the completed task and original record, with the follow-up in a separate
      discussion. Retained evidence/native conversation copies do not promise access to
      hidden reasoning or an exact historical model snapshot.

## QUARK dashboard proposal

Keep one operational overview, with details opened only when useful:

- Shared remaining allowance/reset/freshness and current computer pressure at the top.
- Work grouped into Backlog, Queued, Running, Paused/Needs input and Completed; filters
  for project, provider/manager and priority. Status columns on desktop can become a
  selected-status list on phones. This presentation is now implemented in Work; see QUARK_COORDINATOR.md.
- Each task card: plain-language outcome, project/manager, actual model/provider,
  priority, budget remaining/estimated spend, resource demand, and the reason it is
  waiting or paused. Show a time estimate only when supported. Task cards group their
  execution attempts and subagents rather than treating every model turn as a new task.
- Open a card for its workers/evidence and existing priority, budget, pause/continue and
  manager-chat controls. Work state comes from real execution; changing presentation
  must not fabricate completion or bypass a quota hold. Put advanced scheduling rules
  behind settings rather than listing them across the main dashboard.

The Work screen now has the requested QUARK conversation above status columns, using real
jobs/tasks and the existing queue/accounting controls. Its coordinator saves owner decisions
and can change project priorities, pauses and allowance allocations; host rules enforce the
limits. There is no external Jira integration. See QUARK_COORDINATOR.md for verified scope.

## Requested scoped unattended permissions — pending verification

The latest owner correction supersedes the earlier blanket full-access/bypass request.
Managers should read broadly, use the internet and available native tools, but only write
inside their assigned folder/worktree. Read-only diagnostics can stay read-only. Native
unattended policy should deny out-of-scope operations instead of waiting indefinitely for
human approval, while managers record blockers and continue independent tasks.

Implement this centrally using supported provider settings, not per-feature tool emulation.
Native sandboxing must actually enforce local writes; arbitrary MCP/remote tools need their
own enforcement and cannot be claimed contained by a prompt. Existing login/account policy
and genuine user choices remain visible. Current saved permissions are unchanged by the
QUARK board implementation. See QUARK_COORDINATOR.md for scope and guide notes.

**Status reminder:** The unchecked drawing boxes remain unchanged so the source specification
is preserved. Use [FEATURES.md](FEATURES.md) and [VERIFICATION.md](VERIFICATION.md) for current
implementation and acceptance. Responsive/emulated checks do not replace physical phone or
native computer-use acceptance.
