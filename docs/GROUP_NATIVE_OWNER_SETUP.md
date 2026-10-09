# Groups agents on your computer

Groups v1 uses the normal Codex or Claude runtime on each person’s computer, with their
existing provider sign-in, model defaults and native tools. Docker, Linux and a second
provider sign-in are not required. Each person installs sciencewithagents. The creator's
setup agent hosts the shared service in the creator's Cloudflare account; invited members
need no Cloudflare account to join. Tailscale is not part of Groups setup.

## Set up

1. Follow [Groups workflow](GROUP_WORKFLOW.md) to create or join a group by invitation and
   verify membership. Keep the selected worker computer awake and running the app.
2. Open **My group agent**. Enable agents on this computer when prompted.
   This authorizes native access like an ordinary project agent; it starts no model turn.
3. Send **Ask** for a read-only question, or explicitly choose **Work** for work on this
   computer. A saved request waiting for enablement keeps its original text and identity;
   continue that request explicitly after enabling.
4. If the provider reports signed out, use the app’s normal account setup on this computer.
   Do not copy credentials from another member. Model calls use normal QUARK admission and
   each computer’s own allowance.

## What is shared

**Group chat** contains everyone's shared messages. **My group agent** directs your own
agent in the shared context; its shared replies can appear in the group feed. Previously
saved private sessions remain separate and are not exposed by the current two-tab view.
Private asides, drafts and personal conversation history are not automatically sent to
the group. Other members’ messages can inform a reply but cannot authorize local work.

My group agent can query authenticated shared originals and typed evidence while
answering an Ask. Queries retain exact pages across retries and restart. Its offline
evidence position advances only after all pages of an offline query have been read; this
position is separate from older private-aside receipts. A new query refreshes at most 16
more shared events and reports any remaining index gap. Missing responsibility or causal
facts remain unknown. Exact original text is read in bounded pages with a whole-body hash;
headers alone are not the original. These read tools do not publish messages or launch work.

Agents retain ordinary native computer access. Separate conversations are not a filesystem
or network sandbox: a native agent can access whatever its owner’s native permissions allow.
For shared work, use the group workspace and share files deliberately. Never put credentials
or other people’s private information into a shared message.

Connect shared code/files through [native Git setup](GROUP_NATIVE_GIT.md). Each member uses
their own GitHub account and the same intended repository. Shared Work uses member/request
branches, task worktrees and independently reviewed integration. Optional sync publishes
reviewed applied commits and fast-forwards clean checkouts; it does not publish private
history or unfinished files.

For reports, ask My group agent with **Work** to create a PDF and matching LaTeX source in its
group workspace and link both in the final reply. **Open report from this reply** offers only exact captured
files; select the PDF and check its source/supporting files. Explicit sharing makes that copy
available under **Manage → Advanced → Browse earlier shared reports**. Source-only reports support Reading; the server
does not compile remote TeX on your host. Capture requires Python 3; existing Reading conversion
tools remain necessary. See [scoped reports](GROUP_DOCUMENTS.md). The older isolated adapters
remain separate. See
[current status](STATUS.md#groups) for the delivered scope and acceptance evidence.

## Existing installations

The app preserves older Linux setup records, accounts and saved requests. It does not copy
an isolated session into a local agent or replay uncertain work. New local requests use new
execution records; old uncertain requests stay available for inspection. The retained
[isolation implementation](GROUP_ISOLATION.md) is a technical reference, not the default
Groups installation procedure.
