# sciencewithagents

Run Codex and Claude project teams from your computer or phone. QUARK coordinates their
queue, shared allowance and computer resources. Personal conversations and worker records
stay local; Groups publishes explicitly shared content to its configured group service.

## Beta demo

These are temporary beta screenshots with some empty or incomplete data. The interface
will change; these images will be replaced for the final presentation. See
[current status](docs/STATUS.md) for known gaps.

### Home

Your starting point on the phone: see the selected computer and remaining Codex and Claude
allowance, open your chats or QUARK's work queue, and find items needing your attention
alongside your own to-do list. Apps includes a LaTeX/PDF reader for reports on your phone.

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

## Set up

Paste this into Codex or Claude on the computer you want to use:

```text
Set up sciencewithagents from https://github.com/OscarBarreraGithub/sciencewithagents.
Find and preserve any existing installation. Otherwise clone it into a local folder
outside cloud sync. Follow docs/CONTRIBUTOR_SETUP.md and check docs/STATUS.md first.
Use my own Codex or Claude account; I do not need both. Handle the technical setup,
install the Mac Applications launcher when supported, and open the app. Help me
choose my manager and worker defaults, then prepare my first project without sending
its brief until I am ready. Keep phone access, VS Code sharing and GitHub backup
optional. Ask me only for necessary sign-in, device and preference steps. Do not run
the full developer test suite for ordinary setup. Explain how to reopen the app and
report anything incomplete rather than claiming success.
```

**Access:** ordinary project managers and workers use the selected provider's native tools
and full-access execution by default. They can run commands and access files/network as your
user; the project folder is an intended scope, not a filesystem or network sandbox. Explicit
read-only or restricted choices remain enforced. Groups native agents use a separate,
owner-authorized Linux environment with its own sign-in and tool tradeoffs; it does not
confine ordinary project agents. Read [native access](docs/DECISIONS.md#native-agents-thin-supervision)
and [Groups setup](docs/GROUP_NATIVE_OWNER_SETUP.md) before choosing those workflows.

**Requirements:** a coding agent, Node 24+, Git, and a working Codex CLI or Claude Code
account. Your setup agent checks these. Apple Silicon macOS is the verified desktop target;
see [other platforms](docs/CONTRIBUTOR_SETUP.md#check-the-machine-first).

**Status:** beta. Tested workflows, device limitations and unfinished features are listed in
[current status](docs/STATUS.md). This is source installation, not a one-click installer.
The computer must stay awake and running the app for work and phone access.

[Features](docs/FEATURES.md) · [Setup details](docs/CONTRIBUTOR_SETUP.md) ·
[Documentation](docs/README.md) · [MIT licence](LICENSE)
