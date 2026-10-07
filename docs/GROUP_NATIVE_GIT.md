# Shared files in native Groups

Group messages use the creator's Cloudflare service. Shared files use a separate GitHub
repository. Joining a group does not grant access to that repository.

## Connect a repository

1. In **Manage group → Shared files**, use the GitHub setup prompt with your setup agent.
   Sign in to your own GitHub account. Supply your GitHub username, not your group display
   name. Unknown usernames can stay blank.
2. Choose the intended repository. A new repository should be private unless its owner
   chooses otherwise. The owner invites the intended GitHub accounts; each member accepts
   and verifies access using their own account. Never copy credentials between members.
   Initialize a new repository once on the creator’s computer (an empty initial commit is
   sufficient), then have members clone that same history. Do not initialize separate roots.
3. The setup agent connects the repository to the server-selected **shared** workspace for
   this group. It must preserve existing files, remotes, branches and running work. Do not
   connect the private conversation's workspace or the application's data directory.
4. Enable **Automatic sync**, then use **Sync now** to check access. Existing uncommitted
   files are not uploaded. A missing collaborator account remains an explicit setup step.

The app does not infer collaborator identities or send GitHub invitations. The setup
agent uses native Git/GitHub tools for account sign-in, repository creation and invitations.
The browser cannot supply a filesystem path, executable or shell command to the Git API.

## Work, review and sync

An explicit shared **Work** request starts on a member/request branch. Workers make changes
in ordinary task worktrees. Independent review and an exact integration preview precede
applying the committed result; the project's human-review setting still applies. Shared
files exposes reviewed tasks and their exact apply previews. **Ask** does not start this
file-writing workflow.

Automatic sync checks enabled workspaces about once a minute while this app is running.
It fetches the repository's default branch and advances a clean, idle checkout only when
Git can fast-forward, and only on the default branch. Existing work branches stay fixed;
a new Work request uses the latest shared base after prior work has been published. It publishes applied commits with retained independent-review
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
