# Current status

Checked 2026-10-01. **Early access; not yet signed off for an unattended collaborator release.**
Documentation cleanup and a passing UI check do not resolve backend release failures.

## Release blockers

The [last inspected failing CI run](https://github.com/OscarBarreraGithub/sciencewithagents/actions/runs/36842768536)
has six backend failures involving provider/model routing, Claude runtime defaults, a
read-only review and the asynchronous manager-lease recheck, including an unhandled
assertion. Triage must distinguish stale expectations from runtime defects, correct them,
and pass the relevant checks before a new release sign-off. Later runs are on the
[CI page](https://github.com/OscarBarreraGithub/sciencewithagents/actions).

## Delivered, with acceptance limits

The app connects project setup, manager/worker conversations, versioned prompt drafts,
shared editor chats, QUARK's board/budgets/coordinator, computer health, model preferences,
phone pairing and recovery. [Features](FEATURES.md) describes their boundaries.
Source installation and isolated Codex-only/Claude-only first replies have been exercised
on Apple Silicon macOS. Linux CI does not certify native Linux desktop integration.
Intel Mac and Windows remain unqualified; see [machine support](CONTRIBUTOR_SETUP.md#check-the-machine-first).

Desktop and simulated phone checks include failed requests, retry, saved data, keyboard
layout and long chat history. They do not certify physical Home Screen retention, cellular
reconnection, hardware keyboards or all OS/browser versions. Use [phone acceptance](PHONE_ACCEPTANCE.md)
on the actual device. The companion is installed from source; no marketplace release is claimed.

## Outstanding product work

- **Automatic five-hour utilization:** QUARK has shared reserves, caps, pacing and concurrency
  limits. It does not yet automatically target a reset window or shift suitable new work
  toward Claude to use spare capacity. Respect actual account/model windows and explicit choices.
- **Apps:** the gallery is an empty placeholder. Registered app tiles and project-site
  publication are not connected.
- **Setup progress:** GitHub/Cloudflare copy prompts work, but do not yet detect completion
  or hide completed steps. Native Codex/Claude sign-in/model checks are separate and connected.
- **Updates:** the update prompt still expects a recovery-copy reference prepared in the app.
  Moving that preparation entirely into the setup agent's workflow remains outstanding.
- **Orb:** seven shapes, random selection and tap feedback exist; broader variety and the
  requested longer, quiet animation remain unfinished.

## Intentionally deferred

AI news, the personal-agent destination, a standalone public Guide/FAQ, marketplace publication,
distributed job migration and a packaged cross-platform installer. The README is the public
landing; dedicated website design is deferred. Automatic cache-warming turns are disabled;
[issue #1](https://github.com/OscarBarreraGithub/sciencewithagents/issues/1) tracks future work.

Allowance attribution is estimated, without a validated 2–3 percentage-point error bound.
No provider cache-retention guarantee exists. Native tools and external MCP services retain
their own permission boundaries. Browser storage and source backups do not guarantee recovery
of every unsent prompt or external native history. See [accounting](QUARK_ACCOUNTING.md),
[worker tools](WORKER_TOOLS.md) and [recovery](RECOVERY_COPIES.md).
