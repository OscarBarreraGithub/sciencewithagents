# Connect your computers — setup-agent guide

For the person: open **Settings → Computers and accounts → Connect another computer**.
Copy **On the new computer** into Codex or Claude there. It installs sciencewithagents
using the contributor guide, checks that computer’s provider/models and supplies a non-secret
handoff. Then expand **Then finish linking from your main computer** and paste its prompt
into the setup agent on the computer you normally open the app from. Tell it which computer
uses which account. Copying alone does not install or connect anything. Complete sign-in and any operating-system permission
on that computer yourself. Afterwards, choose **Computer** in the app; projects, saved
views, drafts and the native terminal follow that selection. No account switch or shell
command is needed in the normal app journey.

## What stays where

The entry computer serves the phone's paired HTTPS page. Other computers are reached
through an existing SSH connection from that entry computer. Each runs its own Agent Dock
and its own signed-in Codex or Claude. Provider credentials, repositories and provider threads never
move through this setup. A computer must be on, logged in, running Agent Dock and reachable.
The entry computer must also remain on for phone access. This is not cloud execution.

Each computer has its own personalized assistant. Its visibility defaults to no projects;
selecting projects shares only those on that computer. Merely switching between personal,
school and family computers never shares their conversations with another account's model.
Cross-account assistant memory/routing is intentionally not automatic.

## Bounded setup

1. Follow CONTRIBUTOR_SETUP.md independently on each intended computer. Preserve its
   provider sign-in, settings, MCPs, skills and files. Do not copy the maintainer's `data/`,
   Codex home, credentials, SSH keys or browser profile. Confirm the person has authority
   over the intended installation; a similarly named account is not sufficient.
2. Use an existing, privately reachable SSH route. Agent Dock does not enable Remote Login,
   alter firewall/privacy settings, open router ports or configure an arbitrary network
   from the browser. If no route exists, record which physical/setup step is missing and
   continue other work. Never repurpose an unrelated school/HPC or GitHub SSH alias.
3. Prepare a dedicated host-local SSH alias with verified known-host identity and working
   noninteractive authentication. Preserve SSH's own credential storage and ProxyJump
   configuration. Strict host-key checking and batch authentication are mandatory; no
   forwarded agent, X11 or additional local/remote/dynamic port forwards. Read-only
   `ssh -G` inspection checks the effective alias before the app starts it. A host-key
   mismatch needs independent verification, not deletion of the saved trust record.
4. Through that verified route, read the target's loopback `/api/host-info`. Pin its
   `hostId` and protocol version. Do not learn or replace a pin automatically after an
   unexpected mismatch. Confirm the target is the intended account's installation.
   Current installations report `localAuthentication: true` and require an app connection
   credential in addition to SSH. On the target, use the existing private data directory's
   `local-access.json` and its **host** field only. `readLocalAccess` in
   `apps/server/src/local-access.ts` validates its ownership, permissions and schema.
   Transfer that app-specific host key programmatically over the verified route into the
   entry's private connection record; never print it, paste it into chat or send it to the
   browser. Do not copy the **owner** or **bridge** key, browser cookies or provider credentials.
5. Save a private regular `data/hosts.json` on the entry computer, using the shared
   `hostConnectionsSchema`. Maximum 16 connections; generated unique IDs; mode 0600.
   Preserve existing records and write atomically. The browser cannot supply any of these
   transport fields. The `credential` below is the target's host key, not its provider token.
   Example with placeholders (the actual credential is 64 hexadecimal characters):

   ```json
   [
     {
       "id": "<generated UUID>",
       "label": "School laptop",
       "accountLabel": "School account",
       "expectedHostId": "<verified target host UUID>",
       "sshAlias": "dock-school",
       "remotePort": 4330,
       "credential": "<private target app host key>"
     }
   ]
   ```

6. Reopen the entry app when its active work is safe, choose the computer and verify project/account labels, a retained
   conversation, saved drafts and explicit reconnect. Check loss/recovery of the route,
   and native **Take control here** with two clients. No uncertain input is resent.
   Complete the physical phone journey separately using PHONE_ACCEPTANCE.md.

## Security and recovery / future wiki material

- Only the exact typed application route/method/query allowlist is forwarded. Phone
  pairing, computer administration, remote folder selection and raw provider RPC are not.
  Each remote machine keeps its own queue; there is no cross-machine task migration.
- The selected account is pinned for the life of a browser document. Switching performs
  a full reload; stale callbacks stay on the old route and drafts have a separate host key.
- The gateway pins identity on connection **and every request**. The receiving server
  checks the expected identity before acting. This closes replacement on the same port
  between a handshake and a write; a mismatch must not receive the message body as work.
- The entry gate authenticates the phone. Its cookies, Cloudflare headers and user
  authorization headers are not forwarded to another computer. Locked/revoked phone
  streams close, including SSH-proxied events and terminal sockets.
- SSH disconnects are **computer unavailable**, not **phone unpaired**. No automatic body
  replay or hidden account fallback. Retry connection, then inspect message receipts.
- An authenticated-connection error is not a provider sign-in problem. Verify the target's
  current host identity and app host key through the authorized route; repair only that
  entry's connection record. Do not disable local authentication or copy the stronger owner
  key. The app uses host-scoped challenge proofs for reads, writes and streams; status pages
  never expose the key. Older unauthenticated fixtures are not a model for a new installation.
- A cloned/replaced database can carry a copied host identity: do not use database copies
  to set up a different person's machine. The local launcher also checks an installation
  hint so another clone on the same port does not open under the wrong app icon.
- The owned SSH lifetime process closes when the entry app exits or crashes. Do not
  terminate all SSH/Node processes. Other applications' network connections are unrelated.

Verified evidence: three isolated app instances, same IDs/retry keys across accounts,
actual HTTP/SSE/WebSocket boundaries, same-port replacement, and four-size browser
selection/draft recovery. These fixtures do not certify another person's SSH/network setup.

The first adapter uses standard [OpenSSH configuration](https://man.openbsd.org/ssh_config),
not Codex Remote's account linking. Future host transports can implement the same narrow
`ConnectHost` lifetime interface without changing project storage or weakening the gate.
