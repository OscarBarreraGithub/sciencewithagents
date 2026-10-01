# Shared native conversations

## Helper visibility

Companion 0.2.7 filters its loaded-chat choices by native subagent ancestry and
sciencewithagents ownership tags. The app's native-daemon and saved-session pickers
use the same rule. Task/subagent history remains accessible from its parent work.
The installed native Codex picker already defaults to interactive sources, excluding
native subagents. It still treats separately launched App Server helpers as VS Code
sessions: our provenance tag does not hide an active helper there. Finished app-owned
task/resource/finder cleanup uses native archive, keeping the rollout readable. Imported
personal chats are never automatically archived. Restart the editor normally to activate
an updated companion; no reload is needed for native archive cleanup or the app filters.

## Existing Codex terminal sessions

**Chats → Shared** now also lists loaded conversations from an already-running Codex shared
server. Select a **Codex session** to read, send, guide the observed active reply or request
Stop. No companion, new sign-in, import or replacement agent is needed for this path. VS Code
sharing still uses its existing companion. The Chats VS Code status counts editor connections
only; the Chats card counts native Codex sessions separately.

The app asks the installed CLI for its existing daemon socket, follows its managed link to
an owned Unix socket, and connects only its own client. It never starts, stops or reconfigures
the daemon, resumes an unloaded thread, changes the model/permissions, or answers native
requests. Original approvals and advanced controls stay in Codex. A fresh session may not
expose history before its first turn; the app says so explicitly while allowing input when
native metadata confirms it is idle. It never labels unavailable history as an empty archive.

Phone and native terminal input share the same conversation. Simultaneous sends can join
the same reply; this is not exclusive input ownership. Steering and Stop target exact observed
turns. Lost acknowledgements retain a durable receipt and are never automatically replayed.
Closing the app's observation connection leaves the terminal and its work running. These
outside sessions are not converted into QUARK-managed workers.

This requires a running compatible Codex shared server, verified here with CLI 0.158.0 and
managed daemon/native terminal 0.159.2. An older isolated terminal or `--no-daemon` session
cannot be attached through this interface. Only up to 100 loaded sessions are discovered;
ephemeral and explicitly non-interactive helper threads are excluded. It does not scan saved
history. Native responses are bounded to 32 MiB; phone pages keep the existing 40-row/64,000
character bounds and lazy tool expansion. Unknown future protocol changes remain a
compatibility limit, not grounds for patching a binary or changing native permissions.

## 2026-09-30 — message-first history and instructions during work

Companion **0.2.6** adds native Codex steering and explicit Claude queued follow-ups. A
Codex update targets the observed current reply; if it ended meanwhile, the app keeps the
draft rather than starting a new reply. Claude sends through its existing native queue and
requires the provider's acknowledgement. The phone labels that action **Queue follow-up**;
it does not promise immediate steering. Both reuse durable delivery receipts, including
lost responses, refreshes and editor reconnection. Neither stops work to inject a message.

Consecutive tool/reasoning events now occupy one expandable activity summary. History
pagination counts these summaries alongside actual messages, so hundreds of tool calls
cannot displace the last user request and progress reply. Expanding a summary reads a
bounded page of original activity, with earlier/later actions and long-result parts retained.
The original native history is unchanged. Old companions retain their supported controls;
the new capability requires activating the updated companion, without separate sign-in.

Focused native-adapter, gateway and desktop/mobile browser checks pass, including iPhone
WebKit and lost-response/reload journeys. Isolated real Codex and Claude editor runs also
verified busy-turn steering and acknowledged queued follow-ups, respectively, with both
views synchronized and unsent desktop drafts preserved. The 0.2.6 package is installed;
activation in the owner's active editor remains a separate safe-reload step.

For this installed update, wait until the current native reply and tools finish, then use
**Developer: Reload Window** in VS Code and reopen the same saved conversation if needed.
Refresh the phone view. Re-share that same conversation only if it did not reconnect.
No new sign-in or phone pairing is needed. Reloading while a turn is active can interrupt
it; do not reload the owner's editor automatically. A server restart cannot replace the
bridge already loaded inside the editor. After activation, the shared window advertises
`canSteer` for Codex or `canQueue` for Claude.

## 2026-09-29 — direct local sharing and bounded phone history

The owner reported a phone freeze on the real 6,309-entry, 20,668,927-byte conversation.
The client fetched and rendered its entire history every second, including collapsed tool
bodies. Earlier small-fixture checks and a successful connection did not cover this case.

Companion **0.2.5** removes the separate editor authentication/code flow at the owner's
explicit request. The server accepts native loopback producers without credentials; browser
origins and the remote producer route remain blocked. Browser/phone consumer authentication
is unchanged. Existing 0.2.4 windows can keep working until a safe reload; their old proof
format remains readable for compatibility, but no editor credential is required or issued.

Phone reads now contain at most 40 entries and 64,000 text characters. Entries longer than
8,000 characters have explicit part navigation; older/newer pages retain stable entry
cursors and original history. Tool bodies mount only when expanded. Unchanged entries skip
Markdown reconstruction; hidden views stop polling, and earlier pages refresh less often.
0.2.5 pages before the local socket, while the server pages full responses from older
companions. No owner conversation was sent a test prompt or stopped. See VERIFICATION.md
for the actual-history replay evidence and remaining physical-phone confirmation.

## 2026-09-28 — companion 0.2.4: authenticated local connection (superseded)

Companion **0.2.4 is installed locally**, without reloading an active editor. At the next
safe reload use **Editor chats → Connect editor** in the app, then **Connect this editor**
in VS Code’s sciencewithagents menu. Its one-use code grants only the editor bridge; the
credential is saved in VS Code SecretStorage and pinned to this workspace. Subsequent
reconnects verify the app and send fresh proofs. No provider token, account change, native
thread replacement or automatic message is involved. Prior provider/share choices remain.
The normal app now requires this connection; the older companion cannot connect anonymously.
See [local access](LOCAL_ACCESS.md). Automated client/backend and UI checks pass; no live
provider mirror after activating 0.2.4 is claimed until the editor is safely reloaded.

## 2026-09-17 — companion 0.2.2: compatible updates and Stop reply

The owner has confirmed working Claude phone/desktop sharing. This is not a fresh pairing
or sign-in task. Companion **0.2.2 is installed locally**, adding structural Codex compatibility
and a typed **Stop reply** action for both providers. No editor reload was forced; activation
requires a deliberate reload when work is safe. This is not marketplace publication.

Verified with 81 extension tests and two separate ten-check real-provider probes:

- Codex **26.908.40401**: `data/mirror-vscode-x0wyiH/evidence.json`.
- Claude Code **2.1.274**: `data/claude-mirror-vscode-WOGCEp/evidence.json`.

Both used new disposable conversations, copied provider files, separate editor profiles,
workspaces, gateways and phone-sized browsers. Each proved actual provider activation,
bidirectional messages, separate native drafts, retained history after browser reload,
phone Stop acknowledgement for the observed reply, return to idle, a same-session follow-up,
stop sharing and byte-exact restoration. The evidence/screenshots are private ignored runtime
files, not shipped assets. Test processes were closed; the owner's editor/app were not
reloaded. Physical phone, other platforms and long-history limits remain separate checks.

Future troubleshooting wiki incident: the first Claude Stop probe
(`data/claude-mirror-vscode-yISZRH`) received a real stop acknowledgement and displayed
**Interrupted** in native Claude, but the phone stayed busy. Claude's `turnComplete` field
also records successful completion and remains false after an interrupted/error result.
The adapter now records the original terminal result, clearing that observation on a new
native message, started command, non-idle session event or changed binding. It still checks
outstanding sends, queued work, background tasks and approvals; it does not rewrite native
fields or infer completion from a stop acknowledgement. The successful follow-up probe
above verified the correction. Regression tests also cover changed query/channel identity,
stale tokens, simultaneous controls, disposal, timeout and lost confirmation.

The owner explicitly does **not** require automatic VS Code crash restoration. This mirror
can remain less flexible than Agent Dock's managed/native-terminal workflow. Reopen VS Code
and its original saved conversation, and share it again when needed. Do not reconstruct
the editor's context, start a replacement agent, or silently replay input after a crash.

## Purpose and navigation

The owner explicitly accepted a maintained monkeypatch and requested the smallest possible
live mirror: saved output, text input and synchronization with human desktop submissions.
This supersedes the earlier requirement to stop/resume an existing private-pipe conversation.
The one-time installation reload is different from ordinary handoff: the existing sidebar
continues to own the live conversation after setup.

The owner subsequently confirmed the original mirror works. Its web UI is now a normal
**VS Code chats** section: select a chat in the sidebar (phone: open the chat menu), read
and reply in the central pane, or choose **All chats** to see connections/setup guidance.
It no longer floats over an unrelated manager conversation. Offline and working states
are explicit; updated companions offer Codex steering or Claude queued follow-ups during work.
The composer stays at
the bottom, history scrolls independently, and **Latest messages** returns to live output
without pulling the reader away from older messages.

## Chat navigation and recovery contract

- Codex and Claude Code have distinct labels/identities; selecting one never changes
  another's model/account or converts an existing thread to a different provider.
- Shared conversations appear automatically while the companion is connected. Selecting
  one is read-only until **Send**. Unsharing/offline never automatically sends old input.
- Reload restores this browser tab's selected chat, known summaries and separate drafts.
  Session storage is scoped to the selected computer and provider. It is not a promise
  that closing/clearing a tab preserves an unsent draft or transfers it to another device.
- Previously observed offline summaries stay visible (up to 50). Loaded messages stay
  visible until navigation/reload. Full history still comes from the original editor;
  an offline reload clearly waits for it rather than presenting an empty log as complete.
- An editor restart can change the connection ID without changing provider/thread identity.
  If the editor shares a different thread, the current phone chat stays offline; select
  the other chat deliberately. This prevents a saved draft reaching the wrong conversation.
- Pending deliveries retain their original receipt through navigation/reload. **Check
  delivery** reads that receipt, not a fresh send; explicit human inspection is required
  before clearing an uncertain result. Late completion cannot clear another chat's draft.
- **Stop reply** targets an observed active reply, not whichever work happens to run later.
  Lost confirmation offers **Check stop status**, a read-only receipt lookup. Clearing an
  uncertain receipt requires explicit native inspection and never replays that stop.
- Project managers, team views and their existing draft/recovery rules remain separate.
  Claude mirroring is independent of Agent Dock-managed Claude workers; see the current
  [feature map](FEATURES.md) for that separate runtime's readiness and limitations.

See [the extension's user guide](../apps/vscode-mirror/README.md) for install/share/stop/restore.
The source lives in `apps/vscode-mirror`; it is a normal, bundled VS Code extension, not a
Codex plugin/MCP and not another provider runtime. Do not publish the private Agent Dock
repository, model histories or runtime fixtures as part of packaging.

## Small architecture

```
Codex / Claude Code extension's existing private connection
  ↕ one in-process reference + companion observer/text sender/stop control
Agent Dock Mirror extension — outbound loopback WebSocket
  ↕ narrow read / send / observed-reply stop contracts, no arbitrary RPC
Agent Dock gateway — existing paired-device authentication
  ↕
Computer browser / phone central chat
```

The Codex patch adds only an in-process reference at activation. The companion subscribes
as a provider, reads `thread/read` with saved turns and uses `turn/start` with text only.
Stopping uses `turn/interrupt` with the exact observed native turn ID. A control is consumed
before dispatch, so two devices or a late retry cannot interrupt that turn twice.
It never launches Codex, loads an unselected history, answers an approval or calls resume.
Thread selection is a native VS Code action, not a phone-controlled filesystem or thread
adoption operation. The original native UI continues to receive provider notifications.
The shared [protocol documentation](https://learn.chatgpt.com/docs/app-server) guided these
operations; the extension hook is an unsupported local implementation detail.

Claude Code has a separate small adapter behind the same companion/menu and gateway.
Its structurally located activation hook exposes the existing in-process host. The adapter lists
already-loaded native channels, reads the original saved-session response, observes live
output, and sends a plain user frame through the original transport. Native replay display
shows the sent message without editing the native composer. That display echo is **not**
a delivery receipt: confirmation comes from the provider's command lifecycle/replay/result.
Ambiguous/closed channels fail closed. No Claude CLI/SDK process is launched or resumed.
Both providers can be shared concurrently, one conversation per provider per VS Code window.
Claude Stop invokes the original selected channel's captured `query.interrupt()`; the adapter
invalidates its token on a new native turn, channel/query replacement or completed result.
It does not request cancellation of all queued work. Original approvals stay native.
The official [Claude VS Code guide](https://code.claude.com/docs/en/vs-code) describes the
native controls this adapter preserves. Its private hook is not a documented extension
API, nor Claude's separate [Remote Control service](https://code.claude.com/docs/en/remote-control).

The shared Zod contract allows only window discovery, selected history read, text send,
observed-reply interruption and read-only delivery-receipt lookup. Provider is part of the dispatch identity, not a request
to change a conversation's model. **Check delivery** uses GET and cannot create a first send.
The extension producer route exists only on the local gateway, rejects browser origins,
and is excluded from computer-proxy routing. Existing phone pairing guards consumer routes.
32 KiB WebSocket limits remain unchanged. Updated companions send bounded history pages;
legacy full responses have a 32 MiB ceiling with an explicit failure rather than silent truncation.

Awaiting-approval and disconnected states remain explicit and are checked at submission.
The common native request boundary reserves pending starts to prevent simultaneous device
submissions from slipping between the check and write. Desktop drafts are never edited.
Codex steering uses the original native turn precondition; Claude queued input uses its
native command lifecycle. This preview does not recreate every editor queue control.
SQLite records send/stop intent before forwarding; crashes/disconnects never automatically
retry an uncertain action. Stop acknowledgement means a request was received, not that
completed actions were undone. Retained provider history remains the transcript source of truth.

## Compatibility maintenance / future troubleshooting wiki

- Initial tuple: VS Code 1.137.0 on macOS arm64, Codex extension 26.908.40401;
  original bundle SHA-256 `820691c93be40e73f0929b633cddc694b41775050cd72283faba283e53941f4f`.
- Claude tuple: VS Code 1.137.0 on macOS arm64, Claude Code 2.1.273;
  original extension-host SHA-256 `60bde6e451ab360d03cfc30f6ef19cb4c8d4e43c92b56861dd0d957f07836a25`.
  Also real-tested: Claude Code **2.1.274**, original host SHA-256
  `613726e21950df0779e418ccb82f21b59bc71eeaca6cec7eb6db2afb5b08cded`.
  Only that host file is touched; existing ClaudeTeX/webview assets stay untouched.
- From companion **0.2.1** for Claude and **0.2.2** for Codex, these hashes are evidence,
  not an allowlist. Parse the executable host/connection class and construction,
  independent of generated identifiers or version.
  Require one unambiguous match and the expected runtime collections/methods/channel state.
  Strings/comments cannot masquerade as a match. Compatible future updates are allowed;
  actual structural/runtime incompatibility disables only the affected bridge with an explanation.
- Keep exact backups and unchanged destinations; restore only recognized bytes through
  atomic replacement. Later foreign edits are never overwritten. Legacy 0.2.0 hooks remain
  recognized. Hook failure must not interrupt native activation/input/output. Check both
  compatible renames/unrelated edits and true missing/ambiguous features in regression tests.
- Codex structural v2 checks the required connection methods/collections and one construction.
  The original v1 hash is retained solely for byte-recognized legacy undo, not new-version
  eligibility. Existing recognized v1 hooks remain usable. Inspect actual breakage in a disposable copy, not by replaying
  owner work or disabling provider updates. One provider's failure does not stop the other.
- First install requires an intentional window reload. Never reload the owner's active
  window during work just to run an acceptance test. Subsequent handoff needs no reload.
- Never ship a copy of Codex's proprietary extension assets or its provider binary.
- No reliable uninstall callback exists: restore before uninstall. The inert export alone
  does not create network access if the companion is disabled/removed.
- Saved history and live notifications are different concerns. Verify actual streaming,
  desktop text, native visibility of phone input and unsent-draft preservation, not just a
  successful `turn/start` response. Older rendered DOM is not a complete-history source.
- An uncertain send is not a request to retry. Inspect native history, then clear the
  original receipt deliberately. Do not replay a user's failed usage/reset commands.
- Developer fixtures use their own profile, extension copy, workspace, gateway and browser.
  Close all owned processes and check listeners afterward. Do not kill normal VS Code,
  Chrome, the user's Codex processes or the normal Agent Dock phone connector.

## Bounded acceptance / release gate

Live isolated Codex and Claude acceptance passed, including Stop and follow-up, as recorded
above and in VERIFICATION.md; the owner also confirmed the phone/editor sharing workflow.
It remains a private preview, with long-conversation,
other-platform and publication checks separate. Unit and mocked browser checks alone do
not prove a new provider's native sidebar integration.
Run the Codex opt-in fixture with `node scripts/probe-vscode-mirror.mjs --run --stop-reply`, or Claude
with `node scripts/probe-claude-mirror.mjs --run --stop-reply`; each follows VS Code's registered
installed macOS provider and makes clearly labeled disposable model turns. Omitting
`--stop-reply` runs the original message/handoff probe without the extra interruption turns.
Use `--steer` for the real Codex busy-turn check or `--queue` for Claude's native queue.
For the Claude fixture only, `DOCK_MIRROR_MODEL` and `DOCK_MIRROR_EFFORT` can select native
model/effort settings without changing the owner's editor profile.
Never run it against an owner's existing conversation.

Before marketplace publication:

1. Owner reviews the VSIX and physical phone ↔ native keyboard exchange, including an
   existing long conversation, active work, disconnect, stop-sharing and restore.
2. Record the exact passing platform/provider matrix. Other platforms remain refused;
   compatible but untested provider versions are allowed, not represented as certified.
3. Choose public licensing, source/release repository and support/privacy URLs. Confirm
   `oscarphysics` publisher control; no token extraction or marketplace publication is implied.
4. Package only the manifest, bundled companion, licenses and user-facing documentation.
   Inspect the VSIX file list and scan it; never ship runtime data or proprietary assets.
5. Publish a pre-release only after owner approval. Keep compatibility updates small and
   repeat apply/restore, transcript, bidirectional send, permissions and retry checks.

Prepared behavior is not universal provider UI parity. Native approvals, images/attachments,
slash menus and advanced controls stay in VS Code. Other terminal clients are not attached.
