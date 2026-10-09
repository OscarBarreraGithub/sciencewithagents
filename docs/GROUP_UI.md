# Groups presentation and synthetic preview

The normal app has **Group chat** and **My group agent** tabs. The latter uses the current
member’s own provider account and allowance. **Setup** offers readable creator, member and
shared-file choices; phone pairing remains optional. **Manage** keeps invitations and local
agent access visible, with **Remove from my app** directly below the dialog heading.
Setup and management disclosure rows use readable bordered controls. **Advanced** holds
repository review, shared proposals, older report lookup and creator backups. Advanced content
loads once on first opening and stays mounted when collapsed. Exact pending/error request controls describe the specific request.

Validated shared report notifications show **Open report** and a collapsed exact original.
Completed own replies expose their report offer only through the exact retained result/source
identity. Opening a report uses the existing group-scoped reader and current membership;
malformed or unrelated originals retain the ordinary message renderer. No personal Library
or filesystem-path fallback is added. The synthetic preview below remains a separate
limited presentation; current checks and remaining acceptance are in [Status](STATUS.md#groups).

**Setup → Shared files** first saves a chosen work folder, then offers its scoped setup prompt.
After creating or joining, **Manage → Work folder** attaches that saved selection explicitly
and verifies the intended private repository. New verified connections start automatic sync;
an existing saved pause is preserved. One repository controller retains exact pending changes
across the ordinary connection controls and Advanced review. **Remove from my app** hides
the local list entry while preserving membership, work, history and drafts; **Removed groups**
offers restore and exact interrupted-change recovery. The visible contribution selector reflects
the host’s saved Read-only/Contribute mode; drafts stay editable and new sends follow that
admission setting. Advanced displays optional
last-reported local receipt usage, separate from cloud or physical disk storage. Folder and
visibility controls make no model call.

The reusable presentation components have a synthetic preview alongside the normal
**Home → Groups** integration. Preview data does not exercise native execution, authenticated
hosting or publication. Use [Group workflow](GROUP_WORKFLOW.md) for the real entry.

`apps/web/src/groups` exports typed landing and workspace components. The landing lists
projects and calls injected create/join/open callbacks. Members type their display name;
there is no inferred name or hosting-success screen. Names render as isolated untrusted
text. Display-only escapes make control and bidi-format characters visible while preserving
ordinary international names and retained source strings. Names never authenticate members.

The workspace places shared feed beside the member's conversation on desktop. Phone tabs
retain each panel's scroll and draft. Chat reserves at least 120 CSS pixels for the
transcript. When headings, enlarged text and the existing composer need more height,
the chat panel scrolls vertically as a whole; its transcript still scrolls through messages.
Controls need not fit onscreen simultaneously: wheel scrolling and keyboard navigation
reach the private/catch-up controls, composer, Send and tabs without horizontal overflow.
In short viewports the feed heading and category
controls scroll with the evidence, giving the reading area more usable height. Categories
toggle off on a second press, without an All chip. Rows show supplied substantive summaries; the UI does not generate summaries.
Shared pages use browser-portable group contracts, at most 20 requested events per page,
with a 200-event reading window. Original expansion retains exact whitespace and Unicode,
checks the event ID, byte count and SHA-256 before display, shows loading/error/retry,
and displays supplied causal/evidence references. New group or
session identities discard pending reads and expansions. Revocation removes feed and chat.

The host supplies separate authorized shared/private chat slots, with distinct session and
draft identities. The preview composes the existing `Conversation` and `Composer` using
synthetic `Agent`/`AgentDetail` values and `draftOverride`; it does not duplicate chat.
Switching private/shared views unmounts the previous session's DOM; draft/history retention
across that switch remains the host's responsibility. Catch-up keeps the selected chat
mounted, hidden and inert, retaining its draft, selection and reading position. Dismissing
catch-up restores the prior shared/private context and focuses its invoking button.
Escape dismisses only the active workspace layer and leaves nested dialogs/portals,
already-handled events and IME composition to their owners. In the composed Notepad,
Escape minimizes the Notepad and retains the private aside and draft.
Private catch-up calls an injected callback and shows its supplied result/coverage only
in the member's panel. Request privacy must be enforced by the host. Neither a separate
React slot nor a label proves backend confinement. The host must enforce authorization,
private persistence/retrieval, no implicit publication and whole-provider isolation.

## Local preview and checks

Use Node 24 and the existing frozen-lockfile dependencies. From the repository root:

```sh
pnpm --filter @dock/shared build
pnpm exec tsc -p apps/web/tsconfig.groups.json --noEmit
pnpm --dir apps/web exec vite --config vite.groups-preview.config.ts
```

Open `http://127.0.0.1:5197`. Stop that owned fixture with Ctrl-C when done. It uses a
separate browser entry/config, with no app proxy, demo server, providers or native startup.
Its data, callbacks and failures are synthetic. Create/join report that integration is
unavailable. Drafts and synthetic chat messages use separate per-session browser storage. Sends only append browser fixture messages; they run no model and publish
nothing. Shared chat's existing send preparation semantics are unchanged. Exact source
expansion renders host-supplied original evidence without modifying it.

Backend-dependent normal chat features (uploads, history/receipt lookups or native commands)
are unavailable and fail visibly. The fixture rejects fetch, XHR, sockets and live-event
connections before normal chat modules load, its CSP denies connection traffic, and
rendered links show an unavailable notice instead of navigating.
The preview serves only its named fixture entries, Vite client modules, web source,
built shared contracts and dependency assets. It checks decoded/canonical real file paths;
arbitrary repository-root paths and ignored runtime data are unavailable, including
raw-query and encoded/traversal requests. There is no public directory or backend proxy.
The dedicated browser checks deny unexpected requests, permitting these static loopback
assets only. A real HTTP test uses a fabricated canary under the task's ignored `data/`
folder to verify denial without reading private content. Do not substitute the normal
Playwright config or start the installed app.

```sh
pnpm --dir apps/web exec playwright test --config playwright.groups.config.ts
pnpm --dir apps/web exec vite build --config vite.groups-preview.config.ts
```

The focused tests cover typed-name/create/join validation, filter toggles, bounded pages,
exact originals and retry, late responses after identity changes, private/shared drafts,
failed sends, catch-up failure/retry, keyboard focus/navigation, revocation and large text.
Correction regressions exercise private Notepad Escape at all four sizes, handled/composing
and nested-dialog events, mounted catch-up draft/selection/scroll/focus retention in both
chat contexts, and short-landscape feed reading. At 150% text in both shared and private chat, tests
require a transcript of at least 120 CSS pixels, an actually visible final message within
the clipping panel, and wheel/keyboard access to the composer, Send and tabs. Viewport
screenshots capture readable messages and reachable composer positions separately;
vertical scrolling is useful and allowed.
Screenshots/results live under ignored `data/groups-ui/`. Chromium viewports are desktop
1440×1000 and **emulated** 412×915, 360×800 and 915×412. This is not physical-device,
iOS keyboard, live-provider or two-installation acceptance.

## Integration and acceptance

The normal host supplies authenticated group/member/context identity, bounded authorized
feeds and exact originals, stable cursors, durable draft receipts, private catch-up and
explicit publication. Owner setup, Git/actions and QUARK use their protected host adapters.
The synthetic preview cannot establish those guarantees. Deployed Free hosting, isolated
provider readiness and two-installed-computer acceptance remain separate; physical phone
follow-up is owner-deferred. See [Status](STATUS.md#groups).
