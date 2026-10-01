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

## Reading and replying

- History loads in bounded pages; tool activity expands on demand. Older/newer controls
  preserve the original text without loading the whole transcript onto a phone.
- Send goes to the selected native conversation. Phone sends do not edit the desktop draft.
- **Send guidance** targets the exact active Codex turn. **Queue follow-up** uses Claude's
  acknowledged native queue; acceptance does not mean the follow-up has run yet.
- **Stop reply** targets the observed reply. It cannot undo completed work or cancel every
  future native action. Lost acknowledgements offer a receipt check, never an automatic replay.
- Models, permissions, native questions, slash menus, attachments and unsupported rich tools
  stay in VS Code. This is a text mirror, not complete provider UI parity.

App-created helpers are filtered by provenance rather than their names. Their saved evidence
remains available under the parent work. Separately launched active helpers can still appear
in the provider's own picker; sciencewithagents cannot promise to hide them there.

## Compatibility and removal

The companion currently supports **macOS arm64**. It checks actual provider connection structure
and runtime capabilities, not a fixed version allowlist. Compatible updates may continue working;
future versions are not automatically certified. An incompatible bridge fails visibly without
replacing the native provider. Updates can require one safe editor reload.

Before uninstalling, choose **sciencewithagents → Restore an original extension** for each
enabled provider, then reload when safe. Restoration only replaces recognized patched bytes;
it never overwrites a later provider update with an old backup. If already uninstalled, reinstall
the companion to restore, or reinstall the provider through VS Code. No reliable uninstall hook
exists. The remaining inert reference alone opens no network connection.

## Privacy

The companion connects only to the app's local loopback gateway. It has no telemetry or provider
credential store. The local producer trusts native programs on this computer; it does not
identify an individual OS account or extension. Browser-origin and remote producers are refused.
The app's authenticated phone/browser routes protect viewers.

Native history stays with the provider. The app retains delivery/stop receipt metadata, not a
second full editor transcript. Browser drafts have their own local storage limits. Cloudflare,
when used for the phone connection, terminates TLS; this is not end-to-end encryption against it.

MIT licensed, distributed from source; **not yet published on the VS Code marketplace**.
[Technical maintenance and release checks](../../docs/VSCODE_MIRROR.md).
