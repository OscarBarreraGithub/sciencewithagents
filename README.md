# sciencewithagents

Run Codex and Claude project teams from your computer or phone. QUARK coordinates their
queue, shared allowance and computer resources. Personal conversations and worker records
stay local; Groups publishes explicitly shared content to its configured group service.
New installations start with QUARK pacing and automatic checks off, and an empty Apps page.

## Set up

**Shared group?** Use the [Groups setup prompt](#groups-beta).

**Only have the Codex or Claude desktop app?** Install its terminal tool first; you only
need one. Open Terminal on the computer that will run your agents:

<details>
<summary>Install Codex or Claude Code</summary>

**Codex:**

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

**Claude Code:**

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

Open a new Terminal window, run `codex --version` or `claude --version`, then run
`codex` or `claude`. Sign in with your own subscription account if asked and paste
the setup prompt below. Already installed? Use the
[update commands for your installation](docs/CONTRIBUTOR_SETUP.md#install-or-update-your-agent-cli).
These are the official [Codex](https://learn.chatgpt.com/docs/codex/cli) and
[Claude](https://code.claude.com/docs/en/quickstart) macOS/Linux installers.

</details>

For your own projects, paste this into Codex or Claude on the computer that will run your agents:

```text
Set up sciencewithagents from https://github.com/OscarBarreraGithub/sciencewithagents.
Find and preserve any existing installation. Otherwise clone it into a local folder
outside cloud sync. Follow docs/CONTRIBUTOR_SETUP.md and check docs/STATUS.md first.
Use my own Codex or Claude account; I do not need both. Install my chosen provider's
CLI if missing, or update it through its existing method, then verify its version and
available models. A desktop app alone is not enough. Handle the technical setup,
install the Mac Applications launcher when supported, and open the app. Ask which
provider only if I have not said and none is saved. Keep saved or stated model choices,
otherwise use the recommended defaults; do not interview me role by role. Save any
explicit choice once in the app's Model preferences and confirm the saved values. Prepare
my first project with those defaults, asking only for missing project details, without
sending its brief until I am ready. QUARK pacing, phone access, VS Code sharing and
GitHub backup are optional. Ask me only for necessary sign-in and device steps. Do not run
the full developer test suite for ordinary setup. Explain how to reopen the app and
report anything incomplete rather than claiming success.
```

## Groups beta

Each person installs the app on their own computer and uses their own Codex or Claude
account. **The group creator hosts the shared service in their own Cloudflare account.**
Other people join that service by invitation; they do not need to deploy another copy.
There is no maintainer-issued setup code. GitHub is optional for sharing code, not required
for group chat. See [Groups setup](docs/GROUP_WORKFLOW.md).

**Create a group — paste into your setup agent:**

```text
Set up sciencewithagents for Groups from
https://github.com/OscarBarreraGithub/sciencewithagents.
Find and preserve my existing installation, accounts, files and running work.
Follow docs/CONTRIBUTOR_SETUP.md and docs/GROUP_WORKFLOW.md. Use my own Codex or Claude
sign-in. Install the chosen provider CLI if missing, or update its existing installation,
then verify its version and model discovery before continuing.
Follow the owner-hosted deployment instructions in docs/GROUP_HOSTING.md to
deploy the group service to MY Cloudflare account on Workers Free. Do not use the
maintainer's service, require a beta code, buy a domain, or enable paid services.
Handle deployment and private local configuration; leave account sign-in and account
selection to me. Open Chats → Groups, help me create a group and invite another person, and
explain Group chat (everyone’s messages) and Group manager (my agent’s shared work). Use native local agents, without Docker.
Give me a short checklist of the remaining human steps. Verify Group chat messages in both
directions and an Ask in Group manager once the other person joins. Report what remains untested.
```

**Join a group — send this prompt and the invitation privately to the new member:**

```text
Set up sciencewithagents from https://github.com/OscarBarreraGithub/sciencewithagents
to join the group in my invitation. Preserve my installation, accounts and files.
Follow docs/CONTRIBUTOR_SETUP.md and docs/GROUP_WORKFLOW.md. Use my own Codex or Claude
sign-in and native tools. Install the chosen provider CLI if missing, or update its
existing installation, then verify its version and model discovery.
Configure the invitation's group service using the documented
setup-agent process, without deploying a separate service or using the maintainer's
account. Open Chats → Groups → Join group. The invitation grants membership;
no confirmation code or separate approval is needed. Verify Group chat messaging and my Group manager.
Keep phone access and GitHub optional; list only the human steps I still need to do.
```

**Your steps:** sign in to your agent provider; if creating the group, sign in to Cloudflare
and choose your account; send or accept the invitation link. Your
setup agent handles the commands and configuration. GitHub sign-in is needed only for
optional repository sharing or submitting a public issue.

## Phone or laptop access

Use your own Cloudflare Workers Free account and a free `workers.dev` address to reach your
running computer. Your setup agent connects that address to the app's protected phone entry;
you do not need to buy a domain. The phone itself needs no Cloudflare sign-in or VPN app.
Paste this into the setup agent on the computer that runs your projects:

```text
Set up phone and browser-only laptop access for this sciencewithagents installation.
Follow docs/CLOUDFLARE_SETUP.md and docs/PHONE_WORKFLOW.md from the current source.
Use MY Cloudflare account on Workers Free, a stable free workers.dev address, and one
fixed Workers VPC Service through an app-owned named tunnel to the authenticated paired
listener on 127.0.0.1:4331. Preserve existing connections, pairings, projects and running
work. Do not require a purchased domain, paid services or a phone VPN. Handle deployment
and private configuration; never expose the local owner listener. Coordinate any
necessary update or restart with active work. Give me the short human checklist: account
sign-in and selection, free address, phone passkey and matching-number confirmation.
Verify the phone connection and reconnection with me; keep passwords and tunnel tokens out of chat.
```

If your installed prompt still asks for Tailscale or a domain, follow
[Update an installation](docs/UPDATE_APP.md) before copying it again. Existing working
domain connections stay in place. Groups hosting is independent: one creator hosts its
service in their account, and members join by invitation.

[Phone or laptop access](docs/PHONE_WORKFLOW.md) · [Another worker computer](docs/MULTI_COMPUTER_SETUP.md) · [Update an installation](docs/UPDATE_APP.md)

**Access:** agents use your account's native tools and full-access execution by default,
including files, commands and network access. Explicit read-only or restricted choices stay
enforced. Shared and private chats have separate histories; this is not a filesystem sandbox.
See [native access](docs/DECISIONS.md#native-agents-thin-supervision) and
[Groups setup](docs/GROUP_NATIVE_OWNER_SETUP.md).

**Requirements:** a coding agent, Node 24+, Git, and a working Codex CLI or Claude Code
account. Your setup agent checks these. Apple Silicon macOS is the verified desktop target;
see [other platforms](docs/CONTRIBUTOR_SETUP.md#check-the-machine-first).

**Status:** beta. Tested workflows, device limitations and unfinished features are listed in
[current status](docs/STATUS.md). This is source installation, not a one-click installer.
The computer must stay awake and running the app for work and phone access.

## Beta demo

These are temporary beta screenshots with some empty or incomplete data. The interface
will change; these images will be replaced for the final presentation. See
[current status](docs/STATUS.md) for known gaps.

### Home

Your starting point on the phone: see the selected computer and remaining Codex and Claude
allowance, open your chats or QUARK's work queue, and find items needing your attention
alongside your own to-do list. Help includes a LaTeX/PDF reader for reports on your phone.

<img src="docs/beta-test-demo/00-home.png" alt="Phone Home screen with remaining AI allowance, Chats, Apps, QUARK, attention items and a to-do list" width="360">

### Projects that wait their turn

Set a project to **Back burner** for work you want done when other work is out of the way.
With QUARK scheduling enabled, it waits while higher-priority jobs are running or ready to
run. Optional usage caps pause work without deleting files or progress.

<img src="docs/beta-test-demo/01-project-priority.png" alt="Project priority choices, Back burner mode and optional AI allowance caps" width="360">

### VS Code chats alongside your managers

Bring shared Codex and Claude Code conversations from VS Code into the same app as your
project managers, including on your phone. Shared editor chats keep their identity and
stay distinguishable from managers and background helpers.

<img src="docs/beta-test-demo/02-shared-vscode-chats.png" alt="Chat list with VS Code sharing status and separate Managers and Shared filters" width="360">

### Attention items, current jobs and computer usage

Items needing your input come first, alongside your general to-do list. Below them, see
active projects' estimated AI allowance use per hour and a snapshot of CPU, memory, swap
and free disk space. The percentage is an estimate of each provider allowance window,
not an exact token bill. This example has no active project jobs to populate the list.

<img src="docs/beta-test-demo/03-attention-and-usage.png" alt="Attention items and to-do list above hourly allowance use and a computer resource snapshot" width="360">

### A resource assistant for your computer

Talk to a dedicated agent about slowdowns and let it inspect current conditions and past
readings. I use it to investigate issues such as runaway Chrome processes instead of
trying to diagnose everything from a single CPU percentage.

The lightweight watcher monitors continuously while the computer is awake and the app
is running. The AI assistant wakes for your questions or optional automatic checks;
it does not spend tokens continuously. Sustained resource changes can wake a check that
connects busy processes and scripts to QUARK’s projects. The charts show how conditions
change over time.

<img src="docs/beta-test-demo/04-computer-health.png" alt="Resource assistant entry point and CPU trend charts" width="360">

### Working from a phone, with room to write

Continue the same conversation from your phone: read replies, expand grouped tool activity,
send messages, steer or queue follow-ups where supported, and stop a reply. For longer
prompts, I often use **Open notepad**: a full-page editor with autosaved local versions.
Minimize it back into chat without sending or losing the draft.

<img src="docs/beta-test-demo/05-phone-chat.png" alt="Phone conversation with collapsed tool activity, Stop reply, message input and Open notepad" width="360">

### Manage multiple computers

Use the computer selector to switch between connected sciencewithagents installations
from the same app, including on your phone. Each computer keeps its own projects,
conversations and Codex or Claude sign-ins. A selected computer must be awake, reachable
and running the app; switching views does not move running jobs between computers.

<img src="docs/beta-test-demo/06-connected-computers.png" alt="This computer selector with online status beneath the sciencewithagents heading" width="270">

[Features](docs/FEATURES.md) · [Setup details](docs/CONTRIBUTOR_SETUP.md) ·
[Documentation](docs/README.md) · [MIT licence](LICENSE)
