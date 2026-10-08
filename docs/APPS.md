# Apps

**Apps** starts empty on a new computer. It shows registered web apps and restores the
**LaTeX** tile when that computer has recent documents. Updates preserve existing apps
and document history. The [LaTeX/PDF reader](LATEX.md) is also available through
**? → LaTeX / PDF reader** and saved document links.

## Project apps

A manager runs its app natively, for example a development server in its own terminal,
then registers it with the `dock_app` coordination tool:

| Field                    | Meaning                                                                         |
| ------------------------ | ------------------------------------------------------------------------------- |
| `name`                   | Short title shown on the tile; unique within the project                        |
| `port`                   | Loopback port the app listens on (1024–65535), not sciencewithagents' own ports |
| `path`                   | Optional page, such as `/` (default) or `/dashboard?view=today`                 |
| `description`            | Optional one-line summary                                                       |
| `remoteUrl`              | Optional HTTPS address the owner already set up for other devices               |
| `id`, `expectedRevision` | Omit to register; supply both to update or `action: "remove"` (host `apps`)     |

Registration only records where to open the app. It does not start, stop, proxy, host or
publish anything. Tool retries reuse their receipt, an identical repeat registration returns
the existing app, and a different app with the same name is refused with that app's ID.
Changes need the current revision and are recorded as `app.*` events. A project can register
up to 24 apps. Managers can change only their own project's apps.

Older Codex conversations can retain a tool catalog without `dock_app`. Their refreshed
host instructions provide `node apps/server/dist/cli.js quark app /absolute/path/request.json`
with the installation's data directory. The manager saves the same app fields, its
`managerId` and one UUID `key` in a JSON file inside its project folder. This route requires
that manager's active admitted turn and write permission, and keeps the same revision and
retry rules. Reuse the file and key after a lost response; a new conversation is unnecessary.

Each tile shows the app's state on its computer:

- **Running:** the port accepts connections on `127.0.0.1` or `::1`.
- **Stopped:** nothing is listening. Ask the project's manager to start it.
- **Not responding:** the connection timed out; the app may be starting or busy.
- **Status unavailable:** the selected computer could not be read. Nothing was changed.

Checks are bounded loopback connection attempts, reused for a few seconds. They send no
request to the app, so opening Apps does not trigger an app's own work.

**Open app** appears only in a browser on the app's computer and opens
`http://localhost:<port><path>` in a new tab. On a phone, or with another computer selected,
the page explains where the app runs instead. **Remove from Apps** removes the tile only; the
app, its files and any running process are unchanged.

Phone and other-computer connections relay only this app's own allowlisted routes. Serving
project app pages through that authenticated address would give those pages your
sciencewithagents session, so it is not offered. To use an app from a phone, give its manager
an HTTPS address you have already set up for it as `remoteUrl`; the tile then links to it.

## Publishing accounts

**Set up publishing accounts** has copyable prompts for GitHub CLI and Wrangler sign-in. Only
apps that use GitHub or Cloudflare need them. When Apps or **Help and setup** opens, the
selected computer runs a read-only check: `gh api user` through GitHub CLI's own sign-in and
`wrangler whoami --json`. A step is marked done only when that request succeeds. A certificate,
token or configuration file alone never counts, and the check never signs in, deploys or reads
credentials. Wrangler may renew its own saved sign-in, as any Wrangler command can.

Completed steps collapse behind **Show setup prompt**. When both are done, the Apps shortcut
becomes a one-line confirmation; the full guide stays in **Help and setup**. Other results say
what is missing: the tool is not installed, it is installed but signed out, or the service could
not be reached. Wrangler must be installed where the app can run it, even if you signed in with
`npx` before. Results are saved on that computer. Opening a guide reuses a result for 10 minutes;
**Check again** reruns after 15 seconds. Each check has a time limit. Demo installations never
check. **Hide setup shortcut** remains a display preference for this browser and computer.
