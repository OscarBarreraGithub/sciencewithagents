# Shared start/stop actions: candidate implementation

This candidate contains typed shared instructions, work registrations, proposals,
confirmation, an owner-bound coordination adapter and board controls. **The normal
Groups entry, authoritative hosted route and admitted native manager lane are not
mounted yet. D1–D5 remain open.** Local SQL and browser checks are not production
or two-installation acceptance. No provider, cluster or account action is performed.

## Behavior in the bounded modules

An explicit shared instruction keeps its exact original text and authenticated
member/installation identity. Questions, ideas and private evidence cannot become
an action by supplying an arbitrary source ID. Verified autonomous sources retain
manager and shared-goal identities. Owner task/source verification is a required
trusted adapter; it must not infer authority from UUID or display-name shape.

A proposal retains the current work revision, competing requester and time.
Confirmation is durable and idempotent, rechecks that exact revision and requires
an explicit override where appropriate. It records the affected member's notice
in the same transaction. Pending confirmations supersede older pending actions.
An uncertain dispatch blocks another confirmation until the existing owner receipt
is reconciled. Evidence and originals append; corrections never rewrite history.

Only the original owner installation can claim an action. The final claim checks
current work CAS and current requester membership, including same-ID claim retries.
An offline owner stays pending. The coordination adapter resolves the exact
owner/task/manager resource and uses typed normal delegation or worker-pause
contracts. Its lane must persist the action ID through the existing manager operation
receipt before effect, use existing QUARK/central model policy/account ownership,
and reconcile uncertain work against that same receipt. It creates no provider queue,
process controller or native output store.

The scoped native catalog includes board inspection, normal task creation, delegation
and worker pause, plus proposal/confirmation. Delegation and pause produce proposals;
confirmation precedes effect. A private context receives shared board inspection only.
The browser route accepts board/instruction/propose/confirm, never task registration,
executor dispatch, account routing or arbitrary Runtime RPC.

The board component defaults to the normal `/api/groups/actions` endpoint and stores
exact pending IDs in tab storage. Lost acknowledgements retry the same payload/ID;
known stale confirmations can be discarded and replaced after refresh. It shows
requester/time, original owner, override notification and pending/uncertain outcome.
The separate browser fixture checks these controls with simulated API responses.

## Original-owner runtime adapter (source candidate)

`group-coordination-runtime` binds normal Store tasks, immutable shared native task
attestations and durable action receipts to the original group manager. An idle
online owner can confirm an action through model-free ordinary QUARK admission and
that manager's signed lease. It does not borrow the project's primary manager or
launch an ordinary host worker. Retries retain exact input and stop target; unknown
native closure retains the hold.

Shared native managers issue fresh worker conversation identities under the same
accepted owner/group/shared guest HOME account scope. Each task uses an explicit
`/workspace/tasks/<taskId>` native process directory and separate container/run
lifetime. Containers never delete the shared volume; private contexts cannot reuse
it. Native workers receive board inspection, while manager mutations require the
exact current Work grant and retained manager/task/shared-goal source. A provider
or saved restricted-tool choice without an accepted route fails visibly without
changing the choice or importing host credentials.

Focused controlled checks cover idle-owner leases, actual connector queue binding,
lost publication/action acknowledgements, immutable delegation input, original stop
target recovery, scope/grant rejection, explicit process cwd and independent shared
HOME container stopping. These are source regressions, not real-provider, shared
HOME concurrency, two-installation or normal GUI acceptance. Consumer mounting and
exact independent composition review remain separate.

## Concrete wiring still required

- **Hosted membership owner:** install `GroupActionsService` with the same DO SQL
  storage, existing credential hash, hosting/object checks, revocation failure guard
  and bounded mutation/storage admission; expose authenticated
  `/v1/groups/:groupId/actions`. Supply verified normal owner-task and autonomous
  manager-source bindings. These required ports cannot be stubbed in production.
- **Normal host/UI owner:** provide the saved-handle, current-enrollment protected
  command transport, retaining exact service configuration/credential/hosting approval.
  Mount `registerGroupActionsRoutes` in normal authenticated routes and
  `GroupActionsBoard` in the selected shared Groups view. The existing
  `GroupHost.authenticatedContext` read port alone is insufficient for this transport.
- **Native/normal coordination owners:** register `groupCoordinationTools` with the
  existing native coordination capability factory. Implement the narrow normal task,
  approved work-resource and original owner's manager operation receipt/QUARK lane.
  Run owner reconnect draining through `dispatchGroupAction`; reconcile retained
  dispatch state before any resubmission. No alternative member executor is permitted.
- **Promotion/query owners:** consume authenticated `evidence` pages. Each immutable
  source has `group-action:<groupId>:<sequence>` identity and version 1; exact JSON and
  explicit instruction/proposal/action/goal/task/manager/worker/outcome and supplied job/Git evidence links are retained.
  Only nullable absent links are allowed. Publish/deliver override notices and action
  outcomes through their existing source receipt lane. A stored notice is not proof
  of successful cross-installation notification.

These hook requests were sent to their owners before edits. This candidate changes
only new feature-prefixed files. No peer-owned entry file, native module, shared index,
installed checkout, main source or hosting dependency is changed/imported. Interface
reading used frozen normal `e876ba7`, corrected hosted `6c32d54` and native `eb591a6`;
that is interface evidence, not approval or dependency integration.

## Focused checks

Use Node 24, build shared contracts, then run
`vitest run apps/server/src/group-actions.test.ts`. Tests cover persisted confirmation,
competing proposals, stale CAS, override notice, revocation, original-owner/offline
routing, lost acknowledgement, concurrent receipt retries, restart, SQL failure,
immutable evidence, autonomous attribution, typed normal tools and private authority.
The hosted adapter is exercised with Node SQLite and current enrollment rows;
**no workerd, hosted HTTP or actual native execution is tested here**.

From `apps/web`, run Playwright with `playwright.group-actions.config.ts`. Its owned
loopback preview closes after checks. Desktop, 412×915, 360×800 and 915×412 exercise
conflict confirmation, lost-ack reload, exact retry identity, stale recovery and width.
Screenshots are control-only browser emulation with default fixture styling; normal
Groups styling/mounting, physical phones and two installations remain unverified.
