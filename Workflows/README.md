# Workflows

A workflow describes a method an agent can follow. Use this one folder for the methods supplied here, imports from other groups, and methods you create. Nothing in this folder becomes active merely because it is present.

| Method | Ask for it |
| --- | --- |
| [Review](review.md) | “Have this derivation reviewed.” |
| [Literature search](literature.md) | “Start a deep literature search for this question.” |
| [Figures](figures.md) | “Use this group's plotting recipe.” |
| [Cluster work](cluster.md) | “Rerun this using our established cluster workflow.” |
| [Cross-agent communication](cross-agent.md) | “Use the sciencewithagents.com cross-agent instructions.” |
| [Heartbeat](heartbeat.md) | “Check the managers every fifteen minutes.” |

Say “Create a workflow that…” to write a new method, or “Import the workflows from this repository” to bring in someone else's. Preserve imported authorship, license, source version, and useful directory structure. Inspect instructions and dependencies before using them. Copying a method does not authorize arbitrary installation or enable it across all projects.

Record each project's selected methods and versions in its README. “What is active?” should distinguish available, selected, actually used, needing setup, and running. Disable a method when asked without silently abandoning an active job. Keep user imports excluded from the public starter unless deliberately contributed. A remote agent needs access to the selected version; a path on another computer is insufficient.

## Updates

At each named SWA action or resumption, check the official entry at sciencewithagents.com and the relevant maintained source. Compare the installed revision/commit or digest; an unchanged result needs no full reload. Ordinary native tool calls inside the task are not separate SWA invocations.

Read changed instructions before new work. Preserve local adaptations and prior usable versions; reconcile against the version originally imported instead of overwriting edits. Keep running workers on their assigned version until a checkpoint/handoff. Record the version actually used and an unavailable update check honestly. Compatible instruction refreshes do not authorize new accounts, costs, wider access, or publication.

When copying one method out of this repository, retain its supporting files or rewrite relative references to the same pinned source revision so the copy remains usable. Keep source and adapted version distinct. Do not fetch a mixture of files from changing revisions. A known installed version can remain usable offline; do not label it current without a successful check.

## Writing a method

Keep it short and teach the setup process: define the outcome; inspect existing work/tools/accounts; consult current authoritative guidance; establish missing pieces; perform the real task; inspect the result; save the working route and useful failure findings. Explain how to recognize success and resume after an interruption. Exact commands follow from this user's environment.

State inputs, outputs, scope, checks, and stopping conditions. Keep personal prompts outside shared methods. Public reusable instruction templates are separate from personal conversations. Prefer existing tools and native facilities; add helper code only for a demonstrated gap.

[Guide](../docs/README.md)
