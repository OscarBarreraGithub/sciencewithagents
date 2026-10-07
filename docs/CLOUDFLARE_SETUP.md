# Cloudflare phone setup

External-agent runbook for a stable free phone address in **the current person's own
Cloudflare account**. New setup uses Workers Free at `workers.dev`, one fixed Workers VPC
Service, and an app-owned named tunnel. No purchased domain or phone VPN is required.
Local desktop use needs no Cloudflare account. [Groups hosting](GROUP_HOSTING.md) is separate:
one creator hosts its shared service, and members join by invitation.

The agent handles commands, deployment and private configuration. The person completes
account sign-in/selection and phone pairing; give them [this short checklist](PHONE_SETUP.md).
Read the current official [VPC setup](https://developers.cloudflare.com/workers-vpc/get-started/),
[VPC commands](https://developers.cloudflare.com/workers-vpc/reference/wrangler-commands/) and
[Tunnel API instructions](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/)
before setup. Keep passwords, tokens and private device evidence out of chat, Git and screenshots.

## Required boundary

The path is `https://<worker>.<account-subdomain>.workers.dev` → Worker → one HTTP VPC
Service fixed to `127.0.0.1:4331` → the app's **paired** entry. The app authenticates phones;
there is no separate phone-side Cloudflare/GitHub login. Static assets and bounded pairing
endpoints may be public. Every private API, image, event stream and terminal upgrade requires
an approved browser credential. Pairing needs passkey creation and exact computer confirmation.
Never expose the local owner/development listener on port 4330, use a whole-network VPC
binding, or let requests select a destination. The same authenticated entry serves Groups
and the rest of the app without another phone deployment.

Workers VPC is currently free during beta on all Workers plans; normal
[Workers limits](https://developers.cloudflare.com/workers-vpc/platform/limits/) apply.
Verify the person's account is on Workers Free. Do not enable a paid plan or promise future
beta pricing. [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
provides the free stable hostname; a `pages.dev` site is not a substitute tunnel hostname.

## 1. Inspect the installation and select the account

Follow [Contributor setup](CONTRIBUTOR_SETUP.md) for an absent installation. For an existing
one, identify its clone, launcher, owner port and actual private data directory
(`DOCK_DATA_DIR` can override `data/`). Inspect phone settings and enabled state privately.
Preserve working transports, domain routes, paired devices, unrelated services and active
work. This runbook does not authorize replacing an existing connection. If the installed
screen still suggests Tailscale or requires a domain, follow [Update an installation](UPDATE_APP.md)
safely before copying its prompt again; copying a new prompt does not update the running app.

Reuse working Wrangler/account sign-in. Otherwise open native Cloudflare sign-in and have
the person complete account/email/MFA steps and select **their** account. Confirm its ID,
Workers Free plan and `workers.dev` account subdomain before creating resources. GitHub
sign-in is not required. Setup needs Workers Scripts Edit, Cloudflare Tunnel Edit and
Connectivity Directory Admin/Bind rights in that account. No zone or DNS permission is
needed for this route. A permission failure is not a reason to buy a domain or change accounts.

## 2. Prepare the app-owned named tunnel

Install or reuse `cloudflared` from its official platform instructions. Use the latest
version, **at least 2025.7.0**, with `tunnel run --token-file` support. On a Mac with Homebrew,
`brew install cloudflared` is one supported path. Capture its stable executable path for
the launcher if needed (`DOCK_CLOUDFLARED_BIN` is supported). Workers VPC requires QUIC;
verify outbound UDP 7844 and no forced `http2` transport. See
[VPC tunnel requirements](https://developers.cloudflare.com/workers-vpc/configuration/tunnel/).

Create a distinct remotely managed named tunnel for this installation, such as
`sciencewithagents-personal-phone`, through the person's dashboard or authorized API.
For the API, use `POST /accounts/{account_id}/cfd_tunnel` with a distinct `name` and
`config_src: "cloudflare"`. Parse the response privately, checking `success` and the exact
account/tunnel ID. Write its returned runtime `token` directly to the actual data directory's
`cloudflare-tunnel.token`, a new regular owner-only file (0600). If needed, obtain the runtime
token through `GET /accounts/{account_id}/cfd_tunnel/{tunnel_id}/token`. Do not print either
credential response. Store no account API token, global API key or login certificate there.

Do not install the dashboard's suggested system service or start another persistent
connector: the app starts and stops this tunnel. Do not modify an unrelated tunnel.
VPC routing needs no published hostname, DNS record, public ingress or subnet route.
If saving a remote ingress configuration, keep it only `http_status:404`; the VPC Service
supplies the specific private destination. Do not use a Quick Tunnel as a pairing origin.

## 3. Create the fixed service and deploy the phone Worker

From the selected account with current Wrangler, create this one HTTP service, substituting
the new tunnel UUID and a distinct service name:

```sh
CLOUDFLARE_ACCOUNT_ID=<account-id> sh scripts/pnpm dlx wrangler@4.147.0 vpc service create sciencewithagents-phone \
  --type http --tunnel-id <tunnel-uuid> --ipv4 127.0.0.1 --http-port 4331
CLOUDFLARE_ACCOUNT_ID=<account-id> sh scripts/pnpm dlx wrangler@4.147.0 vpc service get <service-uuid>
```

Read back type `http`, that tunnel ID, IPv4 `127.0.0.1` and HTTP port `4331`. Do not use
`vpc_networks` or grant the Worker general tunnel/network access. This fresh-setup template
fixes port 4331; retain an existing installation's different configured port and route.

Choose a distinct Worker name and verify its resulting
`https://<worker>.<account-subdomain>.workers.dev` origin. From the repository root, prepare
new private deployment files (substitute all angle-bracket values):

```sh
node scripts/phone-cloudflare-setup.mjs prepare <installation-data-dir> \
  https://<worker>.<account-subdomain>.workers.dev <worker> <account-id> \
  <service-uuid> --verified-workers-free
```

The helper creates a new private `phone-cloudflare/deploy-<uuid>/` directory containing
`wrangler.json` and `phone-access.json`. It does not deploy, start a connector, activate
phone access or overwrite existing files. Review the exact account, public origin and
single `PAIRED_APP` binding before deploying with the generated configuration:

```sh
sh scripts/pnpm dlx wrangler@4.147.0 deploy --config <generated-directory>/wrangler.json
```

The source template is [phone-worker.ts](../deployment/phone-worker.ts); the checked-in
Wrangler template is inert. Its VPC binding determines the destination. The fetch URL uses
the public Worker hostname as HTTP `Host`, preserving the app's exact host/origin checks;
the tunnel encrypts the connection until its loopback HTTP hop. Cookies, `Origin`, response
streaming and WebSocket upgrades pass through. Verify the deployed URL exactly matches
the configured origin; retain its name and account subdomain so pairing remains stable.
Disable preview URLs and keep logs from recording phone credentials or conversations.

## 4. Activate private app settings and safely reopen

Only when the installation has no existing phone configuration, exclusively create its
`phone-access.json` from the reviewed generated file, mode 0600:

```json
{
  "origin": "https://<worker>.<account-subdomain>.workers.dev",
  "authentication": "paired",
  "transport": "cloudflare",
  "port": 4331
}
```

Verify `cloudflare-tunnel.token` is a regular owner-only file without printing it. Keep
runtime/deployment data ignored by Git. Confirm 4331 is available, distinct from the owner
listener and bound to loopback. The app reads settings at startup; coordinate a safe
relaunch of only this installation around active work using [Operations](OPERATIONS.md).
Leave optional login services off and never start another server against the same data.
New paired configuration begins with phone access off and pairing closed.

## 5. Verify the boundary, then pair

Before enabling, probe the paired listener with the public Worker **Host**: private
requests must return 503 while off. Check `/api/snapshot`, `/api/events`, and a WebSocket
upgrade to `/api/owner-terminal/<test-uuid>/socket` with the matching HTTPS `Origin`.
Do not probe the owner port or count redirects as denial.

Choose **Phone access → Turn on phone access** locally. The app starts its scoped connector;
verify it connects over QUIC. With pairing closed, repeat the unauthenticated probes locally
and through the real HTTPS URL: private HTTP/events/socket upgrades must return 401, with
no private content or status 101. A ready connector alone is not acceptance. If a boundary
check fails, turn access off and repair it before continuing.

Choose **Create a new code**. The person scans it, names the phone, saves its passkey and
confirms the matching number on the computer within 15 minutes. Follow
[Phone acceptance](PHONE_ACCEPTANCE.md): verify the same workspace and Groups, incremental
events, authenticated terminal upgrade, reconnect over cellular, retained drafts, off/on
recovery and the Home Screen shortcut. Do not remove working enrollment to repeat a check.
Return the finished HTTPS address, technical checks and remaining human/device steps;
mark physical checks only when observed. Ordinary setup needs no full developer suite.

## Existing connections and recovery

Working domain tunnels, private-network routes and Access-mode configurations remain
supported. Preserve them rather than migrating to this new default. If the person explicitly
chooses a domain for a new connection, use the official published-hostname route to the
paired listener, preserving the public Host and unrelated DNS/mail/websites. Domain or trust
changes may revoke browser approval and need a separately authorized migration with a
consistent private backup and rollback. Never remove an Access gate without verifying its
replacement app boundary; never open an unauthenticated fallback.

The app retries an exited owned connector with bounded backoff; its explicit reconnect
action retains approved devices and enabled intent. Turn off blocks remote access and
closes streams; turn on lets approved browsers reconnect. Remove device revokes it.
Changed origin or lost browser storage can require deliberate pairing again. Pair before
adding a Home Screen icon, then verify the shortcut while retaining the working browser.
Cloudflare supplies transport encryption; this is not an end-to-end-encryption or permanent
browser-storage guarantee. Record live acceptance separately from source/fixture checks.
