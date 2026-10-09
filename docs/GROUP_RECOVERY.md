# Private Groups recovery

The ordinary **Recovery copy** contains the main app database. Groups also owns local
journals, membership configuration, immutable report files and workspaces. Ask your setup
agent to make a **Groups recovery archive** before maintenance. This is local maintenance,
not a model request or a Cloudflare deployment. Existing data is preserved.

## Save and check

1. Identify this installation's configured data directory. Let active work finish or
   explicitly stop it; reconcile recorded running work, then quit the app through its
   supported launcher. Do not stop unrelated processes. Keep this installation closed
   until capture finishes, including its optional login service if it was already enabled.
2. Run `node scripts/groups-recovery.mjs save /absolute/path/to/data` from this source
   installation. The command refuses a listener on its configured local port and recorded
   running turns. It never stops processes or changes requests itself.
3. Keep the returned archive reference. Run
   `node scripts/groups-recovery.mjs verify /absolute/path/to/data ARCHIVE_UUID`.
   Check `externalWorktrees`: any nonzero count requires separately preserving the exact
   referenced task folders before treating the backup as complete.
4. Reopen the original installation normally and check its records. Arrange an off-device
   private copy of the archive **and its adjacent receipt** through your own backup service.
   Never send these files to GitHub or other members.

Archives are private directories under `data/group-recovery/<UUID>`, with a separate
`<UUID>.receipt.json`. They include `dock.sqlite`, the complete local `groups/` directory,
and Groups task worktrees beneath this installation's `data/worktrees/`. Existing source
files are untouched. Each SQLite database becomes a standalone checked copy; other files
retain exact bytes and owner executable status. A final source inventory check rejects
changes during capture. Symlinks, hardlinks and special files fail closed. Limits are
50,000 files and 4 GiB per archive. Failed partial directories remain for local inspection;
neither archives nor originals are automatically deleted.

**These archives contain private conversations and local membership credentials.**
They exclude hosted Cloudflare Durable Object state, native provider session/history and
sign-in files, browser-only drafts, and external repositories/task worktrees. They are
same-installation recovery material, not an invitation or a way to clone another member's
identity. A valid local archive does not prove remote-service or provider recovery.

## Stage recovery without replay

Run `node scripts/groups-recovery.mjs stage /absolute/path/to/data ARCHIVE_UUID`.
It verifies the original receipt, every file hash and database integrity, then copies only
manifest-listed files into a new private `data/group-recovery-staging/<stage UUID>`.
It never overwrites the current installation, launches the app, sends messages or resumes
agents. Preserve the original archive and current data.

Inspect the staged database and retained request/result/publication identities. Restore
only with the app stopped, after checking absolute project/worktree paths and the native
account on this computer. Moving to another directory requires a deliberate path migration;
the staging command does not rewrite paths. Preserve current phone trust and membership
revocations: an older local credential does not restore revoked remote membership. Review
uncertain or pending work against current authoritative receipts; do not reset IDs, replay
model input or copy another person's credentials. Follow the broader
[recovery-copy runbook](RECOVERY_COPIES.md#restore-safely--setup-agent-runbook).

## Capacity and hosted service

Local recovery does not raise the service's finite admission limits. If a retained journal
or hosted service is full, preserve its identities and originals and stop new mutations;
reads and exact receipt reconciliation must remain available. Changing endpoints, clearing
journals or making a new operation ID is not a repair for uncertain work. Use the separate
[creator-authorized hosted archive](GROUP_HOSTED_RECOVERY.md) for remote application SQL.
It requires current creator authority and a quiet snapshot, retains exact IDs and does not
restore state automatically. Never substitute a local archive for that remote export or
claim deployed/full-capacity recovery has been validated by fixtures.
