# Documentation

Start with the [setup prompt](../README.md#set-up). Current implementation and limitations
are in [Features](FEATURES.md) and [Status](STATUS.md).

## Setup and everyday use

- [Install with your coding agent](CONTRIBUTOR_SETUP.md)
- [Open the app and connect VS Code](LOCAL_ACCESS.md)
- [Cloudflare phone setup prompt](PHONE_SETUP.md) and [pairing workflow](PHONE_WORKFLOW.md)
- [Connect another computer](MULTI_COMPUTER_SETUP.md)
- [Choose managers, workers and model defaults](MODEL_POLICY.md)
- [QUARK queue and budgets](QUARK.md) and [its coordinator](QUARK_COORDINATOR.md)
- [Computer health](RESOURCE_WATCH.md) and [Slurm cluster](CLUSTER.md)
- [Apps, project apps and publishing accounts](APPS.md), [LaTeX and PDF reader](LATEX.md),
  [phone LaTeX authoring](TEX_AUTHORING.md)
- [Update a customized installation](UPDATE_APP.md)
- [Recovery copies](RECOVERY_COPIES.md) and [private source backups](SOURCE_BACKUPS.md)

## Technical references

- [Operations and recovery](OPERATIONS.md), [troubleshooting](ORCHESTRATOR_TROUBLESHOOTING.md)
- [Cloudflare phone setup](CLOUDFLARE_SETUP.md), [real-phone acceptance](PHONE_ACCEPTANCE.md)
- [Native provider boundaries](PROVIDER_COMPATIBILITY.md), [managed Claude](MANAGED_CLAUDE.md),
  [worker capabilities](WORKER_TOOLS.md), [cross-provider routing](MULTI_PROVIDER_ROUTING.md)
- [Shared usage collector](USAGE_COLLECTOR.md), [allowance accounting](QUARK_ACCOUNTING.md),
  [outside-agent access](AGENT_USAGE_ACCESS.md), [QUARK skill](../skills/quark/SKILL.md)
- [VS Code companion](../apps/vscode-mirror/README.md) and [bridge maintenance](VSCODE_MIRROR.md)
- [Saved requests and paged archive review](ARCHIVE_REVIEW.md)
- [Group collaboration data foundation and remaining gates](GROUP_COLLABORATION.md)
- [Hosted group membership and revocation foundation](GROUP_HOSTING.md)
- [Durable hosted receipts, exact source registration and Node transport](GROUP_DELIVERY.md)
- [Durable group publication and journal limits](GROUP_PUBLICATION.md)
- [Normal authenticated Groups workflow and current gates](GROUP_WORKFLOW.md)
- [Groups agents with existing native sign-in](GROUP_NATIVE_OWNER_SETUP.md)
- [Native Groups shared files, branches and reviewed sync](GROUP_NATIVE_GIT.md)
- [Persistent local Groups test workflow](GROUP_FIXTURE.md)
- [Groups presentation and synthetic browser preview](GROUP_UI.md)
- [Verification](VERIFICATION.md), [maintenance scripts](../scripts/README.md),
  [browser checks](../apps/web/tests/README.md), [legacy workspace](CLASSIC_WORKSPACE.md)

## Product and development

- [Design decisions](DECISIONS.md) and [interface requirements](DESIGN.md)
- [Guide and presentation notes](PRODUCT_STORY.md)
- [Beta demo screenshots](../README.md#beta-demo) — temporary previews, not final artwork
- [Repository instructions](../AGENTS.md), [public-site deployment](../deployment/README.md)

Private conversations, drawings, device receipts, generated evidence and continuation notes
belong outside tracked source. Older implementation narratives remain in Git history;
current instructions should not require reading that history.
