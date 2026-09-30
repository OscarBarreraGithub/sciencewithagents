# QUARK access for another coding agent

An agent with local shell access can read sciencewithagents' shared reports and request
capped work from one of its existing project managers. No second collector, terminal poller
or provider credential plumbing is needed. App-managed managers already get the equivalent
inspection tools and host-signed leases automatically; this client is for agents outside them.

## Read the shared reports

Run these from the installed repository. Use that installation's `DOCK_DATA_DIR` if customized.
The app must be open; these commands never start a background service or a model.

```sh
node apps/server/dist/cli.js quark projects
node apps/server/dist/cli.js quark usage
node apps/server/dist/cli.js quark resources
node apps/server/dist/cli.js quark jobs
node apps/server/dist/cli.js quark jobs PROJECT_UUID
```

JSON usage includes both providers, exact window IDs, remaining percentage, reset time,
observation time and stale/error state. It includes separate model windows when reported.
Missing weekly windows stay missing. Resources includes cached pressure, trends and grouped
process activity. Jobs includes queue reasons, planning estimates, token/accounting totals,
allowance holds and owned local jobs. Project filtering selects that project's job/accounting
records; machine/provider readings and shared window totals still describe the whole host.
Read commands neither refresh native authentication nor trigger a new provider usage request.

## Submit bounded work

Store a JSON request under ignored `data/` or another private runtime folder. Generate its
UUID once. Use real IDs from the reports, not the illustrative labels below:

```json
{
  "key": "REQUEST_UUID",
  "projectId": "PROJECT_UUID",
  "task": {
    "title": "Verify the calculation",
    "goal": "Check the calculation and explain any discrepancy.",
    "acceptance": "Reproducible evidence and an independent review.",
    "scheduling": {
      "priority": "background",
      "expectedTokens": 12000,
      "tokenBudget": 200000,
      "quotaPercent": 2,
      "expectedSeconds": 600
    }
  },
  "allowances": [
    { "provider": "codex", "windowId": "REPORTED_WEEKLY_WINDOW_ID", "limitPercent": 10 }
  ]
}
```

```sh
node apps/server/dist/cli.js quark dispatch /absolute/private/request.json
```

`managerId` is optional; omit it for the project's primary manager. `task.parentId` can refer
to an existing task in the same project, retaining its allowance ancestry. If scheduling is
omitted, the client defaults to background priority and the central planning estimates.
Priorities are interactive, high, normal and background. Model/provider selection stays with
the existing manager and central policy; the client cannot supply executables or arbitrary RPC.

At least one allowance is required. **10 means ten percentage points of the full reported
allowance**, not ten percent of the remaining portion and not a “70% remaining” threshold.
Caps apply only to the named provider/window. A Codex weekly cap does not limit Claude; include
separate requested Claude caps if its work must be limited too. A model-specific window covers
that model, not the provider's entire account. No weekly window is invented for plans without
one. `quotaPercent` is a per-turn reservation estimate; `limitPercent` is the task grant.

All caps and the first manager request commit together. An invalid/stale/missing window leaves
no new task or queued work. The first manager turn and descendant tasks inherit the task cap.
Shared reservations and existing project/ancestor caps continue to apply. A very small grant
may wait immediately when it cannot fit the estimated turn plus stopping buffer. Explicit
allowance gates apply even with optional priority/resource pacing off; that switch remains
visible under Work. Percentage attribution and stopping are estimates with monitoring latency,
not a validated 2–3 percentage-point accuracy guarantee.

The result contains the task, queued run ID and saved caps. Inspect progress in the app or
with `quark jobs PROJECT_UUID`. It is a submission receipt, not proof of completed work.
Keep the same file/key after lost responses, timeouts or app restarts. Retrying returns the
same receipt. Changing a previously accepted request under its key is rejected. Start a new
key only for genuinely new authorized work. The client cannot raise a saved cap, resume holds,
approve permissions or integrate results. Those remain owner controls in the app.

## Instructions and installation boundary

The reusable [QUARK skill](../skills/quark/SKILL.md) ships with the source. An outside agent
can read it directly; no global hook or skill installation is required. For managed agents,
the app supplies its current charter and typed tools, using the same cache and admission gates.

On app startup the host creates a private `data/agent-client.json` containing a random
installation capability and loopback address. The CLI reads it without printing it. The file
must belong to the OS account and have no group/other permissions; symlinks are refused. It
survives ordinary restarts and retains its secret when the local port changes. Never commit,
share or put it in a prompt. It is not a Codex/Claude token. The typed client routes reject
missing credentials and are unavailable on the phone entry or another-computer proxy.

This capability trusts agents running as the installation's OS user. It is not a sandbox
against a program that already reads that user's private files. The app's older browser and
VS Code companion endpoints still need their broader local-authentication correction; this
adapter does not claim to protect those routes. No global provider hooks or interception of
unrelated terminal/editor sessions is installed. The calling agent receives no manager lease.
