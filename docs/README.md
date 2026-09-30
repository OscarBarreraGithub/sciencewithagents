# Documentation

The next design is recorded in [the Home requirements](HOME_UI_REQUIREMENTS.md) and
[the chat drawing requirements](CHAT_UI_REQUIREMENTS.md).
Its sketches and backlog are saved in **sciencewithagents · fresh design** in Sketchcoded;
this design has not replaced the running interface.

Implementation follows the owner-approved [simplification account](SIMPLIFICATION_ACCOUNT.md):
preserve native capabilities and make QUARK observe and supervise work. Its unchecked items
remain outstanding; the earlier implementation pause is historical.

Current interface: [connected web/mobile flow](UI_REBUILD.md). Home, Projects, tasks,
Conversations, Work, Attention, results, reviewed changes, Computer health, Models, usage,
assistant, editor chats and setup/recovery controls connect to the backend. AI Fieldnotes
awaits its intentionally later news source. See [current status](STATUS.md) for acceptance
limits and [the guide notes](WORKFLOW_BUILD.md) for journeys. The
[previous workspace reference](CLASSIC_WORKSPACE.md) remains for deliberate maintenance.

For the future public-facing story, see [PRODUCT_STORY.md](PRODUCT_STORY.md); the current scheduling brief is tracked in [QUARK_CHECKLIST.md](QUARK_CHECKLIST.md).

QUARK's conversation, project board, provider maintenance and retained-request recap guide:
[QUARK conversation and board](QUARK_COORDINATOR.md).

Start with [what the app actually does](FEATURES.md). It maps the original ideas to
implemented behavior, evidence, physical setup and deliberate limits. For normal use,
the [main README](../README.md) explains the app's buttons without developer commands.

## For the owner or a new user

New: [chat with existing live Codex and Claude Code conversations](../apps/vscode-mirror/README.md)
through the same VS Code companion and central web chat list.
Developers/reviewers: [maintenance and marketplace checklist](VSCODE_MIRROR.md).

Opening the desktop app, reconnecting old drafts and connecting an editor:
[Local access](LOCAL_ACCESS.md).

Native worker capabilities and optional saved restrictions: [Worker tools](WORKER_TOOLS.md).

| I want to…                                                 | Read                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Use the app, create a project or talk to a manager         | [Start using Agent Dock](../README.md)                                                                               |
| Check whether an idea is implemented or still pending      | [Feature map](FEATURES.md) and [current build status](STATUS.md)                                                     |
| Know what needs me rather than more agent work             | [Next owner check-in](OWNER_CHECK_IN.md)                                                                             |
| Set up my phone, choose its lock and add the icon          | [Connection setup](PHONE_SETUP.md), [phone workflow](PHONE_WORKFLOW.md) and [real-phone checks](PHONE_ACCEPTANCE.md) |
| Ask an agent to set up a fresh clone                       | [Agent-led setup](CONTRIBUTOR_SETUP.md)                                                                              |
| Update an existing installation with its records intact    | [Update handoff and setup-agent runbook](UPDATE_APP.md)                                                              |
| Connect personal, school or family computers               | [Multi-computer setup](MULTI_COMPUTER_SETUP.md)                                                                      |
| Choose Codex or Claude for managers and workers            | [Managed Claude controls](MANAGED_CLAUDE.md) and [provider/model choices](MULTI_PROVIDER_ROUTING.md)                 |
| Save a private recovery copy or understand backup coverage | [Recovery copies](RECOVERY_COPIES.md) and [GitHub source checkpoints](SOURCE_BACKUPS.md)                             |

Normal phone use does not require GitHub/Cloudflare account login. Initial pairing requires
a passkey and computer confirmation; repeat unlock is optional per paired device, default on.
The owner's Safari enrollment succeeded; Home Screen, cellular and restart checks remain.
After a Mac restart, log in and open
the app; login-item streamlining is deliberately deferred. Other computers retain their
own accounts and histories. See the feature map for the tested and physical boundaries.

Codex and Claude can be **managed** managers/workers in one project, using each selected
computer's installed sign-in and model catalog. [Managed Claude](MANAGED_CLAUDE.md) explains
its supported controls and native-only limits; [routing choices](MULTI_PROVIDER_ROUTING.md)
now use the [shared model policy](MODEL_POLICY.md); task classification is explicit and QUARK paces usage. Reported tokens are not
remaining allowance or a bill. The separate VS Code companion shares original editor
conversations without converting them into managed workers. Its owner-confirmed chat path
supports **Stop reply** and compatible update checks. The **0.2.5** companion removes
separate editor authentication, with installation/reload tracked separately in [status](STATUS.md).
After an editor crash, reopen the original conversation and share it again; automatic
editor recovery is not promised.

## For the setup or continuation agent

Outside agents can use the [QUARK usage and dispatch guide](AGENT_USAGE_ACCESS.md) and
[portable instructions](../skills/quark/SKILL.md) without discovering provider credentials.

Read [AGENTS.md](../AGENTS.md), the main README and [design decisions](DECISIONS.md) before
architecture changes. Use current instructions rather than replaying an old incident.

| Task                                                                         | Guide                                                                                                                                     |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Continue this owner's existing installation                                  | [Resume point](RESUME.md), then [current check-in](OWNER_CHECK_IN.md)                                                                     |
| Set up someone else's clone safely                                           | [Contributor setup](CONTRIBUTOR_SETUP.md)                                                                                                 |
| Provision/repair the phone connection                                        | [Private/domain choices](PHONE_SETUP.md), [Cloudflare setup](CLOUDFLARE_SETUP.md); finish with [physical acceptance](PHONE_ACCEPTANCE.md) |
| Connect another authorized host/account                                      | [Multi-computer setup](MULTI_COMPUTER_SETUP.md)                                                                                           |
| Configure a private GitHub source destination                                | [Source-backup runbook](SOURCE_BACKUPS.md)                                                                                                |
| Create/check a local recovery copy and restore without overwriting live work | [Recovery-copy guide](RECOVERY_COPIES.md)                                                                                                 |
| Check managed Claude setup, permissions, models and continuity               | [Managed Claude](MANAGED_CLAUDE.md)                                                                                                       |
| Stop/update/recover, manage processes or check authorization                 | [Operations](OPERATIONS.md)                                                                                                               |
| Diagnose a previously encountered failure                                    | [Orchestrator troubleshooting — future wiki material](ORCHESTRATOR_TROUBLESHOOTING.md)                                                    |

Setup is agent-led; the person supplies account consent, device verification and choices
the agent cannot safely infer. No copied credentials, blanket repeat approvals, paid
upgrades, unrelated SSH access or idle developer services. Keep independent authorized
work moving when only a physical setup branch is waiting. Never record codes/tokens,
conversations or private deployment receipts in these tracked documents.

## For developers and reviewers

| Question                                        | Source                                                                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What behavior must remain true?                 | [Feature map](FEATURES.md), [phone workflow contract](PHONE_WORKFLOW.md), [repository rules](../AGENTS.md)                                                               |
| Why was a particular design chosen?             | [Decisions](DECISIONS.md); check the date and superseding decisions                                                                                                      |
| What actually passed, on which version/source?  | [Verification](VERIFICATION.md), not an undated test count                                                                                                               |
| How does the app stay thin as providers evolve? | [Provider compatibility](PROVIDER_COMPATIBILITY.md), [managed Claude](MANAGED_CLAUDE.md) and [editor bridge maintenance](VSCODE_MIRROR.md)                               |
| Where is the implementation?                    | [Shared contracts](../packages/shared/src), [host/runtime](../apps/server/src), [web UI](../apps/web/src); specific files/checks are linked from [Features](FEATURES.md) |
| What should be repeated after a change?         | Focused tests plus relevant [verification procedures](VERIFICATION.md); ordinary UI checks cover desktop, 412×915, 360×800 and 915×412                                   |

## Current guidance versus historical evidence

[FEATURES.md](FEATURES.md) is the navigable capability map. [STATUS.md](STATUS.md) records
the integrated readiness decision; [OWNER_CHECK_IN.md](OWNER_CHECK_IN.md) lists human-only
handoffs. [RESUME.md](RESUME.md) is a continuation note for this installation, not a
collaborator's setup template. Current delivery and pending design are recorded in
[WORKFLOW_BUILD.md](WORKFLOW_BUILD.md), [HOME_UI_REQUIREMENTS.md](HOME_UI_REQUIREMENTS.md)
and [CHAT_UI_REQUIREMENTS.md](CHAT_UI_REQUIREMENTS.md).

[DECISIONS.md](DECISIONS.md), [VERIFICATION.md](VERIFICATION.md) and the troubleshooting
wiki seed retain older evidence intentionally. Some features once marked “v2” are now
implemented. Old Cloudflare Access/MFA instructions are rollback history, not the current
phone journey. Superseded handoff files and one-off experiments are recoverable in Git
history rather than duplicated as apparent current instructions. The accepted phone
contract lives in [PHONE_WORKFLOW.md](PHONE_WORKFLOW.md).

When adding a feature, update its map entry with its actual boundary and code/test links;
record dated execution evidence separately. Distinguish a fixture, a real provider/cloud
check and physical acceptance. Do not turn a new contract, an unrun test, or an older
passing source checkpoint into a claim that the owner's complete workflow is finished.

QUARK use and limits: [QUARK.md](QUARK.md). Shared provider collection and setup: [USAGE_COLLECTOR.md](USAGE_COLLECTOR.md).

Computer health and the resource assistant: [RESOURCE_WATCH.md](RESOURCE_WATCH.md).
