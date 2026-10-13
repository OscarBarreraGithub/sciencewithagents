# Interface system

SWA uses a dark-only interface for application chrome, conversations and controls. Original
PDF pages, report images and scientific figures retain their source colors. The existing
React/Vite app, authenticated host APIs, browser access and Mac launcher remain the delivery
path; changing the interface does not change native provider tools, sessions or permissions.

## Components and visual language

Use the shared React Aria primitives for new interactive controls, existing Lucide icons,
and CSS variables for consistent surfaces, readable text, focus and state. Migrate controls
in bounded working journeys. Preserve native buttons and dialogs until their replacement
passes the same keyboard, touch, draft and navigation checks. Do not introduce a second
component behavior library or a generic provider command gateway.

The visual hierarchy is canvas, panel, raised control and hover surface. Neutral dark
surfaces carry the content; a restrained indigo accent identifies selected destinations and
primary actions. Adjacent secondary controls, including three-dot menus, share one treatment.
Use at least 44 CSS pixels for action targets and 16 pixels for setup/control text. Keep
visible keyboard focus, sufficient text contrast and reduced-motion support.

The 2026-10-13 Groups workspace slice replaces the rejected theme-only layout. Desktop uses
one narrow sidebar for global destinations, conversation categories, compact group rows and
computer/allowance utilities. The main canvas has a title/member header, understated Group
chat / Your Claude Code tabs, continuous author-labelled messages and one anchored composer
with integrated Send/Notepad and saved-draft state. Contribution mode and other management
remain in Manage; read-only status stays visible in the header. Navigation makes no model call.
Desktop navigation can use 34–44 pixel rows and 13–15 pixel secondary text; setup and input
text stays at least 16 pixels. Phone actions retain 44 pixel targets, with separate list/thread
views and no bottom bar. Home, projects and QUARK keep their existing layouts.
Keep this slice focused on the Groups experience. The user's existing Claude Code conversation
remains the agent through the optional Groups plugin. Broader agent-interface and Herdr work
are separate. Functional checks and independent code review do not establish visual acceptance
or prove which revision another computer has installed.

## Research and packaging

The earlier [design investigation](DECISIONS.md#dark-interface-and-delivery) selected
[React Aria](https://react-aria.adobe.com/) for its unstyled components and built-in keyboard,
touch and focus behavior. Its [Button documentation](https://react-aria.adobe.com/Button)
defines normalized press events and disabled/pending states. SWA owns the appearance and
still verifies its actual journeys; a library alone does not prove accessible behavior.

Anthropic's [frontend-design plugin source](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/frontend-design/skills/frontend-design/SKILL.md)
provides design guidance, while its [design plugin](https://github.com/anthropics/knowledge-work-plugins/tree/main/design)
offers critique, design-system, copy and accessibility workflows. These are useful references,
not runtime component libraries. No provider plugin is installed as part of this UI change.

[Claude Code mods](https://code.claude.com/docs/en/plugins/mods/overview) can draw panes and
controls inside Claude Code. The official [sample mods](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods)
show optional detail panes and short status affordances. They do not supply SWA's browser UI.
The selected-conversation Groups plugin keeps its existing hooks/MCP architecture.

A desktop wrapper can be considered for a concrete native need after browser acceptance.
[Tauri](https://v2.tauri.app/concept/process-model/) uses platform WebViews, adding another
runtime to qualify while rendering the same web interface. The browser and existing launcher
are the smaller route for this design change. No new native bridge or wrapper is introduced.

## Acceptance

For each changed journey, cover empty/loading/failure/retry states, keyboard focus, saved
drafts and reload/navigation. Inspect desktop, 412×915, 360×800 and 915×412 screenshots,
enlarged text and reachable controls. Record production bundle changes when adopting a
component dependency. Browser/device emulation is distinct from physical iPhone Safari and
Home Screen acceptance; see [phone acceptance](PHONE_ACCEPTANCE.md). Source checks and
built assets are separate from installation, activation and two-person Groups acceptance.
