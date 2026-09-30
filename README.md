# sciencewithagents

A private home for your work with AI, on your computer and phone.

See your Codex and Claude usage, follow the teams working on your projects, and keep the
conversations and decisions behind the results. Each computer keeps its own accounts,
files and history.

## Your three setup choices

1. **GitHub backup:** decide whether you want private copies of your project code.
   Your setup agent connects your own GitHub account; you complete its sign-in.
2. **Phone:** decide whether you want the same chats on your phone. Open the pairing
   link, save the passkey and confirm the matching number on your computer.
3. **Phone connection:** choose the private, no-domain Tailscale option, or use
   Cloudflare with a domain you already control. Your setup agent configures the connection;
   you complete any account sign-in. There is no separate sciencewithagents account.

All three are optional for local computer use. Your agent handles installation and setup;
you choose the options and complete account/device prompts. Start with [Set up on your computer](#set-up-on-your-computer).

## The connected app

The current app opens to a new home designed for phones and adapted for desktop. It shows
real subscription readings, items needing attention, project summaries, recent results and
computer resources. Opening it does not start a conversation or change your work.

**Home, Projects, project/task detail, managed Conversations, Work, Attention, Recent Results,
review/apply, transcription, Computer health, Model settings and QUARK usage controls are
implemented in the new interface.** The personal assistant, assistant privacy, shared editor
chats, saved-history search, browser view handoff, Settings, computer selection, phone controls
and recovery copies are connected too. Create a project or connect an existing folder on your Mac. If it needs a local starting
version, **Start tracking this folder** sets that up in the app without uploading files. Talk to
its manager and inspect its workers through the normal navigation. Finished work opens as
a saved record with an explicit **Ask about this work** action: a separate read-only
discussion preserving the completed task and review. Eligible Codex and Claude workers can copy
their original native conversation through its recorded final reply; saved-evidence discussion
remains available for either provider. Claude needs a root reply captured by this version; older
records and native helpers use saved evidence. Opening a page never starts a model turn.
Finished task workers release their idle processes while keeping saved conversations, reviews
and files. Paused work, pending permissions and native input remain protected.

New Codex and Claude conversations use native tools, skills, hooks and connections with their existing
permission rules. QUARK watches their work and budget. Saved conversations and project tool
restrictions remain intact; an idle conversation can choose **Advanced controls →
Tools and connections → Use my native settings** for its provider. The optional older restrictions remain
under **Tools for new workers**, where **Use native settings** restores inheritance for future
workers without changing existing conversations. Claude helpers retain their own observed tool and closing-text
histories. Registered native helper transcripts now fill in saved replies, reported models and
deduplicated input/cache counters, including delayed writes and resumes. Recognized native
completion results also retain each helper's delivered report and reported run token total,
separate from the inclusive team count. Helper output breakdowns
and exact nested ancestry remain incomplete; parent team totals are not charged twice. Native Claude questions appear in the conversation with
choices, multiple selections and custom answers, forwarded to the original request once. See
[native capabilities and saved restrictions](docs/WORKER_TOOLS.md).

The connected interface follows the AI-designed Sketchcoded board and the owner's drawings.
Mobile refinement and release acceptance are recorded in [Build status](docs/STATUS.md).
Advanced/native controls and manual task/module-manager creation are connected. **Welcome and
setup** automatically checks existing native sign-in and available models without a prompt, links saved team choices
and first-project creation, and provides bounded native Codex device-code sign-in. A new empty
installation defaults to Codex only; existing policies are preserved. On Mac, **Sign in with Claude**
opens Claude Code’s native login window; finish its browser flow and check sign-in in Welcome.
Credentials stay with Claude and existing accounts are not replaced. **Phone access** now offers
an optional private Tailscale connection without a domain: check readiness, confirm the address,
turn it on and pair. Tailscale installation/sign-in and HTTPS consent remain with the person;
the existing domain route remains available. See [phone setup and acceptance limits](docs/PHONE_SETUP.md).
Initial source installation still needs its setup steps. Retained backend capabilities are not
proof that those screens work here. Phone pairing, unlocking and manual locking remain. Shared VS Code conversations connect
locally without a separate editor code. Long histories open in bounded sections, with older
messages and large tool results available on demand; original conversations are retained.
See [connected workflow and guide notes](docs/WORKFLOW_BUILD.md) for the current slice.

**Chats → Shared** also opens existing Codex conversations from a running native shared
server, including compatible terminal sessions. Read, send, guide the current reply and
request Stop without importing or restarting the agent. Native settings and approvals stay
on the computer; simultaneous inputs can join one reply. Older isolated terminals are not
supported. See [native session sharing and limits](docs/VSCODE_MIRROR.md#existing-codex-terminal-sessions).

Open **Computer health** from the home’s computer card for recent trends, grouped app
activity and **Open Resource assistant**. Asked diagnoses use native tools in a full-screen
conversation. Configurable automatic checks remain bounded snapshot reports and stay out of
the normal chat list. Both use the central model policy, with one bounded consultation when needed. See the
[resource watcher guide](docs/RESOURCE_WATCH.md) for metrics, privacy and limits.

Project setup keeps the manager's provider/model separate from the workers' provider mix
(Codex only through Claude only) and spending level (Light, Default or Tokenmax).
The controls show actual available model names. **Workspace settings** holds the shared
defaults and family mappings. Defaults follow available updates; exact versions remain
selectable, and missing models are reported rather than silently replaced. See
[model policy](docs/MODEL_POLICY.md) for coverage, native-session boundaries and the full mapping.

Read the [interface handoff](docs/UI_REBUILD.md) for the exact scope, or the
[nontechnical product story](docs/PRODUCT_STORY.md) for the broader vision.

Open **Work** to talk to QUARK above the shared project board. Ask it to pause projects,
change priorities or allocate allowance. It saves those decisions outside project repositories;
existing host guards enforce caps and protected headroom. Default: latest Opus, configurable.
Automatic checks wake for relevant work changes with bounded frequency and duration. Open a
provider's usage card to refresh usage, check connection or check/install CLI updates through
its recognized installer. See [QUARK conversation and guide notes](docs/QUARK_COORDINATOR.md).

Open **All usage** or **Work** to give projects/tasks a share of a reported allowance,
inspect tokens per agent, and continue work paused by QUARK. Automatic guards retain files,
queued messages and conversations; only the owner can increase a saved cap. Cache timers
and bounded refreshes help reuse eligible task contexts. Percentage attribution and cache
lifetimes are estimates; 2–3 percentage-point accuracy and guaranteed cache retention are
not established. Codex expiry is unknown by default. See [accounting and cache controls](docs/QUARK_ACCOUNTING.md).

Open a project’s **Private source backup** card to preview and connect a private GitHub
destination. Confirm the exact address before creating or connecting it. The same card shows
verified checkpoint status and retry; conversations and unsaved files need separate backup.
See [setup and recovery limits](docs/SOURCE_BACKUPS.md).

Managers need a host-signed QUARK lease before orchestration. Dispatch hooks check it again,
and the app monitors workers independently of their manager's availability. Managers can
pause owned workers while retaining progress. [Lease and native-context limits](docs/QUARK.md#managers-need-a-quark-lease).

## Set up on your computer

Open this repository with your coding agent and ask it to follow the
[setup guide](docs/CONTRIBUTOR_SETUP.md). The agent installs dependencies, checks your
chosen Codex or Claude sign-in, and prepares the local app. You complete any account
sign-in yourself. No conversations, credentials, screenshots or test databases are included
in this repository.

You can give your setup agent this request:

> Set up sciencewithagents from this clone using docs/CONTRIBUTOR_SETUP.md. Use my own
> installed Codex or Claude sign-in and let me choose which provider to use. Preserve my
> existing accounts and files. Open the app and walk me through Welcome and my first
> project. Leave phone access and private source backup optional. Tell me which steps
> need my sign-in or device; ordinary setup does not need the full developer test suite.

On a configured Mac, open **sciencewithagents** from Applications. It opens the app in your
browser through a private, one-use handoff. Older open tabs reconnect automatically when
this browser already has access, keeping their destination and unsent drafts. Expired access
offers **Open desktop app**; return to the tab to continue. Conflicting drafts are available in
**Recovery copies**.
Local use needs neither Cloudflare nor a phone. Your computer needs to remain
awake and running the app for agents or an existing phone connection to stay available.

Phone access is optional. Start with the [phone connection choices](docs/PHONE_SETUP.md),
and you pair through the browser using a passkey and confirmation on your computer. Existing
paired phones can simply refresh to see the new home. The app offers private Tailscale setup;
the domain connection remains an agent-led option.

Source setup requires Node 24+ and Git. It checks installed Codex/Claude executables before
installing dependencies; either provider can be used independently. The app can also open
before either is installed, but agents need a connected provider before starting work. Prefer a local Developer folder over cloud-synced Documents/iCloud. Setup still
needs an agent/developer environment; this is not a packaged installer
or automatic updater. Sharing the public repository and publishing a promotional website
remain separate steps.

Apple Silicon macOS is the verified desktop target. Linux CI verifies the source build;
Intel Mac, Windows and native integrations on other platforms have separate limits. See
the setup guide's [machine support](docs/CONTRIBUTOR_SETUP.md#check-the-machine-first),
[optional VS Code companion](docs/CONTRIBUTOR_SETUP.md#optional-vs-code-companion) and
[network requirements](docs/CONTRIBUTOR_SETUP.md#network-access-by-feature) before a new install.

## For developers

Use Node 24+, Git and the repository's pnpm wrapper. From this directory:

```sh
node scripts/setup.mjs
sh scripts/pnpm start
```

The app binds to **http://127.0.0.1:4330**. In another terminal, `sh scripts/pnpm dock open`
opens the authenticated browser view; the bare loopback address does not authorize private
API calls. Use the installed app for normal opening. Runtime data belongs under ignored `data/`.
Never run tests against an owner's data directory. Login/background service installation is
optional and remains off unless explicitly requested.

The current interface lives in `apps/web/src/home/`. Current browser checks live in
`apps/web/tests/home/`; retained interface checks are grouped in `apps/web/tests/classic/`.
[Browser test instructions](apps/web/tests/README.md) explain the separate suites. Generated
screenshots, recordings, traces and fixtures stay under ignored `data/` and are not shipped.
TypeScript builds reject unused imports, locals and parameters. Keep reusable test sources;
retire one-off experiments and superseded handoffs instead of adding archive copies.

The previous interface remains available for deliberate maintenance at `/?workspace=classic`.
It is not linked from the new home. Its [reference guide](docs/CLASSIC_WORKSPACE.md) describes
the retained capabilities; its presence does not mean those screens have been redesigned.

## Learn more

- [Product story and functionality inventory](docs/PRODUCT_STORY.md)
- [Feature map and current limits](docs/FEATURES.md)
- [QUARK: usage, priorities and paced background work](docs/QUARK.md)
- [Shared Codex and Claude usage](docs/USAGE_COLLECTOR.md)
- [VS Code conversation companion](apps/vscode-mirror/README.md)
- [Current status and verification](docs/STATUS.md)
- [Documentation directory](docs/README.md)

## Licence

sciencewithagents is [MIT licensed](LICENSE). You can use, modify and share your own version.
Bundled third-party fonts and the optional usage reader retain their own licence notices.
