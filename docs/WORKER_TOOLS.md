# Native capabilities and saved worker restrictions

**Current native policy (2026-10-05):** native writing roles (project managers, write-enabled
workers, conversations and requested resource assistants) run with each provider's documented
full access and no routine permission queue: Claude `bypassPermissions`, Codex
`danger-full-access` with approval policy `never`. Files, local servers, browsers, Git and SSH
work with the owner's own user permissions. The project folder or task worktree is the intended
working scope, stated in their instructions; it is **not** hard containment. Managers keep the
reviewed-change apply workflow; implementers still work in task worktrees. Read-only roles
(reviewers, background checks, read-only discussions) keep native plan/read-only sandboxes;
explicitly saved read-only or restricted choices are preserved. Changing file access reconnects
the native session before the next turn. Real questions (AskUserQuestion) still surface; any
remaining native prompt is declined rather than queued. QUARK leases and stop hooks, provider
and organization policy (for example a disabled bypass mode) and the owner's own native sandbox
settings still apply. This supersedes the 2026-09-30 sandboxed write policy, which blocked
browsers, plain SSH and copy-back of cluster output.

A real Claude fixture under the earlier sandbox verified project file moves, loopback and
public HTTPS, a Chromium screenshot and one tiny FASRC job; the sandbox blocked cluster
copy-back until an unsandboxed retry, which this policy removes. A Codex fixture recovered a
sandboxed Chromium failure by escalation. Under this policy a Claude manager turn moved
project files, took a Chromium screenshot and copied cluster output back with no prompt or
retry, and its question still waited for the owner; no-model Codex App Server checks accepted
`danger-full-access` + `never` and ran the same file, browser, HTTPS and SSH steps.
See [dated evidence](VERIFICATION.md).

## Native inheritance

New Codex and Claude conversations now inherit native capabilities. Existing saved
conversations retain their restrictions; **Advanced controls → Tools and connections** can
explicitly select native inheritance while idle without replacing their history. New delegated
workers inherit when the project uses native settings and `tools` is omitted. Explicit
project grants, pending receipts and old-client per-tool saves retain their earlier meaning.
The personal assistant's selected-project privacy, resource checks and saved-work discussions
remain restricted. Claude hook IDs retain separate helper histories across resume, including
tool evidence and reported closing text. Helpers share root admission, budget and stop control.
Owned-hook transcript references now recover saved helper replies, reported models and partial
input/cache usage with durable catch-up. Unlinked streamed text/team totals remain with the
parent; full helper output accounting and exact nested hierarchy remain pending.

Native inheritance adds QUARK tools and observation without disabling the provider's hooks,
skills, plugins, web tools or configured MCPs. The launch policy above supplies unattended
native controls; explicitly saved restricted sessions keep their separate settings.
Codex read-only turns explicitly allow native network requests without granting file writes;
native writing turns use full access as above. Earlier live macOS evidence covers the read-only
path and the former workspace-write boundary.
Task file permissions and exact review/apply remain. No plugin inventory/probe thread is needed
to launch an inherited Codex conversation. Native manager children join the existing supervised
family; they are not independent managers with fresh budgets. See VERIFICATION.md for evidence.

Claude adds only the private Dock MCP integration and appends coordination instructions.
For a native Claude conversation or manager, open **Advanced controls → Session settings →
Chrome browser** and choose **Enable for this conversation** while idle. This uses Claude's
official `--chrome` option for that conversation without changing your global preference.
**Inherit my native setting** remains the default; saved restricted sessions keep Chrome off.
The Claude in Chrome extension must be connected, and its site permissions still apply.
Unattended launches deny residual permission requests instead of leaving work waiting for
routine approval; human questions remain answerable. Saved restricted sessions forward their
original permission requests. Read-only workers retain native plan permissions. The private
Dock SDK integration accepts mode-based coordination requests for its exact registered tools
in an active unattended native turn, allowing reviewers to record `dock_review` without leaving
plan mode. Native ask rules and user-interaction requirements remain effective; this grants no
file-write or external-MCP approval. An actual Opus reviewer resumed and recorded a scoped `changes_requested` verdict in the
2026-10-01 beta check; the follow-up correction retained its independent review requirement.
A hook's successful admission returns no tool permission grant.
Before acknowledging a stopped active turn and releasing its reservation, QUARK closes the
owned provider process group: a native turn interruption alone can leave a tool command running.
The grace-period fallback also handles missing stop events. Queued messages, files, quota holds
and original session identities remain saved; continuation resumes that identity.

## Project choice

Open **Tools for new workers** and choose **Use native settings** to inherit
Codex/Claude capabilities for future delegations. **Save worker settings** makes this explicit,
including for a project that previously saved restrictions. No catalog read is required.
Existing conversations keep their own settings. The previous allowance is retained for
explicit restricted requests; restoring native defaults does not silently grant dormant tools.

Choose **Use app restrictions** to expose the older Codex controls below. Saved policies
without a native/restricted marker and older clients' saves retain their restricted meaning.
A lost response can still be reconciled using its exact request, including after a newer save;
reading an old receipt does not undo the current choice. There is no automatic migration of
saved disabled values into permissions.

The remainder describes those optional restrictions, not the new default.

Within **Use app restrictions**, choose the web-search level,
image generation, installed Codex plugins/connected apps, and any configured MCP tool
servers. **Show available tools** reads only server names from this computer's Codex
configuration. It does not run a model, start a manager conversation, install anything,
or send tool configuration/credentials to the browser. Choose **Save worker settings** explicitly.

A manager receives the saved allowance with project state and requests only the subset
needed for each new worker. Both Codex and Claude managers can request these tools for a
Codex worker. Requests above the allowance fail before creating a worker. Indexed/cached
search never grants live web access. Under this restricted policy, an omitted request grants none of these extra tools.
The selected worker's provider/model still comes from the central model policy and QUARK
still admits the work. There is no silent switch from Claude to Codex.

The allowance is for **new delegations**. Changing it does not interrupt work, revoke or
widen an existing conversation's tools, or change managers' own execution restrictions.
Use a saved worker's Advanced controls to change its settings while idle. Existing owner
choices, model pins and original provider contexts remain intact. Permission requests,
task workspace restrictions and the project’s review/application policy remain required.
Installed plugins may include connected apps and skills; this setting does not approve
messages, purchases, publication or other external actions.

If a save response is lost, **Check save request** retries that exact receipt after reload.
If another tab changed the saved allowance, your edit is retained and **Reload saved settings**
deliberately reads the current version. An unavailable catalog does not erase selections;
previously selected servers can be removed without rediscovering them. Catalog presence is
not proof that the tool is signed in or will succeed in a later task worktree.

## Manager contract

Managers keep independent owner asks in durable work items; steering adds or corrects work
unless the owner cancels or replaces it. Notes remain the owner's. The turn overview shows
at most 60 unresolved items and reports `workItemsPage.omitted` and `nextCursor`.

Managers also receive `ownerRequests`: retained owner messages without an explicit whole-message triage
disposition. Page `dock_inspect {ownerRequests:{cursor:...}}` until `nextCursor` is null, including
after steering or compaction. Read full wording with `read:{source:"entry",id:entryId}`.
Link each independent ask through `dock_work_item.sourceMessages:[{agentId,entryId}]`;
one message may link several items. After reviewing the whole message and mapping every independent ask, record
`sourceDisposition` summarizing triage and linked items, or an answer, cancellation,
replacement or nonactionable input. A bare link remains pending review; a disposition
marks it triaged, not completed.
Keep `sourceDisposition` within 2,000 characters: summarize every independent ask and
its linked item IDs, with detailed evidence in work-item detail or checkpoints. A rejected
oversized summary leaves the saved item and original source unchanged. Shorten the complete
summary and retry; never truncate the original message or claim triage before saving succeeds.
Delivery remains queued/running/failed/cancelled for normal sends; steering is submitted or
uncertain. Uncertain input is retained without automatic native replay. Sources stay owned
by their receiving manager. Work-item revisions and append-only events preserve provenance.
Changing a work item's source set clears its old disposition unless the manager explicitly
renews whole-message triage; reordering the same sources does not clear it.
Use `dock_inspect {workItems:{cursor:"…"}}` to continue, following each `nextCursor` until
null; `includeDone:true` includes completed items. Reads stay within the caller's project.
Raw prompts remain available through history/read, but prompt storage alone does not prove
every request was recognized or completed. Managers reconcile the list with source evidence
after compaction and before reporting completion; no automatic perfect-recall claim is made.
Adjacent status or privacy questions add to the open work. Deferral, cancellation or
replacement needs an explicit owner decision recorded with its source message. Coalesced
manager updates (`quarkUpdate` on existing tool replies or Claude post-tool context, never a
new turn) carry `openWork`: up to five unresolved items with IDs, status, owner and task
references, short previews and the same `nextCursor`. A manager `dock_checkpoint` reply
reports open-item and untriaged-request counts; saving a summary resolves nothing.

`dock_inspect {}` and ordinary host state include `workerTools`, with its `toolPolicy`, revision and
the owner-granted Codex ceiling. Optional `dock_delegate.tools` accepts:

```json
{
  "mcpServers": ["configured-server-name"],
  "pluginsEnabled": false,
  "webSearch": "indexed",
  "imageGeneration": false
}
```

The host checks the ceiling again after asynchronous task preparation, then records the
selected tools and grant revision with the worker and assignment event. Exact delegation
retries return the original worker even if the owner later changes the ceiling. A new
request uses the current ceiling. Managers cannot edit the allowance through their tools,
the outside-agent QUARK client, or worker prompts.

The native Codex tool catalog is saved with a context. Older manager contexts may retain
the earlier `dock_delegate` schema without `tools`; resuming does not replace that schema.
Use the manager's explicit **New context** control when needed, preserving its saved
history and project evidence. The app does not silently replace original contexts.

## Compatibility boundary

The optional per-tool ceiling described above is a retained Codex-specific restricted mode.
It does not define the capabilities of new native-inheriting Claude or Codex workers. Explicit
unsupported restricted-mode requests fail with an explanation; do not build a second tool
framework to force provider parity. Use native inheritance for the provider's own configured
tools and permissions. Existing restricted contexts retain their original consent behavior.

Native integration still needs compatibility checks when provider protocols change. See
[Provider compatibility](PROVIDER_COMPATIBILITY.md) and [current release status](STATUS.md).

Browser workflows additionally need the provider's native browser integration and its site
permissions. Shell/network access does not grant browser access. **Chats → Browser** provides
a token-free Codex setup check and native Codex/Claude instructions. Legacy Computer Use
inventory can report a connected extension; newer native Node REPL tools and providers that
require an active conversation remain unverified by this check. The check is advisory and
never blocks an agent's native browser tools. A failed check never widens
permissions. Report the specific missing setup once and continue independent work rather
than repeatedly retrying a denied browser action.
