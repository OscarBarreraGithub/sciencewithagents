# Hosted group membership

The protected group service implements authenticated membership and
[durable delivery](GROUP_DELIVERY.md) for the normal app. Local workerd/HTTP checks cover
independently enrolled hosts, restart and revocation; they do not prove a deployed service,
Workers Free entitlement or two installed computers. See [current acceptance](STATUS.md#groups).

## Hosted activation remains explicit

`apps/group-service/wrangler.jsonc` disables HTTP activation, workers.dev, preview URLs
and request observability. No account, login, token, secret or deployment command is
part of this package. There is no deploy script or paid fallback. A plan string, Free
DNS zone, absent subscription, or account usage model cannot activate this service.
The explicit test-harness `local-test` value permits only HTTP loopback requests; never
configure it on a deployed Worker. The `hosted` path additionally
requires a configured exact HTTPS origin and a separate protected hosting-approval capability
hash; the host resolves its approved endpoint and headers out of band. Defaults remain empty
and disabled until the owner verifies actual Free entitlement and authorizes the endpoint.
A hostname alone is not an authorization boundary. See [HTTPS configuration](GROUP_DELIVERY.md).

Cloudflare currently offers SQLite Durable Objects on Workers Free, with errors on
Free allowance exhaustion. Actual account entitlement mapping, permitted setup,
account-wide budget allocation and live validation are still required before a separate
production activation change. This package's per-group guards do not prove account-wide
quota protection or an absolute billing cap. **A separate production enablement gate must
verify fail-closed authorization under actual Workers Free storage/write exhaustion:** if
a revocation write cannot commit while credential reads still work, access must be denied
by a verified mechanism before activation. The current integration implements a write probe,
durability barrier and recoverable request-specific failed-revocation markers, checked under local SQLite faults; it does not prove
actual platform-exhaustion or unwritable-outage recovery behavior. See [delivery](GROUP_DELIVERY.md). Local storage reservations cannot
reserve account write/request allowance or prevent other objects exhausting it. An account
administrator can change plans or buy unrelated services. [Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Protocol and authority

One generated group UUID routes to one SQLite Durable Object via `getByName(groupId)`.
Names are explicitly entered and never used as identity. Each enrollment gets separate
random member and installation UUIDs. All active members have the same invite, approve,
revoke, roster, pending-list and audit permissions. Revoking the last active installation
leaves the group inaccessible; setup cannot restore it or bypass membership.

A client retains three independent values generated with a cryptographically secure RNG:
a 256-bit installation credential, a 256-bit invitation secret when issuing an invitation,
and a 256-bit confirmation value when joining. The wire encoding is exactly 64 lowercase
hexadecimal characters. Each installation/group must use a fresh credential. The service
stores only domain-separated, group-bound SHA-256 digests of these capabilities; raw
values never enter receipts, audit, returned errors or logging. Possession authenticates
an installation, not a person's legal identity. This topology is not end-to-end encrypted.

The shared `group-membership.ts` contracts allow only membership fields and require typed
names. The browser-portable `groups.ts` module supplies UUID/name contracts directly;
membership imports the narrow membership contracts; delivery separately imports its Node/Worker wire module.
Membership adds no Unicode normalization or control/bidirectional-character filtering.
Future UI work must define safe name rendering (text escaping and direction isolation)
and an explicit input policy, preserving legitimate international text and originals under
the existing name contract. That UI obligation is not delivered by this package.

All HTTP calls are explicit JSON POSTs. Installation auth is `Authorization: Bearer …`.
No capability goes into a path/query. This slice builds no invitation URL or landing
page: a future client must place the invitation secret in a URL **fragment**, remove it
before further navigation, and redeem only after an explicit user action. GET/prefetch
cannot initialize or enroll. Responses use `no-store` and `no-referrer`; errors are fixed
codes, with no input, SQL exceptions or stacks. Callers must not log requests/secrets.

| Route/command                          | Required authority and result                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/create`, `initialize`             | Separate setup header plus client installation credential, operation UUID, group name and member name. Returns creator identity.                              |
| `/v1/groups/{uuid}`, `invite`          | Active installation; client-generated invite secret, operation UUID and TTL (1–900 seconds). Returns invite UUID/deadline.                                    |
| Same route, `join`                     | New installation credential, single-use invite secret, confirmation value, operation UUID and typed name. Returns pending identity; no membership access yet. |
| Same route, `approve`                  | Active member supplies exact pending installation UUID and matching confirmation obtained separately from the joining person. Returns active identity.        |
| Same route, `status`                   | Existing pending/active credential; revoked and unknown credentials fail uniformly.                                                                           |
| Same route, `roster`/`pending`/`audit` | Active member; bounded keyset page (`after`, `limit`). Returned `next` continues the page.                                                                    |
| Same route, `revoke`/`revokeInvite`    | Active member and exact installation/invitation UUID. Revokes active or pending enrollment, or an open/consumed invite.                                       |

The setup binding is a hash produced by `setupHash`, not a plaintext setup credential.
It is empty in the default configuration. Setup derives a stable generated group UUID
from the setup digest and initialization operation UUID, so a lost create acknowledgement
needs no global directory/object. It can initialize only an empty object. On an existing
group, even an initialization retry requires that exact creator's active installation
credential before the receipt is read. Setup headers are forbidden on other commands.

Invitation consumption and pending creation are atomic. Approval requires the invitation
to remain consumed, unexpired and unrevoked, and its issuer still active. Revoking an issuer
invalidates outstanding invitations and prevents approval of its pending enrollments;
already approved members retain their own authority. Revocation wins whenever it commits
before a competing approval; target revocation after approval still denies target access.
Expired pending enrollments continue occupying the pending bound until explicitly revoked.

The joining installation shows its confirmation separately to the approver; the pending
list does not reveal it. Approval is bound to both that installation UUID and confirmation
hash. A pending installation can recover only its own identity/status, never the roster.

## Receipts, revocation and bounds

Crypto is asynchronous before the transaction. The synchronous transaction then checks
current group routing, authorization and revocation before reading a receipt. A fresh
join authenticates an open, unexpired invitation and active issuer before normal admission
can disclose a capacity limit. A same-ID join receipt is recovered with its bound enrolled
credential even though its invite is now consumed. The transaction writes the membership
change, audit entry, receipt and counters together. Cursors are
fully consumed before any await. [SQLite transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Receipts are keyed by credential hash and operation UUID and retain a canonical request
hash with hashed secret fields. Same key/payload returns the exact response; changed payload
or command is a conflict. The client keeps its original operation, credential, invitation
and confirmation locally until recovery. A recovered join receipt remains the original
pending response after approval; `status` supplies current state. Every retry authenticates
again. Revoked credentials cannot use a receipt to resurrect enrollment; rejoining requires
a new invite, new credential and fresh approval. A retry of approval whose target was later
revoked fails. A self-revoked creator cannot recover initialization through setup.

Audit records contain only operation kind, actor/target IDs, sequence and time. SQLite
triggers reject audit updates/deletions. Nothing silently prunes history or receipts.
All dynamic SQL values are parameters; identity/secret lookups and state/page queries are
indexed. Lifetime bounds also bound stored-row scans (including historical invitations).

| Guard                                                        | Bound per group                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| HTTP and internal envelope                                   | 4 KiB; streaming enforcement without Content-Length          |
| Page                                                         | 1–50 entries; indexed keyset continuation                    |
| Active installations / lifetime enrollments                  | 64 / 512                                                     |
| Open unexpired invitations / pending enrollments             | 32 / 32                                                      |
| Invitation lifetime                                          | Up to 15 minutes; expiry applies to join and approval        |
| Normal mutation admission                                    | Stops at 1,536 recorded operations or 500 mutations/day      |
| Member revocation                                            | Exempt from normal admission; at most 512 successes/lifetime |
| Normal non-delivery SQLite ceiling                           | 16,777,216 bytes (16 MiB), checked before and after writes   |
| Additional revocation envelope (incl. delivery pointer maps) | 104,484,864 bytes (99.64453125 MiB), not eagerly allocated   |
| Derived total membership envelope                            | 121,262,080 bytes (115.64453125 MiB), application bound      |

Every successful member revocation still increments both counters and appends its audit
and exact receipt atomically. Normal admission counts those operations too, so revocations
can close normal admission earlier; they do not consume a daily/lifetime revocation budget.
An active actor can revoke each existing active/pending enrollment once, including itself.
A nonexistent/already revoked target with a new operation key is denied without writing;
a same-key retry by a still-active actor returns its receipt and resolves any retained failed-revoke marker. Self-revocation
also denies that actor's retries. The 512 enrollment bound is never reset or pruned, so the
lifetime receipt/audit bound remains 2,048. `revokeInvite`, including expired/consumed invite
cleanup, uses normal admission and cannot spend member-revocation storage.

The post-write normal size fence runs inside the same SQLite transaction; exceeding 16 MiB
of non-delivery file growth rolls back the entire normal effect, receipt, audit and counters. Member revocation skips
history, day and database admission altogether. It does not reject at the total reserved
ceiling: that number is a conservative envelope calculated under the scoped schema and SQLite
format/allocation assumptions below, not another admission guard. It is not a proven
production or provider-quota guarantee. Reads/retries still require
current authorization. No history deletion, reset, automatic upgrade or paid
fallback exists. `unavailable` never acknowledges a completed effect. A transaction fault rolls back; a
post-commit durability error may be ambiguous and requires exact-request recovery. Failed
authorized revocation markers are resolved atomically by successful revocation/reconciliation;
ordinary faults recover via a fresh write probe and barrier. Keeping an operation allows
a retry but does not promise actual platform capacity recovery.

### Storage reserve derivation

`apps/group-service/src/capacity.ts` derives a deliberately loose page envelope rather than
an empirical per-write allowance. Normal membership writes still stop at 16 MiB of non-delivery growth. The internal lifetime membership-mutation
guard is 2,048 (reduced from 10,000); permissions and 512 lifetime enrollments stay intact. The reserve charges replacement of the **entire maximum live
contents** of all eleven trees touched by member revocation, including unchanged old rows.
It is substantially larger than observed growth and is not allocated as padding by the
service. The resulting 115.64453125 MiB total is below the **128 MiB membership design budget**, leaving
room within the proposed **250 MB/group** envelope for the separately fenced delivery tables and indexes.
The guard limits retained membership history and can close normal mutations before all
otherwise eligible joins/approvals; this is an internal bound for the isolated slice. The
512 lifetime enrollment/revocation limit remains reachable, as the actual RPC fixture
shows, but unlimited re-enrollment, invitation cleanup or approval history is not provided.
Delivery allocation is now independently fenced at 64 MiB; no production quota configuration is implemented here.

Payload bounds use the existing 120 UTF-16-unit name contract: at most 360 UTF-8 bytes, or
720 ASCII characters after worst-case JSON escaping (for example 120 control characters).
UUIDs are 36 characters and hashes 64. Even allowing UTF-16 SQLite text storage and record
headers, a revocation receipt cell is below 2,304 bytes, an enrollment below 1,024 bytes,
metadata below 1,024 bytes, an invitation below 512 bytes and audit below 256 bytes. Index
cells are below 256 bytes. With 4 KiB pages these fit below SQLite's table/index overflow
thresholds, so no overflow chains are needed. Ordinary admission checks the runtime page
size and fails closed if it differs. These bounds depend on the scoped schema and fixed
reply shape; new fields/indexes or larger limits require revisiting the derivation.

A conservative leaf allowance is one whole page per record. Interior pages have at least
two children; charge another whole page per leaf plus an extra root per tree. Row bounds
for the touched trees are: enrollment table/state index, 512 each; invitation table/state
expiry index, 2,048 each; receipt table/primary-key index, 2,048 each; audit table, 2,048;
metadata, one; `sqlite_sequence`, two; and failed-revocation marker table/primary index, 512 each. Marker payloads (three UUIDs, two hashes, state and record headers) stay below 1,024 bytes. Invitation counts are actually smaller because
only normal mutations can issue them. Summing `2 × row bound + 1` gives **24,593 pages**.
The unchanged UUID/hash indexes keep the same keys and rowids through revocation.

The largest tree has at most 2,048 records; a binary-fanout depth envelope is 13 levels.
SQLite balances up to three old/five new sibling pages; charge six extra pages per level
for all eleven trees, or **858 pages**, even though their modifications run sequentially.
The allocation assumption is SQLite freelist reuse before file extension, so free pages
from earlier operations do not accumulate beyond the initial size plus the calculated
maximum live/transient envelope. It must be rechecked for a changed runtime/storage engine. Include
**58 pointer-map pages** conservatively for the initial 4,096 normal pages, delivery’s
maximum 16,384 additional pages, and the tree/balancing pages (five-byte map entries), even when auto-vacuum is disabled. Thus the
additional reserve is `(24,593 + 858 + 58) × 4,096 = 104,484,864 bytes`. Metadata/counters,
audit's sequence, receipt's primary index and open-invite state/index changes are included.
Across a closure period with no new normal writes, at most 32 open invites can change;
this envelope nevertheless includes every historical invitation and both affected trees.
[SQLite page/record format](https://www.sqlite.org/fileformat.html),
[SQLite balancing and freelist allocation](https://github.com/sqlite/sqlite/blob/master/src/btree.c).

Actual local workerd growth evidence (pinned versions below, Node 24): one fixture performs
all 512 lifetime enroll/revoke transitions. At closure it has 64 active and 32 pending
installations (416 already revoked), maximum-width escaped/three-byte/bidirectional names,
1,536 seeded historical invitation rows, populated table/unique/state indexes, 1,536 audit/
receipt rows, a full day counter and SQLite padding to 16 MiB. The remaining 96 revocations
update all 32 open invites. The test records numeric whole-database growth and largest
per-revoke growth as a secret-free `sqlite-growth` annotation. One observed run grew from
16,777,216 to 16,891,904 bytes: **114,688 bytes / 28 pages**, with largest single-revoke
growth **8,192 bytes / two pages**. UUID distribution and page packing can vary between runs.
Fixture day advances and historical occupancy/padding are seeded locally; all enrollment
and revocation transitions run through actual RPC/SQLite transactions. Historical cells
are seeded to stress the schema's conservative row envelope, not a claim that every cell
combination is reachable through the protocol. workerd does not expose `dbstat`; this is
whole-database page growth during index updates, not separately measured per-index pages.
The measurements check the scoped local runtime, not a universal bound or actual Workers
Free exhaustion. Runtime/page/version and real platform exhaustion behavior remain
separate production enablement gates.

## Local verification

Use Node 24 and the existing pnpm workspace. Only local tooling is required:

```sh
pnpm --filter @dock/shared build
pnpm --filter @dock/group-service types
pnpm --filter @dock/group-service config:check
pnpm --filter @dock/group-service build
pnpm --filter @dock/group-service typecheck
pnpm --filter @dock/group-service test
```

Bindings are generated by Wrangler 4.147.0; platform types are pinned to
`@cloudflare/workers-types` 5.20261006.1 and compatibility date 2026-10-06. Configuration
is checked against that installed Wrangler schema. Current official testing instructions
use `@cloudflare/vitest-plugin` (1.3.6 here), Vitest 4.1.11 and actual local workerd
1.20261001.1/Miniflare 5.20261001.0-alpha, rather than the older skill's Vitest 3 pool setup.
[Official test configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/),
[Durable Object testing](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/).

The suite exercises fresh creation, two independent credential holders through HTTP,
pending approval, equal permissions, bounded pages, single-use/concurrent joins, receipt
conflicts, revocation/approval races, eviction and runtime abort/restart recovery,
secret-free SQLite snapshots/audit/errors, rejected private/provider canaries, expired and
revoked invitations, cross-group denial, capacity/history/daily/member/pending limits and
transaction rollback on a forced storage failure and a crossed normal storage fence.
Capacity tests combine full day/storage with both the normal 1,536-operation ceiling and
a synthetically seeded full nominal 2,048-row history, deny expired/consumed invite cleanup, preserve
exact receipts/audit and deny revoked status/roster/pending/audit and receipt replays. Both
ordered outcomes plus concurrent approval/revocation races assert durable final states. Test secrets are random in-memory values.
The test harness owns and resets local runtime storage; it does not bind a public test port,
launch providers, change Cloudflare accounts or touch the running app.
