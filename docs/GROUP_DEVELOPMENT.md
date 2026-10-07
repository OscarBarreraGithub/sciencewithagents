# Local Groups development fixture

This developer host reuses the normal built web UI, `main --demo`, `DemoProvider`,
`Runtime` and `createServer`. The integrated [persistent Groups test workflow](GROUP_FIXTURE.md) adds local saved groups,
shared feed and separate private asides behind fixture authentication. It does not implement
real provider containment, hosting, Git synchronization or account integration.

## Current Chats integration checks

The current product interface is covered by `tests/group-host` with
`playwright.group-host.config.ts`, plus `tests/home/groups-setup.spec.ts`. These
exercise the built Chats → Groups interface on owned loopback test hosts. The older
`tests/groups` and `tests/group-fixture` presentation suites still describe the retired
standalone Groups/private-aside interface and require migration; they are not the
current UI acceptance suite. Their retained server fixtures remain useful for transport
and saved-history checks.

## Run beside an installation

Use Node 24 and this isolated source checkout. Install the pinned dependencies with
`sh scripts/pnpm install --frozen-lockfile` if needed. Build only these packages:

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
sh scripts/pnpm --filter @dock/shared build
sh scripts/pnpm --filter @dock/server build
sh scripts/pnpm --filter @dock/web build
```

Choose a fresh fixture root beneath this checkout's ignored `data/fixtures/` and an
unused loopback port. Run in the foreground:

```sh
DOCK_FIXTURE_ROOT="$PWD/data/fixtures/member-a" DOCK_PORT=45421 \
  node apps/server/dist/main.js --demo --fixture
```

Open the **Groups test host URL printed by the foreground process**; its local access
fragment is exchanged for a fixture cookie. The seeded Fieldnotes manager and newly created Codex
conversations use fake replies; no native provider runs. Existing normal chat/notepad
components and saved SQLite history are reused. Only explicit fixture selection redirects the root to
`/group-fixture`; ordinary navigation remains unchanged. A second foreground terminal can run:

```sh
DOCK_FIXTURE_ROOT="$PWD/data/fixtures/member-b" DOCK_PORT=45422 \
  node apps/server/dist/main.js --demo --fixture
```

Each root owns `data/` (database, lock, conversations) and `workspace/` (demo project).
The seed never points fixture agents at the source tree. Stop each owned foreground
process with Ctrl-C; restart with the same command to retain chats. Delete only its
chosen root when finished and after shutdown. No installed app must be stopped or
reconfigured. An occupied port fails and releases the fixture lock; it never kills
or replaces the listener.

Selection requires both flags, an absolute fixture root and an explicit port between
1024 and 65535 excluding 4330, 4331 and 5178. Do not supply `DOCK_DATA_DIR`, `DOCK_DEV`
or `DOCK_LAUNCHER_LIFETIME`. Invalid selection fails before production startup; a
`DOCK_FIXTURE_ROOT` without `--fixture` also fails. Roots must be empty on first use;
subsequent use requires the fixture marker. Symlink ancestors, symlink contents,
hard-linked/special files and saved records pointing outside owned workspace/data
are rejected. Never copy an installation database, account or history into a fixture.

## Fixture boundary

The supported surface is authenticated local Groups test-host routes, built static UI,
saved snapshots/status, local chats, chat
creation/visibility, drafts/workspace restoration, demo model discovery and event
invalidation. Other API routes return `403 FIXTURE_ROUTE_DISABLED`; unsupported
provider selection fails visibly. Native terminals, account/sign-in/history discovery,
folder browsing/connection, provider updates, task worktrees/application, document
compilation, SSH/notebooks, collectors, local transcription, publishing, phone/tunnels,
other-computer connections, recovery exports and source backups are unavailable.
Native agent coordination tools do not execute in this fixture. Background native
transcript collection, provider maintenance, conversation-search work, coordinator
wakeups and local-job dispatch are skipped. QUARK still supervises the fake chat queue.
Ordinary installation behavior, native provider permissions and the authenticated real
owner terminal retain their normal paths when no fixture is selected.

This is trusted developer configuration with fake providers, not an OS sandbox for
hostile code. Checks cover static path selection and the supported API/background
paths; they do not prevent a separate local process from changing fixture files after
validation. Audit and test any new fixture route before enabling it. The ordinary
`--demo` flag alone is a UI demo, **not** this bounded fixture host.

## Reproduce the focused proof

Build the three packages above, then run:

```sh
sh scripts/pnpm --filter @dock/server exec vitest run \
  src/development-fixture.test.ts src/owner-terminal.test.ts
sh scripts/pnpm --filter @dock/server typecheck
sh scripts/pnpm exec tsc --noEmit --target ES2023 --module NodeNext \
  --moduleResolution NodeNext --strict --skipLibCheck \
  apps/server/src/development-fixture.test.ts
```

The fixture test checks invalid/foreign/native configuration, injected forbidden-entry
canaries, normal saved chat and new conversation creation, two concurrent real main
entries on owned loopback listeners, built UI/assets/API, a fake reply retained across
restart, open-event-stream shutdown, lock removal and unrelated-listener preservation
on startup failure. Native executable canaries use fabricated homes/configuration and
owned marker paths; no real provider/account is needed. All owned test hosts and fixture
roots close through test cleanup, including failures.

The owner-terminal regression separately checks its existing authenticated production
behavior with an owned test shell. No installed app operation, real provider/account,
external hosting, group transport/privacy, hostile filesystem race, full two-member
Groups workflow or physical-device behavior is validated here. Fetching built UI/assets
is an HTTP smoke, not a rendered desktop/mobile layout check. Independent review and
exact application remain separate manager-owned steps.
