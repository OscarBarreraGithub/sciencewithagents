# Temporary Groups-only branch

**Ready for joint beta testing** on the published `groups-only` branch. Publication requires
independent approval of the exact final candidate. [Current status](STATUS.md) records the
20 passing Groups browser cases, eight full-SWA workspace/draft regressions and focused
startup, retention, plugin and Git fixtures. Live private GitHub, independent two-person
and physical-phone acceptance remain beta work; browser phone checks are emulation.

`groups-only` is a temporary branch of the same sciencewithagents repository. Its normal
`pnpm start` and existing Mac launcher open Groups. It does not start personal chats,
QUARK, managers, editor bridges, terminal hosting or cluster runtimes. Full SWA source
and existing records remain retained; saved scheduling and model choices are not turned off.

The branch supports human messaging, invitations, local removal/restoration,
drafts, shared report reading and optional existing-Claude summaries. Shared folders/private
Git now use a thin adapter: automatic sync fetches safely and publishes only exact
owner-approved immutable checkpoints. It never stages, commits, checks out, merges or resets
native working files. Use your ordinary Claude/native Git workflow to receive changes in the
checkout. No app-owned group agent is started.

New selected-Claude PDF/TeX capture into the reader and a finite archive workflow remain
unsupported follow-ons. Git can share committed report files through normal checkpoint
review; that does not create report-capture or hosted-reader receipts.

For the published branch, give this prompt to your existing native setup agent:

```text
Use the temporary groups-only branch of my existing sciencewithagents repository.
Read docs/GROUPS_ONLY.md and docs/STATUS.md first. Preserve my installation, accounts,
files, source changes, launcher, private data directory, port and optional plugin configuration.
Do not clone a second application or copy credentials. Inspect the branch/revision and
preserve a source/data recovery copy before changing my installation. Wait for an idle
checkpoint and use its existing launcher to stop only this installation. Switch to the
reviewed groups-only branch, install pinned dependencies using pnpm install --frozen-lockfile,
build, and reopen with the same launcher. Verify Groups and saved records with me.
Human Groups requires Node 24+ and Git; do not install or launch Codex/Claude for human
chat. Optional selected-Claude summaries need my existing Claude Code and use allowance.
Do not install that integration unless I ask. Never change my saved QUARK/model settings,
start a manager to update the app, deploy a new Worker or enable paid services merely
because I switched branches. Keep this branch for subsequent updates, never silently
switch to main. Explain incomplete capabilities from Status.
```

Use the creator's existing Groups service and invitation flow in [hosting](GROUP_HOSTING.md).
The optional [Claude plugin](GROUPS_CLAUDE.md) keeps its private configuration format,
selected session and generation-bound Stop receipts. Ordinary shared reading and human
transport make no model call. Automatic summaries use the central bulk policy and allowance.
Direct hosted phone pairing stays under Manage and requires the compatible existing Worker.

## Files with your existing Claude

1. In Manage, choose the same intended folder used by your existing Claude. The browser sends
   a saved folder ID/selection, never a path or shell command. Choosing it creates no project,
   manager or provider session. Existing full-SWA workspace receipts remain retained.
2. Ask your ordinary native setup agent to inspect the folder, preserve its Git history/remotes,
   verify your own GitHub account, and create/use the intended **private** repository. The
   creator initializes shared history once; other members clone that history and accept their
   separate GitHub invitations. No group invitation supplies GitHub access. Connect/verify in
   Manage; a verified connection starts automatic sync unless you previously saved Off.
3. Reload only the optional Groups plugin at an idle native checkpoint and select that exact
   conversation. Native hooks privately observe its session and current canonical folder.
   Missing/invalid folder proof disables file publication while summaries can continue.
   Other conversations/subagents stay excluded. Folder observations have a finite 2048-change
   history; capacity refusal preserves receipts and disables new file publication, without pruning.
4. Claude commits only the changes you intend to share using ordinary native Git, then calls
   `groups_files_propose` with the immutable SHA and a retained UUID. Review the exact full
   commit history, metadata and binary files in Manage → Files from your Claude. Only the
   authenticated app owner can approve that exact preview; native tools cannot attest approval.
   Later/dirty changes are excluded. Retry retains the same checkpoint and message identity.

Copy into the ordinary native agent for repository setup:

```text
Set up the intended private GitHub repository for the Groups folder I chose in Manage.
Follow docs/GROUPS_ONLY.md and docs/GROUP_NATIVE_GIT.md; use my own native Git/GitHub sign-in.
Preserve current files, history, branches, remotes, collaborator access and active jobs.
Do not stage everything, overwrite a checkout, install integrations or create a Dock manager.
Inspect private/runtime material before any intended commit. Use one shared repository history;
verify my own account access and intended private visibility. Help me choose Verify connection
in Manage. Automatic sync fetches and publishes only exact owner-approved immutable checkpoints,
never changes my native checkout. Use normal native Git for reviewed incoming checkout updates.
In my existing selected Claude, reload the optional Groups plugin at an idle checkpoint so its
native hooks can observe this same folder. Propose only my intended committed SHA through
 groups_files_propose with a retained UUID, then let me review and approve its exact history in
Manage. Do not claim a proposal uploaded files or that Git sharing created a hosted report capture.
```

Stop/reselection, read-only mode and local removal prevent old pending checkpoints from
publishing. Stop does not close Claude or its jobs. Before replacing an attached folder,
Stop sharing, close that native conversation and its jobs, and confirm the exact stopped
selection in Manage. Closure never approves files. Existing saved owner phone configuration
is also retained: its authenticated paired listener/tunnel may run when configured. The direct
hosted Groups phone feed is a separate option that can read while this computer is closed.
Neither phone path starts Runtime, QUARK or managers in this branch.

To return to full SWA, have the same external agent preserve current source/data, wait for
idle work, stop only this installation through its launcher, switch back to its saved main
revision, rebuild and reopen. Use one installation/process per private data directory.
Before reopening main, inspect its saved scheduling and queued-work implications through the
supported controls. Groups-only preserves those records and does not dispatch them; this is
not a promise about full-SWA activation with scheduling enabled. Existing full-runtime fixtures deliberately use
`--full-swa` or `--demo`; these flags are for maintenance, not the Groups product flow.
