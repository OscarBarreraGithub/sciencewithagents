# Persistent local Groups test workflow

This isolated developer workflow composes the reviewed Groups screens, normal
Conversation/Composer and DemoProvider with the existing GroupEventRepository.
It saves local groups, shared chat, separate private asides, drafts and send receipts.
It is one owner on one fixture host, with fake replies. No production Groups entry,
cloud deployment, invitation, native provider or second installation is enabled.

## Run

Use this task checkout, Node 24 and the pinned dependencies. Never run the fixture in
an installed checkout or copy installation data into it.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
sh scripts/pnpm install --frozen-lockfile
sh scripts/pnpm --filter @dock/shared build
sh scripts/pnpm --filter @dock/server build
sh scripts/pnpm --filter @dock/web build

env -u DOCK_DATA_DIR -u DOCK_DEV -u DOCK_LAUNCHER_LIFETIME \
  DOCK_FIXTURE_ROOT="$PWD/data/fixtures/groups-a" DOCK_PORT=45421 \
  node apps/server/dist/main.js --demo --fixture
```

Choose a fresh root and unused nonreserved port. The existing safe-host filesystem,
lock, loopback and default-deny route guards remain enforced. Open the **Groups test
host URL printed by that foreground process**. It carries a random fixture-only
connection token in its fragment, exchanged for a same-origin HttpOnly cookie and
removed from the page URL. Treat that opening link as local access authority; do not
share it. Bare API calls cannot unlock themselves with names, contexts, paths or labels.
The token and all fixture state stay under that chosen ignored root. It is unrelated
to provider credentials and works only with this test host.

Type a display name and project name under New project. Send in Your chat; the host
queues the existing DemoProvider and records exact submitted originals and completed
fake replies. Shared feed displays deterministic test excerpts, with verified exact
original expansion. These are not LLM summaries. Feed reads request at most 20 events
and retain the UI's bounded 200-event window; catch-up explicitly covers the latest
20 shared events. Reopen from Back to groups after reloading. Use Private aside for a
separate saved chat and draft; those originals never enter shared feed, expansion or
catch-up. Its composer shows the private scope before Send. Backend-dependent uploads,
native commands, invitations and cloud joining fail visibly as unavailable.

Stop the owned foreground process with Ctrl-C. Restart the exact command/root to keep
history and drafts; the cookie remains valid. Retry previous message retains its scoped
send key after a lost acknowledgement/reload/restart. A journal commits queue acceptance
and its receipt together, then reconciles immutable event receipts after interrupted
handoffs. Explicit retry can resume an interrupted **fake** turn using the same run;
it never replays a native action. Saves use draft revisions and durable retry keys.
Each tab keeps its own unsent shared/private text, saved revision and uncertain draft
request in sessionStorage, including across reload. A definitive draft 409 discards
only that rejected request, reads the saved version and requires **Use saved version**
or **Keep my text**. Keeping text still uses a revision check: another intervening save
requires a new choice. New typing during a save is retained. Uncertain/lost-ack requests
replay their exact key, revision and text before newer typing is saved. Opening a private
aside and returning uses the same per-tab save queue; clean toggles do not bump revisions.
Legacy fixture localStorage pending requests are replayed with their original identity;
a rejected legacy request can be recovered using the same controls. Deterministic
400 validation and 413 encoded-request rejections clear only the matching request;
your text is retained with a visible instruction to shorten or correct it before
saving/sending. Before a new autosave, the client applies the current host draft
schema (including unpaired-surrogate rejection) and measures the actual UTF-8 JSON
body, including handle, key, revision and escaping. Repeated oversized edits make
no draft requests; all text remains available with the same visible feedback, and
shortening recovers saving/sending. These checks never discard or prevent replay
of an already uncertain pending identity. Nothing is silently truncated. Drafts allow
at most 16,384 UTF-16
units and UTF-8 bytes, and the JSON request body must fit 24 KiB (escaping counts).
Shortening the text creates a new save request. Network failures, 5xx and authentication
failures retain the exact uncertain key/revision/text until acknowledged. Bounded local
view parsing salvages supported pending identities when other metadata is malformed.
If local text is damaged, it recovers the matching pending snapshot first, then
a valid saved base, without creating an empty autosave. Valid new typing and
explicit conflict choices survive recovery. A view with a supported pending handle
from another shared/private scope is discarded and recovered from this scope's host;
unparseable/unsupported records also fall back to the host's saved draft. Copy important
unsent text before closing a tab: tab-local recovery is not a cross-device draft service.
Test limits are 32 saved groups and 256 sends per session; existing send receipts remain
replayable at the limit. Chat renders the latest 200 entries and shows “Older messages
hidden” when truncated;
this fixture offers no older-chat paging. Shared feed expansion remains separately bounded.
Abrupt termination during initial provisioning may leave unreachable fixture-only
rows; no saved group/receipt points to them. Use a fresh root for further development
when limits are reached; no deletion or production lifecycle API is exposed.

## Focused checks

After the three builds above. For the bounded draft correction, use the
strict client check and selected browser cases below. R1/R2 do not require repeating
the unchanged host/foundation suites or the prior full workflow walkthrough:

```sh
sh scripts/pnpm exec tsc -p apps/web/tsconfig.group-fixture.json --noEmit
sh scripts/pnpm --dir apps/web exec playwright test \
  --config playwright.group-fixture.config.ts \
  --grep 'oversized.*preflight|damaged.*recover|new draft preflight|oversized pending|5xx and auth|two pages|draft lost ack'
```

Original focused acceptance checks:

```sh
sh scripts/pnpm --filter @dock/server exec vitest run \
  src/group-fixture-host.test.ts src/group-events.test.ts \
  src/development-fixture.test.ts src/owner-terminal.test.ts
sh scripts/pnpm --filter @dock/server typecheck
sh scripts/pnpm exec tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck \
  apps/server/src/group-fixture-host.test.ts apps/server/src/development-fixture.test.ts
sh scripts/pnpm exec tsc -p apps/web/tsconfig.group-fixture.json --noEmit
sh scripts/pnpm --dir apps/web exec playwright test \
  --config playwright.group-fixture.config.ts
```

Browser checks own fresh fixture roots/loopback processes and close them, including
failure cleanup. They exercise actual persisted create/send/exact-source/reload/restart,
lost-ack retry for sends and drafts, two-page revision conflicts and explicit recovery,
new typing during acknowledgements/remounts, private Notepad Escape/drafts/catch-up,
readable transcript and composer
at 150% text, and scroll containment. Chromium desktop 1440×1000 and emulated
412×915, 360×800 and 915×412 evidence is retained under ignored
`data/group-fixture-evidence/`. The separate UI-only fixture and its original tests
remain available as documented in [Groups UI](GROUP_UI.md).

## Acceptance boundary

This fixture uses fake providers and same-owner local authentication. Its generic snapshot,
event and draft routes are developer fixture surfaces, not revocable multi-user privacy
boundaries. Normal Groups uses separate authenticated host/service routes. Fixture checks
do not prove native privacy, deployed sync, Workers Free entitlement, GitHub writes or two
installed computers collaborating. See [current acceptance](STATUS.md#groups).
