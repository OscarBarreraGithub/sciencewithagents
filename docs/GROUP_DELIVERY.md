# Durable group delivery

The protected group-service Worker stores membership, shared message publication, actions
and shared document transport in the same SQLite Durable Object. Every operation checks the
current group and active enrollment in the same synchronous transaction as its effects.
The normal host resolves credentials and immutable bindings; the browser supplies opaque
saved handles and bounded intent, not endpoints, paths, credentials or arbitrary RPC calls.

Source/local tests exercise this boundary with independent authenticated installations and
real local workerd storage. They do not establish deployed hosting, provider acceptance or
two installed computers. See [Status](STATUS.md#groups) and the [normal workflow](GROUP_WORKFLOW.md).

## Hosting and enrollment authority

Fresh installations have no maintainer service default. The creator's external setup agent
deploys the protected Worker to the creator's own verified Cloudflare Workers Free account,
following the exact commands in [hosting setup](GROUP_HOSTING.md). Members configure that
same exact HTTPS service from the creator's invitation through their trusted setup agent;
they do not need their own Worker or Cloudflare account for Groups.

Repository deployment defaults remain disabled. `local-test` accepts explicit HTTP loopback
configuration for owned tests. `hosted` requires the exact approved HTTPS root origin,
protected routing capability and a saved verified-Free setup identity. The Worker checks
its matching origin and approval hash as well as enrollment Bearer authentication. A value
in a configuration file is not proof of Free entitlement. Redirects are refused; native TLS
verification remains enabled. No service is deployed or purchased by opening Groups.

Protected configuration stays in same-owner private host files. The creator alone retains
`setupCapability`; member hosts omit it. Invitations include a routing-only service descriptor
in their fragment. The external setup script validates and saves that descriptor without
fetching it; browser invitation requests cannot select a URL or replace configuration.
Membership credentials are independently generated on each installation. They use headers,
never URLs, event JSON, receipts or logs. Delivery rejects browser Origin, setup headers,
queries and non-POST requests. Changing the saved endpoint, endpoint identity or binding
refuses reconciliation against a different service; no automatic reset rewrites history.
Secret rotation preserves saved enrollment ownership.

Existing beta memberships and pending receipts retain their pinned service and signed
admission tickets; creation expiry still closes only unused creation. This compatibility
path does not enroll fresh installations in the maintainer's account.

## Exact sources, receipts and reads

Before publication the trusted host registers the exact journal-issued shared GroupSource
at `POST /v1/groups/{remoteGroupId}/delivery` using `registerSource`. Registration binds the
complete local publication binding and member alias to the authenticated remote enrollment.
Session/native aliases identify one group context; distinct message aliases permit many
messages in that context across restart. The registration operation ID recovers the same
result. Conflicting reuse refuses without rewriting an existing source or blocking the group.
Private native contexts and ambient personal/native IDs have no publication authority.

`begin`, fixed chunks and `commit` retain the original protocol-180 header, identifiers,
UTF-8 boundaries, byte counts and SHA-256 digests. Commit validates the whole envelope and
atomically stores one authoritative remote sequence and receipt. A lost acknowledgement is
uncertain until receipt reconciliation; it never authorizes a second publication ID.
Retained local sequence numbers and server-attested remote authors remain distinct.
Immutable triggers protect original sources, identities, authors, headers, chunks and
committed receipts. There is no history purge or counter reset.

Feed reads use group-bound snapshot cursors, excluding later commits from a saved page set.
Expansion returns unchanged original chunks and their manifest. Hosts verify scope, author,
ordering, watermark, continuation and digests. Private handles, wrong authors, inactive
members, uncommitted data and other-group requests are refused. Quiet acknowledgements do
not manufacture shared evidence. Designated-writer promotion retains original authors and
pending source IDs; writer downtime leaves work pending rather than inventing a summary.

## Shared reports

`POST /v1/groups/{remoteGroupId}/documents` uses the same hosting/membership authority.
Explicit sharing publishes a separate immutable manifest, selected authored files and an
optional PDF. Its owner is the authenticated **shared target context**, proved through
registered delivery identities and contexts; a private grant's native context is excluded.
The host durably retains the publication UUID, manifest digest and bytes before handoff.
Changed bundles use new publication identities; lost acknowledgements and partial uploads
resume the existing identity from exact receipts and next chunk indices.

Files use fixed 48 KiB binary chunks in SQLite, not stored base64 copies. Chunk and whole-file
hashes are verified. Listing returns bounded manifests only. Opening a selected file fetches
its chunks on demand and rechecks the remote grant/current membership before returning it.
Cached readers must revalidate remote authority on every open; they cannot fall back to a
personal library. Only the publishing installation can resume or revoke a publication.
Explicit cancellation releases unused staging reservation while retaining uploaded bytes,
original manifest and receipt. Revocation denies future reads; it cannot recall downloaded
copies. See [document contracts](GROUP_DOCUMENTS.md) for local capture/compiler limits.

## Capacity and recovery

| Guard                                                   | Bound                                                               |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| Retained feed operations / registered messages          | 2,048 / 4,096 per group                                             |
| Active feed staging                                     | 64 per authenticated enrollment; revoked staging excluded           |
| Logical feed storage                                    | 16 MiB, including source/header/chunk/receipt accounting            |
| Shared physical delivery allocation                     | 64 MiB cumulative positive SQLite growth, including document tables |
| Normal membership / aggregate normal-write fence        | 16 MiB / 80 MiB                                                     |
| Feed original / chunk                                   | 1 MiB / 16 KiB; at most 64 chunks                                   |
| Feed / expansion page                                   | 8 headers / 4 chunks                                                |
| Shared documents actual + reserved / incomplete uploads | 32 MiB / 8                                                          |
| Document chunk / manifest page                          | 48 KiB binary / 4 entries                                           |
| Daily document upload / read budget                     | 64 MiB / 128 MiB; metadata/wire responses also count                |
| HTTP body / decoded response                            | Approximately 100 KB / at most 512,000 B                            |
| Host I/O / body deadline                                | 5 seconds; caller abort honored                                     |

Pre/post capacity checks roll back refused effects. Feed writes do not consume membership's
operation/day counters; document publication begins use existing membership admission.
Document completed history has no separate lifetime count cutoff; actual retained bytes and
metadata still consume capacity. Incomplete/abandoned data is not automatically deleted.
Capacity refuses new work while retaining original IDs and acknowledged results.

The normal-write fence protects membership's separately derived revocation reserve.
Revocation bypasses ordinary admission. Every non-revoke operation, including reads/replay,
performs a real write probe; `storage.sync()` must succeed before success leaves the object.
Transient storage faults return `unavailable`. Failed authorized membership revokes attempt
a bounded durable marker; while one remains open, non-revoke access is denied across object
restart. Successful exact revocation resolves it; resolved marker history remains retained.
A failed/unacknowledged revoke is not a completed revoke. A completely unwritable store cannot
promise that new intent became durable. Application page/storage bounds are not provider
quota reservations or proof of account-wide abuse/outage behavior; see [hosting](GROUP_HOSTING.md).

After a possible HTTP handoff, timeout, abort, redirect, disconnect or invalid response is
ambiguous. Retry the original key. `not_sent` is reserved for proof before fetch; missing
receipt access does not prove no prior effect. Unknown schema versions, conflicting legacy
bindings or ambiguous permanent-block state refuse migration instead of resetting history.

## Focused developer checks

Use the pinned Node/dependencies in an isolated checkout and build shared contracts first.
Run only the relevant service/host tests for the changed boundary:

```sh
sh scripts/pnpm --filter @dock/shared build
sh scripts/pnpm --filter @dock/group-service typecheck
sh scripts/pnpm --filter @dock/group-service config:check
sh scripts/pnpm --filter @dock/group-service exec vitest run test/delivery.test.ts
sh scripts/pnpm --filter @dock/group-service exec vitest run test/group-document-transport.test.ts
sh scripts/pnpm --filter @dock/server exec vitest run src/group-publication-host-transport.test.ts
```

Owned local Worker/HTTP tests cover exact originals, restart/lost-ack recovery, bounded
cursors, private/cross-group refusal, membership revocation and capacity pressure. Document
transport checks use two independently enrolled identities and distinct host aliases against
real local SQLite; they preserve exact authored source and PDF bytes. A local HTTPS fixture
can verify TLS/header handling but does not prove a deployed endpoint or Free eligibility.
Temporary hosts, runtimes and browsers must close through their owned cleanup. Keep source
provenance, commit-specific reviews and historical run receipts under ignored `data/`.
