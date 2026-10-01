# sciencewithagents for Codex and Claude Code

A small, **unofficial private preview** that mirrors existing VS Code Codex and Claude Code conversations
to your paired sciencewithagents phone. It does not start another agent or move the conversation.
This is not an OpenAI or Anthropic product and is not endorsed by either provider.

## Before you begin

You need Codex or Claude Code installed, signed in and working, and a running sciencewithagents installation.
Both are optional independently; having one does not install or require the other.
For phone use, finish sciencewithagents's phone pairing first. No additional account, tunnel,
password or public port is created by this extension. Your computer must stay awake with
VS Code and sciencewithagents open. SSH/remote extension hosts are not certified by this preview.

## Start mirroring

1. Install the review VSIX using VS Code's **Extensions → … → Install from VSIX**.
   Companion **0.2.7** connects directly to the app on this computer. No separate editor
   login, connection code or saved editor credential is required.
2. Click **sciencewithagents** in VS Code's bottom status bar. Choose **Share a Codex conversation**
   or **Share a Claude Code conversation**. The same menu handles initial setup and sharing.
   First-time setup modifies one checked provider file and saves an exact backup. Both providers
   check the connection structure they need; a new version number alone is not a blocker.
   Other extensions' webview customizations are not rewritten.
3. When current work is safe, choose **Reload window** once. Reloading restarts the extension
   host, so do not do it during important running work. Subsequent phone/desktop handoffs
   need no reload. Open your saved conversation in the original provider extension.
4. Click **sciencewithagents**, choose the provider's share action, and select your conversation.
5. Select that conversation under **VS Code chats** in sciencewithagents's normal chat list,
   on your computer or paired phone. Type or paste
   a message and press **Send** (Enter also sends; Shift+Enter adds a line).

Only your chosen conversations are shared: one per provider per VS Code window. You can
share Codex and Claude Code at the same time; they remain separate conversations with their
original accounts and tools. To stop, click **sciencewithagents → Stop sharing** and choose one or both.
The status bar shows sharing/connection state. If sciencewithagents is closed, open it again;
the extension reconnects without sending a message. A saved choice is remembered per
workspace; open the original conversation in its provider after a VS Code restart.
VS Code crash recovery is deliberately not a requirement of this lightweight mirror:
reopen the editor and its original saved conversation, then share it again if necessary.
sciencewithagents's managed conversations have a separate, stronger restart workflow.

Already using the companion? Version **0.2.5** removes the separate editor authentication
introduced in 0.2.4 and sends bounded history pages. Install it, then activate it with a
safe editor reload; never interrupt running work for an update. The updated app also pages
older companions' replies, so the phone fix does not require reloading an active editor.
Provider selection, native histories, drafts and phone pairing are retained.

Long conversations open at their latest section. **Older messages**, **Newer messages**
and **Back to latest** navigate without loading the whole conversation onto your phone.
Tool results are opened on demand; very long entries have **Previous part / Next part**.
The original text remains in VS Code. Routine reconnects never send a message.

The same menu offers **Open sciencewithagents chats** and **Open native commands and settings**.
The latter opens Codex's own command menu or Claude Code's original chat, where `/` opens
its native menu. Nothing is pasted into a draft and no setting is changed automatically.
Existing **sciencewithagents Mirror** command names and saved shortcuts remain supported.

## Exactly what this preview does

- Reads the saved transcript, including desktop-submitted messages and available tool
  activity; refreshes live output while open. This is not a screenshot of a scroll viewport.
- Sends plain text to that same loaded conversation through its existing native connection.
  It does not resume, fork, reconstruct context, change models/permissions or manage MCPs.
  Native picker changes that have not yet been applied to a turn are not copied to the
  phone: it inherits the loaded conversation's last applied settings.
- Keeps unfinished drafts separate. Sending from the phone never pastes into the desktop
  editor, steals keyboard focus or changes the clipboard.
- Updated companions allow **Send guidance** during Codex work, bound to the exact observed
  native turn. If that reply finishes first, guidance is refused without starting another turn.
  Claude Code offers **Queue follow-up** through its existing native input queue. A matching
  provider queue/start acknowledgement confirms acceptance; queued does not mean processed.
  Older companions keep busy input disabled. Native approval/input requests remain in VS Code
  and block these actions; there is no remote auto-approval or command endpoint.
- Records a delivery receipt before sending. A lost response offers **Check delivery**,
  not an automatic resend. Inspect VS Code before clearing an uncertain receipt.
- **Stop reply** interrupts the observed active reply through the original provider.
  It cannot silently target a newer reply, answer a permission request or undo completed
  actions. **Check stop status** reads the saved receipt without repeating the stop.
  After an uncertain result, inspect VS Code before clearing that receipt. Queued work
  retains the provider's own behavior; this is not a cancel-everything command.

This is a text mirror, not full provider UI parity. Native slash-command pickers, attachments,
interactive tools, image rendering, model controls, permissions and settings remain in
VS Code. Unsupported saved activity is labeled with a request to view it there. Retained
visible history is not hidden reasoning or a full context-cache backup. Current companions
send only the requested history section. Older companions still have a 32 MiB full-response
limit, reported explicitly. Live view refresh is approximately 1.5 seconds; earlier history
refreshes every five seconds, and hidden pages pause polling. Claude Code's
saved transcript is refreshed at most every five seconds, merged with observed live output.
Claude slash-leading messages are refused with guidance to use the native command menu;
this preview does not claim remote command/settings parity.

## Compatibility and recovery

This preview supports **macOS arm64**. Both providers check their actual connection
structure and runtime capabilities, not a version/checksum allowlist. Compatible updates,
including changes to generated names or unrelated code, can keep working. Real native
messaging has been tested on **Codex 26.908.40401** and **Claude Code 2.1.273 and 2.1.274**;
Stop reply and same-session follow-up passed with Codex 26.908.40401 and Claude 2.1.274.
Future versions are not
automatically certified, but are no longer rejected just for being new. An update can still
require one deliberate reload to activate its prepared hook if the provider loaded first.

The steering and native-queue additions have focused race, retry and compatibility tests.
Local inspection confirmed Codex 26.917.62051's exact-turn steering protocol and Claude Code
2.1.284's queue lifecycle acknowledgements. These additions have not yet had a live provider
or physical-phone acceptance check. Updating this companion requires a safe editor reload;
no active conversation is automatically reloaded or used for a test message.

If the required connection structure really changes, only that provider's sharing stops with an
explanation; its native extension remains available. sciencewithagents never guesses a different session,
replays input or overwrites later file edits. Exact backups/restoration remain required.
Hashes protect restoration and record tested evidence; they do not reject compatible
updates. Leave provider updates enabled. A failure in either provider does not disable the other.

Choose **sciencewithagents → Restore an original extension** for each enabled provider before uninstalling.
It stops sharing and restores only a byte-for-byte recognized patch; reload when safe.
Uninstalling VS Code extensions does not run a reliable cleanup hook. If you uninstall
without restoring, the remaining patch only exposes an in-process reference: it opens no
network connection on its own. Reinstall this companion and restore, or reinstall Codex
or Claude Code through VS Code. Never copy an older backup over an upgraded provider installation.

## Privacy and trust

No telemetry, cloud backend, provider credentials or second model login. The extension
connects outward only to sciencewithagents on `127.0.0.1` (default port 4330). Existing sciencewithagents
phone authentication protects remote reads, sends and stop requests. The editor producer
trusts native programs on this computer, including other OS accounts; it does not identify
a particular extension. Browser-origin producers and remote producer connections are refused.

Conversation content travels through sciencewithagents to its authorized viewers. The provider retains
history; this preview does not create a second transcript archive. sciencewithagents saves send/stop
receipt metadata and a hash, not a second copy of message text. Browser drafts and unresolved
receipts stay in that tab's session storage and are not telemetry. Cloudflare, if used for
your existing phone connection, terminates TLS; this is not end-to-end encryption against it.

## Review and publication

This VSIX is a private review artifact, **not a marketplace release**. Review the live
desktop/phone workflow, choose the public license/source location, verify publisher
ownership and finish the release checklist in `docs/VSCODE_MIRROR.md` before publishing.
No OpenAI or Anthropic binary or patched provider source is redistributed in this package.
