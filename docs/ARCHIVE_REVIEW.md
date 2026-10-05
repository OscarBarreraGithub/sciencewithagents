# Saved requests and archive review

Managers retain owner requests as original saved-message IDs, separate from conversation
previews. Work items can link several source messages, and several items can share one
message. A bare link leaves the message pending review. After reading the whole message and
mapping its independent asks, the manager records an explicit whole-message disposition.
That records triage, not completion. Items still need outcome evidence before closing.
Untriaged inputs return in existing manager boundaries after steering/compaction; no new
human attention items or model turns are created just to repeat reminders. Managers continue
independent work while another item waits. See [the manager contract](WORKER_TOOLS.md#manager-contract).

## Review saved text

Open **Chats → Assisted search → Search saved text**. Enter literal wording, or leave the
field blank to review history. Choose **All retained app history** or a listed editor thread.
Use **Next archive page** until the scan completes, including pages without matches.
**Read full message** opens the original text in parts; its conversation link only navigates.
These reads consume no model allowance. Failed reads retain the query and exact page for retry.

App search examines full retained visible entries and decisions across all projects, archived
chats and workers. Results are previews; follow message parts to read complete wording.
Available VS Code/loaded Codex server threads are scanned through native history pages,
including long messages and individual entries inside grouped tool activity. Each editor
thread is a separate scan. Switching the native thread invalidates its old cursor.

Coverage is limited to retained app evidence and available shared native transcripts on the
selected computer. Offline/unshared editor histories, unsent drafts, other computers and
hidden reasoning are not searched or reported as empty. Reconnect/share an editor and refresh
sources to review it. New records require refreshing the scan; streaming entries can finish
while browsing. Assisted model search remains a separate, bounded ranking of candidates.
No RLM framework, guaranteed recall or automatic sentence-to-task conversion is claimed.

## Typed read routes

`GET /api/archive/editors` lists available editor identities and coverage limitations.
`POST /api/archive/search` accepts `source:"managed"` or `source:"editor"`, a literal `query`,
`limit` (1–50), and the previous `cursor`. Editor requests also require the exact `windowId`,
`threadId` and `provider`. Native scans may return no matches with a non-null cursor; continue.
`POST /api/archive/read` accepts the original result ID, source/record type and character offset;
editor reads require the same native identity. No route accepts paths, shell or arbitrary RPC.

Existing project history/read APIs and saved IDs remain unchanged. Manager tools stay scoped
to their own project, and owner-request source links stay with the receiving manager. The
owner archive routes use the app's existing local/paired and selected-computer boundaries.
