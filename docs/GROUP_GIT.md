# Groups Git adapter

The host connector implements ordinary `https://github.com/owner/repo.git` observation,
selected content reads and fresh reviewed proposal creation through Git smart HTTPS.
It also retains the local bare endpoint and historical custom HTTPS reader. The concrete
native guest export provider and protected normal-host/UI binding are integrated. Local
Git-protocol and isolated guest checks do not prove an actual GitHub write or complete
two-installed-computer workflow; those acceptance checks remain open.

## Protected host integration

`GroupGitService.open` takes private host storage, a pinned installed Git executable,
`GroupEventRepository`, a native GitHub identity resolver and `nativeExports`. Register
`endpoint: {kind: 'github', url, binding}` only from trusted host configuration. `binding`
pins the existing authenticated account ID, repository numeric/node IDs and canonical
owner/repository name. Account/repository REST metadata is rechecked before every Git
request; redirects, changed identities, alternate origins and credentials in URLs fail.
The exact endpoint binding contributes to the durable repository configuration digest.

`openNativeGitHubIdentity(installedGhExecutable, accountId)` uses the existing native
`gh auth token --hostname github.com` command inside protected code, verifies the binary
hash, redacts errors and retains the token only in memory. It does not log in, switch an
account, install anything, change Git configuration or persist credentials. Nothing in the
browser connector accepts paths, endpoints, executables, credentials or shell commands.
The native identity resolver has been tested only with a disposable executable here.

The host provisions exact group/member/installation/repository/resource/endpoint/executor
grants and immutable review/history receipts. Unlisted paths are private. Content grants
and metadata grants remain distinct; private contexts cannot publish. Changed grant
content needs a new revision. `authority.issue(persistedAuthenticatedScope)` returns
opaque repository-authorized access. The normal host binds `GroupGitConnector` methods
to authenticated context, opaque repository IDs and the host scheduler. Git observation
makes no model call and adds no independent timer.

## Supported transport

The adapter follows the official [Git HTTP protocol](https://git-scm.com/docs/http-protocol),
[pack protocol](https://git-scm.com/docs/pack-protocol) and
[pack format](https://git-scm.com/docs/pack-format). It uses upload-pack with negotiated
`filter blob:none` for complete commit/tree metadata and explicit object requests for
selected blobs. Raw packs preserve exact commit messages, timezone headers and signatures.
Full pack checksums, individual object hashes, delta bases/expansion, object counts,
content sizes and deadlines are checked. Thin packs, tag objects, implicit LFS hydration
and submodule/symlink content export are refused; no fallback downloads an entire clone.

The raw TCP stream meters encrypted request/response bytes, including TLS handshakes,
HTTP headers/framing and payload, before forwarding them to TLS. An oversized read chunk
aborts the connection before decoding. TCP/IP headers, retransmissions and bytes already
queued by the kernel are outside this application quota. Metadata/view operations share
an aggregate transfer budget and independently bound decoded object/content bytes.
Only `github.com` and `api.github.com` are used; standard TLS verification, no redirects,
no cookies and no response decompression. The protected dial/CA dependency exists for
loopback TLS fixtures; production uses normal DNS and public certificate validation.

Proposal refs are always new `refs/heads/dock-proposals/<repositoryId>/<proposalId>`.
Actual receive-pack discovery must advertise `report-status`; the command uses the
all-zero old SHA, so the server refuses a concurrent existing ref. Only one exact create
command is sent. No update/delete command, force, reset, stash, rebase, stage-all or
shared-main publication is implemented. The exact reviewed object closure is transmitted;
no commit is reconstructed or silently re-signed. The final reported status and remote
ref must agree with the reviewed SHA.

The historical `/group-git/v1/` reader still refuses observation/publication and is not
GitHub functionality. The host-exclusive local bare endpoint uses atomic no-replace
`link(2)`. Neither endpoint activates native agents or changes their tools/permissions.

## Required native immutable source

`group-git-native-export.ts` owns the typed `GitNativeExports.acquire/inspect` port. Its
request binds the operation/export IDs, exact persisted GroupScope, repository/resource,
grant/review/history revisions, reviewed source SHA, explicit content paths and quotas.
The native owner must inspect **all reachable committed history before guest-to-host
export**, refuse private/metadata-only/LFS/submodule/large data, freeze a new read-only
bare object resource outside every guest write mount, and attest its receipt durably.
Node pathname/inode checks are not that native implementation.

The receipt binds the request digest, source SHA, native receipt ID and complete closure
manifest (`gitObjectManifest`: sorted SHA/type/size/SHA-256 object-frame inventory).
The Git consumer rechecks receipt/admission on each command, independently scans complete
history and verifies the raw closure manifest before remote effect intent and again before
sending. It never takes proposal bytes from active `.git`. Missing/mismatched native
receipts deny GitHub publication. Tests supply a controlled source owner, not an actual
native guest exporter. The native owner must implement and agree this port; that integration
is still missing. Normal injection must provide this concrete port, not an available flag.

## Preservation and recovery

Active HEAD, index, config, dirty/staged/untracked/ignored bytes and editor buffers are
not mutated. Observation uses a separate host-owned bare store, and selected immutable
views contain only granted files. Metadata commands run in bounded configuration-free
shadows through the pinned builtin executor: no helpers, hooks, filters, external drivers,
URL rewrites or inherited Git controls. Host stores/journals/views stay outside guest
write grants. Linked gitdir/common-dir, alternates, shallow/SHA-256/split-index resources
remain unsupported. Live editor pathname checks detect ordinary swaps but cannot certify
hostile ancestor-swap containment; native isolation remains a separate required boundary.

WAL/FULL SQLite, parameterized statements, non-expiring exclusion, append-only transitions
and immutable payloads persist exact identities, grants, intents and receipts. Native
export intent is retained before handoff. Recovery inspects the same export ID only;
an absent/unknown receipt fences new IDs. Known privacy refusals currently retain that
intent for manager disposition. No timeout grants permission to replay.

A remote effect intent forbids automatic replay. Lost acknowledgements reconcile by
reading the exact repository/ref with the same reviewed source and original operation
ID. Absent effects remain uncertain; changed authorization or new IDs cannot bypass that
fence. Pre-intent observation failures retry their saved plan. Outbox receipts remain
current-grant scoped and recipients deduplicate event IDs. QUARK/provider admission and
actual namespace termination remain owned by the native runtime.

## Focused checks

Node 24 focused fixtures exercise the production adapter against loopback TLS and real
`git http-backend`, including ordinary URLs, identity/grant mismatch, metadata/blob quotas,
hashes/deltas, immutable receipt/manifest refusal, privacy/history, dirty-copy preservation,
create-only races, offline/restart and same-ID lost-ack reconciliation. They use no real
account, credential store, provider, remote repository, deployment or installed activation.
Actual isolated native export has separate local checks. A live GitHub write requires
a real completed native request, exact content/history grants and independent review
authority; existing account authentication alone is insufficient.

```sh
node apps/server/node_modules/vitest/vitest.mjs run --root apps/server \
  src/group-git-github.test.ts src/group-git-pack.test.ts \
  src/group-git-native-identity.test.ts
```

### Normal Groups controls

The shared group includes a **Shared Git workspace** panel for visibility, branch
observation, copy snapshots, edit intentions, overlap warnings, independent views
and reviewed proposals. Files start private. Metadata sharing discloses names;
content sharing applies only to the selected saved files. An edit intention is
advisory and expires; it is not a lock. Unsaved editor buffers are not observed.
A proposal requires an independent saved review matching the current sharing
policy and complete-history grant. Its separate ref does not update main.

The setup agent provisions saved GitService registrations and a private
`groups/git-resources.json` beside the normal GroupHost database (owner-only
0600, regular file). It contains the pinned installed `gitExecutable`, optional
`ghExecutable`, and `resources` records: saved shared-context `handle`,
`repositoryId`, label, completed `nativeRequestKey`, granted `guestRepository`,
approved relative `paths`, and independently approved `reviews` IDs. Browser
controls select only these opaque saved resources, paths and reviews. They cannot
choose host paths, commands, endpoints or accounts. The native GitHub resolver
uses the existing pinned account; it never signs in or changes that account.
Absent or invalid Git setup leaves human Groups messaging available.

The server retains exact pending mutations and outbox notifications across
reconnects. Retry the saved change after lost acknowledgement. A typed refusal is
returned only when planning failed before the requested effect was admitted.
The native pre-turn hook observes the approved branch and captures the exact
saved copy before subsequent explicit Work in its original native context;
observation retains its one-minute floor/backoff and never overwrites dirty files.
The server also advances saved observation/outbox work while the browser is closed.
