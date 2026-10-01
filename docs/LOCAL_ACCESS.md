# Open and reconnect your local workspace

Open **sciencewithagents** from Applications. The installed app connects your browser to
this installation through a private, one-use handoff. You do not need another account or
a provider password. The private browser address still reaches only this computer.

An older tab at the original local address reconnects automatically if this browser already
has access. It retains the intended screen, including editor links. When access expires,
**Open desktop app** opens the normal handoff; returning to the old tab retries automatically.
**Check connection** remains available if the browser does not report that return. Each old
tab retains its own unsent editor draft: another tab cannot read its per-tab storage.
Shared drafts and pending request IDs are retained;
reconnecting does not send them. Conflicting older versions remain readable and downloadable
under **Settings → Recovery copies → Retained browser drafts**. Original storage is not
deleted. Large transfers or unavailable browser storage keep a recovery/retry route.

## Share an editor conversation

With the current companion, choose **Share a Codex conversation** or **Share a Claude Code
conversation** from VS Code’s sciencewithagents menu. The extension connects directly to
the running local app. There is no separate editor authentication, code or credential.
Existing provider accounts and phone pairing are unchanged.

The editor producer remains native loopback-only and rejects browser-origin connections;
it is never registered on the public phone listener. This trusts local native programs on
the computer, rather than identifying an individual extension or OS account. Consumer
browser/phone routes retain their existing authentication. No additional local trust
framework replaces the removed editor flow.

## Connections and limits

Welcome automatically checks existing native sign-ins and model availability when its saved
check is missing or older than five minutes. This is metadata only: it does not send a prompt,
start login or change provider choices. A fresh check is reused; **Check this computer** retries.
Model discovery errors no longer imply that an already signed-in account needs another login.

The remaining account/device steps have separate purposes:

- Codex or Claude owns its initial sign-in; an existing native session is reused.
- Phone pairing admits that browser once. Returning access uses the approved browser credential without an app lock;
  there is no separate phone GitHub or Cloudflare login in paired mode.
- Private GitHub source backups are optional and reuse the existing GitHub CLI sign-in.
- A separate computer needs its own authorized connection and provider accounts. This remains
  a setup-agent/device step, not an extra registration for every conversation.

The phone’s existing pairing/passkey boundary is separate and remains unchanged. Configured
other-computer gateways use their own credential and typed route allowlist; they cannot
create local browser/editor credentials or change the destination’s phone access. Initial
other-computer provisioning still needs its setup-agent flow and real-device verification.

Local access protects the loopback entry using private files owned by the signed-in OS
account. It is not isolation from a malicious process already running as that same account
or as an administrator. A browser session is reusable for up to 30 days; cleared browser
storage needs another app opening. No provider credential is copied for these connections.

For source development, start the server and run `sh scripts/pnpm dock open` in another
terminal. The advanced `dock attach` command authenticates to its original managed session.
Installation files stay under ignored `data/`; no reusable credential is put in an address,
browser history, web settings or source repository. Demo mode is deliberately isolated and
does not enable this boundary against an owner’s data.

See [verification](VERIFICATION.md) for tested behavior and the remaining physical-device
limits.
