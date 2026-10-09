# Shared files in native Groups

Group messages use the creator's Cloudflare service. Shared files use a separate GitHub
repository. Joining a group does not grant access to that repository.

## Connect a repository

1. Choose the existing local folder you want to share. The native chooser or app folder
   browser returns a saved selection; choosing it needs no GitHub setup or agent access.
   After creating or joining the group, attach that selection as its shared work folder.
   The app rejects its private storage, folders inside it, and parent folders containing it.
2. Use the GitHub setup prompt with your setup agent for that chosen folder. Sign in to your
   own GitHub account. Supply your GitHub username, not your group display name. Unknown
   usernames can stay blank.
3. Create or use the intended private repository without replacing existing local history.
   The owner invites the intended GitHub accounts; each member accepts and verifies access
   using their own account. Never copy credentials between members. Initialize a new
   repository once on the creator’s computer (an empty initial commit is sufficient), then
   have members clone that same history. Do not initialize separate roots.
4. The setup agent connects the repository to the selected **shared** workspace for this
   group. It must preserve existing files, remotes, branches and running work. Do not connect
   the private conversation's workspace or the application's data directory.
5. Verify the connection explicitly. The app checks native GitHub metadata for the intended
   private repository and tests its Git remote. Automatic sync starts for a newly verified
   connection without a checkbox prerequisite; a saved explicit Off choice is preserved.
   Pause/resume remains available in advanced controls. Existing uncommitted files are not
   uploaded. A missing collaborator account remains an explicit setup step.

The app does not infer collaborator identities or send GitHub invitations. The setup
agent uses native Git/GitHub tools for account sign-in, repository creation and invitations.
The browser cannot supply a filesystem path, executable or shell command to the Git API.
Repository verification uses the signed-in native account's
[GitHub repository metadata](https://cli.github.com/manual/gh_repo_view); it makes no model call.
The normal connection panel retains the host's current sync notice even after verification.
**Check repository** reads fresh status without starting sync or changing a saved operation;
Automatic sync **On** does not mean dirty or divergent files were overwritten.

Shared Work runs in the attached folder. Changing the folder appends a new binding and
creates a fresh native conversation when work next starts; it preserves saved model choices.
Earlier requests, callbacks and retries retain their original folder and conversation.
Switching waits for active/queued/child work, local jobs and unresolved native or Git
handoffs to settle. A replaced or unavailable folder fails closed rather than adopting its files.

## Work, review and sync

An explicit shared **Work** request starts on a member/request branch. Workers make changes
in ordinary task worktrees. Independent review and an exact integration preview precede
applying the committed result; the project's human-review setting still applies. Shared
files exposes reviewed tasks and their exact apply previews. **Ask** does not start this
file-writing workflow.

**Unfinished files on this computer** shows local edits in the group workspace and up to
50 task workspaces, with at most 16 file names per workspace. Likely private/runtime names
are withheld. Scientific `data/` names are allowed only when the selected project is
canonically separate from the app’s private storage; credential, log and database names
remain withheld. The same project proof applies to its task workspaces. Status responses
contain no file contents and never stage or publish unfinished work.
Unavailable workspaces remain visible for repair; clean status is not a completed review.

Automatic sync checks enabled workspaces about once a minute while this app is running.
It fetches the repository's default branch and advances a clean, idle checkout only when
Git can fast-forward. A completed app-owned Work branch that is fully published may
return its clean, idle checkout to the default branch to receive later shared files,
including while Read-only. Its original branch and request history stay fixed. Missing,
failed or uncertain completion, pending original/report capture, unresolved Git operations,
dirty/active work and divergent
history prevent that switch. A new Work request uses the latest shared base after prior
work has been published. Sync publishes applied commits with retained independent-review
evidence to the work branch, then advances the default branch when that is also a
fast-forward. Sync itself makes no model call.

Dirty or active work remains untouched. If another member advances the default branch
independently, the reviewed work branch can be shared, but the app does not overwrite or
force-merge the divergent work. A manager must prepare and review a correction before
integration. No force-push, reset, rebase or branch deletion is part of automatic sync.

Only committed, reviewed, applied changes are automatically published. This is not folder
mirroring or automatic merging of arbitrary branches. The app checks outgoing checkpoints
for likely private/runtime files and recognizable credentials; these checks do not replace
review. Private chats, drafts, provider credentials and conversation databases stay outside
the shared repository.

## Recovery

Git controls retain operation identities so a retry does not invent a different apply
target. Lost authentication, a changed remote, conflicts or a dirty checkout leave files
and branches in place and show a status in Shared files. Fix the reported condition and
retry. Turning automatic sync off preserves all files and branches.

Native agents retain their ordinary Git tools and account permissions. These controls do
not turn native execution into a filesystem sandbox. The older isolated Groups Git adapter
has a separate contract and is not changed by this native workflow.

The retained explicit Git operation history has a finite 4096-operation limit; ordinary
automatic idle checks do not append operations. Publication checks allow regular files smaller than 100 MiB each and scan at most
512 MiB of distinct outgoing blobs per pass. They also bound a publication to 128
commits and 1000 changed-path entries across those commits. Larger batches need smaller reviewed
checkpoints; paid Git LFS is not enabled. These checks do not establish unlimited storage.
