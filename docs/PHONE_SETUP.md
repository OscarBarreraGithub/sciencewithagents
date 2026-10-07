# Connect your phone through your Cloudflare account

Open **Settings → Phone access** on the computer that holds your workspace. Copy its
**Cloudflare phone setup prompt** into Codex or Claude on that computer. The agent handles
the free phone address, tunnel, account checks, private app configuration and verification using
[the complete Cloudflare runbook](CLOUDFLARE_SETUP.md).

The tunnel and phone address belong to **your own Cloudflare account**. Each person who
wants to reach their computer sets up that computer's connection in their own account.
GitHub is not required for phone access. The phone itself uses app pairing, without a
separate Cloudflare sign-in. New setup uses Workers Free and a stable free `workers.dev`
address; you do not need to own or buy a domain. Groups hosting remains independent: the
creator hosts its shared service, and members join by invitation.

If your installed prompt still suggests Tailscale or requires a domain, have your setup
agent follow [Update an installation](UPDATE_APP.md) safely before copying the prompt again.

## Your to-do list

1. Create or sign in to your own Cloudflare account when your setup agent opens its native
   sign-in page. Complete account verification yourself; keep credentials out of chat.
2. Select your Cloudflare account and approve the free `workers.dev` phone address. Your
   agent verifies Workers Free and handles deployment. No domain or nameserver step is needed.
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
