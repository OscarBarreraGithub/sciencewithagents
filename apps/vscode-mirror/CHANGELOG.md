# Changes

## 0.2.9

Recheck helper provenance before sharing history or sending a message, and clear a saved
selection if it now resolves to a background helper. Personal chats with matching names
remain available.

## 0.2.8

- Use the original hand-drawn alien for the extension icon.

## 0.2.7

Loaded-chat sharing choices exclude native subagents, temporary sessions and
sciencewithagents-owned helper sessions using provider provenance. Saved task history
is retained. This changes the companion picker; the native Codex picker remains owned
by Codex.

## 0.2.6

Send instructions during active work: Codex steering targets the observed current reply,
and Claude follow-ups use its native queue with provider acknowledgement. Existing saved
delivery receipts prevent duplicate sends after connection loss. Tool bursts become one
expandable activity summary so messages stay visible; original activity remains paged and
available on demand. Activate this update at a safe editor reload; no reload is forced.

## 0.2.5

Remove the separate VS Code authentication and connection-code flow at the owner’s request.
Share directly with the native local app. Negotiate bounded history pages so long
conversations do not send their full transcript on every phone poll. Native provider
permissions, selected conversations and phone pairing remain unchanged.

## 0.2.4

Add **Connect this editor** using a one-time code from the desktop app. Store the narrow
bridge credential in VS Code SecretStorage, pin the workspace identity and verify the app
before sending one-use connection proofs. Reconnects preserve existing shared conversation
choices and refuse a mismatched workspace. No provider account changes or automatic sends.
Existing windows activate this update at their next safe reload; no reload is forced.

## 0.2.3

Rename visible companion menus and help to sciencewithagents. Existing extension, command, bridge and pairing identifiers stay compatible. No native editor reload is forced.

# Changelog

## 0.2.2 — compatible Codex updates and safe Stop reply

- Codex now uses structural and runtime capability checks like Claude. Compatible
  updates need no new version/hash allowlist; exact backups and legacy undo remain.
- Stop the observed native reply from Agent Dock for either provider. Saved receipts,
  consumed controls and read-only status checks prevent duplicate or stale stops.
- Claude interrupted/error results now release the phone composer after actual completion,
  without changing native state or treating the stop acknowledgement as an idle signal.
- Both providers passed isolated real stop/follow-up, bidirectional messages, separate
  draft, history reload and byte-exact restoration checks. Editor crash recovery remains
  separate from Agent Dock's managed-session restart behavior.

## 0.2.1 — tolerate compatible Claude updates

- Replaced Claude's exact version/checksum allowlist with parsed host-construction and
  runtime capability checks. New versions, minifier renames and unrelated edits no longer
  block sharing; actual missing/ambiguous capabilities stop only the affected bridge.
- Kept exact backups, idempotent setup, guarded restoration and the 0.2.0 undo path.
  Observation-hook failure cannot block native activation or native input.
- Verified real bidirectional sharing on Claude Code 2.1.274, native draft preservation,
  history reload and restoration. Codex's existing adapter is unchanged.

## 0.2.0 — shared chat navigation and Claude Code preview

- One Agent Dock status-bar menu for initial setup, sharing either provider, native
  controls, stop sharing and reversible restoration. Codex and Claude Code are optional
  independently, and can both be shared from the same VS Code window.
- Version/checksum-pinned Claude Code 2.1.273 adapter uses its existing loaded channel,
  retained transcript and original approvals. Plain text only; native drafts stay separate.
  Phone sends wait for an actual provider acknowledgement, not the local display echo.
- Agent Dock opens shared conversations in its central chat view and normal navigation.
- Provider-scoped sharing preferences migrate existing Codex choices without losing them.
- Still a private preview; not published to the marketplace.

## 0.1.0 — private review preview

- One explicitly shared existing Codex conversation per VS Code window.
- Saved transcript, live output and text submission through the original connection.
- Reversible, checksum-pinned compatibility patch; no provider process or credentials.
- Existing Agent Dock pairing protects phone access. Approvals remain in VS Code.
