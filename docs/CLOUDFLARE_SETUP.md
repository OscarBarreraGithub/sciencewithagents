# Cloudflare phone setup

Setup-agent runbook for an optional domain connection. Local desktop use needs no Cloudflare
account. The no-domain alternative is [Tailscale](PHONE_SETUP.md). Use the current person's
account and an existing authorized hostname; do not purchase a domain or change unrelated services.

The person completes native account sign-in and phone verification. The agent handles technical
setup and reports any remaining device step. No account tokens, passwords, pairing codes or
private receipts belong in chat, Git or screenshots. Read current official Cloudflare instructions
before changing its API/CLI configuration; this guide specifies the app boundary, not a frozen API.

## Required boundary

Cloudflare supplies HTTPS and tunnel routing. The app's **paired** entry authenticates phones;
there is no separate phone-side Cloudflare/GitHub login. Static assets and bounded pairing
endpoints may be public; private APIs, images, event streams and terminal upgrades require an
approved browser credential. Pairing needs passkey creation and exact computer confirmation.
There is no recurring app lock. Never expose the local browser/development listener on port 4330.

## New installation

1. Follow [Contributor setup](CONTRIBUTOR_SETUP.md), then inspect this installation's phone
   configuration and existing accounts/routes. Reuse working sign-in through the supported
   native flow. Do not assume another installation's device state or historical approvals.
2. Select an unused, authorized HTTPS hostname. Create only its named tunnel, exact DNS route
   and scoped runtime credential. A new paired installation does not need an Access application
   that asks the phone to log in. Keep account-level setup credentials outside the app.
3. Write host-only `data/phone-access.json` with the selected canonical HTTPS `origin`,
   `authentication: "paired"` and `port: 4331`. Missing authentication preserves legacy Access
   mode; it is not the new-install default to copy. Preserve an existing configuration deliberately.
4. Route that exact hostname to `http://127.0.0.1:4331`, preserving the Host header, with a
   catch-all `http_status:404`. Both local listeners remain loopback-only. Do not add a zone-wide
   route or expose other local services.
5. Store only the scoped tunnel runtime token in `data/cloudflare-tunnel.token`, a regular
   private file with mode 0600. Use the app-owned connector; do not install a second daemon.
   `DOCK_CLOUDFLARED_BIN` can select the host's installed executable if discovery needs help.
6. Before exposure, verify the paired entry denies unauthenticated private HTTP and socket
   requests using the intended Host. After starting the scoped connector, verify those denials
   again at the real HTTPS address. Pairing must initially be closed. Connector-ready alone
   proves neither authentication nor a usable phone journey.
7. On the computer open **Phone access → Create a new code**. The person scans it, names the
   phone, saves a passkey and confirms the matching number on the computer within 15 minutes.
   Follow [Phone acceptance](PHONE_ACCEPTANCE.md) for Home Screen, returning access and cellular
   checks. Do not remove an already working enrollment merely to repeat a setup test.

## Existing Access-mode installations

Access mode is retained for compatibility, not prescribed for new setup. Migration changes a
security boundary: make a consistent private backup, record exact trust/routes/policies and
stop only this installation's connector before changing them. Verify the paired entry locally
first. Preserve unrelated organization MFA, applications, domains and services.

Any removal of an old Access gate must be scoped to this one hostname and paired with the
verified app-owned boundary. Read the current Cloudflare policy semantics, preserve rollback
configuration, and verify the full HTTPS path before reopening. Trust/origin changes may revoke
old browser approval; tell the person before migration. If a check fails, stop the connector
and restore the exact prior route/trust/policy. Never open an unauthenticated fallback.

## Failure and recovery

- A tool permission failure is not an OAuth failure. Inspect the actual capability/error;
  do not ask for another token or weaken protections as a repair.
- The app retries an exited owned connector with bounded backoff. Use its explicit reconnect
  action after repeated failure. Preserve approved devices and enabled intent.
- Turn off blocks remote access; turn on restores approved browsers. Remove device revokes
  it and closes private streams. Changing the trusted origin or losing browser storage may
  require pairing again. Neither a synced passkey nor knowledge of the URL enrolls a browser.
- Pair before adding a Home Screen icon. Installation and browser storage can differ; keep
  the working browser until the icon is verified. No perpetual-storage or end-to-end-encryption
  claim follows from using Cloudflare.
- Ordinary setup checks its actual connection and failure paths. A source change to authentication
  requires focused HTTP/socket/pairing regression checks, not replay of an old passing test count.

References: [Tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/),
[policy actions](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/),
[app phone contract](PHONE_WORKFLOW.md), [operations](OPERATIONS.md).
