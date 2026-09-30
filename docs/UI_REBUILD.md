# Home-screen rebuild

## Owner drawings — 2026-09-29

The latest [Home drawings and requirements](HOME_UI_REQUIREMENTS.md) connect Chats,
Apps, QUARK, account/phone access, resource details and human/general to-dos. They
define the active scope of the fresh-design board; the historical interface below
is not the specification for what belongs in this redesign.

The new chat drawings and handwritten requirements are recorded in
[CHAT_UI_REQUIREMENTS.md](CHAT_UI_REQUIREMENTS.md) and the Sketchcoded board
**sciencewithagents · fresh design**. The current task imports and organizes the
design only. Do not implement this redesign until the owner requests that step.

## Connected workflow build — 2026-09-28

The full AI-built Sketchcoded flow is being connected to the backend for desktop/mobile,
with aesthetic revisions afterward. Projects, managed Conversations, Work/job details,
Attention, Recent Results, exact review/apply and transcription now work in the new shell.
Finished workers have separate read-only saved-evidence discussions. Parallel changes can
request a new reconciliation task without reopening the original task or its review.
QUARK transient recovery and native-manager admission are separately implemented/verified.
The personal assistant/privacy, shared editor chats, saved-history search, browser handoff,
Settings, computer selection, phone controls and verified recovery copies are connected.
Advanced/native controls, manual task/module-manager creation and Codex history import into
Claude-managed projects are connected too. Compaction uses QUARK admission and preserves tasks.

Welcome/setup now checks native sign-in and actual model availability without a prompt, links
team choices and first-project creation, and offers bounded native Codex device-code sign-in.
Fresh empty installations default to Codex only; saved owner routing and exact pins remain intact.

Current verification is in [Status](STATUS.md) and [Verification](VERIFICATION.md). The
complete hosted checkpoint passes. Native Claude sign-in, optional private phone setup,
launcher resilience and recovery/update handoffs are implemented; actual physical-device
acceptance and owner release choices remain separate. The connected flow and guide notes
live in [WORKFLOW_BUILD.md](WORKFLOW_BUILD.md).
The overall goal remains active; no drawings are required to continue.

**2026-09-27:** **All usage** and **Work** now open working QUARK allowance budgets, token
accounting, pause recovery and cache controls. See [QUARK_ACCOUNTING.md](QUARK_ACCOUNTING.md).
The historical placeholder account below records the initial landing-page slice; the connected workflow above supersedes it.

**Current update (2026-09-25):** [Model settings](MODEL_POLICY.md) now centralizes tier/provider defaults, latest-family resolution, exact pins and bounded undergrad escalation. It is a working home destination. Earlier descriptions below that defer automatic routing or describe inherited manager models are superseded by that policy. Original native editor sessions retain their own choices.

2026-09-24. The owner requested a new phone interface built from verbal direction, with
its landing screen implemented and descriptive placeholders at every destination. The
2026-09-25 owner request adds Computer health as the first working destination; see
[RESOURCE_WATCH.md](RESOURCE_WATCH.md).

The default home uses warm white, ink, cobalt, locally hosted Manrope/Instrument Serif,
simple allowance meters and a quiet constellation graphic. Phone navigation stays in a
bottom bar; desktop uses the same information in a wider grid. The page is observational:
opening or navigating it makes no model calls, sends no chat and restores no provider session.

**Live:** selected-computer identity, shared Codex/Claude/Fable remaining allowances, reset countdowns,
attention summaries, manager/editor-chat counts, running/queued work, CPU/available memory,
project estimates, recent results and the Computer health watcher. Missing/stale readings remain explicit. Reservations
are labeled estimates, separate from measured whole-computer use. Provider refresh remains
owned by the existing collector. Browser retries only reread the shared state.
Allowance percentages and filled meters show what remains in each window.

**Placeholders:** conversations/managers/VS Code, personal agent, usage detail, attention
inbox, QUARK controls, projects/new project, computers, news, search,
and recent-result detail. Model settings is implemented; other workspace settings remain a future screen. Every destination explains its intended role and returns
home; browser Back and direct reload work. Choosing one performs no underlying action.

**Retained:** backend scheduling, histories, pairing, original approvals and integration
gates. The phone gate still runs before private reads, and paired phones keep a working
Lock app button. The previous interface is loaded only by a deliberate maintenance selection
(`/?workspace=classic`); normal home navigation never enters it. Existing jobs are not stopped
or replayed by this frontend change. Native VS Code chat URLs now open the VS Code placeholder
when selected through the new interface; full editor controls remain in the original editor.

The active browser suite lives in `apps/web/tests/home/`, with Chromium touch profiles at
412×915, 360×800 and 915×412, desktop at 1440×1000 and an iPhone WebKit profile. This is browser
emulation, not proof of a physical iOS keyboard/Home Screen or Android hardware. Screenshots,
recordings, traces and demo data remain under ignored `data/`, never the shareable source.
The prior suite is organized under `apps/web/tests/classic/` and remains independently runnable.

Computer health now provides app groups, pressure readings, trends, Ask and watcher settings.
Opening it remains read-only; only explicit Ask or enabled automatic checks start a diagnosis.

The initial landing-page slice is retained here as design history. Use the current connected
workflow and Status for what works today; aesthetic revision remains with the owner.
