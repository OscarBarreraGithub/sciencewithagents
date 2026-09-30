# Native capabilities and saved worker restrictions

**Latest requested policy (2026-09-30), pending native-sandbox verification:** broad read
and internet access, with writes confined to the assigned project/worktree. Automatically
deny operations outside the allowed scope instead of waiting on routine tool approvals.
Read-only diagnostic roles may remain read-only. This supersedes the blanket full-access/
bypass request. Arbitrary MCP and remote tools need their own enforcement; native inheritance
alone neither enables unattended access nor proves a filesystem boundary. Current saved
permission behavior remains unchanged by the QUARK board work. See [coordinator notes](QUARK_COORDINATOR.md).

**Direction superseded, implementation retained (2026-09-28):** the owner requested native
capability inheritance with QUARK observation/supervision, rather than expanding these
app-owned tool ceilings. See [the simplification account](SIMPLIFICATION_ACCOUNT.md),
especially S01–S04. New Codex and Claude conversations now inherit native capabilities. Existing saved
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
skills, plugins, web tools or configured MCPs, and without rewriting its approval preferences.
Task file permissions and exact review/apply remain. No plugin inventory/probe thread is needed
to launch an inherited Codex conversation. Native manager children join the existing supervised
family; they are not independent managers with fresh budgets. See VERIFICATION.md for evidence.

Claude adds only the private Dock MCP integration and appends coordination instructions.
It forwards native permission requests without a tool-name gate. Read-only workers retain
native plan permissions. A hook's successful admission returns no tool permission grant.
If native Stop does not end an owned run, QUARK closes that owned group after its grace period,
retaining queued messages, files, quota holds and original session identities.

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
task workspace restrictions and exact owner review/apply confirmation remain required.
Installed plugins may include connected apps and skills; this setting does not approve
messages, purchases, publication or other external actions.

If a save response is lost, **Check save request** retries that exact receipt after reload.
If another tab changed the saved allowance, your edit is retained and **Reload saved settings**
deliberately reads the current version. An unavailable catalog does not erase selections;
previously selected servers can be removed without rediscovering them. Catalog presence is
not proof that the tool is signed in or will succeed in a later task worktree.

## Manager contract

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

## Remaining compatibility work

Managed Claude external MCPs, plugins, web/image tools and native-approval parity remain
separate work. Requests for these extra capabilities on a managed Claude worker currently
fail with an explanation. Native Claude and shared VS Code conversations retain their own
capabilities. The current Codex adapter still requests tool consent; a project allowance
does not yet provide the requested opt-in to native automatic tool approvals.

Codex's [App Server](https://learn.chatgpt.com/docs/app-server) and
[plugin approval settings](https://developers.openai.com/plugins/build/plugins) are native
interfaces, not an app-owned credential store. The implementation uses the existing typed
adapter and approval flow; changing these interfaces still requires compatibility work.

## Guide and website wording

Decide which tools a project team may use once. Its manager then equips each new worker
for the task, within your choices. You can inspect the tools assigned to that worker and
keep control of permission requests and final changes. The current delegated-tool flow
supports Codex workers; mixed-provider parity is still being built.
