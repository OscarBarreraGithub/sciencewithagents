# Agent-led setup from a clone

For the person: clone/open this repository with your coding agent and ask it to follow this
guide. The agent does the technical steps below. Complete your own account sign-in only
when the provider asks; never send passwords or codes through chat. Recommend GitHub signup
when offered, but do not require GitHub or Cloudflare account login on the phone.

## Setup agent

The current interface connects projects, conversations, tasks, reviews, shared editor chats,
usage/QUARK, advanced controls and configured phone/recovery settings. Use the normal app for
those journeys. Welcome/setup now checks native sign-in/models and provides native Codex device-code
sign-in. On Mac, Welcome also opens Claude’s native Terminal/browser sign-in after confirming
it is signed out; account details stay with Claude. Initial source setup uses this guide.
Phone access offers optional Tailscale setup inside the app; see [PHONE_SETUP.md](PHONE_SETUP.md),
[WORKFLOW_BUILD.md](WORKFLOW_BUILD.md) and [STATUS.md](STATUS.md).
The retained `/?workspace=classic` interface is an optional maintenance surface. Private
runtime and browser-test output remain under ignored `data/`; never copy them into another
person's installation. This installation's personal operational history is evidence about
this computer, not authority to reuse its credentials or standing approvals for a new owner.

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
   is not acceptance. Record any device/account handoff for this installation separately
   from this repository's owner-specific OWNER_CHECK_IN.md.
5. On Mac, run `node scripts/create-launcher.mjs --install` to place the generated app in
   the user's Applications folder, only when that exact destination is absent. Existing
   apps are never overwritten; ask the setup agent to inspect an existing installation
   instead of deleting it. The launcher records this clone, data directory, Node/Codex
   stable executable entries, optional Claude/phone connector entries, known-tool directories and
   configured loopback port. Claude is
   discovered from the setup agent's PATH; host-only `--claude /absolute/path/to/claude`
   or `DOCK_CLAUDE_BIN` can select it explicitly. Missing Claude does not prevent
   Codex launch, and missing Codex does not prevent Claude use; an invalid explicit selection fails setup without replacing configuration.
   Rebuild after moving/changing these locations or adding tools to an older launcher.
   A moved clone can rebuild its generated launcher when the old folder is absent, its
   marker/configuration agree, the data directory moved with it (or remains at its original
   external location), and the old app/server are stopped. The previous configuration is
   retained privately under `data/launcher/before-move-*.json`. A copied clone whose source
   still exists is not treated as a move. This repairs launcher paths only: inspect project,
   worktree and native-session paths separately before using a relocated populated install.
   An existing installed app is still preserved; the setup agent must inspect and replace
   its exact stale copy deliberately, keeping a recovery copy rather than deleting it.
   Node, Codex and Claude retain their stable installed entries, not version-specific symlink
   targets. Automatic Node selection only prefers an alias resolving to the running Node;
   a runtime installed without a stable alias still needs an explicit stable selection or
   a rebuild after replacement. Finder launches include captured tool directories plus the
   standard local/Homebrew directories, so `gh`, the phone connector and transcription tools
   can be found. A host-only `--cloudflared /absolute/path` or `DOCK_CLOUDFLARED_BIN` preserves
   an explicitly selected phone helper. No global shell configuration is changed.
   It checks for the correct installation, preserves an unrelated listener and keeps private
   failure logs. No login item is enabled. Double-click launch and explicit Quit own only
   this app's started server; closing a browser leaves agents running. Installation does
   not start the app or phone connector. On other platforms retain the existing source
   entry; a packaged cross-platform launcher is not claimed.
6. Start the app only when the person is ready to use it. Open the local address for them.
   Have them use **Welcome and setup → Choose team defaults**, keep or save their provider
   choice, return to **Check accounts and setup**, then **Check this computer → Create first
   project**. If the saved defaults already match their provider, continue directly to the
   check. Do not replace this journey with package-manager commands.
   Phone setup follows PHONE_SETUP.md (optional Tailscale) or CLOUDFLARE_SETUP.md, with a verified
   remote authentication boundary before exposure. Private source backups follow SOURCE_BACKUPS.md.
   Other computer/account connections follow MULTI_COMPUTER_SETUP.md. Share that guide with
   the setup agent on each machine; the person should not need to type its technical steps.

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

## Recovery notes / future wiki material

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
YouTube downloader current in an app-owned virtual environment: the verified Mac uses
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
