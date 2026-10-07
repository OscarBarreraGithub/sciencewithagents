# Connect your phone through your Cloudflare account

Open **Settings → Phone access** on the computer that holds your workspace. Copy its
**Cloudflare phone setup prompt** into Codex or Claude on that computer. The agent handles
the tunnel, account checks, private app configuration and verification using
[the complete Cloudflare runbook](CLOUDFLARE_SETUP.md).

The tunnel and phone address belong to **your own Cloudflare account**. Each person who
wants to reach their computer sets up that computer's connection in their own account.
GitHub is not required for phone access. The phone itself uses app pairing, without a
separate Cloudflare sign-in.

## Your to-do list

1. Create or sign in to your own Cloudflare account when your setup agent opens its native
   sign-in page. Complete account verification yourself; keep credentials out of chat.
2. Choose a domain you control and approve the phone address. Your agent checks domain/DNS
   readiness and guides any required registrar or nameserver action. A new domain may cost
   money; the agent must explain the choice before a purchase or nameserver change.
3. When the agent has finished, return to **Phone access → Check phone setup**. Choose
   **Turn on phone access**, then **Create a new code**. Scan it with your phone, save its
   passkey and confirm the matching number on this computer. Pair before adding a Home
   Screen shortcut, and verify that the shortcut opens the same workspace.

Keep the computer awake, online and running sciencewithagents. The setup agent should give
you the finished HTTPS address, completed checks and any remaining human step. An unperformed
physical-phone check stays unverified. See [phone acceptance](PHONE_ACCEPTANCE.md).

## Recovery and existing installations

Existing connections and approved devices stay in place. The new setup screen does not
replace an installed transport, tunnel, hostname or pairing. Ask your agent to inspect a
working installation before making any change.

**Retry connection** repairs a failed phone listener without restarting the desktop.
If the app-owned connector exits, it retries three times with increasing waits before
offering **Reconnect phone access**. A running connector handles ordinary network recovery.
Retries retain approved devices and never replay messages. Turning access off closes its
connector and active connections while keeping devices for later reconnection. Reopening
the app restores saved enabled intent. Config-file changes require a safe app relaunch;
the setup agent coordinates this around active work.

Browser storage loss or a changed trusted origin can require pairing again. Keep a working
browser until a new shortcut is verified. See [phone workflow](PHONE_WORKFLOW.md) for the
pairing, storage and Home Screen boundaries.
