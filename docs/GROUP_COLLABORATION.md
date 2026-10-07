# Group collaboration foundation

The shared TypeScript/Zod contracts and local Node 24 SQLite event repository underpin
the normal [Groups workflow](GROUP_WORKFLOW.md). Authenticated enrollment, hosted transport,
owner-authorized native execution and the UI are integrated. Actual deployed hosting,
provider sign-in and two-installed-computer acceptance remain listed in [Status](STATUS.md#groups).

## Identity and access

Group, member, installation and local session identities are generated UUIDs with distinct
TypeScript brands. Members must supply a nonempty display name; names never authorize access.
Here `installationId` identifies a group enrollment, not a global physical machine: enrolling
the same machine in another group generates a different ID.
A persisted context binds group, member, installation, visibility and exact provider/native
session identity. Native identities cannot be registered twice, including across groups or
shared/private visibility. Registration accepts no parent/fork field. The native
adapter must prove that a provider context is fresh; this repository cannot inspect provider
history or enforce process confinement.

`GroupEventRepository` is a **trusted host module**, not a browser API. Only an authenticated
host adapter may provision members/contexts, revoke membership or call `trustedHostScope`.
That adapter must resolve identity from its authenticated, persisted context; it must not
forward a browser-supplied label or scope. The returned opaque handle is local to one
repository instance. Serialized scopes and handles from another instance have no authority.
On restart the host must resolve identity and obtain a new handle. The normal host and
protected group service supply network authentication, invitation expiry and native broker
integration; this repository alone supplies none of them.

Every append, feed read, evidence expansion and publication checks active membership,
installation and exact persisted context inside a SQLite transaction. Private feeds contain
only that member's exact private session. A private context may explicitly read the group's
shared feed/evidence, but cannot access another private session, another member's private
records or another group. Shared contexts cannot read private evidence. `sharedPublication`
returns only a bounded allowlisted batch of shared records and exact originals; it rejects
all private handles and private/unrelated records. It is a local publication boundary, not
an implemented network outbox by itself. The normal host uses the separate publication and
promotion adapters; they do not make private evidence shared automatically.

## Immutable evidence and retry

Each event retains an exact source message identity, causal references, evidence references,
entity revision, category, substantive caller-authored condensed text and original-content
manifest. Categories are Question, Idea, Decision, Instruction, Conflict, Blocker, Finding
and Action. The repository does not generate summaries or truncate prompts. Original chunks
and condensed entries reject updates/deletions. Corrections append a new event referencing
the current entity evidence; previous feed entries and originals remain unchanged. A feed
entry is evidence, not authoritative action state.

A durable unique `(group, member, installation, operation)` receipt hashes the complete
validated scope and payload. An identical retry returns its original result, even after
restart; a changed payload or scope conflicts. The exact session/message source is also
unique. Entity revisions are checked under the same write transaction: shared revisions
are group-wide; private revisions belong to the exact private context. Two concurrent
connections cannot both append against the same expected revision. References must already
exist and be visible to the caller; future, private and cross-group references are rejected.
One exact source message stores one event and its complete original. A message containing
both a Decision and an Action still has one original evidence event here. The separate
promotion controller handles classification/synthesis; this repository does not split a
source into multiple derived feed items.

Reads intentionally use `BEGIN IMMEDIATE`, as writes do, to keep membership checks and
retrieval in one serialized transaction for this small-group foundation. This trades read
concurrency for consistent authorization; concurrent read optimization remains later work.

UTF-8 limits are 16 KiB per inline original/chunk, 64 chunks and 1 MiB per original,
4 KiB per condensed text, 16 causal and 16 evidence references, and 50 feed entries per page.
Oversized originals require explicit ordered chunks, with byte counts and SHA-256 hashes.
Expansion reconstructs the exact original and verifies the manifest. Malformed Unicode is
rejected rather than silently replaced. No automatic chunking or silent truncation occurs.

Feed queries use indexed group/visibility/context predicates, ascending sequence cursors,
a fixed snapshot watermark and explicit continuation. Cursors are bound to the reader's
persisted context and requested visibility, and survive repository restart. Later appends
or corrections cannot change an earlier snapshot. Completion of a snapshot is not a promise
that no later events exist; a new query with `after` set to the previous watermark reads
only the next incremental snapshot. When a cursor is provided, its `after` and watermark
take precedence; the separate query `after` is used only when starting a snapshot.
Public sequence numbers count only the group's shared stream or the exact private session.
Private, other-group and other-private-session appends cannot change that stream's event
positions, watermark or continuation. All event responses (including append/replay,
expansion and publication) use these scoped positions. Feeds retrieve positions through
the unique `(stream_key, position)` index, then check the authorized event predicate.
The normal host supplies durable per-member catch-up snapshots and verified evidence
queries through [catch-up](GROUP_CATCHUP.md), separately from these repository cursors.

Schema version 2 adds an immutable position table and version marker. Opening the prior
unversioned schema backfills scoped positions in the original insertion order atomically;
no event JSON, original chunk, context, receipt, reference or entity revision is rewritten
or removed. The old database-wide row key remains internal storage metadata. Responses
project the scoped position into `sequence`, including for legacy receipt replays.
Version 2 cursors are explicit; old unversioned cursors are rejected and callers must
start a fresh snapshot. Unsupported schema versions fail closed without resetting history.

## Normal composition and acceptance

The normal feed controller uses a designated writer with a renewable lease and durable
projection/synthesis receipts. It uses the selected installation's own admitted provider
account; it cannot borrow another member's credentials. Private native contexts retain
separate fresh identities. See [promotion](GROUP_PROMOTION.md) and [native isolation](GROUP_ISOLATION.md).

The normal host/service integrate invitations and revocation, quota/offline delivery,
shared/private UI, Git controls and owner-bound actions. The group service uses actual
SQLite Durable Objects, with controlled local workerd checks. These are implemented source
and local tests, not proof of Workers Free entitlement, a deployed HTTPS endpoint, real
provider readiness or two installed computers collaborating. Current release acceptance is
tracked in [Status](STATUS.md#groups); this repository's unit tests cannot establish it.

Focused verification builds shared/server TypeScript and runs only
`apps/server/src/group-events.test.ts` under Node 24. Tests cover privacy and cross-group
canaries, forged/relabelled scopes, revocation, durable retries/conflicts, stale/concurrent
revisions, exact originals, immutable corrections, causal evidence, snapshot pagination,
interleaved stream metadata and nondestructive v1 migration/restart. The separate-process
race fixture imports current `src/group-events.ts` with `tsx`, rather than server `dist`.
Build shared contracts before running the focused tests (shared package imports use its build).
Test databases and dependency caches default to ignored task-local `data/`; reviewers may
set `GROUP_EVENT_TEST_TMPDIR` to a conventional permitted temporary directory. No app, native
provider, collector, service, phone tunnel or network deployment is started.
