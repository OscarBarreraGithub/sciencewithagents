# Hosted Groups archives and recovery

Work ID: `dd2a5e5e-hosted-recovery`. This is a read-only application SQL export,
private local archive and conservative recovery policy. No automatic restore is provided.

## Save and verify an archive

On the original creator computer, open **Groups → Manage → Private hosted backup →
Export hosted data**. Choose a quiet window and let verification finish. The app saves
a fresh archive and reports its ID and row/byte counts; its receipt retains the SHA-256.
It never asks for a path,
SQL query, Cloudflare token or service URL in the browser.

The archive is `<app-data>/groups/hosted-archives/<archive-id>/archive.jsonl` on that
computer. Its directory is `0700`, file `0600`; no previous archive is replaced. The setup
agent can copy that verified file to the owner's chosen private backup storage. It contains
membership/invitation hashes and shared content: do not attach it to public issues or Git.
After copying, verify it in the corresponding private app-data layout with the current
built server:

```sh
node scripts/group-hosted-archive.mjs verify /absolute/app-data archive-uuid
```

Verification reads the complete file and checks its digest, schema/table catalog, ordered
row identities, column/cell counts, contiguous pages, exact integers and binary encodings.
It executes no exported SQL and makes no network call. The app removes its own failed fresh
output. Preserve a copied or previously saved archive that fails verification for inspection;
it is not a successful backup. The browser retains the exact request key across reloads
and restarts. Retry reconciles the same group-scoped archive ID, verifies its existing
bytes and obtains fresh creator authorization; it does not create another copy. The app
retains the verified receipt after reload. **Export another snapshot** explicitly starts
a new key after success. The local durable intent uses the existing 2,048-operation
history bound. A corrupt, missing or incomplete file left by a crash is held for inspection;
it is never replaced. The app offers **Keep held archive and export a fresh snapshot** only
after that explicit held-file result. This preserves the old intent/bytes and starts a new
key/ID; it does not turn a normal uncertain acknowledgement into a duplicate export. A normal
remote-changed result retries the same key in the app. Ask the setup agent to inspect held
files privately, preserve them before moving them to separate private storage, and use the
verification command; never edit their footer or overwrite a verified copy. If a previously
verified archive was moved, same-key retry stays held rather than reusing its ID for new bytes.

The protected service requires the existing setup capability **and** the still-active
original initialized enrollment. It verifies the initialization receipt and group-ID
derivation. An invitation, joining enrollment, or setup capability alone cannot export
membership hashes. No admin membership role is introduced. A revoked creator cannot use
this export to restore membership; missing creator capabilities require explicit recovery.

## Snapshot and finite limits

Production pages pin Cloudflare's current SQLite bookmark and compare it before/after each
page. Any intervening change aborts the export; retry starts a fresh snapshot. Local Worker
fixtures use a bounded full-state digest because PITR/bookmarks are unavailable locally.
Production bookmark errors never fall back to a weaker snapshot.

Even ordinary group reads can update retained write probes or read counters. Background
clients, publication/reconciliation passes, and active native work can therefore interrupt
an export. There is no implicit service freeze or stopping of anyone's work. Arrange an
explicit quiet maintenance window for a larger archive; repeated changes fail visibly.

Limits are 512 KiB/page, 128 rows/page, 4,096 pages, 1,000,000 rows, 512 MiB encoded
payload and 180 seconds/export, with a five-second page deadline. The local archive store
allows one export at a time, eight retained directories and 1 GiB total. Empty held directories
count toward that limit with zero bytes. To free retention capacity, the setup agent must
deliberately move the complete private UUID directory after preserving and verifying its
backup. For a held partial/empty directory, preserve its ID and any bytes for inspection,
move the entire directory privately, and continue with the explicit fresh-snapshot key;
do not reuse the held key or call that partial a verified backup. Moving only a file leaves
a counted held directory. Nothing is automatically pruned.
These are application bounds, not a purchase of provider quota or infinite group capacity.

All currently present application SQL tables, exact `sqlite_master` definitions (including
indexes/triggers), row IDs, original text, integer values, BLOB report chunks, membership,
revocations and idempotency/action receipts are retained. Empty tables and SQLite sequence
rows remain represented. Unknown tables, virtual/without-rowid tables, nonempty hidden KV,
alarms or oversized data fail closed instead of producing a partial-success archive.
Local Wrangler's exact `__miniflare_do_name` SQL metadata table is retained only in local
fixtures; it is not an allowed production-table exception.
This is a logical SQL archive, not SQLite physical pages, Cloudflare's private log, or a
backup of local private conversations, provider credentials, native journals/workspaces,
unpublished report captures or local configuration. Preserve those separately through the
existing private installation backup process.

## Supported updates and capacity transitions

The supported migration is a reviewed same-service update preserving the Cloudflare account,
Worker/DO class and namespace binding, existing SQLite migration tag, exact group identities,
setup/routing capability mapping and all rows/receipts. Once export is available, take a verified archive first; apply
additive schemas and compare retained identities/counters afterward. Do not delete/recreate
the namespace, reset capacity counters or change endpoint aliases to make pending work pass.

An existing earlier Worker without this export endpoint cannot produce a pre-update archive
through this feature. For that first update, preserve the available current private local
membership/configuration, native/receipt journals, and exact source/configuration bundle.
Keep existing DO storage and identities unchanged for an explicitly reviewed additive update
of the same service; export and verify immediately once the endpoint is available. This
first-update disposition does not claim a verified prior remote archive. If current remote-state
preservation cannot be established, hold destructive recovery or data migration. No automatic
PITR, restore, namespace replacement or capability reset is authorized by this exception.

Current delivery/source/history/storage limits still apply; this export does not enlarge
them. A capacity transition can use a new group only with the person's explicit scope:
preserve the old service/archive, reconcile pending effects, create new identities and
invitations deliberately, and share selected content anew. There is no cross-service receipt
import, identity rewriting or transparent migration of old authority. A future lossless
import requires a separately reviewed format/version and reconciliation implementation.

## PITR and destructive recovery

[Cloudflare's SQLite PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)
can restore SQL/KV state within its documented recovery window; it is not available in local
development. This app exposes no restore/bookmark-rewind endpoint or recovery command.

Rolling back old membership or idempotency state is unsafe: it can revive revoked access,
erase acknowledgements and replay already executed native/Git effects. Any account-owner
PITR operation requires explicit quiescence of all participating writers and dispatchers,
preservation of current local native/receipt journals and a verified current archive,
an exact selected rollback point, and a reviewed reconciliation disposition for every
post-point revocation, accepted publication and external effect. Keep uncertain actions
held. Reconcile current revocations, exact IDs/CAS and owner receipts before admitting any
new execution or reconnecting producers. A restored database alone does not establish this.
If a verified current archive is unavailable, hold recovery for a separately reviewed
current-state preservation procedure; do not bypass creator authorization or pending revocations.

## Evidence and remaining acceptance

Focused actual local Worker SQLite tests cover creator denial, exact schemas/row IDs,
64-bit integers/row IDs, binary bytes, no export writes, eviction, changed snapshots and unsupported
state. Local archive tests cover restart verification, corruption/truncation, gaps, private
permissions, concurrent jobs, time bounds and symlinks. A normal authenticated host fixture
loses its app response after the verified archive commits, restarts, and returns the same
receipt without a duplicate archive. Browser checks cover pending/success reload and a lost
response at all four emulated viewports.
An interrupted-file fixture retains its exact first page, reports the held disposition,
and creates a separately identified fresh archive without altering the partial or verified copy.
On 2026-10-08 the maintainer updated the existing Worker and local installation, preserving
all deployed bindings/configuration and saved local enrollment. Four existing creator groups
produced bookmark-backed archives; separate offline CLI verification matched every receipt.
These were small snapshots on one installation, without model calls or destructive restore.
Concurrent-change behavior on the deployed service, larger/full-capacity archives, account
PITR, independent creator/member installations and physical phones remain unverified.
