# Groups agents on your computer

Groups v1 uses the normal Codex or Claude runtime on each person’s computer, with their
existing provider sign-in, model defaults and native tools. Docker, Linux and a second
provider sign-in are not required. Each person installs sciencewithagents. The creator's
setup agent hosts the shared service in the creator's Cloudflare account; invited members
need no Cloudflare account to join. Tailscale is not part of Groups setup.

## Set up

1. Follow [Groups workflow](GROUP_WORKFLOW.md) to create or join a group and verify the
   exact enrollment approval. Keep the selected worker computer awake and running the app.
2. Open **Shared chat** or **Private to you**. Enable agents on this computer when prompted.
   This authorizes native access like an ordinary project agent; it starts no model turn.
3. Send **Ask** for a read-only question, or explicitly choose **Work** for work on this
   computer. A saved request waiting for enablement keeps its original text and identity;
   continue that request explicitly after enabling.
4. If the provider reports signed out, use the app’s normal account setup on this computer.
   Do not copy credentials from another member. Model calls use normal QUARK admission and
   each computer’s own allowance.

## What is shared

**Shared chat** contains messages and agent replies intended for the group. **Private to
you** keeps a separate agent session and local conversation. Private asides, drafts and
personal conversation history are not automatically sent to the group. Other members’
messages can inform a reply but cannot themselves authorize local work.

Agents retain ordinary native computer access. Separate conversations are not a filesystem
or network sandbox: a native agent can access whatever its owner’s native permissions allow.
For shared work, use the group workspace and share files deliberately. Never put credentials
or other people’s private information into a shared message.

Git/report controls that depend on the older isolated runtime are not prerequisites for
chat. Their availability is separate from native chat readiness. See [current status](STATUS.md#groups)
for the exact delivered scope and acceptance evidence.

## Existing installations

The app preserves older Linux setup records, accounts and saved requests. It does not copy
an isolated session into a local agent or replay uncertain work. New local requests use new
execution records; old uncertain requests stay available for inspection. The retained
[isolation implementation](GROUP_ISOLATION.md) is a technical reference, not the default
Groups installation procedure.
