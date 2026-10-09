# Local Groups settings

`Remove from my app` is local visibility, including for the creator. It does not
close the group, revoke membership, delete Cloudflare data, remove credentials or
change native conversations, work, files or saved originals. Restore uses the saved
local enrollment and works without contacting the service.

The authenticated `POST /api/groups/local-visibility` accepts a saved handle, UUID
key, expected local revision and `hidden` boolean. Exact retries return the original
receipt; a later restore cannot be undone by replaying an earlier remove. Groups
lists return visible groups and a separate removed list with the current revisions.
The existing finite Groups operation history also bounds these retained receipts.

Removal pauses optional local summary starts and automatic Git/writer/activity
polling. Pending original IDs, batches and native run IDs remain saved. Admission
checks again before a queued summary reaches the provider. A running turn may
finish; previously authorized Ask/Work retains its original authority. Restore may
resume an unstarted saved batch or publish its completed result; failed or uncertain
native turns are not replayed. Passive viewing and removal make no model request.

Source checkpoint: SWA-GROUPS-LOCAL-REMOVE-20261009. The backend is separate from the
normal interface controls and from actual service/provider acceptance.
