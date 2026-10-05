# sciencewithagents VS Code companion

An unofficial source preview for sharing an existing Codex or Claude Code conversation with
sciencewithagents on your computer or paired phone. It uses the original native conversation;
it does not start another agent. It is not endorsed by OpenAI or Anthropic.

## Start mirroring

You need a working provider extension and sciencewithagents running on this Apple Silicon Mac.
Either provider works independently. Phone use also needs [app pairing](../../docs/PHONE_SETUP.md).
Ask your setup agent to [build the VSIX](../../docs/CONTRIBUTOR_SETUP.md#optional-vs-code-companion).

1. In VS Code, use **Extensions → … → Install from VSIX**.
2. Open **sciencewithagents** in the bottom status bar and choose **Share a Codex conversation**
   or **Share a Claude Code conversation**. There is no separate editor login or connection code.
3. First setup modifies one structurally checked provider file and saves an exact backup.
   When running work is safe, use the offered **Reload window**, then reopen the original chat.
4. Use the share action again to select that conversation. Open it in the app under
   **Chats → Shared**. You can share one conversation per provider per VS Code window.

**Stop sharing** ends the mirror without ending the native conversation. After an editor
restart, reopen the original conversation and re-share if needed. Keep the computer awake,
with VS Code and the app running. No separate public port or provider account is created.

## Remote SSH workspaces

Remote sharing is an explicit source-preview option. Install the companion and the native
provider **in the same remote workspace extension host**, using **Install in SSH: …** in
VS Code. Keep sciencewithagents running on the app computer. Do not reload an active chat
to test setup. A provider that runs locally cannot be shared by a companion running remotely.

Open **sciencewithagents → Connection status and setup → Copy remote setup instructions**
and give the copied prompt to your setup agent on the app computer. It preserves your existing
SSH alias and native sign-in. The companion creates no SSH login, account or credential store.

For manual setup, use the existing trusted SSH alias. On the remote host create a fresh
private directory; retain its printed canonical path:

```sh
umask 077
mktemp -d /tmp/swa-vscode.XXXXXXXX
```

On the app computer, substitute your alias and that directory below. This adds only a Unix
forward to an already-running SSH master, and fails if it cannot bind. It opens no cluster TCP
listener. If your connection has no master, use a separate foreground `ssh -N` connection
with the same `-R` and `ExitOnForwardFailure` options, and keep that connection open.

```sh
mirror_alias=YOUR_EXISTING_SSH_ALIAS
mirror_socket=/tmp/swa-vscode.PRINTED_DIRECTORY/bridge.sock
mirror_port=4330
ssh -O forward -o ExitOnForwardFailure=yes -R "$mirror_socket:127.0.0.1:$mirror_port" "$mirror_alias"
```

On the remote host, set and check the generated socket, replacing the example path:

```sh
chmod 600 /tmp/swa-vscode.PRINTED_DIRECTORY/bridge.sock
ls -ld /tmp/swa-vscode.PRINTED_DIRECTORY
ls -l /tmp/swa-vscode.PRINTED_DIRECTORY/bridge.sock
```

The directory must be owned by your remote account with mode **0700**, the socket with mode
**0600**. Use a canonical absolute path under 100 bytes with no linked directory or socket.
In VS Code **Remote settings**, set `agentDockMirror.remoteSocketPath` to that socket and
`agentDockMirror.port` to the app's port. Workspace files cannot opt into the connection.
Select the native conversation with the usual share action. The status bar reports connected
chats or reconnection; its tooltip and Connection status explain setup/forward failures.
Setting changes reconnect without reloading the editor. A broken or missing forward retries
every four seconds and rechecks permissions; pending sends are never automatically replayed.

**Phone screenshot attachments are unavailable for remote conversations.** Saved screenshots
remain visible/removable, but sending them is refused before local file paths are added.
Remove them to send text; attach files through the native remote editor when needed.

To disconnect, use **Stop sharing** first. Cancel only the forward you created on the app
computer; do not stop the existing SSH master or other tunnels:

```sh
ssh -O cancel -R "$mirror_socket:127.0.0.1:$mirror_port" "$mirror_alias"
```

For a separate foreground tunnel, stop only that tunnel with Ctrl-C. Remove its exact socket
and empty generated directory on the remote host. Clear `remoteSocketPath` when no longer
using this connection. A restart may require restoring the forward and reopening/re-sharing
the native chat. The app computer and remote host must both stay reachable.

Private Unix reverse forwarding has been exercised on FASRC. Disposable transport fixtures
cover local/Unix connections, first setup, permission refusal, reconnect and stop. Installation
and native controls in an actual remote VS Code workspace remain unverified; local provider
qualification does not certify remote provider builds or cluster policies.

## Reading and replying

- History loads in bounded pages; tool activity expands on demand. Older/newer controls
  preserve the original text without loading the whole transcript onto a phone.
- Send goes to the selected native conversation. Phone sends do not edit the desktop draft.
- **Send guidance** targets the exact active Codex turn. **Queue next** saves an app-owned
  message until delivery. **Expand queue → Edit** holds it in the notepad; minimizing or
  reloading keeps it held. **Save and queue** releases it explicitly. Codex also offers an
  explicit **Steer now** for a held message; Claude follow-ups stay queue-only.
  Messages queued inside the native editor, or already handed to it, are labelled separately
  and remain under that editor’s control. Uncertain delivery is inspected, never auto-repeated.
- **Stop reply** targets the observed reply. It cannot undo completed work or cancel every
  future native action. Lost acknowledgements offer a receipt check, never an automatic replay.
- Models, permissions, native questions, slash menus, attachments and unsupported rich tools
  stay in VS Code. This is a text mirror, not complete provider UI parity.

App-created helpers are filtered by provenance rather than their names. Their saved evidence
remains available under the parent work. Separately launched active helpers can still appear
in the provider's own picker; sciencewithagents cannot promise to hide them there.

## Compatibility and removal

The local companion is qualified on **macOS arm64**; Remote SSH is a Unix transport preview
with the acceptance limit above. It checks actual provider connection structure
and runtime capabilities, not a fixed version allowlist. Compatible updates may continue working;
future versions are not automatically certified. An incompatible bridge fails visibly without
replacing the native provider. Updates can require one safe editor reload.

Before uninstalling, choose **sciencewithagents → Restore an original extension** for each
enabled provider, then reload when safe. Restoration only replaces recognized patched bytes;
it never overwrites a later provider update with an old backup. If already uninstalled, reinstall
the companion to restore, or reinstall the provider through VS Code. No reliable uninstall hook
exists. The remaining inert reference alone opens no network connection.

## Privacy

The companion connects to the app's loopback gateway, directly or through the explicitly
configured private SSH Unix forward. It has no telemetry or provider
credential store. The local producer trusts native programs on this computer; it does not
identify an individual OS account or extension. Browser-origin and public/cluster TCP producers
are refused. An enabled private forward extends native producer trust to your remote account's
programs; its socket permissions protect it from other cluster accounts.
The app's authenticated phone/browser routes protect viewers.

Native history stays with the provider. The app retains delivery/stop receipt metadata, not a
second full editor transcript. Browser drafts have their own local storage limits. Cloudflare,
when used for the phone connection, terminates TLS; this is not end-to-end encryption against it.

MIT licensed, distributed from source; **not yet published on the VS Code marketplace**.
[Technical maintenance and release checks](../../docs/VSCODE_MIRROR.md).
