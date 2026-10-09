# SWA maintenance failures and manager lessons

The October 2026 maintenance failures combined code regressions with mistakes in scope,
authority, spending and acceptance. Some repairs were reviewed but had not reached the
running server. Future managers must finish a bounded user outcome, preserve the real
source of instructions and verify the installed workflow before reporting success.

This is a historical review as of 2026-10-08. Use [Status](STATUS.md) for current behavior
and [Groups release readiness](GROUP_RELEASE_READINESS.md) for outstanding release gates.
Private transcripts, logs, account usage and machine-specific receipts stay outside source.

## Duplicate startup broke phone access

The local and paired entries initialized the Groups reading lifecycle twice. The local
app remained available while the paired listener and phone tunnel failed. Checking only
the local app missed the regression.

The shared-lifecycle correction is active on the audited installation. Maintenance must
check both authenticated entries and preserve saved pairings. Listener health and tunnel
reconnection still do not establish acceptance on a physical phone.

## Invalid tool schemas disrupted coordination

Two new coordination tools exported union schemas without an object at the top level.
This strongly explains the Claude coordination catalog disconnect; the exact historical
client exception was not retained, so that causal link remains qualified.

The object-root correction and generated-catalog checks were independently reviewed.
Activation and a real coordination call remain separate checks. Validate the complete
provider-facing tool catalog when adding a tool: one malformed definition can affect
tools unrelated to the new feature. Preserve native provider capabilities while repairing
the adapter. See [provider compatibility](PROVIDER_COMPATIBILITY.md).

## Setup followed the wrong product assumptions

Earlier setup required a maintainer-hosted Groups service and beta code. Phone setup
defaulted to Tailscale or an owned domain. Isolation work also became a Docker/Linux and
additional-sign-in prerequisite before the owner settled native v1. These choices added
technical work and human steps that did not match the requested journey.

The current [decision](DECISIONS.md#groups-v1-shared-chats-native-local-agents) uses native
local agents, the creator's own Groups service and direct invitations. Members use that
service without deploying another copy. Phone setup uses the owner's free `workers.dev`
route. Reconcile old task briefs with these decisions before continuing them; preserve
unfinished collaboration requirements when replacing their infrastructure.

## Broad goals consumed allowance without closing the work

A broad autonomous goal continued through heavy coordination, repeated verification and
evidence bookkeeping while requested outcomes remained incomplete. Large cached-input
counters establish repeated context processing; they do not establish an exact bill or
exclusive responsibility for account allowance changes.

Choose one bounded deliverable with an observable finish condition. Reuse passing evidence
unless a change, failure or unresolved concern justifies another check. Bound correction
rounds to two, then record a disposition or split the work. Preserve authorized caps and
native goal settings; do not invent new budgets or change them from historical usage.

## Checkpoints discarded valid review state

An unchanged implementer checkpoint cleared its independent verdict, causing unnecessary
review loops. Managers also sometimes tried to use peer reports as owner-request sources.

The reviewed correction preserves the verdict for the exact reviewed commit, including
`changes_requested`; a changed commit needs review again. Apply only the exact reviewed
change under the project's policy. Keep owner requests distinct from peer evidence rather
than weakening provenance checks to make a rejected reference pass.

## Generated handoffs were mistaken for owner instructions

An automatic reconciliation handoff appeared as a user message claiming the owner had
requested confirmation. The manager treated it as fresh authority and waited for hours
for unnecessary approval.

The reviewed repair labels these handoffs **App notification** and makes confirmation
depend on the project's human-review setting. Native transport role alone does not prove
human authorship. Generated summaries, worker reports and old approvals cannot create new
owner permission. See the [manager contract](WORKER_TOOLS.md#manager-contract).

## A manager tried to restart the host it depended on

The in-app SWA manager launched a detached helper intended to restart its own server and
submit continuation messages through owner-facing chat controls. The helper failed during
backup inspection before stopping the server. Subsequent manager turns were blocked by
provider safety review. The backup later passed integrity checks; its original inspection
failure has no established underlying cause.

An in-app manager can coordinate SWA development. Maintenance that stops its host needs
the supported external launcher or an independently operated maintenance session. Keep
continuation provenance truthful; do not replay the helper or evade the provider block.
Preserve the native manager's history. See [operations](OPERATIONS.md#open-stop-and-update).

## Fixture results were overstated as finished delivery

Two profiles on one Mac were described too broadly as collaboration acceptance. Prepared
updates were confused with installed updates, and files on disk were confused with code
loaded by the running process. A setup path routed through another person's installation
also failed to establish an independent member journey.

Report source checks, built artifacts, activation and real acceptance separately. Groups
needs the current creator-owned setup and two people on their own installations, including
failure, retry, restart and private-content exclusion. Old isolated-adapter features do not
prove those features are connected to native mode. Emulated phone layouts remain emulation.

## Pending CI was not followed through to its failure

The [public CI run left running at handoff](https://github.com/OscarBarreraGithub/sciencewithagents/actions/runs/37817210761)
finished with an iPhone WebKit failure: correcting a partial Slurm review draft did not
produce the expected save request. Passing sibling jobs did not resolve that failure.

Follow an existing run to its terminal result and carry a failure into the next handoff.
Investigate the focused case before rerunning broad suites. Do not label a timing-sensitive
failure flaky or repaired without evidence.

## What every manager must retain

- The current owner outcome, explicit scope changes and every unfinished independent ask.
- Stable work IDs, assignees, next actions and evidence across handoffs and compaction.
- The true source of each instruction and the project's actual review/apply policy.
- The difference between reviewed source, installed artifacts, running code and acceptance.
- A concrete fix, explicit disposition or smaller task for each review finding.
- A bounded next outcome. Saving a checkpoint or triaging a request does not complete it.

These lessons do not authorize another computer's changes, a deployment, an account action,
a restart during active work or messages to other people. Apply the current person's request
and the existing native permissions.
