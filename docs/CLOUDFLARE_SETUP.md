# Cloudflare setup — agent runbook and troubleshooting

Status: paired-mode browser and real-hostname boundary checks passed (2026-09-13);
physical Safari enrollment subsequently succeeded (2026-09-14). Home Screen, cellular and
restart acceptance remain separate. The hostname uses app-owned pairing, not phone-side
Access sign-in. Current process/continuation state belongs in STATUS.md and RESUME.md.
The final real-hostname check also denies private mutations and an actual forged terminal
upgrade, then closes both its app and connector with exit 0. See the rejected-upgrade
shutdown incident in ORCHESTRATOR_TROUBLESHOOTING.md; a correct 401 alone was insufficient.
This guide records verified steps separately from
remaining deployment checks. It is reusable workflow knowledge, not proof of a live deployment.
Finish with [the real-device acceptance checklist](PHONE_ACCEPTANCE.md); keep fixture and
physical-device evidence distinct.

## What the person does

Ask Codex to set up phone access for this clone. Use the **GitHub signup/sign-in route when
offered**, as the owner did. A GitHub account also supports private source-code backups.
Complete provider sign-in and authorization yourself; do not paste credentials into chat.
The agent handles configuration. Once ready, open **Phone access** on the computer and
choose **Create a new code**. Scan the QR into Safari on iPhone or Chrome on Android; the
phone opens **Name your phone** directly, without a code field. Enter a **Phone nickname**,
choose **Continue**, then **Save passkey**, and confirm the matching number on the computer
within 15 minutes. The Home Screen guide opens directly after computer confirmation; **Open my workspace** finishes setup with or without installing.
An icon added earlier may need adding again from that paired
browser. Manual fallback opens **Enter pairing code**, then **Continue** to the separate
nickname screen. No phone account sign-in is needed. Safari enrollment succeeded; the
remaining device checks are in [the phone checklist](PHONE_ACCEPTANCE.md). The complete
[phone workflow contract](PHONE_WORKFLOW.md) defines pairing, storage and recovery behavior.

No purchases, paid upgrades, payment entry or manual DNS/token checklist in the default
workflow. No collaborator receives access to another owner's Mac or Cloudflare account.

## Paired-mode setup / controlled migration — current instructions

The paired entry is the primary authentication boundary in this mode. Cloudflare provides
HTTPS and named-tunnel routing, not a required phone identity login. The address itself is
not a secret; unauthenticated visitors may load only static app assets and bounded pairing
endpoints. Private APIs, images, event streams and terminal upgrades require an approved
browser credential. Initial passkey registration and exact computer confirmation remain;
there is no recurring app lock. Device removal revokes access. Turning phone access off
blocks it while off without deleting approved devices. Never tunnel local port 4330.

1. Read current STATUS.md and OWNER_CHECK_IN.md. Run the full types/backend/build and
   four-viewport browser suite, including real WebAuthn browser/server checks, before
   changing live authentication. All 96 existing checks passed under the restored full-access
   profile on September 13. Earlier policy refusals were historical, not expired OAuth.
   Recheck effective access after a session restart; never bypass an actual refusal.
2. For new accounts, use the official MCP connection and computer-only human OAuth steps
   in the legacy reference below, preferably GitHub signup when offered. Inventory an
   available hostname; do not buy a domain or assume a free new domain. Create only the
   named tunnel, exact unused hostname/DNS route and scoped runtime token needed here.
   A new paired-mode installation does not need an Access phone sign-in application.
3. For an existing installation, read back the exact receipt-identified app policies,
   hostname and tunnel ingress. Privately preserve the old trust/route/policy configuration
   and make a consistent database backup. Stop only the owned connector before migrating;
   no live legacy entry may accidentally lose its front gate. Preserve unrelated account
   policies, organization MFA, domains, services, source and conversation history.
4. Set ignored host-only `data/phone-access.json` to the selected canonical HTTPS `origin`,
   `authentication: "paired"` and `port: 4331`. This is an agent-side config operation,
   not a browser path/text editor. Missing `authentication` deliberately keeps legacy Access.
   Start the verified app without its connector and test unapproved/private denials locally
   using the exact public Host. A trust-mode/origin change invalidates old trust; record
   that disposition. No phone had enrolled in the earlier owner acceptance attempt.
5. With the connector still stopped, route only the exact Agent Dock hostname to
   `http://127.0.0.1:4331`, preserve that Host and the catch-all `http_status:404`, and remove
   the old connector-side Access JWT requirement for this route only. For the existing
   Access app, use the documented Bypass action scoped strictly to that app's one exact
   hostname as a reversible migration to application-owned auth; retain its old owner
   policy for rollback. Never apply this to a zone wildcard or another application.
   Read current API schemas/policy ordering before writing and read back the full result.
   Bypass removes Access enforcement and Access request logging; it is not authentication
   or a WAF guarantee. Zone HTTPS settings still matter; the paired entry must already enforce
   every private route. See [Cloudflare policy actions](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
6. Start the one app-owned connector for a bounded acceptance window. Verify the actual
   HTTPS origin: no phone account redirect, pairing initially closed, forged/missing
   cookies and Access headers cannot read private APIs or upgrade sockets, wrong code
   fails and pairing requires computer confirmation. If a check fails, stop the connector;
   restore the exact prior app policy/ingress/trust configuration before restarting legacy
   operation. Do not open an unauthenticated fallback or expose local services.
7. Continue PHONE_ACCEPTANCE.md with the owner's physical phone. Confirm enrollment,
   returning access, cellular/home-screen use, same-history handoff, native input, idle restart,
   off/on retention and removal. Physical passkey verification is performed by the owner.
   If that human step is unavailable, stop the acceptance processes, retain config/history,
   record what actually passed and move to another independent bounded slice.

The runtime token remains a scoped 0600 file under private data; no setup-level account
credential enters the app. The app owns connector lifetime and retry. Temporary off blocks
remote access without revoking enrollment; explicit Remove device revokes. Trust origin
changes and lost browser storage still require planned recovery. Do not promise perpetual
browser storage or end-to-end encryption from Cloudflare.

## Earlier Access-mode setup — historical reference / rollback only

The following account/MFA steps describe the old deployed mode, not the new phone journey.
Reuse its MCP connection/provisioning lessons where applicable; do not rebuild an Access
identity requirement for a fresh paired-mode installation.

1. Read AGENTS.md, this guide and PHONE_WORKFLOW.md. Inspect current configuration
   without dumping credentials. Keep local app ports and Codex RPC private. Do not touch
   the old phone-assistant installation. Keep a private, sanitized setup receipt under data/.
2. Connect the official **Cloudflare API MCP**, not just the documentation MCP:
   `https://mcp.cloudflare.com/mcp`. Use existing configuration if it already matches.
   For a new Codex CLI connection, the agent runs
   `codex mcp add cloudflare-api --url https://mcp.cloudflare.com/mcp`.
   The installed CLI may start OAuth immediately. For an existing connection needing login,
   use `codex mcp login cloudflare-api`. Let the human review the provider consent screen.
   Request only the account/zone discovery, tunnel, DNS and Access permissions needed.
   Do not grant billing or unrelated product authority just to simplify setup.
3. Open the authorization link **on the Mac running Codex**. Its loopback callback points
   to that Mac, not a remote phone. Do not record live OAuth URLs, codes, tokens or cookies
   in this guide, model checkpoints, Git or public diagnostics. A browser visit is not
   proof of successful authentication: wait for Codex's completion result.
4. Confirm the MCP tools are actually available, then perform a read-only account/resource
   check. A successful login and a usable tool connection are separate checks. Discover
   current API shapes through the MCP; do not guess resource IDs or copy outdated examples.
   Infer defaults from the authorized owner/account. Ask only about genuinely ambiguous
   ownership, not fields the agent can determine safely.
5. Use an existing suitable hostname and free-tier services. The named-tunnel design needs
   a domain available to the account. If none exists, resolve the stable zero-cost address
   design before claiming setup is complete; do not buy a domain, commandeer another
   project hostname, move nameservers, or substitute a public Quick Tunnel. Keep independent
   local implementation moving while this deployment detail is unresolved.
   For `access.api.error.not_enabled`, inspect the documented organization-create API:
   `POST /accounts/{account_id}/access/organizations`. Create a narrowly named organization
   and re-read it before retrying an uncertain write. This worked without payment entry on
   the verified account. Do not repeat OAuth or invoke subscription/billing writes.
6. Create/reuse narrowly identified Agent Dock resources: owner-only Access application
   with MFA, named tunnel, exact hostname route, and catch-all denial. Protect the entire
   host, including downloads, event streams and terminal upgrades. Never create a broad
   bypass rule. Record the specific created resource IDs privately so retries can inspect
   and reuse them. Never delete existing account resources as generic cleanup.
7. Configure the local phone entry in ignored `data/phone-access.json`. Fields are
   `origin` (canonical HTTPS origin), `issuer` (Cloudflare Access team origin), `audience`
   (this Access application's AUD), `owner` (verified owner email), and `port` (default 4331).
   These are trust settings, not browser-editable parameters. Start in the disabled state.
   Tunnel **only** to this separate loopback entry, preserving the public Host header;
   never point the tunnel at the unauthenticated local app port. Keep tunnel runtime
   credentials in restricted local storage, separate from setup authorization and source.
   Install `cloudflared` using its official package route. Save only this tunnel's runtime
   token in `data/cloudflare-tunnel.token` (regular file, 0600, private parent directory),
   without printing it or putting it in process arguments. Do not install another login
   service. With this file, the app's phone switch owns the connector; **Reconnect phone
   access** retries an exited connector without revoking devices. The host uses `cloudflared`
   from PATH or host-only `DOCK_CLOUDFLARED_BIN`. No file means external supervision, an
   advanced alternative, not the normal collaborator setup. Restart after installing config.
8. First exercise a disposable project. Then enable access locally, pair one phone and
   test on cellular. Verify denial without valid Access identity and device enrollment;
   verify existing streams close on device revocation. Preserve exact Codex approvals.
   Check chat, child history, native terminal, suspend/resume, restart and home-screen login.
   Do not automatically replay messages, terminal input, approvals or uncertain setup writes.
9. Only report completion with actual endpoint and device evidence. Document limits,
   created resources, verified versions and cleanup/recovery steps. Keep services running
   only for active checks until the owner wants normal background phone use. The Mac must
   remain awake and online; an open Chrome window is not required.

## Verified incidents / future wiki material

### App-owned pairing migration / HTTPS boundary — 2026-09-13

Read back the exact app and ingress, saved private rollback JSON and a consistent database
backup, then validated the locked paired server before cloud changes. With no connector
running, removed connector-side Access validation only for Agent Dock's exact hostname
and added a non-reusable app-scoped Bypass policy. The previous owner policy remains for
rollback. No organization MFA or unrelated application/zone settings were changed.

The zone's Always Use HTTPS setting was off for unrelated sites. Agent Dock now redirects
forwarded HTTP document reads to its pinned HTTPS origin and refuses plaintext mutations;
the real HTTP URL was tested. Do not enable a zone-wide setting without its broader scope
being authorized, or confuse a secure cookie with a secure first page load.

`node scripts/verify-phone-entry.mjs --run` checks a disposable local authenticated entry.
Adding `--public` temporarily uses the app-owned connector and exact configured origin,
without opening enrollment, touching owner conversations or starting a provider. The
real endpoint returned paired status without account redirect, refused forged private
reads/encoded paths and wrong pairing code, and redirected HTTP. Cleanup closed the owned
server/connector and removed only its generated fixture. This does **not** prove Safari,
Face ID, installed-app storage or cellular acceptance. Private receipts are under
`data/migrations/paired-20260913/`; the normal-use service stays off during development.

For rollback, stop the connector first, remove only the receipt-identified migration
Bypass policy, restore the saved exact ingress/trust settings, read back, then validate
the legacy entry before restarting its connector. Do not recreate accounts, rotate
unrelated credentials, delete the owner policy or blindly repeat an uncertain API write.

### Session policy regressed independently of source access — 2026-09-09

New source and tests could be written, but Git staging returned `.git/index.lock: Operation
not permitted`, Chromium failed before opening a page with macOS MachPortRendezvous permission
denied, and read-only Cloudflare MCP execute required approval while the profile forbade it.
These are three effective capabilities, not another owner decision or proof OAuth expired.
Record them together in OWNER_CHECK_IN.md, do not repeat sign-in or attempt alternate
drivers/credentials. Backend/reproducibility and independent coordination work continued;
no live cloud authentication or owner history was changed. New source is not yet backed up.

### MCP connection is not the same as tool availability — 2026-09-08

The agent added `cloudflare-api` using Codex's supported CLI. It discovered OAuth, started
a loopback callback and reported **Successfully logged in** after owner authorization.
The running agent's tool catalog still did not contain Cloudflare tools. Do not ask for
another token or repeat sign-in merely because an already-running client needs its MCP
connection refreshed. Refresh/reconnect through the client's supported UI, then verify
with a read-only tool call. The resumed session now exposes search/docs/execute, and actual
account, zone and tunnel reads succeeded. Tool availability is no longer a blocker.

Computer Use explicitly refused to operate `com.openai.codex` for safety reasons when the
agent checked whether it could perform that refresh. Respect this boundary: do not retry
through AppleScript, another UI driver or changed permissions. Ask the person to refresh
the MCP connection in Codex, or restart Codex and reopen the saved conversation if necessary.
The tested source checkpoint and these instructions make that a resumable client handoff,
not another authentication task or a reason to repeat completed implementation.

### Effective access and stale executable paths — 2026-09-08

A resumed session initially still had workspace-only execution and an approval policy that
could not request escalation. Cloudflare execute returned a policy error even though OAuth
was valid. After the owner changed the actual session to full access, execute worked. Stop
asking for approvals already covered by standing authorization. Inspect the effective tool
profile; do not edit security gates to bypass a refusal or mistake a policy error for OAuth.

The unrelated `node_repl` failure pointed at nonexistent `Codex.app`; the installed host
was `ChatGPT.app`. Repaired only the stdio command, bundled Node path, module directory,
Codex binary path and host version after inspecting the actual bundle. Preserved trust
settings and other MCP config. The configured process passed `initialize` and `tools/list`,
then was stopped. This proves startup, not hot-loading tools into an existing turn or
browser attachment. No sandbox-disable flag was needed. It is separate from Cloudflare.

### Access initialization is not another OAuth failure — 2026-09-08

Account/zone/tunnel reads worked, but Access reads returned error 9999 `not_enabled`.
Organization creation returned 201 and subsequent reads succeeded, without payment entry
or subscription changes. Unlike the dashboard guide's default-IdP description, the API-created
organization had no IdPs. Created the Cloudflare IdP restricted to account members, plus
an exact owner-email application policy and independent MFA. Signing up through GitHub
does not itself prove Access MFA. A subscriptions read lacked authorization; do not broaden
billing permissions just to inspect it. No paid plan was chosen.

Enable independent MFA at organization level before requiring it for this application.
Preserve other fields on PUT; leave global enforcement off and scope the requirement to
Agent Dock. Offer biometrics/security key/TOTP with a 24-hour session. The person enrolls
their authenticator. Protect the whole host before DNS or connector startup. No bypass or
service-token testing exception was introduced.

### Cloud provisioning and process ownership — 2026-09-08

Created an unused scoped hostname, owner-only Access app/policy, named tunnel and proxied
CNAME. Private ignored receipts hold IDs/trust settings, never collaborator configuration.
Read-back verified full-host Access, MFA, no preflight bypass, binding/HttpOnly cookies,
and ingress exclusively to 127.0.0.1:4331 with public Host, required connector-side Access
validation and catch-all 404. Cloudflared 2026.8.3 reached the real edge; unsigned and forged
requests redirected to Access on every probed path. Public JWKS loaded.

The app-managed connector passed two real on/ready/off cycles in an isolated database,
without opening owner history or starting a model. Its readiness listener is ephemeral and
loopback-only. The existing lifetime-pipe host stops the connector group after a gateway
crash; never bulk-kill cloudflared. The app shows connecting/ready/error with explicit retry
after process exit. Cloudflared handles ordinary network reconnects. Connector readiness
does not prove owner sign-in, pairing, application reachability or physical phone acceptance.

### Revocation must stop existing connections, not just new requests

A local real-socket check found queued SSE events trying to write after a revoked stream
ended. Check both destroyed and writable-ended state before pumping or writing heartbeats.
Test terminal and SSE shutdown at revocation; a passing new-request denial is insufficient.
The focused server suite now covers this race without starting a provider or cloud tunnel.

### Tests must preserve the real proxy boundary

Node fetch did not preserve the test's requested Host override. The resulting 403 was
the correct host protection, not a reason to widen allowed hosts. The socket-level test
uses Node HTTP with an explicit public Host header. Missing-origin tests must omit the
header, not provide a JavaScript undefined value rejected by the test injector.

### Pairing recovery and phone behavior

Codes are short-lived, single-use, attempt-limited and stored only as hashes. Their plaintext
cannot be redisplayed after restart: create a new code, rather than persisting secrets for
convenient retries. A lost pairing response requires inspecting cookie/session state, not
automatically resending the code. In the old Access mode, turning access off invalidated
every device enrollment. In paired mode it closes pending pairing and active connections,
retaining approved devices for direct reconnection once phone access is on again. There is
no app lock or repeated verification. Enrollment has no automatic server expiry; its cookie
requests 400 days, renewed on visits, subject to browser retention. Require explicit Remove
device for permanent revocation; a trust/origin reset is also a deliberate revocation.
Browser and installed-app storage may differ; verify on real iOS/Android rather than
claiming that a desktop viewport test proves installation or authentication continuity.

### GitHub is source backup, not a private-runtime dump

Keep verified source checkpoints in private GitHub repositories. Conversations, credentials,
SQLite databases, uploads and runtime logs must never enter Git—even a private repository.
Managers must report backup status and preserve failed/unpushed work. Do not force-push,
discard changes or pretend a dirty directory is clean. The event-driven checkpoint hook,
private-destination checks, history scan, failure recovery and manager/UI status are
implemented. See [SOURCE_BACKUPS.md](SOURCE_BACKUPS.md) for agent-led configuration,
verification boundaries and failure handling. Cloudflare OAuth does not sign GitHub CLI in.

## Authoritative references

- [Cloudflare API MCP / OAuth](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/)
- [Codex MCP setup](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Access JWT verification](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [Tunnel setup and Quick Tunnel limits](https://developers.cloudflare.com/tunnel/setup/)
- [Clientless hostname requirement](https://developers.cloudflare.com/learning-paths/clientless-access/initial-setup/add-site/)
- [Organization creation API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/methods/create/)
- [Cloudflare identity provider](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/)
- [Independent MFA](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)
