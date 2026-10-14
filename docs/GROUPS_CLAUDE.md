# Groups with your existing Claude Code

**Temporary `groups-only` beta:** ready for joint beta testing, contingent on exact final independent approval and publication. Follow [Groups-only setup and updates](GROUPS_ONLY.md) first and check [current beta limits](STATUS.md). Human Groups needs no provider installation. Full-SWA instructions below apply when using main.

Keep full SWA. The optional `plugins/groups` plugin connects your ordinary Claude Code
conversation to Groups; it creates no manager and does not contact QUARK. Group members
use their own Claude accounts. Group hosting stays with its creator's Cloudflare account.

On the temporary `groups-only` branch, follow [thin folder/Git setup](GROUPS_ONLY.md#files-with-your-existing-claude).
Native hooks keep a private session/folder proof for file publication; reload the plugin at an
idle checkpoint after a build. Missing/invalid proof refuses file publication while summaries
continue. The branch fetches and publishes approved immutable commits without mutating the
native checkout. New report capture remains unsupported; existing report reading is retained.

## Setup agent

Preserve the person's existing installation, accounts, data, plugins, hooks and active work.
Follow [installation/update](CONTRIBUTOR_SETUP.md), then build the reviewed checkout. Start
SWA through its supported launcher; coordinate a required restart at an idle checkpoint.
Do not reinstall or update the provider solely to activate this plugin. Verify its native
plugin/hook support; unsupported native versions need a separately agreed update.

Find this installation's actual private data directory; do not assume a new empty one.
Run `node scripts/groups-claude-setup.mjs /absolute/existing/SWA/data`. This saves paths,
not credentials, under `~/.config/sciencewithagents/groups-claude.json`, outside plugin
caches and shared project folders. It refuses to overwrite another saved installation.

In the person's intended project folder, add this reviewed checkout as a local marketplace
and install only this optional plugin, scoped to that person's project:

```sh
claude plugin marketplace add /absolute/SWA/checkout
claude plugin install swa-groups@sciencewithagents-local --scope local
```

In their existing Claude conversation, run `/reload-plugins` at an idle checkpoint. Keep
the same native conversation. Claude may explain a prompt-cache cost before reload; follow
its native controls. SWA does not install integrations by default, replace native settings
or update the provider. A clone plus a bare skill does not supply the MCP server or hooks.
For a temporary explicit test, `claude --plugin-dir /absolute/SWA/checkout/plugins/groups`
also loads the plugin. See [Claude's plugin installation](https://code.claude.com/docs/en/discover-plugins)
and [local marketplace updates](https://code.claude.com/docs/en/plugin-marketplaces).

After a reviewed SWA update and build, reload the plugin through Claude's native controls;
the local marketplace uses this checkout directly. The private connection and selected
conversation live outside plugin caches and survive updates.

Use [Groups hosting](GROUP_HOSTING.md) for creator setup and preserved upgrades; members
configure the creator's verified service and join their invitation without deploying
another Worker. In SWA, open **Chats → Groups**. Give your normal Claude the connection
prompt under **Your Claude Code**, or invoke `/swa-groups:groups` and ask it to connect
this conversation to the intended group. The selected native session ID persists through
resume/compaction. Clearing/forking into a different native session requires selecting it
explicitly. Other conversations and subagents are not enrolled automatically.

## What is shared and charged

Starting with the next submitted turn after selection, only NEW prompts and final replies
from the explicitly selected conversation enter the
private local sharing journal. Previous private history, tool output and files are not
imported. The separate Claude helper uses the central **bulk** model policy; its actual
model appears after a summary completes. It produces compact group updates, skipping
greetings. Automatic summarization uses allowance and may be imperfect; keep credentials
and material unsuitable for the group out of a conversation selected for automatic sharing.

Feed downloads and human messages make no model call. Reading group text inside Claude
uses Claude's context allowance. Peer text grants no authority to execute local work.
The selected agent can read, create, join, invite, revoke and post through narrowly scoped
Groups MCP tools, under its native permissions and the person's instructions.

SWA must be running to summarize/deliver. Native hooks retain bounded pending exchanges
while it is closed. **Stop automatic sharing** or `groups_stop_sharing` stops future
publication attempts; an update already being delivered may still arrive. Retained
receipts remain private. The app saves each Stop with its selection generation and recovers
that exact receipt after a lost reply. A retry cannot stop a subsequently selected conversation,
even if its native session ID is unchanged; status is read again after recovery. Older browser
requests without a saved generation can only look up an accepted receipt. If none exists,
their identity remains saved separately while you can explicitly stop the current selection.
Native `groups_stop_sharing` calls may omit the generation for a new current-selection Stop;
retrying their key always recovers the original result. **Pause automatic sharing** holds
queued summaries without stopping your native Claude conversation or discarding its backlog.
Reading and manual group messages remain model-free; resuming can process saved authorized
exchanges using allowance. Removed local groups also pause automatic summaries. Summaries run no more than once a minute per computer, with a bounded
pending queue. Uncertain model attempts are never automatically repeated; ask your Claude
to share a selected update. Delivery retries retain the same UUID and saved summary, back
off, and stop automatically after a terminal refusal or eight failed attempts. The sharing
status retains that update's key for an explicit `groups_delivery` retry without a new model.
An automatic update is retryable only while its exact sharing selection remains enabled;
Stop or a new selection refuses old updates. Unknown or already delivered keys are refused.
Warnings and interrupted counts belong to the current sharing selection; earlier receipts
remain in private history. Without a selected integration, SWA starts without a sharing
database or poller; unsafe optional data cannot stop the rest of the app.

Shared files use the [reviewed Git workflow](GROUP_NATIVE_GIT.md). Connect and verify the
chosen folder/private repository, including each member's separate GitHub access. Ordinary
Claude commits intended changes using native Git, then calls `groups_files_propose` with
that SHA and a retained UUID. In Manage → Files from your Claude, review every new commit
including full messages and author/committer details, and inspect binary files locally,
then approve that exact checkpoint. No SWA Work request
or extra model call is needed. Native agent credentials cannot attest this app-owner review.
Verified automatic sync publishes only approved immutable Git refs and a small group
message naming their commit; it never stages files or changes the native checkout. Later
edits need a new proposal/review. Divergence shares the checkpoint on its own member ref
and preserves the remote default; ask Claude for a reviewed correction. A refused default
update keeps the confirmed checkpoint shared and announces it, with a status explaining
that repository rules need attention. Paused sync keeps
approval local. Uncertain Git/message delivery retains the same SHA, ref and message key,
backs off and stops after eight failures; Retry this file checkpoint rechecks that exact
approval without a model. A new selection/folder/repository requires a fresh proposal.
This source candidate also adds a [direct hosted phone feed](GROUP_PHONE_FEED.md), with
one-use pairing, read-only access by default, optional human posting and revocation in Manage.
It requires matching app and Worker updates; the paired group page can then read shared
messages while the computer is closed. Reading and human posting make no model call. The
existing full-owner phone route still needs the running computer. Activation, physical-phone
and independent two-person acceptance remain pending.
Once an external conversation is selected, existing app-managed Git may fetch, but holds
checkout changes and app-owned Work operations while that conversation might still use
the folder. Stop sharing, close Claude and check all its jobs (including remote jobs),
then confirm **Claude and its jobs are closed** in Manage. This app/paired-owner
confirmation is retained append-only and applies only to the exact stopped selection;
ordinary agents cannot attest it. Clean, idle sync can then resume. Stopping automatic
sharing alone does not prove closure. Select the conversation again before resuming
external work so its folder is protected again.
Cluster-native Claude support has not been proved. For now use normal local Claude and
native SSH/Slurm, keep active job inputs fixed and share selected returned results.
