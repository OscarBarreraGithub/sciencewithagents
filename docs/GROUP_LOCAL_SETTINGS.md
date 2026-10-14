# Local Groups settings

**Manage → Remove from my app** appears directly below the dialog heading. It hides the
group locally, including for the creator. It does not close the group, revoke membership,
delete Cloudflare data, remove credentials or change native conversations, work, files or
saved originals. Restore uses the saved
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
Normal records stop at 2044 MiB, leaving 4 MiB for local sharing-pause/remove controls
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

## Pause automatic sharing

The **Automatic sharing: On / Paused** button opens this computer’s saved setting.
**Pause automatic sharing** holds new group-agent requests, queued summaries and model
handoffs; **Resume automatic sharing** may process already authorized queued work using
provider allowance. Reading and manually sending group messages use no model and remain
available while paused. Your normal private Claude conversation remains native. Phone
posting is a separate explicit pairing permission: a phone without it still cannot send.

The host enforces the pause. Ask/Work, action confirmations and new report/file/profile
publications still require resuming; repository sign-in, access checks and existing Git
sync remain available. Original queue/request/batch IDs and drafts stay saved. Already
running work may finish, and exact pre-pause receipts can still reconcile. Pausing does
not cancel work or discard backlog; changing this setting does not enable an agent or
change accounts/models. Failed or uncertain turns retain their explicit recovery and are
never automatically replayed.

A lost reply retains **Retry saved sharing change** after reload. **Check current sharing
setting** only reads. An acknowledged retry reads the current Groups list rather than
trusting an earlier receipt. If a late startup cannot be proved to have no handoff or
measured spend, its original evidence remains available instead of automatic replay.

The authenticated `POST /api/groups/local-mode` accepts a saved handle, UUID key,
expected mode revision and `mode` (`read-only` or `contribute`). Its append-only revisions
are independent of local visibility. Exact old retries cannot undo a later choice;
refresh the Groups list for current `local.mode` and `local.modeRevision`. A missing
setting means automatic sharing On for compatibility, without granting native agent enablement.
