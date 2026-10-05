# Current status

Checked 2026-10-04. **Beta: current workflows have been exercised with real Codex/Claude
projects and desktop/phone browser checks.** This is not a claim that every device or
future provider version is certified. See [verification](VERIFICATION.md) and the
[published-source CI](https://github.com/OscarBarreraGithub/sciencewithagents/actions).

The earlier provider-routing, Claude review and manager-lease failures are corrected.
The beta pass also fixed owned-process stopping, delayed allowance attribution, crowded
attention/QUARK layouts, keyboard composers, draft races and helper search filtering.
Product work below remains outside this polish pass.
Paired devices can browse existing folders on the selected host. New project managers have
scoped project-folder writes; explicit read-only choices and reviewer restrictions are preserved.
Spawn creates a fresh manager even for a previously connected folder. Chat configuration can
remove a stopped manager, cancelling queued work while retaining files and saved history.
Computer health links selected process/script identities to QUARK jobs and wakes bounded
diagnostics for sustained resource changes, with cooldowns and a daily attempt limit.

## Delivered, with acceptance limits

The app connects project setup, manager/worker conversations, versioned prompt drafts,
shared editor chats, QUARK's board/budgets/coordinator, computer health, model preferences,
phone pairing, recovery and the [LaTeX/PDF reader](LATEX.md). [Features](FEATURES.md) describes their boundaries.
LaTeX math renders automatically across chat views and shared editor messages; full document
compilation remains in the reader. LaTeX-backed reports offer reflowing Reading mode, with
adjustable text and individually scrollable equations alongside Original PDF. Direct resource
questions default to a stronger grad model and native investigation; automatic checks remain
bounded routine reports. The reader offers an explicit, selectable-model formatting pass
(default Sonnet) into a separate reading copy; originals remain intact.
Source installation and isolated Codex-only/Claude-only first replies have been exercised
on Apple Silicon macOS. Linux CI does not certify native Linux desktop integration.
Intel Mac and Windows remain unqualified; see [machine support](CONTRIBUTOR_SETUP.md#check-the-machine-first).

Desktop and simulated phone checks include failed requests, retry, saved data, keyboard
layout and long chat history. They do not certify physical Home Screen retention, cellular
reconnection, hardware keyboards or all OS/browser versions. Use [phone acceptance](PHONE_ACCEPTANCE.md)
on the actual device. The companion is installed from source; no marketplace release is claimed.

Routine work no longer stops at legacy raw-token estimates. Actual provider allowance caps,
reserves, resource checks and saved pauses remain enforced. **Help → Report a bug** saves a
private report and dispatches it to one maintenance manager through normal delegation/review.

Provider outages no longer block saved views: model discovery retries queued messages,
provider preparation runs independently, and bounded queue/SSE work yields to HTTP requests.
Browser drafts survive failed first reads and ambiguous sends; a cold reconnect can display
the local draft for copying. This does not replace access to the running host for saved history.

## Outstanding product work

- **Request coverage:** saved prompts, work items and handoffs retain evidence, but managers
  still need to triage each request. There is no automatic proof that every small ask became
  a task or was completed. RLM-assisted archive audits are being evaluated, not shipped.
- **Cluster integration:** cached FASRC SSH access, monitoring-script inspection and read-only
  job/account queries are verified. QUARK's cluster collector, submission guards, job tracking
  and notebook tunnels remain unimplemented. See [the integration boundary](QUARK.md#cluster-integration-boundary).

- **Hourly allowance budgets:** per-provider `% usage / hour` is a measured estimate. Enforced
  budgets are allocations within provider windows, not rolling hourly rate limits.
- **Five-hour utilization:** QUARK reports account-wide burn and projected remaining allowance
  at reset, and wakes the coordinator for sustained spare capacity while useful work exists.
  Managers receive the signal and choose eligible work within provider preferences and caps.
  It does not guarantee exhausting a window or force-switch existing conversations.
- **Apps:** LaTeX/PDF reading is connected. Custom project-app registration and project-site
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
