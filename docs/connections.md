# Connect the tools you already use

Start with the user's requested outcome and available capabilities. Inspect existing accounts, installed tools, current documentation, and saved non-secret setup before creating another connection. Derive the route for this installation, verify the requested exchange or artifact, and save what worked. Exact commands, model availability, and sign-in procedures change.

## Browser, phone, terminal, and IDE

Ask for an interface choice only when it changes the setup and cannot be inferred. An IDE needs no special SWA role. What matters is which repository the agent can access, where commands execute, and whether it can reach the intended running session.

For a browser chat, establish actual repository read/write access and an executor if calculations are needed. Have it read the project instructions and recover its own assignment. A repository connector may be read-only; a URL does not establish write access or native session identity. If writes are unavailable, send an attributed report through an authorized route or explain the manual handoff. Do not claim participation is complete until a real read/report/write has been observed for the chosen route.

When the user asks to connect a phone, help with their preferred app. Claude or Codex are reasonable starting points; consult the current official mobile/remote-control docs for the selected account and host. Explain which computer must remain online. Check whether the route attaches to a running conversation, opens another one, or accesses only saved files. Do not prescribe one permanent slash command for every platform.

If a conversation is “open elsewhere,” identify the session that owns it and the supported attach or handoff route. Preserve live work; never bypass a session lock or silently start competing writers. A second terminal is not automatically a second controller of the same process. VS Code or another editor can work on the same repository, but chat sharing and remote control need separate verification.

Useful starting points: [Codex documentation](https://learn.chatgpt.com/docs/) · [Claude Code setup](https://code.claude.com/docs/en/setup) · [Claude remote control](https://code.claude.com/docs/en/remote-control). Follow the current product's links when documentation moves. No particular remote-control product is required by this kit.

## When the usual computer is asleep

An authorized environment can continue from the latest verified uploaded checkpoint on a separate branch. Read the notebook, current assignments, and saved job references; check jobs still running elsewhere before launching replacements. Explain that unpublished changes and private Records on the sleeping machine are unavailable. A read-only chat can discuss or draft but cannot save or execute the work.

When the original environment returns, preserve its local changes and reconcile the branches. Check assumptions, figures, and results as well as merge conflicts. Continuing a task does not automatically transfer its manager role. GitHub stores uploaded files; it does not wake a computer or run a manager.

## Completion checks

The rules live in [the working agreement](working-agreement.md). A supported native end-of-turn hook should return the working agent to this small instruction:

> Read the project's AGENTS.md and the working agreement. Inspect the work you just did: notebook, evidence, attribution, Git checkpoint, requested sync, and privacy. Fix missed requirements within the assignment. Report anything incomplete. Skip this check when no substantive work or pending checkpoint exists, and respect user stops.

Establish the hook for the actual host:

1. Read its current lifecycle-hook documentation and inspect installed version, trust/configuration, and existing hooks. Preserve existing behavior.
2. Choose a supported completion event that can return a reminder to the working agent. A shutdown notification may be unable to continue work. Use one guard against repeated hook continuations; do not create an endless “check again” loop.
3. For Codex, check the current supported handler types and Stop decision response. Where a command handler is required, a tiny local handler can read the native input, emit the reminder through the documented continuation response once, and exit normally when already in that continuation. Do not assume a prompt handler is supported merely because another agent supports it.
4. For Claude Code, use the supported Stop handler and its repeat guard. A prompt hook's judgment may lack file access, so a bare self-assessment is not proof the notebook or Git state was inspected. Ask the working agent to do the inspection, or use an appropriate supported command handler.
5. Reload/restart only as the host requires, then verify the hook on real work with a deliberately missing checkpoint requirement. Confirm it is noticed, corrected, and the continuation terminates. Leave missing capability explicit when the host cannot supply this behavior.

No hook is installed by cloning this repository. Native configuration belongs in the chosen host's own configuration location. The reminder does not capture tool calls or enforce permissions. Raw history preservation is a separate small operation described in [Records](records.md). No extra supervisor process is required for completion housekeeping.

Sources to consult at installation: [Codex hooks](https://learn.chatgpt.com/docs/hooks) · [Claude Code hooks](https://code.claude.com/docs/en/hooks). Keep the non-secret discovered configuration and test outcome in the private setup record. Instructions alone remain cooperative; use native access/budget controls for hard boundaries.

## Recover after compaction or a new conversation

Establish how the host loads persistent project instructions. Verify that the agent reads the project entry, its own assignment, the notebook's Now section, Git state, and existing jobs. Native goals, continuation modes, or loops can help sustain execution when available, but they do not replace saved context. Do not start an indefinite loop merely to keep instructions alive.

Check a real return/compaction when the host supports it: retain a known assignment, a user constraint, pending work, and an active job reference; compare what the agent recovers with those facts. Another conversation should identify itself separately and recover work without duplicating the job. Browser recovery requires an actual accessible record connection. A one-time acknowledgment does not demonstrate indefinite compliance.

## Troubleshooting

Identify whether the problem is instruction loading, file access, authentication, missing execution, an unavailable model, session ownership, or a failed scientific task. Inspect the saved route and current official guidance, then repair the failing step. Preserve completed setup and existing jobs. Never switch accounts, billing routes, or models silently to make a launch succeed.

Guide required sign-in in the provider's own interface. Do not collect passwords or tokens in project files. Give one clear user step at a time and verify the resulting capability. A timeout may leave work running; inspect before retrying.

If a product issue remains, prepare a minimal report with versions, reproduction steps, observed behavior, and permitted diagnostics. Keep personal prompts and credentials out. Sending the report requires the user's instruction. Stop once the relevant capability is demonstrated; do not make ordinary setup a broad platform test campaign.

[Guide](README.md) · [Setup](setup.md)
