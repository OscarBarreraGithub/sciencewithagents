# Shared subscription usage

sciencewithagents uses one host-owned collector per computer. The phone, desktop and
both providers' managers read the same saved measurements. Every minute the collector
reads Codex through the standalone CodexBar CLI and Claude through its native OAuth
usage endpoint, including scoped model windows. Overlapping refreshes share a request; failures back off up
to 15 minutes. A Claude 429/503 retry hint can extend the wait (up to a day). Each reading has its provider timestamp and becomes stale after three
minutes. Reading a cached view sends no model prompt.

## Reuse decision

Reuse the standalone reader instead of forking the menu-bar app or creating a second
sign-in store. CodexBar maintains Codex retrieval. A small native Claude reader supplements it because
the installed helper omitted the live Fable window, and the pinned official reader did
not recognize this Mac’s Claude credential namespace. The setup script
copies the installed CLI into ignored `data/tools/`, checks it and records its checksum.
It retains the MIT license. The menu-bar app need not run or stay installed once this
standalone copy and its usage access have been verified. This task does not uninstall it.

`scripts/setup-usage-collector.mjs` is an agent-led setup step, not an instruction that
normal phone users run commands. If absent on Apple Silicon macOS, setup downloads the official v0.65.0 standalone archive
and verifies SHA-256 before extracting the single executable. Other platforms require the
setup agent to install the appropriate official CLI. That release was verified for Codex;
Claude uses the separate narrow native reader within the same collector. Update deliberately by selecting the
new installed CLI with the host-only `DOCK_CODEXBAR_BIN` override and rerunning setup;
no provider binary, account credential or private configuration enters this repository.

The fixed Codex command uses `usage --provider codex --source oauth --format json
--no-credits`. Claude verifies native sign-in identity, reads the existing native credential
into process memory, and makes a bounded GET to `https://api.anthropic.com/api/oauth/usage`.
It checks identity again before accepting the report. No credential is saved, sent to an
agent or refreshed by this reader. Custom Claude profile directories currently report
unavailable rather than risking a different account. Native Claude owns authentication
refresh; failed sign-in reads become stale with retry/backoff. It does not scrape browser cookies, purchase credits, consume an earned
reset, change accounts or send a chat message. Only explicitly selected quota fields
are persisted. Unexpected raw output/errors, emails and credentials are not forwarded
to browsers or model contexts. Existing local provider/collector authentication still
needs to work; a missing reading is displayed as unknown, never zero.

## When a reading fails

**All usage** keeps the last successful reading visibly stale, with its observation time,
a plain explanation and the next automatic check. Claude failures distinguish sign-in,
refused authorization/access, throttled usage checks, service/network problems, unsupported
reports and account changes. A usage-check rate limit does not mean model allowance is exhausted.
Raw errors, response bodies, headers and credentials stay out of the app and agent context.

The existing collector respects valid numeric/HTTP-date `Retry-After` hints on Claude 429/503
responses, with a one-day bound for implausible long hints. Its normal backoff still applies.
That next-check time survives app restarts and is shared by manual refresh, the desktop,
phone and every manager. Pressing Refresh does not start another polling loop or bypass the
wait. A successful report clears the failure and returns to the normal refresh interval.
QUARK keeps its existing admission/recovery rules; an old reading does not become new capacity.
No new sign-in, account switch or token refresh is attempted by the usage reader.

## Independent windows and estimates

Keep five-hour, weekly and named model-specific windows separate. Fable windows in native `limits` remain distinct from the general Claude window. An absent
Fable row is not proof of free Fable capacity. The owner reports Harvard FAS has no
general weekly cap. This host-only statement can be recorded against its verified native
account fingerprint; another sign-in cannot inherit it. A missing weekly field alone does
not prove that for another account. The live FAS report has a general five-hour window,
no general weekly window, and a separate Fable weekly window. It did not report a Fable
five-hour window. Anthropic says Fable may also draw from normal usage, so QUARK checks
both applicable meters and never adds Fable as extra general capacity.
The current collector targets its locally configured OAuth source; it does not pool
other accounts, move native conversations or forward credentials across computers.

Task token estimates and allowance-percentage reservations are two different planning
quantities. They are not interchangeable, provider token limits, a bill or permission for
paid API fallback. QUARK retains allowance reservations after a turn until a later usage
poll can observe it, and waits for an actual refreshed report after a reset timestamp.

The verified official archive is `CodexBarCLI-v0.65.0-macos-arm64.tar.gz`, SHA-256
`72ad0da39058a84f36cd178ac2a492eb139f8c9939997346302a43b19d4cf0fb`.
Its upstream MIT license is retained in `third_party/CodexBar-LICENSE`. Updates require
new parser/live checks; no menu-bar fork or second credential store is needed.

## Sources

- [HTTP retry timing](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)

- [CodexBar CLI and standalone builds](https://github.com/steipete/CodexBar/blob/main/docs/cli.md)
- [Claude retrieval and scoped windows](https://github.com/steipete/CodexBar/blob/main/docs/claude.md)
- [Anthropic’s Fable allowance explanation](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)
- [CodexBar MIT license](https://github.com/steipete/CodexBar/blob/main/LICENSE)
- [Codex account rate-limit interface](https://learn.chatgpt.com/docs/app-server)

The source/provider formats can evolve. Isolated live checks and parser tests accompany
updates; accepting one current report is not a promise of every future provider version.
