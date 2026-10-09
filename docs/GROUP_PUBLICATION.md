# Local durable group publication

`group-publication.ts` bridges the [reviewed event repository](GROUP_COLLABORATION.md)
to the typed [hosted transport](GROUP_DELIVERY.md) used by the normal GroupHost.
Authenticated enrollment, protected endpoint resolution and bounded background delivery
are integrated. The SQLite HTTP receiver and process runners named `*.fixture.ts` remain
disposable tests, never production adapters or proof of deployed synchronization.

Completed deliveries release their active header slots through transactional compaction,
while retaining permanent identity and receipts.
Retained history now uses byte admission within a finite 1 GiB local journal ceiling,
with acknowledgment space allocated before effects. It has no 2,048-identity lifetime stop.
Credential/endpoint changes and exhausted journals require explicit reconciliation;
normal integration does not remove these storage and identity fences.
Epoch rotation cannot extend the journal's lifetime or republish an old event.

## Authorization and scope

The authenticated host chooses a dedicated journal file for one group enrollment
(`groupId`, `installationId`). It resolves a registered remote group, installation epoch,
endpoint alias and credential-grant revision, then calls `trustedHostRegister` with a
host policy callback. These aliases are UUIDs, not URLs or secrets. The callback must
resolve the current identity from trusted persisted host membership/context and secret
storage; it must not echo a browser scope or accept a browser-selected endpoint/path.
This host policy is an explicit trust boundary, not network authentication implemented here.

The callback returns a repository-issued **shared** `GroupAccess` and the current binding.
That exact in-process handle is pinned for the life of this registration. Replacing its
context requires a fresh controller registration; serializing either capability grants
nothing. After repository/controller restart the host must resolve the same authorized
context and obtain fresh handles. A private handle cannot register, read the journal or
publish, even though the event repository permits private contexts to read shared evidence.

Only already-recorded shared event references authored by this enrollment are enqueued.
This controller does not relay another installation's events and offers no original-text
input, private-to-shared promotion or implicit history scan. Enqueue validates the whole
bounded reference batch before writing any rows. Private, other-group and forged references
return fixed errors without copying the attempted IDs, originals or activity counts.
The journal is pinned to one enrollment so another group's occupancy cannot populate its
status or queue quotas. Shared stream positions remain the repository's authorized positions.
The foundation's `sharedPublication` API reconstructs already-authorized same-group shared
originals before the controller checks the author's installation. Other-installation content
may therefore enter bounded local memory, but is rejected before any journal/envelope/transport
output. Checking authorized metadata before expansion is a remaining optimization that requires
a separate foundation API change; the controller does not grant access to private originals.

Every enqueue, inspection, content reconstruction, receipt query, effect, retry and receipt
acceptance rechecks the callback and repository authority. Repository content reads use
`sharedPublication` and its transactional membership/context/installation and manifest
verification. Checks run again immediately before transport invocation and after each await.
Revocation or a changed mapping during I/O prevents accepting that response and further
sends; already accepted remote effects cannot be retracted. Abandoned local leases expire.
The host remains responsible for associating its callback's enrollment with the authenticated
repository context, and for projecting hosted revocation/credential changes into that policy.

## Durable journal and bounded driving

For unfinished deliveries SQLite retains the reference, generated operation UUID, exact event
header, canonical payload hash, immutable binding, attempt count, due time, lease and effect intent.
Original chunk text is reconstructed in bounded memory and is not stored in the journal.
The local event's original operation/causal/evidence/source IDs remain unchanged; the new
publication operation ID identifies remote delivery. Re-enqueue returns that same UUID and
checks the same header/hash, including after restart and simultaneous process enqueue.
A journal-wide unique event identity spans every epoch/partition, enforced both in the enqueue
transaction and by a unique SQLite index. An event retained in another epoch (including complete,
uncertain or exhausted events) returns only `identity_changed`; no new ID is exposed and no row
is added. A mixed batch rolls back completely, including earlier newly inserted references.

Enqueue is a single `BEGIN IMMEDIATE` transaction for the whole batch. A validated committed
receipt is saved with `synchronous=FULL` before later scheduling/compaction. Event append and outbox
enqueue are separate transactions: a host must retain the append result and enqueue/retry
its authorized reference; this module does not scan history to repair an interrupted handoff.
Immutable identity rows and receipts are never deleted to make room for a new operation.
Only a validated committed receipt permits compaction. Enqueue allocates a fixed 8 KiB SQLite
receipt slot under the original operation ID. Retention changes only the constant-size body
and its 0/1 committed bit, requiring no new row/index/overflow-page allocation. If later
completion-state persistence fails, the exact binding/payload/event receipt proves completion
on inspection or restart without another transport query or effect. The retained
row keeps the event UUID, delivery operation UUID, canonical payload hash, SHA-256 of the exact
canonical header, exact canonical source reference (`sessionId`, provider, `nativeSessionId`,
`messageId`), immutable partition/full binding, receipt and all diagnostic/recovery counters.
The original event repository, header and texts remain unchanged. Identical re-enqueue reconstructs
the authorized original and checks its canonical header digest, source and payload hash before
returning the original operation ID. Completed `inspect`/`step` uses the retained state with no
network or extra effect; no history scan creates new queue entries. Pending, uncertain, exhausted
and collision/protocol/integrity-quarantined rows retain their complete headers and recovery state.
SQL triggers prohibit identity edits, deletion, reversing compaction or changing a compacted row.

Schema version 3 migrates versions 1 and 2 in one transaction. It streams existing headers,
records their digest/source and validates bindings, canonical headers, exact committed receipts,
identities, states and counters before compacting completed rows. It never reconstructs originals
or calls a transport during migration. Unknown/unversioned, corrupt or duplicate histories fail
with `storage`; rollback retains the old schema and all rows, without reset or selecting a winning
history. Every open also performs bounded journal integrity validation; this is not a repository
history scan or an enqueue repair. Version 1 did not distinguish offline steps from effects, so
its old attempt count becomes a conservative spent effect budget (capped at 96). Existing legacy
exhaustion remains retained: a committed receipt can finish the same ID, while any additional
effect requires separately reviewed recovery, never a budget/history reset.

`step(handle, operationId?)` drives at most one operation, making at most one receipt query
and one effect. Without an ID it selects one indexed, due eligible row in this enrollment/epoch
(including exhausted receipt-only work),
skipping live leases and future due times so they cannot starve other eligible work.
There is no polling loop, retry timer, model call or provider wake. The host supplies its
clock/deadline scheduler and chooses bounded connectivity/owner wakes. Observe
`inspect(...).nextAttemptAt`; calls before that time return `waiting` without network work.
Normal host delivery and explicit retry wait for short saved deadlines, rechecking early timer
wakes at most three times within the existing wait budget. Longer cooldowns or a stalled clock
retain the same retryable receipt without an early remote attempt or native resubmission.

Leases last 30 seconds; each I/O deadline is five seconds. Concurrent controllers/processes
share the SQLite lease, and an expired owner cannot accept a response or send the next effect.
A transport must honor abort and bound its resources; remote idempotency is still required
because an already transmitted effect may arrive after timeout or lease expiry.

## Version 1 remote protocol requirements

Packets are strict Zod objects. Each key contains protocol version, complete binding,
operation ID and payload hash. A `begin` adds the exact shared event/header. A `chunk`
adds one original manifest index, byte count, SHA-256 and exact text. A `commit` contains
only the key. The current exact event header includes local `scope.source.sessionId`,
`nativeSessionId` (the provider thread ID) and `messageId`. These execution identifiers are
transmitted by this test protocol; there is no claim that they are secret-safe or minimized.
A production projection/minimization decision and matching versioned protocol are mandatory
before actual sharing. This correction preserves the reviewed foundation's exact event IDs.
All original Unicode, whitespace, control characters and manifest boundaries
are preserved; no normalization, rechunking, silent truncation or private source import occurs.

Canonical hashing recursively sorts JSON object keys by JavaScript string ordering,
preserves array order and uses `JSON.stringify` for primitives. Hash the canonical object
`{version,binding,operationId,event,chunks}` with SHA-256 over UTF-8; exclude the
`payloadHash` field itself. This is this protocol's algorithm, not a claim of RFC 8785
conformance. The receiver must implement the same versioned algorithm and exact manifests.

An authenticated receipt binds the same complete key and is one of:

- `absent`: no accepted operation under this key.
- `staged`: the immutable header and any verified chunks are retained; an ordered,
  unique, bounded `missing` list names only this manifest's absent chunks.
- `committed`: exact event ID and a stable positive remote sequence.
- `collision`: this operation or event already has incompatible content/identity.

Before **every** effect, including the first and all uncertain retries, query the same
bound operation's receipt. A staged receipt sends just its first missing chunk; an empty
missing list permits commit. A committed receipt completes locally without repeating an
effect. An absent receipt permits the same-ID begin. Persist effect intent before transport
handoff. A throw, disconnect or timeout after intent leaves `uncertain`; no fresh ID is minted.
On restart, reconcile that intent through the same endpoint/grant receipt before sending.

`not_sent` is available only to a trusted adapter that can prove no new effect was handed
off (for example, a locally detected offline connection). It permits ordinary offline
recovery after the preceding receipt reconciled earlier intent. A transmitted request with
no validated acknowledgement must throw/remain uncertain, including authentication failure
after handoff. Definite query unavailability uses `offline`, `unauthorized` or `revoked`.

Production transport and receiver must provide **all** of these guarantees:

- Authenticate the actual registered endpoint/service and currently enrolled group,
  installation, epoch and credential revision on queries, begin, every chunk and commit.
  Credentials remain in protected secret storage and authenticated headers; never in
  these JSON objects, URLs, journal, logs or errors. Disable redirects to other identities.
- Scope durable remote idempotency to the full binding/operation key. Transactionally reject
  collisions, preserve exact immutable headers/chunks, and acknowledge a staged chunk only
  after its bytes and manifest digest are durably verified.
- Atomically validate the complete canonical envelope, authorize membership, append exactly
  one event and retain its stable commit receipt. Enforce event-ID uniqueness as well as
  operation idempotency. An in-flight old request cannot create a second effect after an
  absent receipt/retransmission; this requires remote serialization and durable idempotency.
- Return authenticated, fresh, authoritative receipts from the same service/database; retain
  receipts/staging for the entire supported recovery lifetime. A JSON `authenticated: true`
  is not a proof. This controller rejects extra fields and mismatched/stale binding, hash,
  operation or event receipts, but cannot establish remote trust from JSON alone.
- Enforce packet/decoded-response/time/concurrency quotas before decoding or writing, and
  authenticate before disclosing receipts or history. Do not forward unrelated host streams.

Changing endpoint, remote group, credential revision or epoch makes an existing registration
report `identity_changed`; a new registration cannot retarget the immutable old partition.
New epochs use separate partitions and cannot send or re-enqueue old event identities.
A new epoch cannot bypass completed, uncertain or exhausted history. Do not clear an uncertain
operation or allocate another ID to bypass this block. A separately reviewed migration or
authenticated old-binding reconciliation is required before production recovery across changes.

## Quotas and recovery states

| Limit                     | Bound                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| One journal               | One group/enrollment; at most eight epochs                          |
| Active headers            | 128 unfinished per epoch, including exhausted/quarantined rows      |
| Retained identities       | Byte admission across all epochs/states; originals and IDs retained |
| Pending / enqueue         | 64 pending per epoch; 16 refs per enqueue                           |
| Header / packet / receipt | 48 KiB / 100,000 bytes / 4 KiB of canonical JSON                    |
| Original                  | Repository limits: 1 MiB, 64 chunks, 16 KiB per chunk               |
| Journal main database     | 1 GiB, enforced with SQLite `max_page_count` on every open          |
| Effect budget             | 96 per operation; receipt-only checks cost zero                     |
| Diagnostic steps          | Saturate at 2,147,483,647; failure/backoff counter saturates at 96  |
| Timing                    | 250 ms after progress; failure backoff 1–60 seconds; no busy loop   |

An additive, once-backfilled counter charges canonical header/source/receipt bytes, 4 KiB
row overhead and each fixed acknowledgment slot plus its row overhead. Inserts and updates
maintain constant-time byte and per-partition active/pending counters. Completed
rows release active-header capacity, never their identity or receipt slot. Re-enqueue of a retained ID
still succeeds at logical capacity; a new ID fails `capacity`. Unfinished/quarantined history
can fill the 128 active slots even if fewer than 64 pending rows remain. Epoch changes never
reset either history or journal-wide capacity.

The overhead allowance is not a proof of worst-case physical fit. The hard SQLite ceiling
can reject writes earlier with `storage`; neither error permits dropping history or allocating
a replacement ID. Compaction releases overflow/free pages for reuse without VACUUM, a second
copy or shrinking the physical file. DELETE-mode rollback journals can transiently require
additional disk space, bounded by the main database size; allow another 1 GiB plus filesystem
overhead. The append-only event repository's original storage and remote receipt/staging
lifetime are separate. No automatic retirement, unlimited history, receipt-only lifetime
extension or epoch workaround is supplied. Endpoint, remote group or credential-grant changes
still block an existing immutable partition, including new enqueues. SQLite/OS failures do
not imply delivery, and an interrupted completion can only recover the same ID through its
bound committed receipt. Old pending journals allocate acknowledgment slots additively before
another effect. A full old journal can still read its original remote receipt, but cannot
handoff a new effect without that reserve. Slots do not reserve OS disk space or hosted quotas.

Statuses are fixed small enums. Authorized inspection adds only this operation's diagnostic
`attempts`, spent `budgetAttempts`, due time and uncertain-intent flag. Failed authorization returns no ID, count, timing or
content. Repository denial is `unauthorized`; a trusted host revocation or authenticated
remote denial may report `revoked`. `offline` preserves the reference; `uncertain` requires
receipt reconciliation. `collision`, `protocol` and `integrity` quarantine an operation.
Diagnostic steps never cause exhaustion. Each newly attempted effect reserves one of 96
budget slots durably with intent immediately before handoff, including retries after an
authoritative absent/staged receipt. Receipt queries never spend a slot, even when a previous
effect remains uncertain. Failed/unavailable receipt checks preserve all prior intent and
budget and keep the capped 60-second backoff. An authenticated `not_sent` proof after
reconciliation refunds only the current effect reservation atomically with clearing intent;
it never refunds an earlier uncertain effect. Definite pre-handoff failures and prolonged
receipt unavailability remain retryable through outages and restart. A successful full
64-chunk event needs 66 effect slots. All counters remain finite/saturating; no retry loop is
created.

At 96 spent effect slots, `exhausted` prohibits additional effects while retaining identity
and uncertain intent. It remains eligible for bounded, authorized receipt-only reconciliation
on the same due-time/backoff and lease rules: a committed receipt atomically completes the
same ID; an absent/staged receipt retains exhaustion and prior uncertainty and sends nothing.
An unavailable receipt never consumes additional budget, refunds history or clears intent.
Each exhausted step makes at most one receipt query and zero effects. Collision, integrity
and protocol quarantine still prohibit further I/O. Exhaustion that needs another effect,
capacity and identity migration need explicit host recovery work; there is no reset that
silently repeats an effect under a new ID. Lost local acknowledgements of enqueue/completion
can be resolved by re-enqueue or authorized inspection.

## Verification and wiring gates

Focused checks use Node 24, the actual `GroupEventRepository`, disposable SQLite journals,
an authenticated owned `127.0.0.1` HTTP receiver and real child-process exits. They cover
atomic concurrent enqueue, leases/late responses, partial chunks, exact Unicode/manifests,
full-size originals, duplicate/collision handling, local and remote revocation, interleaved
private/other-group canaries, lost acknowledgements, restart, pre/post-send crash windows,
more than 96 definite pre-handoff offline/unavailable/not-sent steps, full 64-chunk delivery
through prolonged outages, saturating counters, due-row fairness, zero-row intent fencing,
strict receipt matching, quotas, cross-epoch race/restart/batch deduplication, same-group
other-installation canaries and safe legacy migration/duplicate rejection. Completed turnover
checks deliver 320 real receiver commits with multiple repository/controller reopens and
simultaneous child-process replay of a compacted identity. They preserve exact receipts and
originals, reject compacted payload/binding changes and retain unfinished recovery histories.
Actual process exits immediately before/after completion and migration COMMIT exercise
rollback/retention; corrupt migration inputs roll back nondestructively. An owned SQLite
pressure table fills the main file to 64 MiB, verifies atomic enqueue failure and retained
IDs/receipts across restart, then releases only artificial pressure pages to resume delivery.
A separate large-header check observes freed overflow pages reused by the next enqueue in the
same file; SQLite may first grow the file while updating an active row. A trusted receipt-only
fixture retains more than 2,048 completed identities and checks cross-epoch byte admission
without resetting history. A real smaller physical-fence fixture verifies constant-size
acknowledgment retention despite a forced final-state failure, then restarts without replay.
Lost begin,
partial-chunk and commit acknowledgements are followed by more than 110 unavailable/failed
receipt checks across actual process restarts, preserving the effect budget before same-ID
recovery. Receipt-only completion at the ceiling and no effects for absent/staged ceiling
receipts are checked, including revocation and backoff.
All listeners, databases and owned child processes are closed by the fixtures.

From the task worktree, with Node 24 on PATH:

```sh
pnpm --filter @dock/shared build
pnpm exec tsc --noEmit --strict --noUnusedLocals --noUnusedParameters --skipLibCheck \
  --target ES2023 --module NodeNext --moduleResolution NodeNext \
  apps/server/src/group-publication*.ts
pnpm --filter @dock/server exec vitest run src/group-publication.test.ts
```

The normal host supplies authenticated membership/context mapping, protected credentials,
source registration and bounded outbox scheduling. Finite journal capacity and ambiguous
credential/endpoint changes still require explicit reconciliation; no automatic rotation
or replay extends the lifetime. Actual Workers Free entitlement, deployed HTTPS service,
provider readiness and two-installed-computer acceptance remain external gates. The local
receiver fixture proves none of them. See [Status](STATUS.md#groups).
