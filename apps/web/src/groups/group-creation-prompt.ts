export const groupCreationSetupPrompt = `Guide me through creating a sciencewithagents Group in my existing installation.
Walk me through the necessary choices and sign-in, handle the documented technical work,
and report anything unverified. Preserve my running work, files, Git history, remotes,
accounts, credentials, saved groups, drafts and service receipts. Keep my current app mode
and branch; do not switch to another branch or create another installation. If I am using
the temporary groups-only branch, read docs/GROUPS_ONLY.md for its supported workflow.
Use docs/GROUP_HOSTING.md and docs/GROUP_NATIVE_GIT.md as the technical runbooks, not
invented commands. Do not start a Dock manager or QUARK, install plugins automatically,
copy credentials between people, or upload raw conversations, private paths or histories.

I am the creator. First inspect my saved creator service, member mappings and pending
deployment bundles. Reuse and verify my own existing service when ready; hosting is set
up once, not for every group. Reconcile an unfinished bundle with its exact saved identity.
Preserve Worker identity, origin, capabilities, namespaces, schema, membership and data.
If I need my first creator service, guide sign-in to MY Cloudflare account and verify
Workers Free eligibility with me, then follow the documented prepare/deploy/activate
runbook after my account-owner authorization. Do not replace existing hosting or deploy
an update merely to create a group. An existing service update needs its preserved bundle
and the documented reviewed upgrade procedure; never upgrade my plan or buy storage.

Help me choose the intended project and display names in Groups → New group. Keep any
unfinished form entries. Create only when the app confirms hosting is ready, then help
share the invitation with the people I choose. Members join the creator's service using
their invitation; they need no Cloudflare account or deployment. Verify a human message
in each direction and reconnect recovery with another member. Human chat and reading
need no model or provider installation; using you as my setup agent uses your allowance.

Ask whether I want shared files. If not, finish chat setup without GitHub. If yes, guide
me to choose the intended folder through the app's native picker/saved Folder connection
in Manage, then sign in with MY OWN native Git/GitHub account. Inspect current files,
history, branches, remotes and private/runtime material before any intended commit.
Create or use ONE intended PRIVATE repository, initializing new shared history only once.
Invite only the GitHub usernames I explicitly supply; never infer them from display names.
Other members accept GitHub access using their own accounts and clone that SAME repository
and history into their intended folders. A group invitation grants chat membership,
not GitHub access. Preserve existing folders and remotes; never blindly stage everything,
overwrite files, reset active work or force-push. Help each person choose and verify their
folder connection, private remote identity and own repository access in Manage.

Explain reviewed sync: background fetching does not overwrite the native working folder.
Publication requires an exact immutable checkpoint and authenticated owner preview and
approval; later edits require another review. Preserve saved pause choices, pending receipt
IDs and exact retry identities. For my ordinary Claude Code, the existing Groups plugin
is optional: explain it using docs/GROUPS_CLAUDE.md and install/connect only if requested.
Select the existing conversation in this same folder; use native Git for intended commits,
groups_files_propose with the immutable SHA and retained UUID, then my exact approval in
Manage. Summaries from selected new turns use allowance; raw transcripts stay private.
Do not create an app-owned group agent. Use ordinary native Git for reviewed incoming
checkout changes, preserving dirty files and active jobs. Do not promise automatic folder
mirroring or merging. Verify an approved checkpoint reaches the shared repo and the other
member can receive the reviewed change; report access, review or receipt blockers honestly.
Do not claim committed report files create new hosted report captures. Finish by explaining
how to reopen Groups, invite another member and retry safely, with remaining steps explicit.`;
