# Set up or return to Science with Agents

These instructions are for the agent helping the researcher. Work out the setup from the user's actual tools and accounts. Preserve existing research, instructions, remotes, managers, and running jobs.

## 1. Find what already exists

Read the available context and inspect likely workspace locations. If setup status remains unknown, ask “Have you set this up before—yes, no, or not sure?” Locate the intended project and its actual Git root. Determine whether this is a fresh installation, another interface joining it, or a handoff.

Read any existing workspace note, project README, instructions, and notebook. Identify the current manager and outstanding work. A saved name or old transcript does not prove a process is still running. Connect to the existing participant when a supported route is available; arrange an explicit handoff if responsibility is changing. Do not silently create a second manager.

Inspect capabilities: can this agent read and write the selected files, use Git, execute tools, delegate, and reach the desired remote? A working directory does not identify the app, device, or execution host. Establish destinations from actual tool context. A read-only browser chat can help plan or prepare a handoff; it cannot claim to have written a checkpoint.

## 2. Establish the workspace

For a fresh setup, obtain the official repository through [sciencewithagents.com](https://sciencewithagents.com). Clone it into the user's chosen location, using the URL in the repository README. Ask for a location only when no preference or suitable established location is available. Do not clone a second copy to avoid investigating the first.

Check the root exclusions before creating personal content. The reusable package must not track the user's projects, workspace note, personal workflow imports, or raw records. Keep credentials in the provider's credential store.

Use `My Projects/Workspace.md` as the private, agent-maintained overview when an orchestrator is wanted. It can hold the workspace identifier, orchestrator tag/native reference when available, project locations, attention items, preferences, and handoffs. It is excluded from the public starter. This is one readable note, not a new registry service. For access from another device, establish a separately authorized private location for this note; a local path or public starter clone is insufficient.

Do not install every optional workflow or start a heartbeat during ordinary setup. Tell the user what is ready and what remains unavailable. Resume interrupted setup from its saved state.

## 3. Create or adopt a project

### Project structure

```text
Science with Agents/
  README.md
  AGENTS.md
  docs/                         # includes setup and paper/
  Workflows/                    # one home for optional methods
  My Projects/
    Workspace.md                # personal overview, if needed; excluded
    Project A/                  # independent Git repository
      README.md
      AGENTS.md
      Lab Notebook.md
      [research files]
      Records/                  # private native records; excluded
      .gitignore
      .git/
    Existing Project/
      README.md                 # reference to work stored elsewhere
```

For a new project, create its folder in My Projects, establish local Git tracking, and save an initial checkpoint. Do not describe an uncommitted or failed setup as ready. Create Records only when there is something to preserve. Add `/Records/` to the project's own .gitignore before retaining raw material; verify both `git check-ignore` and the absence of already tracked private files. The outer repository's ignore rules do not configure the project repository.

For existing work, leave it in place. Make a small My Projects entry with a compact description, local location, stable project identifier, and useful remote/history or distinctive-file references. Keep device paths local. Preserve its existing README and research organization; add the missing notebook and instructions where appropriate. If the folder belongs to a larger Git repository, preserve that boundary instead of silently nesting a new one.

If a registered folder moves, verify candidates using the saved identity, Git evidence, and distinctive files. Several clones can share a remote and identifier. Ask when the intended copy remains ambiguous; keep an unavailable entry rather than creating replacement work at the old path.

When adopting work from earlier chats, recover the actual derivations, code, data, and outputs, not only a summary. Review unresolved requests and stated constraints, mark unavailable or externally held material, and keep distinct contributions from several conversations. Retain authorized originals privately under Records; share only scientific summaries and evidence. Never overwrite an earlier import to make the account look simpler.

### The project's front page

Adapt this small outline to the actual research:

```text
Project name and one-sentence question
Project identifier:
Manager and current assignment:
People:
Current work: see Lab Notebook.md
Research and results: useful links
Selected workflows and versions:
GitHub sync: on/off; observed status and time; repository/branch if enabled
```

A project identifier can be a UUID generated once and retained through moves. A clone keeps the project identifier but has its own working location and participants. Put personal preferences in the private workspace note; share project conventions deliberately. Do not store private prompts in either shared front pages or notebook entries.

### The project's AGENTS.md

Install one short entry for all participants. Preserve existing instructions and resolve genuine conflicts; do not replace a project's own rules wholesale. For a new project, use this wording and supply its actual instruction locations:

```text
This project uses Science with Agents. Read the project README and the Now
section of Lab Notebook.md before work. Recover your assigned role and task;
reading these instructions does not appoint you manager.

Read and follow the SWA working agreement at the recorded local documentation
location or the official repository linked by https://sciencewithagents.com.
Check the relevant maintained instructions when invoking or resuming SWA;
preserve the working version and report an unavailable update check.

Keep the notebook and meaningful Git checkpoints current. Keep personal prompts
and raw Records private. Before finishing, inspect the work against the agreement,
fix omissions, and report pending checks, jobs, or synchronization.
```

Replace the generic location above with a working link/path and record the source revision. A separate checkout must reach the docs without depending on another computer's local path. Verify that the selected host loads the entry; use its supported compatibility file/import when required. Browser agents must receive and read the same instructions through an accessible connection. Do not assume file discovery. Keep a local usable copy of the selected instructions where offline work is required.

Create the notebook with a short Now section and a dated first entry. Use the [working agreement](working-agreement.md) for its contents. All roles share the project entry; a nested AGENTS.md is useful only for a directory that needs specialized rules.

## 4. Establish GitHub when wanted

Explain Git as saved versions on the computer and GitHub as an optional online copy. Detect and preserve existing remotes and credentials. If synchronization is requested, help the user sign into their own account, or create one through GitHub's normal interface. Use official Git/GitHub guidance and the installed tool's help to derive commands for the actual machine. Never copy the maintainer's credentials or silently publish private work.

Use an existing authorized repository or create a private project repository by default. Confirm the destination, visibility, branch, and collaborator access from evidence. A collaborator needs actual repository access; seeing a URL is insufficient. Send the initial intended checkpoint and verify its commit exists remotely.

Record sync preference separately from observed status: local only, setup needed, changes pending, up to date, needs attention, or offline/unverified. State which data are tracked. Turning sync off stops this working copy's future automatic uploads; it does not remove remote content or change collaborators' settings. The Records archive is excluded even from a private project repository.

On return, inspect local changes and remote divergence before integrating. Never overwrite unpublished work or force-push to resolve uncertainty. Separate worktrees/branches are appropriate for overlapping writers; workers must not race through one shared Git index.

## 5. Finish with evidence

Confirm the intended project, effective instructions, notebook, local checkpoint, privacy exclusions, and any requested remote checkpoint. Show a short report with links and one next action. Read-only access, unavailable recording, unsigned-in tools, and pending uploads remain explicit.

Establish [native completion checks and records](connections.md) for the chosen host when supported. Verify the mechanism on the user's actual next task; a copied configuration is not proof it ran. Help with phone or IDE connections when asked. Do not make those prerequisites for keeping a notebook.

Teach missing setup one step at a time. Explain what the user should see, accept screenshots where supported, and offer connected browser assistance when available. The user completes passwords, verification codes, and account consent in the provider's interface. Save the non-secret route that worked so setup is repeatable.

[Guide](README.md) · [Working agreement](working-agreement.md)
