# Groups production release readiness

Checked 2026-10-09. The native Groups release candidate connects shared actions,
activity evidence, unfinished-file awareness, reports/PDF sharing and recovery. Independent
source reviews and local fixtures are release preparation. Beta source is published;
production acceptance remains pending the joint test below.

[Status](STATUS.md#groups) separates current behavior from historical acceptance.
[Manager lessons](FAILURE_REVIEW.md) record the maintenance failures and required safeguards.

## Agreed journey

Use **Group chat** and **My group agent**, native local agents and each person's own provider
account. The creator hosts Groups in their own Cloudflare Workers Free account; members
join that service directly by invitation. GitHub and phone access are optional.
Read-only keeps authorized history and file downloads available without starting a model.
Ask uses the member's model allowance to read shared evidence; explicit Work authorizes
local native work. Incoming messages
never authorize another person's computer. Saved private histories remain private.
Docker/Linux isolation and the earlier private catch-up controls are superseded in this journey.

## Candidate and joint acceptance

| Area                  | Implemented candidate                                                                                                                                                                                         | Joint acceptance still required                                                                                                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and chat        | Creator-owned service setup, direct invitations, automatic human-message arrival and retained retry identities.                                                                                               | A fresh creator account and another person's installed computer; both message directions, reload/restart, offline delivery and expired/revoked membership.                                                                       |
| Shared actions        | Legacy managed task delegation, independent review and exact apply; fresh direct Work uses native provider tools, with exact owner-reviewed committed Git sharing.                                            | Both people's normal Work journeys, stale decisions, stopped work and lost acknowledgements without duplicate execution.                                                                                                         |
| Activity and evidence | Scoped producer receipts, exact shared originals, incremental manager queries, causal links and visible unavailable/gap states. Per-member summaries use the saved provider through the central model policy. | Real Codex/Claude output, who did what and why, offline continuation and original expansion across separate computers; no private/draft publication.                                                                             |
| Shared files          | Native Git setup, direct commit previews and owner approval, legacy reviewed-application sync, and bounded unfinished-file awareness with private paths omitted.                                              | Independent Git accounts and a real remote; concurrent edits, divergence, offline changes and lost sign-in, preserving unfinished files.                                                                                         |
| Reports               | Immutable native source/assets/PDF capture, explicit share/revoke grants and the existing Reading/PDF reader.                                                                                                 | Native LaTeX/dependencies, exact report capture and another person's authorized reading; revoked access and interruption.                                                                                                        |
| Recovery and capacity | Private offline local archives; creator-authorized hosted SQL export with verification and held-file recovery; reserved receipt reconciliation at capacity.                                                   | Larger quiet-window snapshots, concurrent changes during deployed export, independent-installation update preservation and representative capacity. Destructive restore and transparent cross-service migration are unsupported. |
| Release               | Focused source/browser checks and dedicated Groups CI jobs.                                                                                                                                                   | Independent installed-candidate acceptance, public Linux CI, documented operating limits, then the owner's public-release decision.                                                                                              |

Keep desktop and 412×915, 360×800 and 915×412 checks; emulation does not establish physical-phone
acceptance. Existing real-service checks used two profiles on one Mac, not independent people.
Recurring Claude sign-in interruptions need a reproducible diagnosis or an accepted recovery
path during native-provider testing.

## Operating and publishing limits

Retained source, receipt, document and publication stores have finite bounds. New work can
be refused while acknowledged identities remain retained. Follow [delivery limits](GROUP_DELIVERY.md),
[local recovery](GROUP_RECOVERY.md) and [hosted recovery](GROUP_HOSTED_RECOVERY.md).
Do not clear identities, change endpoint mappings or replay model input to repair uncertain work.
An export is a logical archive, not an automatic restore or unlimited storage policy.

When a release changes the Worker contract, update the app and existing creator Worker as
one reviewed candidate. The native-first runtime/UI changes alone require no Worker
redeployment. Preserve private
configuration, membership, model/QUARK choices and pending requests. The first additive update
of a Worker without export follows the explicit preservation disposition in the hosted runbook.
Check Workers Free availability in the actual creator account; no automatic paid fallback.
Publish only a clean source snapshot with matching guides, never private repository history,
credentials, conversations or generated evidence.

The project is already published as beta source. A new website, marketplace listing and
cross-platform one-click installer remain deferred. Separate cluster, remote-editor and
LaTeX-helper requests stay open outside this bounded Groups preparation. Real independent
people/accounts/computers and physical-phone checks are reserved for the joint session.
