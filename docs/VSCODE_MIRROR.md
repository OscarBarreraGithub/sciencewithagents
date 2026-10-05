# Shared native conversations: maintenance

The [companion README](../apps/vscode-mirror/README.md) is the user guide. Source is public
and MIT licensed; the marketplace release remains pending. The app's **Chats → VS Code**
control opens connection/setup instructions; conversations live in **Chats → Shared**.

## Architecture and boundaries

The companion observes the selected provider's existing in-process connection, then sends
bounded history and controls through an outbound loopback WebSocket to the app. Remote SSH
workspaces explicitly use a private Unix reverse forward to that same endpoint; there is no
cluster TCP producer listener. The remote native provider and companion must share an extension
host. No new CLI
is launched, unloaded thread resumed, model changed or native approval answered. The gateway
uses its existing authenticated browser/phone consumer routes. Native producer access is
local-only, rejects browser origins and is unavailable through the phone/other-host proxy.
There is no separate editor credential or login.

`agentDockMirror.remoteSocketPath` is a machine-scoped opt-in. Remote extension hosts never
fall back to cluster loopback. Before every connection, the companion checks a same-owner
mode-0600 socket in an unlinked canonical mode-0700 directory. The WebSocket connection uses
its fixed gateway path/Host with a Unix `createConnection` hook, no browser Origin or redirects.
The owner manages the existing native SSH forward; the companion reconnects every four seconds,
reports its failure in connection setup/status, and closes only its own sockets/timers on stop
or setting changes. It never replays pending sends. The [remote setup guide](../apps/vscode-mirror/README.md#remote-ssh-workspaces)
has a copyable setup prompt and exact-forward cancellation instructions.

Actual private forwarding to a disposable loopback HTTP fixture was checked on FASRC, including
0700/0600 permissions and exact cleanup. Disposable local Unix/WebSocket fixtures cover first-run
failure/retry, permissions, reconnect and stop. Actual remote VS Code installation/native controls
remain unverified; this transport preview does not certify remote provider builds or site policy.

Codex uses observed native thread/turn identities for history, text sends, steering and Stop.
Claude uses the selected loaded channel and its native input/interrupt lifecycle. Provider
queue/start acknowledgement, not a display echo, confirms delivery. One conversation per
provider per VS Code window can be shared; their identities and accounts remain separate.

The provider hooks are maintained local modifications, not public extension APIs. Setup saves
exact backups and changes only a checked host file. Native activation must keep working if
hook preparation fails. Do not redistribute provider binaries or patched proprietary assets.

## History, drafts and delivery

Phone pages contain at most 40 entries and 64,000 text characters. Very long entries have
part navigation. Consecutive tool/reasoning activity is grouped so it does not displace the
latest actual message. Tool bodies load on demand. Legacy full responses have an explicit
32 MiB ceiling. Native history is the source of truth; unavailable history is not an empty log.
Codex builds with native turn paging load complete turns once per share and then re-read
only the newest turns as the conversation changes; builds without it keep the full-history
read. Summary or unloaded turns are never shown as a complete transcript.

A slow transcript read keeps the last reading while the editor still answers the bridge's
ping. An editor that stops answering, or whose latest read fails, is shown offline and loses
send, steer and Stop until a newer read succeeds. Polling reads never block a send or Stop.

Drafts and saved views are scoped to computer/provider/conversation/browser. A reconnecting
window can change connection ID without changing thread identity. If it shares a different
thread, the old phone view stays offline rather than sending its draft to the new target.
Offline summaries are bounded; an offline reload cannot reconstruct the editor's full history.

SQLite records send/stop intent before forwarding. Lost replies keep the original receipt;
Check delivery/status is read-only. Never replay an uncertain action after reconnect or crash.
Codex guidance and both Stop paths bind the observed active turn; a stale target is refused.
Codex exposes **Queue next** when a native queue read succeeds; older providers retain
steering and keep unsupported queue sends unsent. Claude follow-up uses its native queue.
A compact, scrollable list shows the provider's current queued messages, including messages
sent from the computer. Queue acceptance is not execution; uncertain receipts retain their
original UUID and are never automatically replayed. Queue reads show up to 100 messages and
mark further native pages. Native questions/permissions stay in the original editor.
Automatic VS Code crash restoration is not promised: reopen the editor/chat and re-share.

## Attachments

Phone composers offer **Attach files** with filenames, sizes, image previews, removal and retry.
Up to four files fit one message; each stored file is at most 8 MB. Authenticated uploads use
generated file IDs under private `data/chat-files/` on the selected host. Older screenshot
references remain available under `data/chat-images/`. Saved drafts and send receipts retain
the references. Before forwarding to the existing native conversation, the server adds local
file paths for its native file/image/PDF tools and a bounded excerpt for UTF-8 text files;
the app hides that transport note. Downloads preserve the file contents and filename. Files
are not automatically executed. This requires the native
agent to read files on the same computer. Unix-forward companions advertise `canAttachImages:false`
in hello and every read. The app disables uploads while retaining saved previews/removal, and the
gateway refuses all attachment references before adding local paths. Remote chats remain text-capable;
attach files in the native remote editor. No remote file-transfer protocol is implemented.

## Helper visibility

The companion and app pickers exclude native subagent ancestry and app ownership tags.
Completed app-owned task/resource/finder cleanup uses native archive while preserving history.
Imported personal conversations are not automatically archived. Native Codex can still label
active standalone App Server helpers as VS Code sessions; provenance does not change that
provider picker. Do not patch its UI or rewrite its database to hide them.

## Existing Codex terminal sessions

Chats → Shared also discovers loaded conversations from a compatible, already-running Codex
shared server, without the companion. It asks the installed CLI for the daemon socket,
verifies the managed link and same-owner Unix socket, and attaches only its own observer.
It does not start/stop the daemon, resume an unloaded thread or change its native settings.

Discovery is limited to 100 loaded sessions; it does not scan saved history. Ephemeral and
non-interactive helpers are excluded. Older isolated or `--no-daemon` terminals are unsupported.
A session before its first turn may not expose history. Simultaneous native/phone sends can
join a reply; this is not an exclusive input lease. Closing the observer leaves native work
running. These sessions are not converted into QUARK-managed workers.

## Compatibility checks

- Detect unambiguous executable structure and required runtime methods/collections rather
  than version strings, generated variable names or a checksum allowlist. Strings/comments
  must not masquerade as code. Refuse ambiguity only for the affected bridge.
- Hashes protect exact restoration, not eligibility of future compatible releases. Preserve
  later foreign edits; keep legacy recognized hooks restorable. Restore before uninstall.
- Test compatible renames/unrelated edits and genuine missing/ambiguous features. Native
  input, streaming and desktop-draft preservation matter as much as a successful API reply.
- First install/update may require a deliberate safe reload. Never reload an active user's
  editor, stop their chat or disable provider updates just to obtain a test result.
- Use a disposable editor profile, provider copy, workspace, gateway and browser. Close owned
  processes afterward. Never replay a user's old prompt to test a repaired bridge.

Live developer probes can consume allowance:

```sh
node scripts/probe-vscode-mirror.mjs --run --stop-reply
node scripts/probe-claude-mirror.mjs --run --stop-reply
```

Use `--steer` for Codex busy-turn acceptance or `--queue` for Claude follow-up. The Claude
fixture can use `DOCK_MIRROR_MODEL` and `DOCK_MIRROR_EFFORT` without editing the user's profile.
Earlier native checks are recorded in Git history; current release limits are in [Status](STATUS.md).
Browser emulation does not certify a physical keyboard/Home Screen or a future provider version.

## Marketplace release

1. Verify a supported platform/provider matrix and actual long-chat, phone/native input,
   disconnect, Stop, stop-sharing and restore behavior.
2. Confirm publisher account ownership and the package's source/support/privacy links.
3. Package only the manifest, bundle, licence, icon and user documentation; inspect the VSIX
   for private fixtures, runtime data and proprietary assets.
4. Publish only with the maintainer's explicit authorization. Source installation remains
   available independently of the marketplace.
