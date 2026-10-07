# Shared start/stop actions

Normal Groups integrates typed shared instructions, work registrations, proposals,
confirmation, the owner-bound native coordination lane and board controls. Local SQL,
Worker and browser checks do not prove real-provider or two-installed-computer acceptance.
See [current release limits](STATUS.md#groups).

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

## Original-owner runtime adapter

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
HOME concurrency or two-installed-computer acceptance. The normal UI and protected
consumer mounts have separate local integration checks.

## Normal composition

The existing membership Durable Object owns `GroupActionsService` and the authenticated
`/v1/groups/:groupId/actions` route. Membership, verified owner-task/autonomous-source
bindings, revocation guards and capacity admission run in the same service transaction.
`GroupHost.actionContext` retains the protected endpoint/enrollment authority; the normal
`registerGroupActionsRoutes` and `GroupActionsBoard` use saved opaque handles.

`GroupFeatureCoordination` registers the native coordination capability and dispatches
confirmed actions through the original manager's ordinary signed lease/QUARK lane.
Reconnect draining reconciles the retained action receipt before resubmission. No alternate
member executor or provider queue is introduced.

Promotion and private queries consume authenticated evidence pages. Each immutable source
has `group-action:<groupId>:<sequence>` identity and version 1; exact JSON and supplied
instruction/proposal/action/goal/task/manager/worker/outcome/job/Git links remain retained.
A stored override notice or outcome is not proof of successful cross-installation delivery;
the original publication receipt must confirm it.

## Focused verification

With Node 24 and built shared contracts, run
`vitest run apps/server/src/group-actions.test.ts`. Persisted confirmation, competing
proposals, stale CAS, revocation, original-owner routing and exact retries are covered.
From `apps/web`, `playwright test --config playwright.group-actions.config.ts` checks the
control fixture at desktop, 412×915, 360×800 and 915×412. Its runner owns the loopback
preview and browser. These fixtures do not establish real-provider or physical-device acceptance.
