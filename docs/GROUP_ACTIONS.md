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

## Native v1 runtime

The host-native bootstrap attaches `GroupFeatureCoordination` to the same action
service and exposes the board under **Manage → Shared work and actions**. The owner’s
manager creates attributable tasks and start/stop proposals from an admitted shared
Work turn. Its ordinary task inspection, independent review and exact apply tools
remain available. `dock_group_actions` reads the shared board. Ask cannot create,
confirm or execute work; incoming messages remain evidence.

`group-coordination-runtime-host` binds each task/shared goal to its exact local Work
request. Confirmed effects run through ordinary Runtime delegation, central model
policy, QUARK admission and signed manager leases, using the original owner’s native
accounts. Implementers receive ordinary task worktrees. A fresh app-owned workspace
can receive an empty local Git baseline without staging files; a GitHub remote remains
optional. Workers retain normal review/checkpoint tools and their own task lineage.

An idle owner uses a model-free control turn carrying the original Work request’s
lineage. An active Ask or unrelated Work cannot lend authority. Durable Store receipts
retain exact action/input/worker/run identities across a lost acknowledgement or restart.
A stopped Work grant cannot launch another worker. Stop needs no allowance admission,
retains its exact original target and cannot interrupt a later worker turn. Definite
pre-effect refusal can settle as blocked; unknown effects remain held for inspection.

The retained isolated connector uses its existing separate native contexts and guest
resources. It is not a prerequisite for native Groups and its saved requests are never
adopted by the host adapter.
Older isolated work records without a saved Stop run recover only from one completed
Start receipt whose worker, task, work mapping, original context and native request
marker prove the exact run. Missing or ambiguous proof blocks Stop for inspection;
the worker's current turn is never substituted.
Pending older Stop receipts may retain their original fingerprint without a run field.
They reconcile only when their saved worker/run matches that proved Start receipt;
the old input stays intact and an uncertain closure is not replayed. Isolated Start
inspection also requires one exact journaled action/run binding, including after restart.

Focused fixtures cover native queue/worktree binding, central policy, Ask and stopped
Work rejection, asynchronous cancellation, lost acknowledgements, restart inspection,
held-admission Stop and manager-proposal recovery in the board. They do not establish
real-provider, separate-computer or physical-phone acceptance.

## Retained owner receipt recovery

The finite reconnect pass can reconcile an exact retained owner receipt even when
current membership denies shared reads or new effects. The private receipt-only lane
accepts the saved original enrollment capability, exact action/revision/task and completed
or absent outcome. A pending action can close without effect only after known owner or
requester revocation and an exact no-effect receipt. Unavailable membership is not treated
as revocation. This lane never invokes a model, starts or stops work, or restores shared
reading permission. Offline owners with no retained receipt remain unresolved.

## Exact override confirmation and capacity

A conflicting override needs the exact authenticated owner/paired-device confirmation
route. The host uses a separate protected service lane to retain the proposal, observed
revision, operation ID and confirming enrollment in one transaction. Generic native action
commands cannot mint that receipt by setting `override: true`. Claims and same-ID claim
retries recheck the stored proof and current requester/owner membership. This is trusted
host confirmation provenance; the full-access native host is not an OS security sandbox
or a physical-human-presence attestation.

New admissions are bounded per member and by the existing shared storage envelope.
Confirmation atomically reserves 384 KiB logical and 512 KiB physical lifecycle capacity
inside the existing delivery pools, with at most 8 unfinished actions per member and 32
per group. Delivery/document admission cannot spend those held bytes. Claim, uncertain
and completion use three fixed action-derived IDs and consume the held capacity rather
than a new admission/day/history allowance. Completion or supersession releases unused
bytes. The separate membership revocation reserve remains available.

First-use schema and all action/receipt/notice growth are authorized, synchronously
accounted and committed with the action. Prior action identities, immutable events,
originals and receipts remain intact; unresolved legacy actions acquire reservations
atomically or fail closed without resetting history. Terminal hot rows point to their
retained append-only event; shared evidence pages keep exact original JSON and typed
causal facts. An autonomous decision is never relabelled as a human instruction.

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

With Node 24, the repository pnpm wrapper and built shared contracts, run
`sh scripts/pnpm --filter @dock/group-service test test/actions-lifecycle.test.ts test/membership.test.ts`
and `sh scripts/pnpm --filter @dock/server exec vitest run src/group-actions.test.ts src/group-coordination-runtime.test.ts src/group-coordination-runtime-stop.test.ts`.
These checks cover actual Worker SQLite reservation/rollback, admission exhaustion,
legacy preservation, exact source hashes/aliases, override proof, revocation, eviction,
lost acknowledgements and model-free retained recovery. They establish local source
regressions, not creator-deployed delivery, real-provider, separate-computer or physical-phone
acceptance. Browser control checks are documented in [release readiness](GROUP_RELEASE_READINESS.md).
