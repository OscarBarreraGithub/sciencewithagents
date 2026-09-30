---
name: quark
description: Read shared Codex and Claude allowance/resource reports and submit capped project work to a running local sciencewithagents app through QUARK. Use when asked to pace or dispatch work through that app.
---

Use the running installation's compiled CLI from its repository directory:

```sh
node apps/server/dist/cli.js quark usage
node apps/server/dist/cli.js quark resources
node apps/server/dist/cli.js quark projects
node apps/server/dist/cli.js quark jobs
```

These read the host cache and start no model. Do not scrape provider binaries, poll usage
endpoints yourself, or read/copy provider credentials. The CLI reads its private host-client
file internally; never print or copy that file into prompts. Use the installation's configured
`DOCK_DATA_DIR` if it differs from the repository's ignored `data/` directory.

Before dispatch, read `docs/AGENT_USAGE_ACCESS.md` in that installation for the request contract.
Resolve the target project/manager and the exact reported provider/window IDs. Preserve the
owner's provider, priority and allowance instructions. Remaining allowance is a percentage of
the full window: “use at most 10% of my weekly allowance” means `limitPercent: 10`, not a floor
of 10% remaining. Each cap applies only to its specified provider/window; add distinct caps
for other providers when authorized. Do not invent a weekly meter for an account without one.
Stale or absent readings require a fresh host reading, not guesses or a replacement account.

Save one UUID-keyed request in an ignored/private JSON file, then:

```sh
node apps/server/dist/cli.js quark dispatch /absolute/private/request.json
node apps/server/dist/cli.js quark jobs PROJECT_UUID
```

A dispatch receipt means queued, not completed. After an uncertain response, keep the same
file and UUID and retry it; never mint another key to check whether the first request worked.
Caps are recorded before admission. Follow the job's wait reason; do not raise budgets,
resume deliberate holds, or create replacement tasks to escape limits. Only the owner can
increase an existing cap. Percentage attribution and cache expiry remain estimates.

App-managed managers already receive typed inspection/delegation tools and signed QUARK
leases. Use those tools inside managed turns, not this external client to sidestep a lease.
The external client requests work from an existing app-managed manager. It cannot turn the
calling terminal agent into a leased manager or control unrelated editor/terminal activity.
It cannot approve permissions, apply code, choose shell commands or modify account credentials.
