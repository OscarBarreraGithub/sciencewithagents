# Agent-led setup from a clone

For the person: clone/open this repository with your coding agent and ask it to follow this
guide; the [README setup prompt](../README.md#set-up) is the canonical copyable request.
Your agent handles the technical steps below. You complete your own account sign-ins when
the provider asks and, if pairing a phone, save its passkey and confirm the matching number
on the computer. Never send passwords or codes through chat.

Private GitHub backup and phone access through your own Cloudflare Workers Free account
are optional choices; local use needs neither.
New phone setup uses a free `workers.dev` address without an owned domain. The phone never
requires a GitHub or Cloudflare account login. Preserve working domain connections.

## Setup agent

The current interface connects projects, conversations, tasks, reviews, shared editor chats,
usage/QUARK, advanced controls and configured phone/recovery settings. Use the normal app for
those journeys. Welcome/setup checks native sign-in/models and provides native Codex device-code
sign-in. On Mac, Welcome also opens Claude’s native Terminal/browser sign-in after confirming
it is signed out; account details stay with Claude. Initial source setup uses this guide.
Phone access provides a copyable Cloudflare setup-agent prompt; see [PHONE_SETUP.md](PHONE_SETUP.md),
[STATUS.md](STATUS.md).
If an installed prompt still suggests Tailscale or requires a domain, follow
[UPDATE_APP.md](UPDATE_APP.md) before recopying it; preserve active work and saved pairing.
The retained `/?workspace=classic` interface is an optional maintenance surface. Private
runtime and browser-test output remain under ignored `data/`; never copy them into another
person's installation. Repository history does not authorize access to another person's accounts or computer.

### Install or update your agent CLI

The desktop apps and editor extensions do not establish that a current terminal CLI is
available. Install **one** chosen provider on the computer that will run the agents.
Welcome → Check this computer → **Install or update Codex / Claude** also has copyable commands.
On Mac, open Terminal with Spotlight (Command–Space, type Terminal, Return).

For a new macOS/Linux CLI installation, use the provider's official installer:

| Provider | Install latest |
| --- | --- |
| Codex | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash` |

Open a **new Terminal window** and run `codex --version` or `claude --version`, then
`codex` or `claude`. Complete native sign-in with your own ChatGPT/Claude subscription if
asked. Paste the README setup prompt into that agent. No second provider is required.

For an existing CLI, have the setup agent identify the executable and its installation
method first (`command -v codex` / `command -v claude`; respect explicit host overrides).
Update through that same method rather than adding a competing copy:

| Existing installation | Update command |
| --- | --- |
| Codex standalone | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |
| Codex npm | `npm install -g @openai/codex@latest` |
| Codex Homebrew (Mac) | `brew update`, then `brew upgrade --cask codex` |
| Claude native / npm | `claude update` |
| Claude Homebrew stable (Mac) | `brew update`, then `brew upgrade --cask claude-code` |
| Claude Homebrew latest (Mac) | `brew update`, then `brew upgrade --cask claude-code@latest` |

Respect intentional pins and organization policies. For other installers, use their
supported update command. References: [Codex installation](https://learn.chatgpt.com/docs/codex/cli),
[Codex npm/Homebrew updates](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#quickstart-using-goals),
[Claude installation and updates](https://code.claude.com/docs/en/setup).

Claude Code 2.1.288 has a known auth-status regression that may cause extra sign-outs;
[2.1.289 reverted it](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21289).
If the launcher's actual `claude` path reports 2.1.288, update it through its normal
installer or channel to 2.1.289 or newer, keeping intentional pins and existing credentials.
This does not establish the cause of any earlier local sign-out.

The setup agent must check the resolved version **after** updating, then the app's real
sign-in/model discovery. A successful `--version` alone does not mean it is current.
If the command is missing or still old, inspect PATH and any captured launcher path;
native installers normally use `~/.local/bin`. Follow the installer's PATH guidance or
select its stable executable explicitly in host setup. Rebuild the launcher configuration
when its captured path needs to change, and reopen only when active work is safe.
Keep existing credentials and conversations. Never fix this by deleting provider state,
installing with `sudo`, or silently changing to API-key billing.

### Check the machine first

| Computer          | Current support and setup boundary                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Silicon Mac | Verified source installation, native Mac launcher and local Codex/Claude flows. The optional usage reader can be downloaded automatically. The VS Code companion supports this platform.                                                                       |
| Intel Mac         | The launcher has no architecture restriction, but a populated installation has not been certified here. Usage-reader installation is manual; the companion currently refuses this platform.                                                                    |
| Linux             | Ubuntu CI checks the source build, backend and emulated browsers. That does not certify native provider sign-in, desktop integration or a real phone. Install the Node native-build toolchain if needed; there is no Mac launcher or supported companion here. |
| Windows           | Native source setup is not qualified: setup uses POSIX shell/process conventions. Do not promise Windows or WSL desktop/phone/provider integration from Linux CI results.                                                                                      |

Node 24+, Git and a working Codex CLI or Claude Code are the source prerequisites.
LaTeX compilation optionally needs Tectonic or TeX Live with latexmk; detect an existing install
first. For reflowing phone reading, install Pandoc and Poppler if absent (`brew install pandoc poppler` on Mac). The original PDF viewer needs none of these tools. See [LaTeX](LATEX.md).
Transcription additionally needs yt-dlp, FFmpeg and whisper.cpp. Phone connections and
private GitHub backup need their chosen native connection tool and GitHub CLI respectively.
Install optional tools for the features the person wants; a missing optional tool must not
be described as a failed core installation. Browser-test downloads are developer-only.

1. Read AGENTS.md, README.md, STATUS.md and DECISIONS.md.
   Confirm the actual directory and installed **Node 24+ and Git**, then the owner’s chosen
   **Codex CLI or Claude Code**. Neither provider requires the other.
   A Codex or Claude desktop app alone is not proof that its CLI is installed and on the setup PATH.
   Use the [terminal install/update instructions](#install-or-update-your-agent-cli) above
   before model discovery, including when a desktop app is acting as the setup agent.
   Prefer a local folder such as `~/Developer`; avoid Documents/iCloud or other synced folders
   for live databases and worktrees. Do not move an existing installation without preserving
   its records and inspecting its actual paths. Do not copy another owner's
   `data/`, Codex home, credentials or browser profile. No global cache ownership repair,
   OS security change or background service is part of dependency setup.
2. Run `node scripts/setup.mjs --check` for a read-only prerequisite check, then
   `node scripts/setup.mjs` from this clone. It installs the pinned pnpm/lockfile
   dependencies, uses ignored project-local caches and builds the app. It does not start
   agents, create cloud resources, buy anything, publish source or enable a login service.
   On macOS it also compiles a local launcher under ignored `data/launcher/sciencewithagents.app`.
   Source installation still needs an agent/developer environment; this is not a packaged installer.
3. For Codex, verify its installed executable and supported sign-in state using `dock doctor`.
   Check the version of the **actual CLI executable the app will launch** before model discovery.
   The prerequisite check verifies that a CLI runs; it does not establish that it is current.
   Update an outdated installation through its existing supported installation method/channel,
   following [OpenAI's update guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex#quickstart-using-goals).
   Preserve deliberate version pins and active sessions; do not install a second conflicting copy.
   Check the executable/version again, safely reopen the affected app connection and retry model
   discovery. Updating a desktop app or editor extension alone does not verify the CLI version.
   If models still fail to load, retain the actual error and version rather than guessing model IDs
   or repeatedly asking the person to sign in. Check Claude's version too when it is selected.
   Let the owner complete required sign-in using the chosen provider’s supported flow. Preserve original
   provider approvals and advanced tools. Do not store account-level credentials in this repo.
   If they will use managed Claude, also check its native installation and subscription
   sign-in on this computer; follow [managed Claude](MANAGED_CLAUDE.md). Claude is optional
   for Codex-only use. Do not extract sign-in files or switch to paid API usage.
4. Review the build result and any optional-dependency warning. After launch in step 6,
   check the person's actual first-run journey: confirm their provider (ask only if neither the
   request nor saved settings give it), check native sign-in/models, and create or connect
   their first project. Creating a project sends no prompt. Start model
   work only when requested.
   Ordinary installation does not need the developer test suite or browser downloads.
   If source changes were needed, run checks appropriate to those changes; a failed check
   is not acceptance. Record any device/account handoff in private installation notes, not in tracked source.
5. On Mac, run `node scripts/create-launcher.mjs --install` to place the generated app in
   the user's Applications folder, only when that exact destination is absent. Existing
   apps are never overwritten; ask the setup agent to inspect an existing installation
   instead of deleting it. The launcher records this clone and its private data directory, captures stable native
   executable/tool paths for Finder, and checks installation identity before starting.
   Slow or reset startup probes retry within a bounded wait; opening still requires a matching identity.
   Automatic Homebrew discovery keeps an equivalent stable `bin` or `opt` entry even when
   a versioned Cellar directory comes first on PATH; explicit absolute selections stay exact.
   It preserves unrelated listeners and keeps private failure logs. Install optional tools
   before rebuilding its configuration so Finder can find them.
   If the clone moves or a captured executable changes, preserve all data, stop the affected
   installation and rebuild the launcher deliberately. Inspect an existing installed copy
   before replacing it; keep recovery available. A copied clone is not automatically a move.
   Host-only `DOCK_CLAUDE_BIN` and `DOCK_CLOUDFLARED_BIN` can select installed tools when
   discovery needs help. Never copy credentials or edit global PATH as a shortcut.
   Installation enables no login item and starts neither agents nor the phone connector.
   Closing a browser leaves work running; the app's Stop and Quit stops its own server.
   Other platforms keep the source entry; no cross-platform desktop installer is claimed.
6. Start the app only when the person is ready to use it. On Mac, open the installed
   **sciencewithagents** app from Applications. For a source launch use
   `sh scripts/pnpm start` and `sh scripts/pnpm dock open` in this clone. The latter
   opens its private browser handoff; a bare localhost link is not the authenticated entry.
   The handoff connects the default browser only; to use another browser, make it the
   default and open the app again.
   **Welcome and setup** summarizes the saved team; it is not a second questionnaire.
   Continue to **Check this computer → Create first project**. Do not replace this journey
   with package-manager commands. QUARK pacing is optional and off by default.

   **Model choices.** Keep saved or explicitly stated provider/model/team choices; otherwise
   use the recommended defaults. Do not interview the person role by role. If they stated a
   choice that differs from the saved settings, save it once through **Settings → Model
   preferences** (Welcome's optional **Edit team defaults**), then reload and confirm the
   saved values. Do not say a conversational answer is saved until that check passes. If it
   cannot be saved, report the exact problem instead of asking the questions again.
   Phone setup follows PHONE_SETUP.md and CLOUDFLARE_SETUP.md, with a verified
   remote authentication boundary before exposure. Private source backups follow SOURCE_BACKUPS.md.
   Other computer/account connections follow MULTI_COMPUTER_SETUP.md. Share that guide with
   the setup agent on each machine; the person should not need to type its technical steps.

### Desktop Groups setup

For a Groups request, continue from the authenticated app to **Chats → Groups** instead of
requiring a personal first project. Follow [Groups workflow](GROUP_WORKFLOW.md): the creator's
setup agent deploys the shared service to that person's own Cloudflare account, following
[hosting](GROUP_HOSTING.md), then configures their installation. No maintainer-issued beta
code or maintainer service is part of fresh setup. Joining members use an invitation and
the documented service-configuration handoff; they do not each deploy another service.
Keep a short human checklist for native sign-in, Cloudflare sign-in/account selection for
the creator and the invitation exchange; the invitation grants membership. Handle the technical commands
for the person. GitHub is optional for repository sharing, not required for messaging.
Preserve existing service configuration, groups and membership; reconcile a mismatch
explicitly. Provider sign-in belongs to this person, never the maintainer or another member.

Enable requested group agents through [native owner setup](GROUP_NATIVE_OWNER_SETUP.md).
They use the normal host runtime and this person’s existing provider sign-in. Explain the
**Group chat** / **Group manager** distinction and normal native computer access; conversation
separation is not a filesystem sandbox. Do not require Docker, Linux or a duplicate provider
sign-in. A missing or expired native sign-in must remain visible. Phone access, VS Code
sharing and Git are optional and do not block desktop human group messages.

### First project and manager handoff

The project form starts from the saved team defaults. Ask only for missing project details:
name and description, and a new folder or an existing local project. Change the manager or
worker provider mix, spending level or exact models only when the person asks; show actual
available model names then. Use the latest family defaults unless the person picks an exact version. A Codex-only or
Claude-only choice must work without installing/signing into the other provider. Untouched
worker defaults follow enabled providers and the shared preset; saved or explicit choices
are retained. If model-default loading fails, use its retry before creating the project.

The first brief opens as an autosaving notepad. Let the person review it; **Send** starts
work and opens the normal conversation. Do not invent a project assignment merely to
prove login. After an authorized first message, confirm a reply, retained history, and
the ability to reopen the project. Explain **Open notepad** and steering/queued follow-ups.

New managers receive their instructions automatically: durable internal and human work
lists, independent manager and worker choices, current worker defaults, native capabilities,
QUARK usage/leases/caps, small independent reviews and the project's application policy.
There is no separate prompt or global hook the person must install. Outside coding agents
can read [the shipped QUARK skill](../skills/quark/SKILL.md) when asked to inspect usage or
dispatch work. Never paste provider credentials or private client files into a prompt.

## Optional VS Code companion

On a supported Mac with VS Code and the chosen provider extension already working, the setup
agent runs `sh scripts/pnpm --filter agent-dock-mirror package` from the repository root.
Use the resulting VSIX under ignored `data/`; the packaging output reports its exact name.
This packages the private preview locally and does not publish it. In VS Code choose
**Extensions → … → Install from VSIX**, then follow the
[companion's connection and sharing steps](../apps/vscode-mirror/README.md#start-mirroring).
The person selects which conversation to share. Wait for a safe time before any required
editor reload. Existing accounts, native permissions and running conversations stay with
their original provider. Explain the reversible provider-file modification before enabling
sharing; the companion guide includes restoration before uninstalling.

## Network access by feature

These are the services used by this source setup, not an exhaustive provider/CDN allowlist.
On a managed school network, have its administrator handle any needed access rather than
changing network/security controls or collecting another person's credentials.

| When                      | Access needed                                                                                                                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install/build from source | The configured npm registry (normally `registry.npmjs.org`) for pinned pnpm and packages; GitHub for the source and optional CodexBar release, including download redirects.                |
| Run native agents         | The chosen Codex/Claude installation's own sign-in and service endpoints. The app uses native sign-in; it does not offer an offline substitute or move work to a paid API.                  |
| Read allowances           | The installed Codex usage reader's service access; Claude's native reader calls `api.anthropic.com`. A blocked or failed reading remains unknown/stale, not unused allowance.               |
| Transcribe a public video | YouTube and its media hosts; `huggingface.co` and its download redirects for the checked Whisper model on first use. Python/package repositories are needed when installing the downloader. |
| Optional phone access     | The owner's Cloudflare tunnel service and configured private app address. Local desktop use needs no phone connection. Existing private-network pairings are preserved.                     |
| Optional source backup    | GitHub access for the native GitHub CLI and Git transport to the selected private destination.                                                                                              |

Do not disable TLS verification, extract browser cookies or bypass sign-in to fix a blocked
dependency. Report which optional step needs repair and leave the local workspace usable.

## Setup troubleshooting

- A sandbox refusal can appear as npm's generic “root-owned cache” error. In the verified
  incident it was access to a machine-wide cache, not evidence requiring `sudo chown`.
  The wrapper defaults npm's cache to ignored `data/npm-cache`; the workspace config keeps pnpm's
  store under `data/pnpm-store`. Do not weaken filesystem permissions to repair a cache.
- A clone installed with the old global pnpm store may report `ERR_PNPM_UNEXPECTED_STORE`.
  Reinstall dependencies in that clone with the project-local store configuration; do not delete
  projects or edit global configuration. Noninteractive automation may use `CI=true` for
  the normal pnpm reinstall. Preserve the lockfile and do not treat a reinstall as an upgrade.
- Git write access, browser process permissions and Cloudflare MCP execution are distinct
  from source-file write access. A verbal approval cannot change an effective tool profile.
  Record the narrow failure once, leave protected settings alone and continue other slices.
- **Claude works in a terminal but not from the Mac app:** Finder does not necessarily
  inherit the terminal's PATH. Inspect the launcher's private `claudePath` entry and rebuild
  through the supported setup flow with the stable installed executable. Legacy configs
  without this optional field still open Codex; do not copy credentials, pin an obsolete
  versioned Claude binary, change global PATH or restart an active owner app without a
  deliberate handoff. Setup only prepares the launcher; it does not launch a model turn.

## QUARK tools and usage

The normal setup script installs a standalone usage reader when available (pinned,
checksum-verified Apple Silicon download otherwise). Reader failures do not turn a successful
source build into a failed app install. They leave a clear incomplete usage step: readings stay
unknown and QUARK can hold jobs requiring them. Retry `node scripts/setup-usage-collector.mjs`
after correcting that step; do not disable admission or invent a zero reading. Native Claude reads its existing
subscription sign-in. Follow USAGE_COLLECTOR.md; no menu-bar app or copied credentials.

For local transcription, install FFmpeg and whisper.cpp as host dependencies. Keep the
YouTube downloader current in an app-owned virtual environment: a compatible app-local setup uses
`python3 -m venv data/tools/yt-dlp-env` and that environment’s pip to install
`yt-dlp[default]==2026.8.19`. This is a setup-agent operation, not a command the phone user
must run. The app prefers that private tool folder and provides its own installed Node
runtime for JavaScript extraction. Verify a public-video job after setup; the first job
downloads and checks the multilingual Whisper base model. Do not extract browser cookies
or request account credentials to bypass a restricted video. Source tools remain under
ignored data/, outside the distributable repository.

New installations leave QUARK pacing and automatic coordinator checks off, and Apps empty.
Do not enable scheduling or seed example/personal apps during ordinary setup. The owner can
opt in later; LaTeX/PDF reading remains under Help. Preserve existing settings and apps.

When upgrading, inspect old queued work before enabling QUARK through Work queue. Fresh
managers inherit scheduling instructions automatically; preserve existing provider contexts
and use their supported next-turn/context controls, never silently reset them for new tools.
