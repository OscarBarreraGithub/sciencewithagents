# Connect your phone

Open **Settings → Phone access** on the computer that holds your workspace. If it already
has a connection, its existing settings and paired devices stay in place.

## Without a domain

Choose **Private connection · no domain needed**. Install/open Tailscale on your computer
and phone, and connect both to the same account or private network. Tailscale offers a free
personal plan; workplace eligibility and plans may differ. Complete its own sign-in and
device permissions directly with Tailscale.

Select **Check this computer**. If HTTPS certificates need enabling, follow the link to
Tailscale's settings, then check again. The device's HTTPS hostname appears in public
certificate logs. The connection itself remains private to the Tailscale network and
sciencewithagents still requires phone pairing.

The app shows the exact private address before saving it. Choose **Use this private address**,
then **Turn on phone access**. Once connected, **Create a new code** starts the usual passkey
pairing and computer confirmation. Keep Tailscale connected on both devices. Your computer
must remain awake, online and running sciencewithagents.

If another app already uses Tailscale's HTTPS address, sciencewithagents leaves it alone and
explains the conflict. A setup agent can help choose a separate arrangement. Failed sign-in,
HTTPS and connection checks can be retried here; they never replace an existing phone setup.

## With a domain you control

Choose **Use a domain I already have**, then ask your setup agent to follow
[Cloudflare setup](CLOUDFLARE_SETUP.md). You complete account sign-in and consent; the agent
handles the connection. No new domain purchase is assumed. This route does not require
Tailscale on the phone. Return to Phone access after setup for pairing.

## Recovery and boundaries

**Retry connection** repairs a failed phone listener without restarting the desktop.
If its owned connector exits, the app retries three times with increasing waits before
offering **Reconnect phone access**. A running connector handles ordinary network recovery.
Retries keep approved devices; they do not replay messages. Turning phone access off closes
the app's connector and active connections while retaining paired devices for direct reconnection. App exit
stops the owned connector; reopening restores saved enabled intent. The private route uses
foreground Tailscale Serve, not public Funnel or a permanent background Serve configuration.
Existing routes are never reset. Changing the node identity or private hostname requires
deliberate setup repair, not automatic reassignment of phone trust.

The private route has API, persistence, owned-process and responsive browser checks. It has
not yet been certified through a physical phone and live Serve acceptance run. See
[phone acceptance](PHONE_ACCEPTANCE.md) for device checks and
[phone workflow](PHONE_WORKFLOW.md) for pairing and Home Screen behavior.

Provider references: [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve),
[Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve),
[plans](https://tailscale.com/pricing).
