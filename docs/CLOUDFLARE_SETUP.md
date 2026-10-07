# Cloudflare phone setup

Complete external-agent runbook for phone access through **the current person's own Cloudflare
account**. Local desktop use needs no Cloudflare account. Each person's phone tunnel belongs to
their account and routes to their computer; never select the maintainer's account or a shared
default service. Groups hosting is a separate setup in [Groups workflow](GROUP_WORKFLOW.md).

The agent performs the technical steps and walks the person through necessary sign-in, domain
choices and phone verification. Give them the short list in [Phone setup](PHONE_SETUP.md).
Keep passwords, tokens and private device evidence out of chat, Git and screenshots. Read the
current official [dashboard](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)
or [API instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
before setup; this guide defines the app boundary and repeatable handoff.

## Required boundary

Cloudflare supplies HTTPS and tunnel routing. The app's **paired** entry authenticates phones;
there is no separate phone-side Cloudflare/GitHub login. Static assets and bounded pairing
endpoints may be public; private APIs, images, event streams and terminal upgrades require an
approved browser credential. Pairing needs passkey creation and exact computer confirmation.
There is no recurring app lock. Never expose the local browser/development listener on port 4330.

## 1. Inspect the installation and choose the account

Follow [Contributor setup](CONTRIBUTOR_SETUP.md) for an absent installation. For an existing
one, identify its clone, launcher, local owner port and actual private data directory
(`DOCK_DATA_DIR` can override `data/`). Inspect existing phone settings and enabled state
privately. Preserve working transports, paired devices, unrelated routes and active work;
this runbook does not authorize migrating an existing connection.

Open the Cloudflare dashboard's native sign-in only if needed. The person creates an account,
completes email/MFA verification and selects **their** account. Confirm the selected account and
zone before creating resources. Wrangler sign-in alone does not create a tunnel, route or phone
credential. GitHub sign-in is not required for this workflow.

## 2. Choose and verify the domain

Ask for a domain the person controls, then select an unused single-level hostname such as
`phone.example.com`. The domain must be active in their Cloudflare account for the normal
published-hostname route. If necessary, guide website addition, DNS review and the registrar's
nameserver/ownership step. Preserve existing DNS, mail and websites. Explain any purchase or
nameserver change and wait for the person's decision before performing it. A domain is not
automatically free; account creation alone does not provide one. If the domain is unavailable,
report that blocker and continue independent local setup. Do not use a temporary Quick Tunnel
as a substitute for a stable pairing origin.

## 3. Prepare one remotely managed named tunnel

Install or reuse the host's `cloudflared` using the current official platform instructions.
Check its version and executable path; the app requires `tunnel run --token-file` support.
On a Mac with Homebrew, `brew install cloudflared` is one supported installation path.
Capture its stable path for the launcher if necessary (`DOCK_CLOUDFLARED_BIN` is supported).

Use the person's signed-in dashboard: **Networking → Tunnels → Create a tunnel**. Create a
distinct name for this installation, such as `sciencewithagents-personal-phone`. Use a
remotely managed tunnel; the app's connector consumes its runtime token and remotely saved
ingress configuration. Do not install the dashboard's suggested system service or another
always-on connector. Do not replace an unrelated existing tunnel.

If the agent already has an authorized Cloudflare API capability, it may perform these steps
through the documented API instead. Scope setup access to this account and zone (Tunnel Edit
and DNS Edit); keep it outside app runtime storage. Create through
`POST /accounts/{account_id}/cfd_tunnel` with `config_src: "cloudflare"`. Retain the returned
tunnel ID privately and write its runtime token directly to the private file in step 4.
Check every API result and read back the exact resources; never print credential responses.

Save this exact remotely managed ingress through the dashboard's published application route,
or `PUT /accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations` (substitute the chosen
hostname and verified paired listener port):

```json
{
  "config": {
    "ingress": [
      { "hostname": "phone.example.com", "service": "http://127.0.0.1:4331" },
      { "service": "http_status:404" }
    ]
  }
}
```

Leave the original Host header intact; do not set `httpHostHeader` to localhost. Add only the
exact proxied CNAME `phone.example.com → <tunnel-id>.cfargotunnel.com`. The dashboard can create
it when adding the published application route; read it back instead of duplicating it.
With the API, use `POST /zones/{zone_id}/dns_records` only after checking for an existing record.
Do not create wildcard/zone-wide routes or expose the owner/development listener on port 4330.
A fresh paired installation needs no Access application that asks the phone to sign in.

## 4. Save private app configuration and safely reopen

In the actual data directory, create `phone-access.json` as a regular owner-only file (0600).
Use the real canonical HTTPS origin with no path or port. Confirm the paired port is free,
distinct from the owner listener and bound to loopback; 4331 is the normal paired port.

```json
{
  "origin": "https://phone.example.com",
  "authentication": "paired",
  "transport": "cloudflare",
  "port": 4331
}
```

Save **only this tunnel's runtime token** to `cloudflare-tunnel.token` beside that file, as a
regular file with mode 0600. The account API token, global API key and login certificate do
not belong there. Transfer credentials directly through a supported private tool or local
secret entry; never ask the person to paste one into conversation. Verify file type/mode
without printing the token. Keep the directory ignored by Git.

The app reads this configuration at server startup. Coordinate a safe relaunch of only this
installation around its active work, using [Operations](OPERATIONS.md), then reopen its local
**Phone access** screen. Leave optional login services off. Do not start another server against
the same data directory. The initial paired configuration starts with phone access off and
pairing closed; the app owns the tunnel process when enabled.

## 5. Verify the boundary, then pair the phone

Before turning access on, verify the paired listener rejects private requests while off
(503). Probe `http://127.0.0.1:<paired-port>` using the chosen hostname in the **Host** header;
do not probe the owner port or accept a redirect as proof of denial. Check `/api/projects`,
`/api/events` and a WebSocket upgrade to `/api/owner-terminal/<test-uuid>/socket`, using the
matching HTTPS Origin for the upgrade. None may return private content or status 101.

In the owner's local app, choose **Phone access → Turn on phone access**. The app starts its
scoped connector; wait for connection-ready. While pairing remains closed, repeat the same
unauthenticated probes locally and at the real HTTPS hostname: private HTTP/events/socket
upgrades must return 401, never private data or status 101. The public shell and bounded
pairing/status endpoints are intentional exceptions. Verify HTTPS and the exact tunnel/DNS
target. If authentication fails, turn access off and repair before continuing. A ready
connector alone is not acceptance.

Choose **Create a new code**. The person scans it, names the phone, saves a passkey and
confirms its matching number on the computer within 15 minutes. Walk them through
[Phone acceptance](PHONE_ACCEPTANCE.md), including pairing before Home Screen installation,
the same workspace/history, reconnecting over cellular, retained drafts, and off/on recovery.
Do not remove a working enrollment just to repeat a check.

Finish with the chosen account/hostname, completed technical checks, and a short list of
remaining human/device steps. Mark physical phone checks only when observed. Keep diagnostic
evidence private. Normal setup does not require the full developer test suite.

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
