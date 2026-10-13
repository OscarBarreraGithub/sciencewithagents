# Groups production release readiness

Checked 2026-10-12. The current source candidate adds the selected-conversation Claude
Code plugin, exact owner-reviewed file checkpoints, a separately paired hosted phone feed
and the dark interface. It preserves full SWA and existing group-agent work. Actual native
Opus 5.5 review approved the initial combined UI and required a raw Git metadata correction.
The actual Opus follow-up approved the source beta corrections, including raw Git review and
generation-bound Stop recovery, with no new blocker. This candidate is not installed or deployed. A clean source-only
release is separate from running-app activation, matching Worker deployment and joint acceptance.

[Status](STATUS.md#groups) separates current behavior from historical acceptance.
[Manager lessons](FAILURE_REVIEW.md) record the maintenance failures and required safeguards.

## Agreed journey

Use **Group chat** for shared messages and **Your Claude Code** to connect the ordinary
native conversation the person already uses. Install the optional plugin explicitly;
select exactly that conversation and group. Native tools, hooks and permissions remain
with Claude. New prompts/final replies enter a private local journal; a separate saved
bulk-model helper publishes compact updates while SWA is running. Other conversations,
subagents and previous private history are excluded. Compaction/resume preserves selection.

The group composer sends human messages directly. Reading/downloading and transport make
no model call. Summarizing and Claude interpreting peer text use allowance. Read-only
pauses new local contribution and unstarted model work. Incoming messages never authorize
local execution. The saved SWA group agent, Ask/Work, reports and older advanced workflows
remain available separately. See [Claude setup and sharing](GROUPS_CLAUDE.md).

The creator hosts Groups in their own verified Cloudflare Workers Free account; members
join that same service by invitation. GitHub is optional for project files. The separate
paired hosted phone view reads and optionally posts human messages while the computer is
closed; full owner-phone access to the computer still requires its running host.

## Candidate and joint acceptance

A real two-turn native Claude conversation exercised plugin selection, native hooks and one
bulk Sonnet update published to an owned local Worker. The selection prompt and reply were
excluded from journaling/publication; only the next selected prompt/reply produced a job.
The original harness exited 1 after publication on an invalid peer-read query; its cleanup
also reported a missing child-closure receipt. A separate model-free reconciliation passed,
verifying the exact peer summary and exclusion of raw
private markers from hosted values with clean owned-fixture closure. No native turn was
replayed, and the original failure and historical cleanup gap remain unchanged. This is
local evidence, not deployed or independent-person acceptance.

| Area                  | Implemented candidate                                                                                                                                                                         | Joint acceptance still required                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Setup and chat        | Creator-owned service setup, direct invitations, automatic human-message arrival and retained retry identities.                                                                               | A fresh creator account and another person's installed computer; both message directions, reload/restart, offline delivery and expired/revoked membership.                                                                       |
| Shared actions        | Legacy managed task delegation, independent review and exact apply; fresh direct Work uses native provider tools, with exact owner-reviewed committed Git sharing.                            | Both people's normal Work journeys, stale decisions, stopped work and lost acknowledgements without duplicate execution.                                                                                                         |
| Activity and evidence | Selected-Claude hooks, private input journal, bulk-model compact updates and exact delivery retries; existing scoped evidence remains retained.                                               | Real Codex/Claude output, who did what and why, offline continuation and original expansion across separate computers; no private/draft publication.                                                                             |
| Shared files          | Native folder/private repository setup, full committed-history preview and owner approval; immutable ordinary-Claude checkpoint publication preserves active checkout/job inputs.             | Independent Git accounts and a real remote; concurrent edits, divergence, offline changes and lost sign-in, preserving unfinished files.                                                                                         |
| Reports               | Immutable native source/assets/PDF capture, explicit share/revoke grants and the existing Reading/PDF reader.                                                                                 | Native LaTeX/dependencies, exact report capture and another person's authorized reading; revoked access and interruption.                                                                                                        |
| Recovery and capacity | Private offline local archives; creator-authorized hosted SQL export with verification and held-file recovery; reserved receipt reconciliation at capacity.                                   | Larger quiet-window snapshots, concurrent changes during deployed export, independent-installation update preservation and representative capacity. Destructive restore and transparent cross-service migration are unsupported. |
| Hosted phone          | Owner-issued short-lived links, current member/device authorization, revocation, recent/full text and exact human-post recovery; model-free with companion runtimes closed in local fixtures. | Real hosted HTTPS origin, physical phone QR/cookie/reload/connection loss, revoke and independent member reading/posting.                                                                                                        |
| Interface             | Dark-only app shell, React Aria controls, readable Groups list/thread/setup/Manage, preserved drafts and recovery; four Chromium layouts plus WebKit emulation.                               | Installed app and physical-device review, ordinary first-time creator/member setup and native selected-Claude contribution in the combined candidate.                                                                            |
| Release               | Focused source/browser checks, actual native Opus source review and dedicated Groups CI jobs; a source release does not activate the app or Worker.                                           | Matching public Linux CI, documented limits and the owner's publication decision for source publication; installed/deployed and independent-person acceptance remain separate activation gates.                                  |

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
The finite-capacity automatic archive workflow remains unfinished.

Low-severity advanced app-owned native/managed Git gaps are deferred as
`SWA-GROUP-NATIVE-BASELINE-20261012`: sync after a remote rewind/removal can republish history
excluded by an earlier review, and managed task integration previews can display replacement-ref
substitutions. Raw publication scans remain enforced. Ancestry, generated empty-repository
baselines and managed preview display need a separate bounded correction. Ordinary selected-Claude
checkpoint publication now validates its retained base against the current remote before any
push; that does not close these advanced gaps.

When a release changes the Worker contract, update the app and existing creator Worker as
one reviewed candidate. The hosted phone routes require the matching Worker update; dark styling alone does not.
Native selected-Claude file proposals also require the matching built app/plugin. Preserve
the creator’s existing account, service, identities and deployment configuration. Preserve private
configuration, membership, model/QUARK choices and pending requests. The first additive update
of a Worker without export follows the explicit preservation disposition in the hosted runbook.
Check Workers Free availability in the actual creator account; no automatic paid fallback.
Publish only a clean source snapshot with matching guides, never private repository history,
credentials, conversations or generated evidence.

The project is already published as beta source. A new website, marketplace listing and
cross-platform one-click installer remain deferred. Separate cluster, remote-editor and
LaTeX-helper requests stay open outside this bounded Groups preparation. Real independent
people/accounts/computers and physical-phone checks are reserved for the joint session.
