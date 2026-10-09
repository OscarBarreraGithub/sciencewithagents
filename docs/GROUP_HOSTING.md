# Hosted group membership

The protected group service implements authenticated membership and
[durable delivery](GROUP_DELIVERY.md) for the normal app. Local workerd/HTTP checks cover
independently enrolled hosts, restart and revocation; they do not prove a deployed service,
Workers Free entitlement or two installed computers. See [current acceptance](STATUS.md#groups).

## Creator-owned Cloudflare setup

Creator-only read-only hosted SQL archives, finite capacity transitions and the required
quiescence/reconciliation policy for any manual PITR are documented in
[Hosted Groups archives and recovery](GROUP_HOSTED_RECOVERY.md).

The group creator deploys the service in **their own Cloudflare account**. Fresh app
installations have no default maintainer-hosted service and require no beta operator or
operator-issued creation code. Joining members use the creator's service; they do not each
deploy a Worker. Existing configured services, memberships and pending beta requests remain
retained. Opening Groups only displays the copyable prompts and human checklist.

Cloudflare documents SQLite Durable Objects on Workers Free, with operations failing when
Free limits are exhausted. Check the actual signed-in account and current entitlement;
never upgrade a plan or assume that a Free DNS zone proves Workers Free. Application limits
are not an account-wide quota reservation or billing guarantee.
[Cloudflare pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Human steps

1. Creator: sign in to **your** Cloudflare account, confirm the account and Workers Free,
   and approve your service's HTTPS address. The setup agent handles the commands below.
2. Members: give the external setup agent the creator's invitation privately, then choose
   **Join group** in the app. No code exchange or separate creator approval.
3. Enable native local agents when ready. Verify one shared message in each direction.
4. For phone access, use the separate [Cloudflare phone setup](CLOUDFLARE_SETUP.md), in your
   own account, and authenticated device pairing. Groups delivery and phone access to the
   running computer are separate services.
5. GitHub is optional for code/files and backup; it is not a Groups messaging prerequisite.
   If wanted, sign in, choose the repository/visibility and accept collaborator invitations.

### Exact external setup-agent runbook

Preserve the existing app and running jobs. Follow [contributor setup](CONTRIBUTOR_SETUP.md)
first. Locate its actual data directory (`DOCK_DATA_DIR`, otherwise the installation's
`data/`); do not create a second installation or use a fixture. Inspect existing
`groups/service.json` and saved membership before changing anything. If a mapping exists,
retain it and reconcile an explicitly requested change instead of overwriting it.

One installation can join Groups on different creators' services. The native setup helper
imports each verified descriptor into a private registry of at most 32 service identities.
Every saved enrollment, pending request and late delivery retains its original service
identity and credential. Existing `groups/service.json` bytes remain intact; matching
legacy enrollments continue using that original route. Explicit `mode: "disabled"` still
disables all Groups network access.

Creator authority is separate from member routing. Joining first does not grant creation
permission. To host your own service later, follow `prepare` and `activate` below; activation
saves an explicit private creator choice for future Groups without disconnecting joined
Groups. An existing creator uses `upgrade`, and a pending deployment keeps its original
bundle. Exact matching imports and activation do not rewrite saved files. Concurrent imports
are serialized; an interrupted import lock needs owner reconciliation after confirming no
helper is running. Preserve the pending bundle and registry while resolving it.

From the installation checkout, use the pinned project tools:

```sh
sh scripts/pnpm --filter @dock/group-service exec wrangler whoami
```

If necessary, run `sh scripts/pnpm --filter @dock/group-service exec wrangler login` and
let the person sign in. Verify the selected account ID and Workers Free in that person's
Cloudflare dashboard. Obtain their workers.dev subdomain and choose a fresh Worker name
that does not replace an existing Worker. A custom domain is unnecessary for Groups.

Prepare local private files after the person confirms the account and origin:

```sh
node scripts/group-cloudflare-setup.mjs prepare /absolute/app-data \
  https://chosen-worker.their-subdomain.workers.dev chosen-worker THEIR_32_HEX_ACCOUNT_ID \
  --verified-workers-free
```

The script prints only a new private directory path under `groups/cloudflare-deploy-UUID/`.
Call that path `/absolute/prepared`. It creates `wrangler.json` with the explicit account ID,
SQLite Durable Object binding/migration, matching approved origin and capability hashes;
`owner-service.json` contains private creator/routing capabilities. The files are `0600`
inside a same-owner `0700` directory. It performs no network call or deployment, and never
replaces the app's existing mapping. Keep these files outside source control and chat.

Build only the shared package needed by this Worker, validate the prepared deployment, then
deploy to the verified account. This step is explicitly part of the creator setup request:

```sh
sh scripts/pnpm --filter @dock/shared build
sh scripts/pnpm --filter @dock/group-service exec wrangler deploy \
  --config /absolute/prepared/wrangler.json --dry-run
sh scripts/pnpm --filter @dock/group-service exec wrangler deploy \
  --config /absolute/prepared/wrangler.json
```

Verify Wrangler reports the expected Worker name, account and exact HTTPS origin. If it
fails, leave the existing app configuration intact and retry the **same** prepared config;
do not generate new credentials or silently choose a different account. On success:

```sh
node scripts/group-cloudflare-setup.mjs activate /absolute/app-data \
  /absolute/prepared/owner-service.json
```

Configuration is read per request. An open Groups setup page checks every five seconds
while visible and refreshes when you return to the tab or reconnect. Once configured,
the setup prompt collapses automatically; existing form entries are kept. Choose **New project**, supply display
and project names, and continue. No operator setup code is needed. An existing creator choice cannot be replaced by another
activation. Joining members may activate their first independently prepared creator service
without replacing the earlier member route. A reinstall/update must retain the same endpoint ID,
capabilities and service origin. Keep the prepared files for future updates.

### Update an existing creator service

Use the current reviewed checkout and the creator's saved private deployment bundle.
Follow the [hosted recovery procedure](GROUP_HOSTED_RECOVERY.md) for its backup and first-update
requirements. Verify the original account is still Workers Free. Do not run `prepare` again.
A saved configuration can contain an absolute source path from an old checkout; prepare a
candidate that keeps the same Worker, account, bindings, migrations and capability hashes:

```sh
node scripts/group-cloudflare-setup.mjs upgrade /absolute/app-data \
  /absolute/prepared/wrangler.json --verified-workers-free
```

This local-only command validates the saved bundle against the active creator mapping and
prints a new private `wrangler-upgrade-UUID.json` path. Its only configuration change is
`main`, pointing at this checkout's Groups Worker source. Original files and credentials
remain intact. Check the exact reviewed source revision and compare the candidate before
using it for the dry-run and deployment commands above. Updating this account requires its
owner's authorization; an app update on a member's computer does not deploy the creator's
Worker. A failed check or deployment keeps the saved mapping; reconcile it rather than
creating a replacement service. Verify hosted data immediately after an approved first update.

The service includes a public `/join` invitation handoff page. It displays joining
instructions and a copy control; it grants no app or group access and makes no membership
or model call. The invitation stays in the browser fragment, is removed from the address
bar after capture, and is not sent to the service or a third-party site. Existing creators
must redeploy the updated Worker with their saved private configuration to enable this
page; keep all credentials, bindings and migrations. Update the app frontend too so newly
generated links use the service's `/join` address rather than the creator's app address.

The private owner configuration has this schema (values below are explanatory placeholders):

```json
{
  "version": 1,
  "mode": "hosted",
  "endpoint": "https://chosen-worker.their-subdomain.workers.dev/",
  "endpointId": "generated-uuid",
  "setupCapability": "64-lowercase-hex-private-creator-capability",
  "hostingAuthorization": {
    "origin": "https://chosen-worker.their-subdomain.workers.dev",
    "approvalCapability": "64-lowercase-hex-routing-capability",
    "freeApprovalId": "generated-uuid-recording-owner-confirmed-free-setup"
  }
}
```

The setup capability creates groups and stays only on the creator's computer. The routing
capability admits requests to the configured Worker; it never substitutes for an independently
generated membership bearer, invitation or exact approval. Hashes rather than raw capabilities
are deployed to the Worker. The approval UUID records the setup decision; it is not automated
proof of Free entitlement.

### Invitation handoff to a fresh member installation

The creator opens **Invite people → Create invitation** and
sends the invitation privately. It expires after 7 days. In owner-hosted mode, its
fragment includes the exact service descriptor (the schema above **without**
`setupCapability`), group identity and invitation secret. The same link can enroll multiple people before expiry. The fragment is removed
from the browser address immediately. Do not paste it into public issues, logs or source.

On the joining computer, the external setup agent saves the invitation in a temporary
same-owner `0600` file, then runs:

```sh
node scripts/group-cloudflare-setup.mjs join /absolute/member-app-data \
  /absolute/private-invitation.txt
```

This validates the descriptor and writes a join-only private configuration; it makes no
network request. The person verifies the service belongs to the intended creator. Arbitrary
browser invitations cannot choose a host, trigger a fetch or override an existing mapping.
If every service-descriptor field matches an existing mapping, the helper reuses it, including
on the creator's own installation. Existing creator authority stays private and unchanged.
A different verified service gets its own registry entry. A changed routing approval for an
existing service identity refuses before writing; an invitation cannot replace its creator
capability. Missing or changed entries refuse access to the affected original Group instead
of falling back to another creator. A Group UUID already retained under another service is
rejected before membership handoff.
The setup agent is the explicit trusted configuration boundary. Remove the temporary
invitation file after handoff. If setup took longer than 7 days, obtain a fresh invitation
from the same creator; the saved service mapping stays valid.

Reload Groups, choose **Join by invitation**, paste a current invitation and choose **Join group**.
The link grants membership directly; there is no confirmation code or approval step. The joining
host holds its own generated credential and no creation capability. Attempting to create a
group on a join-only host refuses before network handoff. To host your own service after joining, use the creator runbook above. Its explicit
activation selects future creation while preserving every joined Group's route.

### Verify completion and recovery

Verify a human message from each installation appears at the other, and each original opens.
The optional legacy feed writer is not required for chat or file sync. Verify local agent access separately
using each person's own provider sign-in; model calls require their ordinary instruction.
Reload/reconnect and confirm membership and saved messages persist. A lost acknowledgement
uses **Recover an interrupted request** / the original request identity; never create another group
to evade uncertainty. Service failures retain requests for retry. A failed deployment is not
a completed setup. Own-account live deployment and real-device acceptance must be checked
for each installation; local tests do not certify them.

### Retained compatibility

Existing beta records retain their original pinned service, scoped signed admission and
exact create retry receipts. Existing protected/local-test/disabled mappings remain
authoritative. The offline beta issuer is retained for existing installations; it is not
part of new owner-hosted onboarding. `local-test` permits only explicit owned loopback tests
and must never be deployed. Existing beta key retirement and creation-expiry semantics stay
unchanged. HTTP redirects remain refused, TLS verification remains enabled, and setup/routing
capabilities are never accepted from arbitrary browser endpoint fields.

## Protocol and authority

One generated group UUID routes to one SQLite Durable Object via `getByName(groupId)`.
Names are explicitly entered and never used as identity. Each enrollment gets separate
random member and installation UUIDs. All active members have the same invite, approve,
revoke, roster, pending-list and audit permissions. Revoking the last active installation
leaves the group inaccessible; setup cannot restore it or bypass membership.

A client retains three independent values generated with a cryptographically secure RNG:
a 256-bit installation credential, a 256-bit invitation secret when issuing an invitation,
and a legacy 256-bit confirmation value retained internally for protocol compatibility.
People do not exchange or enter that value. The wire encoding is exactly 64 lowercase
hexadecimal characters. Each installation/group must use a fresh credential. The service
stores only domain-separated, group-bound SHA-256 digests of these capabilities; raw
values never enter receipts, audit, returned errors or logging. Possession authenticates
an installation, not a person's legal identity. This topology is not end-to-end encrypted.

The shared `group-membership.ts` contracts allow only membership fields and require typed
names. The browser-portable `groups.ts` module supplies UUID/name contracts directly;
membership imports the narrow membership contracts; delivery separately imports its Node/Worker wire module.
Membership adds no Unicode normalization or control/bidirectional-character filtering.
Browser clients must use safe name rendering (text escaping and direction isolation) and
an explicit input policy, preserving legitimate international text and originals. Storage
alone does not provide that presentation boundary; see [Groups UI](GROUP_UI.md).

All HTTP calls are explicit JSON POSTs. Installation auth is `Authorization: Bearer …`.
No capability goes into a path/query. The normal client places invitation secrets in a URL
**fragment**, removes it before further navigation, and redeems only after an explicit
user action. GET/prefetch cannot initialize or enroll. Responses use `no-store` and `no-referrer`; errors are fixed
codes, with no input, SQL exceptions or stacks. Callers must not log requests/secrets.

| Route/command                          | Required authority and result                                                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/create`, `initialize`             | Separate setup header plus client installation credential, operation UUID, group name and member name. Returns creator identity.               |
| `/v1/groups/{uuid}`, `invite`          | Active installation; client-generated invite secret, operation UUID and TTL (1–604800 seconds). Returns invite UUID/deadline.                  |
| Same route, `join`                     | New installation credential, reusable unexpired invite secret, legacy compatibility value, operation UUID and name. Returns active membership. |
| Same route, `approve`                  | Legacy compatibility command; the current app does not use an approval step. Already-active exact enrollments can be acknowledged again.       |
| Same route, `status`                   | Existing pending/active credential; revoked and unknown credentials fail uniformly.                                                            |
| Same route, `roster`/`pending`/`audit` | Active member; bounded keyset page (`after`, `limit`). Returned `next` continues the page.                                                     |
| Same route, `revoke`/`revokeInvite`    | Active member and exact installation/invitation UUID. Revokes active or pending enrollment, or an open/consumed invite.                        |

The setup binding is a hash produced by `setupHash`, not a plaintext setup credential.
It is empty in the default configuration. Setup derives a stable generated group UUID
from the setup digest and initialization operation UUID, so a lost create acknowledgement
needs no global directory/object. It can initialize only an empty object. On an existing
group, even an initialization retry requires that exact creator's active installation
credential before the receipt is read. Setup headers are forbidden on other commands.

An unexpired, unrevoked invitation grants membership directly while its issuer is active.
The same link admits multiple people, each with a separate installation credential. Existing
memberships survive invitation expiry. Revoking an invitation stops new joins; revoking a
member stops that member's access.

Previously accepted pending enrollments are reconciled on authenticated status/roster/pending
reads. Conversion requires the original invitation to remain unrevoked and its issuer active,
respects member/normal-write limits, and is audited once. The invitation deadline does not
strand an already accepted request. Revoked enrollments and grants are never revived.

## Receipts, revocation and bounds

### Change notifications

The fixed `GET /v1/groups/{uuid}/updates` WebSocket is for the protected native
host, using the existing hosting approval and active installation credential in
headers. Browser origins, query credentials and incoming application commands are
refused. Hibernating sockets retain only the group, installation and credential hash;
outgoing frames contain a group UUID and a change hint, never messages or reports.
Each host shares one connection per enrollment through its existing authenticated
app event stream. A hint triggers a fresh authorized read; it grants no execution
authority. Commit notifications check retained revocation markers and close revoked
sockets. Lost hints, restarts and older services use periodic reconciliation and the
disconnected fallback described in [Groups workflow](GROUP_WORKFLOW.md).

Source-derived idle estimates for one visible browser and one registered native
group owner are 1,728 service reads per day with notifications, or 576 over eight
hours, before startup, focus, producer writes, originals and explicit actions. Hidden
browser views stop reading. These estimates and local fixtures establish neither
deployment acceptance nor a reservation of the creator's Free quota. See Cloudflare's
[hibernating WebSocket guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/).

### Durable receipt bounds

Crypto is asynchronous before the transaction. The synchronous transaction then checks
current group routing, authorization and revocation before reading a receipt. A fresh
join authenticates an open (or retained consumed), unexpired invitation and active issuer before normal admission
can disclose a capacity limit. A same-ID join receipt is recovered with its bound enrolled
credential even after its invitation expires. The transaction writes the membership
change, audit entry, receipt and counters together. Cursors are
fully consumed before any await. [SQLite transaction API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Receipts are keyed by credential hash and operation UUID and retain a canonical request
hash with hashed secret fields. Same key/payload returns the exact response; changed payload
or command is a conflict. The client keeps its original operation, credential, invitation
and confirmation locally until recovery. A recovered join receipt remains the original
response from its original attempt; `status` supplies current state. Every retry authenticates
again. Revoked credentials cannot use a receipt to resurrect enrollment; rejoining requires
an explicit new enrollment rather than an authenticated retry. A retry of approval whose target was later
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
| Invitation lifetime                                          | Up to 7 days for new joins; existing memberships persist     |
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
direct multi-person joins, legacy pending conversion, bounded pages, concurrent joins, receipt
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
