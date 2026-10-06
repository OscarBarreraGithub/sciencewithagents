# Saved requests and archive review

## Archive a conversation

Archiving a chat changes its visibility in ordinary discovery and chat lists. Restore shows
it again. App history, files, running jobs, queued messages and permission requests are retained;
archiving never calls the native provider's archive action. This is separate from removing
a project manager. Saved-text search still includes archived app chats and available shared
native transcripts. Shared archives use provider/thread identity rather than an editor window,
and keep a bounded title/caption so they can be listed and restored while the editor is offline.
Full native history still requires its original source to be available.

`GET /api/conversations/visibility` pages saved visibility metadata (up to 100 rows, with an
optional archived filter and the returned cursor). `POST` accepts a typed app/shared target,
expected revision, archive boolean and durable retry key; concurrent changes require refresh.
Normal conversation/shared discovery hides archives unless `includeArchived=true` is requested.
These owner routes preserve the selected computer and existing local/paired access boundary.

Managers retain owner requests as original saved-message IDs, separate from conversation
previews. Work items can link several source messages, and several items can share one
message. A bare link leaves the message pending review. After reading the whole message and
mapping its independent asks, the manager records an explicit whole-message disposition.
That records triage, not completion. Items still need outcome evidence before closing.
Native terminal turns keep the exact text sent, marked uncertain until Codex acknowledges it.
Rejected input shows as cancelled. The main conversation shows the captured input; generated
turn/compaction receipts remain in full history and are never owner requests. Text-free
attachments remain only in native history. Untriaged inputs return in existing manager boundaries after steering/compaction; no new
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

Manager chat separates internal team/QUARK inputs and replies using their retained `message`
or `report` run, including older replies. Subagents keeps that coordination available; search
still examines the complete history. Owner inputs, system notices, approvals and human work
items remain in the main view. A turn with owner steering conservatively keeps its whole
assistant/tool reply in the main view because a streamed item can span the steering boundary.
`GET /api/agents/:id` accepts `channel=conversation|coordination|all` (default `all`); each
channel filters before paging with the existing `before` entry ID. This changes presentation,
not stored entries or native history.

Managers receive pending owner requests at turn start and coalesced tool boundaries. Steering
and compaction preserve the work list. Before reporting completion, they must reconcile both
the pending prompt pages and the full open work list, including older triaged requests. This is
a durable review workflow, not a guarantee that a model interprets every sentence correctly.
