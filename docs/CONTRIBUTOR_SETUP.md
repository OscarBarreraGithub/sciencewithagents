# Agent-led setup from a clone

For the person: clone/open this repository with your coding agent and ask it to follow this
guide. The agent does the technical steps below. Complete your own account sign-in only
when the provider asks; never send passwords or codes through chat. GitHub backups are optional; do not require GitHub or Cloudflare account login on the phone.

Your choices are private GitHub backup, optional phone access, and the phone connection
(no-domain Tailscale or Cloudflare with your own domain). All are optional for local use.
Your agent handles the technical work; you complete your account sign-ins and, if pairing,
save the phone passkey and confirm its matching number on the computer.

The [README setup prompt](../README.md#set-up) is the canonical copyable request.

## Setup agent

The current interface connects projects, conversations, tasks, reviews, shared editor chats,
usage/QUARK, advanced controls and configured phone/recovery settings. Use the normal app for
those journeys. Welcome/setup now checks native sign-in/models and provides native Codex device-code
sign-in. On Mac, Welcome also opens Claude’s native Terminal/browser sign-in after confirming
it is signed out; account details stay with Claude. Initial source setup uses this guide.
Phone access offers optional Tailscale setup inside the app; see [PHONE_SETUP.md](PHONE_SETUP.md),
[STATUS.md](STATUS.md).
The retained `/?workspace=classic` interface is an optional maintenance surface. Private
runtime and browser-test output remain under ignored `data/`; never copy them into another
person's installation. Repository history does not authorize access to another person's accounts or computer.

### Check the machine first

| Computer          | Current support and setup boundary                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Silicon Mac | Verified source installation, native Mac launcher and local Codex/Claude flows. The optional usage reader can be downloaded automatically. The VS Code companion supports this platform.                                                                       |
| Intel Mac         | The launcher has no architecture restriction, but a populated installation has not been certified here. Usage-reader installation is manual; the companion currently refuses this platform.                                                                    |
| Linux             | Ubuntu CI checks the source build, backend and emulated browsers. That does not certify native provider sign-in, desktop integration or a real phone. Install the Node native-build toolchain if needed; there is no Mac launcher or supported companion here. |
| Windows           | Native source setup is not qualified: setup uses POSIX shell/process conventions. Do not promise Windows or WSL desktop/phone/provider integration from Linux CI results.                                                                                      |

Node 24+, Git and a working Codex CLI or Claude Code are the source prerequisites.
Transcription additionally needs yt-dlp, FFmpeg and whisper.cpp. Phone connections and
private GitHub backup need their chosen native connection tool and GitHub CLI respectively.
Install optional tools for the features the person wants; a missing optional tool must not
be described as a failed core installation. Browser-test downloads are developer-only.

1. Read AGENTS.md, README.md, current STATUS.md and the latest DECISIONS.md sections.
   Confirm the actual directory and installed **Node 24+ and Git**, then the owner’s chosen
   **Codex CLI or Claude Code**. Neither provider requires the other.
   The Codex desktop app alone is not proof that its CLI is installed and on the setup PATH.
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
   Let the owner complete required sign-in using the chosen provider’s supported flow. Preserve original
   provider approvals and advanced tools. Do not store account-level credentials in this repo.
   If they will use managed Claude, also check its native installation and subscription
   sign-in on this computer; follow [managed Claude](MANAGED_CLAUDE.md). Claude is optional
   for Codex-only use. Do not extract sign-in files or switch to paid API usage.
4. Review the build result and any optional-dependency warning. After launch in step 6,
   check the person's actual first-run journey: choose their provider, check native sign-in/models,
   and create or connect their first project. Creating a project sends no prompt. Start model
   work only when requested.
   Ordinary installation does not need the developer test suite or browser downloads.
   If source changes were needed, run checks appropriate to those changes; a failed check
   is not acceptance. Record any device/account handoff in private installation notes, not in tracked source.
5. On Mac, run `node scripts/create-launcher.mjs --install` to place the generated app in
   the user's Applications folder, only when that exact destination is absent. Existing
   apps are never overwritten; ask the setup agent to inspect an existing installation
   instead of deleting it. The launcher records this clone and its private data directory, captures stable native
   executable/tool paths for Finder, and checks installation identity before starting.
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
   Have them use **Welcome and setup → Choose team defaults**, keep or save their provider
   choice, return to **Check accounts and setup**, then **Check this computer → Create first
   project**. If the saved defaults already match their provider, continue directly to the
   check. Do not replace this journey with package-manager commands.
   Phone setup follows PHONE_SETUP.md (optional Tailscale) or CLOUDFLARE_SETUP.md, with a verified
   remote authentication boundary before exposure. Private source backups follow SOURCE_BACKUPS.md.
   Other computer/account connections follow MULTI_COMPUTER_SETUP.md. Share that guide with
   the setup agent on each machine; the person should not need to type its technical steps.

### First project and manager handoff

Ask for the project name and description, a new folder or an existing local project, and
the manager's provider/model. Its worker provider mix and spending level are separate,
with defaults and optional exact model overrides. Show actual available model names.
Use the latest family defaults unless the person picks an exact version. A Codex-only or
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
| Optional phone access     | The selected Cloudflare or Tailscale connection's service endpoints and the configured private app address. Local desktop use needs neither connection.                                     |
| Optional source backup    | GitHub access for the native GitHub CLI and Git transport to the selected private destination.                                                                                              |

Do not disable TLS verification, extract browser cookies or bypass sign-in to fix a blocked
dependency. Report which optional step needs repair and leave the local workspace usable.

## Setup troubleshooting

- A sandbox refusal can appear as npm's generic “root-owned cache” error. In the verified
  incident it was access to a machine-wide cache, not evidence requiring `sudo chown`.
  The wrapper now defaults npm's cache to ignored `data/npm-cache`; the workspace config keeps pnpm's
  store under `data/pnpm-store`. Do not weaken filesystem permissions to repair a cache.
- A clone installed with the old global pnpm store may report `ERR_PNPM_UNEXPECTED_STORE`.
  Reinstall dependencies in that clone with the new store configuration; do not delete
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

The normal setup script now installs a standalone usage reader when available (pinned,
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

When upgrading, inspect old queued work before enabling QUARK through Work queue. Fresh
managers inherit scheduling instructions automatically; preserve existing provider contexts
and use their supported next-turn/context controls, never silently reset them for new tools.
