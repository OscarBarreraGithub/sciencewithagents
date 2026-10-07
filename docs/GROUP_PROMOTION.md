# Verified shared activity promotion

The promotion slice supplies strict source/receipt contracts, a bounded host
controller, a same-object service adapter and a durable verified evidence index.
It does not yet replace the normal Groups send/result hooks. Normal integration,
hosted authorization/capacity composition and independent review remain required;
module tests do not establish B1–B5 or a working two-installation journey.

## Source and summary boundary

Producers call the concrete human-send, native-result, manager-action,
worker-result, QUARK-transition, file-change or job-transition handler with a
durable source receipt ID. The owning host reader resolves the immutable shared
source/version and revalidates enrollment, context and publication authority.
Neither a browser body nor raw Store/SSE/history is a source attestation.

Private, unrelated, metadata-only, routine progress, heartbeat and tool-line
activity is excluded before hashing, receipts, synthesis or outbox insertion.
Private work needs an explicit new shared action/receipt; changing a visibility
field cannot authorize publication. Selection has no work mutation interface.
The original producer journal retains the raw activity; suppression does not
delete that journal.

Clear short human statements use their complete substance, never a prefix.
The categories are Question, Idea, Decision, Instruction, Conflict, Blocker,
Finding (including results), and Action (including status). Ambiguous, mixed or
long messages return `needs-summary` unless a source-authorized admitted adapter
is provided. Substantive work producers may supply an evidenced category and
one or two complete sentences. There is no default generic status summary.

Optional synthesis receives at most 32 KiB of exact shared source and authorized
evidence. Its global launch intent and fixed synthesis ID are saved first.
An uncertain launch is inspected with that ID; another installation or a retry
cannot launch a replacement. This module launches no provider. Deterministic
selection, classification, receipt processing and file/job plumbing use no model.

## Shared ownership and retained evidence

`GroupPromotionDoHandler` must live inside the existing group SQLite Durable
Object. Membership, immutable shared-source/version authorization and allocation
checks run synchronously in its transaction. It must not receive a separate
per-installation database or a second storage allowance. The existing service
owner supplies protected routing and these policies; they are not implemented
by this standalone adapter.

Explicit policy designates one installation with a renewable 60-second lease.
Expired leases return `writer_unavailable`; there is no automatic takeover.
The primary receipt key is the remote group, registered source ID and immutable
version. A receipt captures generated operation/entity/synthesis IDs and its
writer. Changed content collides rather than replacing a receipt. Up to 512
receipts are retained per group; exhaustion preserves existing evidence.
Decision, synthesis intent, event binding and confirmed publication transitions
are append-only. Writer transfer waits for authoritative hosted publication,
not merely a local event/outbox. Explicit evidenced owner/manager disposition
can retain and close a stale or proven unlaunched source; promotion itself never
does this. An uncertain native turn cannot be declared unlaunched without proof.

The original source scope is distinct from the writer's registered projection
alias. Both must be shared and authorized in the host repository; the alias must
retain the verified causal references. Consumers must establish trusted local
source/context/evidence mappings for remote sources before calling the controller,
while retaining the remote registered source ID and original author attestation.
Missing mappings are an integration gap, not permission to fabricate context,
causality, membership or author identity. Feed presentation must attribute
substance to the original source, identifying the projection writer separately.

Exact originals and Unicode/chunk boundaries remain in the existing event
repository. The evidence index durably retains the source/version, exact original
source tuple, category producer, event ID, causal/evidence references and correction
link before outbox insertion. Its reader accepts only bounded event IDs and
repository-issued access, independently checking each event. It supports the
private catch-up consumer without an unscoped history subscription.

Corrections append against exact prior event/entity/revision evidence. Earlier
events, summaries, chunks, source IDs and causal links are never rewritten.
Absent causal evidence remains an empty relation; summary language cannot create
links. Stale revisions and integrity failures remain visible and retain receipts.
Lost acknowledgements and publication failures retry the existing event and outbox
identity through `GroupPublicationController`, never a fresh send.

## Consumer entry hooks still required

The normal integration owner must replace the human/native first-240-character
branches with the controller after saving and verifying the producer receipt;
retain raw messages independently when promotion is quiet or needs synthesis.
It must attach the seven concrete hooks to scoped substantive producer paths,
return protected same-DO commands and register writer projection aliases using
the existing source/publication transport. Shared actions and worker/QUARK/file/job
outcomes must use verified causal receipts, never a global event subscription.
Hosted source/version digest verification, original-author mappings, lease policy,
capacity composition, confirmed-delivery proof and evidenced disposition are
required service hooks. Catch-up consumes the verified evidence index. These
normal hooks are owned by the separate integration task, not this slice.

## Local verification

Use Node 24 after installing the unchanged locked workspace dependencies:

```sh
pnpm --filter @dock/shared build
pnpm --filter @dock/server exec vitest run --config group-promotion.vitest.config.ts
pnpm exec tsc -p apps/server/group-promotion.test.tsconfig.json
pnpm --filter @dock/server typecheck
```

Focused tests exercise representative categories, quiet suppression, privacy
canaries, exact expansion, verified/unknown causality, corrections, races across
independent Node processes, other installations, offline/lost-ack/restart recovery,
the existing durable publication outbox, one-shot admitted synthesis intent,
evidence persistence and bounded receipts. The same-DO adapter is tested with a
synchronous local SQLite emulation. This is not actual workerd, real native
execution, a deployed service, two installed applications or physical-device
acceptance. This slice changes no UI; the normal consumer must perform its own
four-viewport checks. Fixtures close their owned databases/processes and remove
their temporary data.

The native synthesis adapter is `createGroupPromotionNativeSynthesis({path,
runtime, journal, bridge, events, authorize, availability, route})`; it calls the
existing central-policy/QUARK `queueGroupNativeRequest` and native `turn` or
read-only `reconcile`, with an immutable local submit fence. `authorize(request,
signal)` must verify the same-DO designated writer/adopted source/version/hash and
fixed synthesis ID, returning `{sharedContextId, writerId}` for the **writer's
already-consented shared native account**. For source B promoted by writer A,
`source.scope` preserves B's attribution; `projectionScope` and `writerId` bind A.
The adapter checks both identities separately and never opens/imports B's HOME.
Exact authorized input, including evidence metadata, is limited to 32KiB; output
must parse as a strict decision with exactly the authorized evidence refs. Invalid
output remains inspectable without another model turn. The committed
`group-promotion-native-hooks.patch` supplies the concrete native bridge/execution
changes against exact normal-native source `30d7505f`: fresh synthesis thread/empty temporary cwd,
A's existing group account volume, no work/read mounts or coordination tools,
provider capability overrides scoped only to synthesis, and no chat/feed source
alias on completion or recovery. The normal production composition applies these three native hunks, exposes
`promotionSynthesis` on the SAME connector retained by bootstrap, and injects it
into the single normal `GroupFeaturePromotion`. The host revalidates its exact
retained writer projection, current same-DO writer lease and fixed synthesis
receipt before resolving the writer’s already-existing shared native account. Without the reviewed synthesis execution hooks, submission
fails closed before a model turn. Normal verified producer hooks must exclude
`group:native-synthesis:<agentId>` lanes, including their metadata. Raw normal
results are saved before promotion; one finite background pass owns writer renewal
and source adoption. Adapter SQLite tests and actual native execution/journal
protocol tests use synthetic provider/namespace fixtures: real provider/account,
shared-HOME concurrency, normal mounts, and independent review remain root-owned
acceptance, with no readiness claim from these local checks.

Serialized authorized source and evidence metadata are limited to 32KiB; this is
not a total provider prompt limit. Native system/account startup instructions,
including instructions from the writer’s same-member/group/shared HOME, may add
context. Optional startup instruction/token isolation remains future work.
Output must parse as a strict decision with exactly the authorized evidence refs.
