# Private recovery copies

## Everyday use

Open **Settings → Recovery copies**. Choose **Create recovery copy**.
Agent Dock saves an extra snapshot on the selected computer and checks it before
showing **Verified recovery copy**. This does not start a model turn, stop work or
change a conversation. Expand a dated row to see counts, its reference and **Check this copy**.
The list scrolls within a bounded panel; expanded details do not stretch the whole page.

For an app update, open **Use this copy before updating** on a verified copy and choose
**Copy update request**. Give it to the coding agent that set up this computer. The request
includes this copy's reference and the [update runbook](UPDATE_APP.md); it does not start
an update or send a model request. If clipboard access fails, the same text stays selectable.
The agent rechecks prerequisites, active work and the copy before changing the installation.

On a phone, this uses the same paired-browser access as your conversations. With
another computer selected, the copy stays on that computer; it is not downloaded
to the phone or transferred to the entry computer. Only dates, counts, state and
an opaque copy reference are returned to the browser.

The list shows the latest 20 recorded copies. Older copies remain on disk. No
copy is deleted automatically. Existing advanced `dock backup` copies are separate:
they do not acquire a verified receipt merely because they exist in another folder.

Desktop shows update/restore guidance beside the list; phones stack those sections.
Retained browser drafts have their own bounded list below, with their existing read/download
actions. Refreshing either display does not create a new recovery copy or resend a draft.

If a connection fails, **Try again** reuses the same request rather than saving a
duplicate. Its request reference survives a reload in the same browser tab when
session storage is available. A known failed or interrupted copy is not retried
automatically: create another copy after inspecting the message. Failed/partial
files remain private for your setup agent to inspect.

## What this protects

Included is the Agent Dock database: managed conversation entries, agent/task
records and context identities, decisions, approvals and events, retained image
bytes, saved app views/drafts, delivery receipts, and private app security metadata.
Counts describe database records, not proof that all provider context was retained.

Not included:

- Project repositories, unsaved project changes or task worktree files.
- Codex/Claude's original session files, exact provider caches or hidden reasoning.
- VS Code mirror transcripts or drafts that exist only in a browser/editor.
- Provider sign-in files, external credentials, tunnel tokens, host/source-backup
  configuration files, or other files outside the database.

Private information typed into a retained conversation remains part of that
conversation and therefore its copy. “No credential-file export” does not mean
the database contains no sensitive information. Never publish copies or send them
to GitHub, including a private source repository.

**A copy on the same disk does not protect against losing that disk/computer.**
Ask your setup agent to arrange a separate private backup destination for these
copies, your project/worktree files and native provider history. This release
does not set up or verify off-device storage. Reviewed GitHub source checkpoints
are a different protection; see [SOURCE_BACKUPS.md](SOURCE_BACKUPS.md).

## Restore safely — setup-agent runbook

The UI deliberately has no live restore, upload, arbitrary path or download API.
Use the copy reference in **Recovery copies → Copy reference** to identify the
exact file locally. Restore requires local setup-agent help and should not be
presented as complete-machine recovery.

1. Determine the exact selected computer/data directory and copy reference. The
   app stores new files under `data/recovery-backups/recovery-<UUID>.sqlite` (or
   that subdirectory of the configured private data directory). Validate the
   recorded reference, regular-file/private-permission status, saved hash when
   its original receipt is available, and SQLite integrity. A standalone file
   without its original receipt can be integrity-checked, but its original hash
   cannot be independently authenticated from that file alone.
2. Let active work finish or explicitly stop it, then quit Agent Dock. Preserve
   the entire current data directory and all project/worktree/provider files
   separately. Do not overwrite a running database or remove existing data.
3. Copy the chosen database into a **new, separate private data directory** as
   `dock.sqlite`. Never combine it with old `-wal`, `-shm` or journal sidecars.
   Recheck the copied bytes before opening it. The source recovery copy remains
   unchanged. Opening the restored database may perform normal app migrations.
4. Check absolute project/worktree locations, provider session availability and
   the installed account on this computer. Database records cannot recreate
   missing project files, native session files, credentials or provider caches.
   Do not copy another account's credentials or pool its history implicitly.
5. Initially keep the recovered installation **local-only**. Old database
   security metadata can predate device revocation, session locking or account
   changes. Do not restore tunnel/configuration files or expose the connector
   until the setup agent has reviewed current phone trust, invalidated stale
   access as appropriate, and obtained any needed owner decision. Do not
   silently erase the owner's working enrollment in the original installation.
6. Point this installation at the separate data directory through the supported
   host setup, then inspect its records. Interrupted work and old approvals need
   review, not automatic replay. Resume native sessions only when their original
   history/files exist; use an explicit new context otherwise. Verify actual
   conversations and work before declaring recovery complete. Preserve the old
   installation until the owner has accepted the result.

## Implementation and evidence

The service uses SQLite's online backup API. It reserves a new generated filename
with exclusive creation, directory mode 0700 and file mode 0600; existing files
and linked/nonprivate storage are refused. Only the new copy is finalized to a
standalone, non-WAL journal mode before SHA-256 and `PRAGMA quick_check` validation.
Rechecking requires its original digest and refuses unexpected journal sidecars.
Integrity confirms database structure/bytes, not semantic correctness of every
stored record or a successful whole-machine restore.

Creation intent and terminal state are durable SQLite records with append-only
events. Duplicate request IDs reuse the original result, concurrent copy/check
work is bounded to one per store, and local/phone listeners share that operation.
A restart marks unfinished reservations as unverified without replaying them.
Shutdown waits for an owned copy before closing the store. Errors are sanitized;
paths, hashes, conversations and security records are never included in responses.

Implemented in:

- `apps/server/src/recovery-backups.ts`
- `packages/shared/src/recovery-backups.ts`
- `apps/web/src/RecoveryBackups.tsx`

Verification on 2026-09-17: ten focused backend checks cover real online copies,
private permissions, receipts/restart, explicit failure/retry, linked storage,
changed bytes and unexpected journals, API contracts and phone authorization.
One opens a separate restored fixture and compares archived entries, settings
and saved image bytes while the original remains unchanged; this is not a real
provider/account/full-machine restore test. Eight browser checks exercise actual
copy/recheck/reload and first-load/uncertain-response recovery at desktop,
412×915, 360×800 and 915×412. Screenshots are private ignored development evidence.

### Troubleshooting

- **A copy is not a backup strategy:** same-disk snapshots, GitHub source backups
  and off-device private recovery protect different data and failure modes.
- **SQLite sidecars matter:** an online copy can inherit WAL mode. Finalize the
  new copy as a standalone file before hashing; never accept an unhashed sidecar
  as part of a supposedly verified snapshot. Do not change the live database's
  journal mode to achieve this.
- **A lost response is not a failed operation:** preserve its request reference
  across retries. A later status poll must not clear that reference while the
  original response can still fail; otherwise a retry can make an extra copy.
- **Restoring security metadata can restore old trust:** inspect phone revocation
  and remembered sessions before bringing a recovered connector online.
