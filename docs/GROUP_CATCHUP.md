# Private incremental catch-up and evidence

This slice supplies concrete authenticated routes, a React catch-up/query view and a native
private-query handler. It does **not** mount itself in normal Groups or register a native tool.
The normal integration owner must mount the routes/view and provide the verified promotion
source adapter; native registration remains with its owner. E1–E3 stay open until those normal
paths and the two-installation/native journey are verified. No production hosting is activated.

`GroupCatchupStore` stores last-read by group/member/installation/enrollment, independently
of shared/private session. It resumes the saved snapshot rather than starting at zero. Pages
hold at most eight consecutive shared positions under one fixed watermark. Fetching does not
acknowledge reading. **Mark this page read** sends the exact server-issued acknowledgement
identity; only then can **Continue catch-up** fetch the next page. Missing positions/tails,
changed watermarks and unknown, stale or differently bound tokens fail closed. An identical
acknowledgement retry returns its original receipt without moving any newer position. Restart
and offline failure retain the snapshot, page and acknowledgement identities. Completion
permits a new incremental snapshot starting at the acknowledged position.

`GroupEvidenceIndex` caches only authenticated shared pages and explicit verified source
facts. Promotion owns source ingest. `GroupEvidenceSourcePort.readVerifiedShared(reader,
eventId)` returns the exact hosted event/position and immutable facts from an authorized typed
original. Ingest independently compares that event to a bounded hosted read. It never infers
subjects, responsibility, resolution, autonomous decisions or causal edges from summary text.
Facts preserve original source ID/version (including string versions), original task/action/
manager/worker/job/file IDs and explicit edges. Original instruction IDs must appear in the
event's verified causal/evidence references. Source-specific facts may be absent; absence is
reported as unknown. A projection writer is not automatically the original author or decider.

Typed queries cover recorded work/responsibility, stop/decision evidence, offline changes,
a member's own original instruction effects, exact file paths, unresolved state and autonomous
decisions. Results cite immutable event/source IDs and original edges, and expand the exact
original with a byte/hash check in the UI. Queries are evidence records, not inferred answers
or authoritative work state. Each generated `queryId` pins both the contiguous indexed shared
watermark and the index revision. Later appends or late source-fact indexing cannot change
an earlier query. The UI retains its exact private request in browser storage for reload/retry;
new explicit queries receive new IDs. Continuation is bound to request/type/limit/group/member/
enrollment and exact shared/private context. Index gaps are explicit; queries never reread
full hosted history to fill them.

The authenticated host resolves opaque handles to `GroupCatchupReader`; browser JSON cannot
choose member, enrollment, executable or path authority. Every read/ack/replay revalidates
membership. `createGroupPrivateEvidenceQuery` additionally requires the owning private
context. It reads shared evidence without forking/resuming a shared session or publishing any
query, prompt or result. The read modules have no shared-event/outbox or execution API.

## Consumer ports

- `registerGroupCatchupRoutes(app, { authenticated, resolve, catchup, evidence })` registers
  `/api/groups/catchup/start`, `/page`, `/ack`, `/api/groups/evidence/query` and `/original`.
  `resolve(handle)` must call the existing authenticated host context resolver, never
  deserialize a scope. Retain owner/paired-device authentication and protected enrollment checks.
- `GroupCatchup({ handle, onClose, members? })` replaces the old catch-up excerpt action in
  normal Groups. `members` contains authenticated display identities, not authority grants.
- `GroupEvidenceIndex(path, sourcePort)` provides `ingestVerifiedShared(reader,eventId)`,
  `observePage(reader,events)`, `pageEvidence(reader,events)` and
  `query(reader,query,limit,continuation,catchup,queryId)`. Ingest uses hosted remote sequence;
  do not substitute a local repository sequence or silently reset an index gap.
- `createGroupPrivateEvidenceQuery({ resolve, evidence, catchup })` returns the native handler.
  `GROUP_PRIVATE_EVIDENCE_TOOL` includes name, description and JSON input schema. Bind `resolve`
  to the persisted owning private context; never use model-supplied membership or global history.

Private read stores have finite retained capacity: 128 member-enrollments, 512 snapshots per
member, 8192 delivered pages, 8192 indexed shared records, 4096 query requests/continuations,
and a 64 MiB SQLite page limit for each store. Exhaustion refuses new work without resetting
last-read or deleting uncertain identities; exact retained retries remain available. These local
limits do not create a second hosted allocation. Normal composition must include source work
in the hosted authority's existing membership/source/quota transaction.

## Local verification

Use Node 24 and build shared contracts first. Run server `vitest run src/group-catchup.test.ts`,
shared/server/web strict typechecks, and web Playwright with
`playwright.group-catchup.config.ts`. The disposable loopback browser host uses deterministic
sources and a synthetic cookie; it invokes the actual routes/store/component without provider
launches. Test-only state reset/lost-response controls exist only in that fixture. The browser
checks cover desktop, 412×915, 360×800 and 915×412, including larger text, explicit multi-page
reading, lost acknowledgement, reload, exact originals and private query continuation. These
are Chromium emulations, not physical-phone, real-native or normal installed-app acceptance.
Temporary fixture databases/servers belong under ignored task-local `data/` and are closed.
