# Local Groups settings

**Manage → Remove from this app** is local visibility, including for the creator. It does not
close the group, revoke membership, delete Cloudflare data, remove credentials or
change native conversations, work, files or saved originals. Restore uses the saved
local enrollment and works without contacting the service. Open **Removed groups** in the
Groups list and choose **Restore group**. A lost acknowledgement keeps **Review saved list
change** after reload; **Check current setting** only reads, while **Retry saved change**
submits the original operation. The app refreshes the current list after an acknowledged retry,
since its saved receipt may describe an earlier state.

The authenticated `POST /api/groups/local-visibility` accepts a saved handle, UUID
key, expected local revision and `hidden` boolean. Exact retries return the original
receipt; a later restore cannot be undone by replaying an earlier remove. Groups
lists return visible groups and a separate removed list with the current revisions.
Local operation, human-send, draft and summary-source receipts share a 2-GiB
conservative byte-admission budget. This replaces small lifetime row-count limits.
Normal records stop at 2044 MiB, leaving 4 MiB for local Read-only/remove controls
and creator revocation intents. Those controls do not enable agents or replay work.
The counter includes retained payload bytes, row overhead and future human-send
receipt space; it is separate from hosted storage, other local databases and physical
SQLite/WAL size. Existing over-budget histories and exact receipt retries remain readable;
new admission refuses before delivery and preserves the unsent draft. No history is pruned.
**Manage → Advanced → Local recovery records** shows the last reported normal receipt budget
from existing list metadata and warns at 80%. It is not a Cloudflare quota or total disk reading;
opening the panel does not start another polling loop.

Removal pauses optional local summary starts and automatic Git/writer/activity
polling. Pending original IDs, batches and native run IDs remain saved. Admission
checks again before a queued summary reaches the provider. A running turn may
finish; previously authorized Ask/Work retains its original authority. Restore may
resume an unstarted saved batch or publish its completed result; failed or uncertain
native turns are not replayed. Passive viewing and removal make no model request.

Current source checks and remaining service/provider acceptance are recorded in [Status](STATUS.md#groups).

## Read-only or Contribute

The visible **Contribute** or **Read-only** button opens this computer’s saved mode selector.
Use Read-only when you want to keep reading without new contributions or model spending.
The host enforces this preference; it is more than a disabled composer. A lost reply retains
**Retry saved mode change** after reload. **Check current mode** only reads, and an acknowledged
retry is followed by a current Groups list read rather than trusting an old receipt.

Read-only pauses new human sends, Ask/Work requests and local action confirmations.
It also holds unstarted group model turns, including summary helpers, before discovery
or provider handoff. Their original queue, request and batch IDs remain saved. Running
work may finish and retain its truthful results. Reading, drafts, history, recovery and
Git file sync remain available; reading and Git transport make no model request.

Contribute resumes already authorized queued work. Changing the mode does not enable
agents, change accounts/models or create a new turn by itself. Failed or uncertain turns
still require their existing explicit recovery; they are never automatically replayed.
If a late startup cannot be proved to have no handoff or measured spend, its original
receipt and evidence remain available for inspection instead of automatic replay.

The authenticated `POST /api/groups/local-mode` accepts a saved handle, UUID key,
expected mode revision and `mode` (`read-only` or `contribute`). Its append-only revisions
are independent of local visibility. Exact old retries cannot undo a later choice;
refresh the Groups list for current `local.mode` and `local.modeRevision`. A missing
setting means Contribute for compatibility, without granting native agent enablement.
