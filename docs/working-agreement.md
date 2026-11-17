# Working agreement

Use this agreement with the agent's available tools and the researcher's instructions. Load the relevant workflow for a task. Preserve the researcher's existing project conventions and explicit choices.

## Roles and assignments

An **orchestrator** keeps the overview across projects, relays requests, checks managers, and reports what needs attention. The **project manager** coordinates that project's science, delegates bounded work, arranges review, maintains its notebook, and integrates results. A **worker** performs an assigned task; a **reviewer** checks a specified result and version. These roles can use any supported model or interface. A fixed depth of subagents is not required; independent sessions and explicit handoffs also work.

Each participant begins with its own tag, role, project, task, reporting destination, and relevant limits. Record a native session/worker ID and model only when exposed; otherwise say unknown or self-reported. Requested model settings and actual host reports are different evidence. Reading another agent's transcript or instructions does not transfer its identity or authority.

Keep one current manager assignment per project. Change it through an explicit handoff recording outgoing work, incoming responsibility, unresolved questions, active jobs, and saved state. A handoff does not itself stop old jobs. A role label is a coordination rule, not a credential or enforced permission boundary.

Preserve explicit model/account preferences for managers, workers, reviewers, and routine checks. New projects may inherit the user's defaults; existing projects do not change silently. Keep those preferences in the private workspace note. The orchestrator can identify related work across projects and propose a handoff or shared result, while respecting each project's access and assignment.

## Keep the right work in the right project

Bind each task to the project identifier and actual repository before dispatch, editing, job submission, or publication. Carry that reference in worker assignments and reports. Similar names, equations, or folders are not enough. In a cross-project overview, ask which project an ambiguous request concerns before routing it. A conversation keeps its assignment until deliberately switched.

Several chats may contribute concurrently. Use distinct tasks and separate working copies/branches for overlapping edits. Preserve others' changes, identify conflicts, and reconcile the science as well as the text. A second phone or browser chat does not silently replace the manager.

Before delegating, record the task, intended worker tag, scope, expected output, stopping condition, and any cost limits in the notebook or private workspace note. After launch, add the actual native reference or failure. Give the worker its own assignment and relevant instructions explicitly. A planned assignment is not evidence that a worker started. Inspect available existing jobs before retrying uncertain launches.

Keep substantial requests visible until completed, superseded, declined, or blocked with a reason. Treat new messages as additions or corrections unless they replace earlier work. Continue independent authorized work while a question is pending. Check the requested result before reporting completion.

## The lab notebook

Use one existing suitable notebook or create `Lab Notebook.md` beside the actual research. Keep a short **Now** section: current question, accepted assumptions, ongoing work and jobs, attention needed, and the next step. Follow it with dated entries for meaningful findings, failures, decisions, reviews, and handoffs.

An entry answers: what were we trying to learn; what did we try; who contributed; what did the evidence show; why did we make this choice; what happens next? Link derivations, source passages, code, inputs, outputs, and checks. Preserve consequential failed attempts and alternatives. Keep shared assumptions and conventions defined once, with exceptions explicit.

Use the notebook and Git history to answer who did what and when. Attribute producers, reviewers, and integrators separately. Save the available native records under the [records protocol](records.md) for questions needing original tool calls or exchanges. Summaries must identify gaps and later reconstructions. Do not invent timing, model identity, or reasons not present in the evidence.

The **scientific ledger** is this connected account: the assumptions, conventions, derivations, inputs, decisions, and dependencies needed to reconstruct each result. It is ordinary scientific content with links. No separate graph database is required. Keep the exact executed source/input versions; a later commit cannot describe an earlier dirty working tree without its saved snapshot or patch.

## Git checkpoints and synchronization

At a meaningful milestone, the assigned writer saves the notebook and intended scientific changes together. Inspect the diff and staged file list; exclude private records, credentials, prompts, unrelated work, and unintended outputs. Use a brief subject describing the result and a body identifying the scientific task, contributors, outcome, checks, and remaining work. Tags such as `Task:`, `Agent:`, and `Reviewed-by:` make history searchable. Never credit a review that did not occur.

Commit coherent progress regularly, including useful failed experiments or explicitly incomplete work. A completion hook alone does not ensure checkpoints during a long turn. Do not create a commit for every tool call or maintain another list of hashes. Each independent writer uses its own Git index/working copy.

If GitHub sync is enabled, push each meaningful checkpoint to the agreed branch and verify receipt. Report offline, rejected, or pending updates accurately. GitHub stores uploaded state; it cannot recover unsaved work on an unavailable machine. Existing remote content remains when sync is turned off.

## Reviews and scientific checks

Choose checks suited to the claim: an independent derivation, dimensional or limiting-case checks, a numerical tolerance/convergence test, a citation check, experimental comparison, or formal verification. Keep the expectation, observed outcome, source/result version, assumptions, and supporting evidence. A command's successful exit is not a scientific pass; a submitted cluster job is still pending until observed complete.

Use [the review workflow](../Workflows/review.md) when another participant should check the work. Bound correction rounds: after two unresolved rounds, report the disagreement and continue independent work rather than looping indefinitely. Materially changed inputs or claims need the relevant checks repeated. Preserve old and contradictory results; never transfer an old pass automatically.

Verification providers can add reports or proof artifacts linked to the same scientific files. Their checks have distinct scopes and are not a universal trust score. A model name does not certify correctness. Local dependency links can later be mapped to a wider physics graph; that integration is optional and unimplemented.

## Collaboration

Use the existing group correspondence location, or create a `Collaboration/` folder only when addressed shared messages are needed. A topic file can hold dated questions, scientific updates, replies, recipients, and open/resolved status. Keep original statements and append corrections. A sent message is not proof it was read. Read pending messages at startup/resume and checkpoints; mark acknowledgment explicitly.

Keep updates short. Categories such as Question, Finding, Decision, Review, or Blocked are enough when useful. Publish only deliberately shared scientific correspondence. Private catch-up requests, personal prompts, and raw conversations are not mirrored. Automatic summaries are optional and scoped to the conversations selected by each participant; they can be paused separately from reading or human messaging. Preserve people's access boundaries.

For example, A changes a derivation while B, who set up the cluster, is away. A's agent reads the saved successful run and follows the [cluster workflow](../Workflows/cluster.md) using A's authorized access. It checks the partition, resources, environment, changes, and existing jobs before submitting. A question that requires B waits in the group correspondence while independent work proceeds. B later reads and acknowledges it. The notebook connects the final choice to its evidence and contributors.

## Return, compaction, pauses, and cost

At startup, after compaction, or whenever your role is uncertain, reread the project entry and recover your own assignment, the notebook's Now section, current files/Git state, active workers/jobs, and relevant instructions. Verify outstanding actions before repeating them. Keep useful state current at milestones rather than relying on a warning before every context reset. Give the same recovery rule to each worker.

Honor stop/pause requests for their stated scope. Stop owned work through the actual native mechanism when authorized; do not assume ending a chat cancels a job. Preserve unfinished tasks and their last observed states. If collaborators give conflicting directions, hold the affected action and ask for a resolution from the responsible people; continue unrelated authorized work.

Distinguish pausing a monitor, pausing research, cancelling a job, and archiving a project. Keep children and queued work visible. Record whether a decision came from a person, the agent's initiative, or an observed tool failure. When a mistaken automatic hold can be repaired within existing authority, repair it and record the evidence; do not broaden permissions to clear it.

Inspect usage only where available and record its scope and time. Do not add a parent's aggregate usage to the same children's usage again. A request such as “keep Project A below 10% of my weekly budget” requires the account allowance, usage source, and available stop/limit mechanism. Report estimates or missing telemetry. Written instructions do not enforce hard limits. The [optional heartbeat](../Workflows/heartbeat.md) uses a native scheduler to check compact reports and contact the existing orchestrator.

## Check before finishing

For substantive work, inspect the notebook, relevant evidence, saved attribution, actual diff, commit state, and requested synchronization. Fix omissions within the task. Report unfinished checks, running jobs, unavailable records, and pending uploads. Skip empty ceremonial updates when nothing material changed. A user stop takes priority over another housekeeping loop.

Use a small native completion hook when supported; [connections](connections.md#completion-checks) explains how to establish it. Keep the rules here. A hook should point here and request inspection, with a bounded retry guard. Neither an agent's “yes” nor an installed file proves the work was checked.

## How to talk to the researcher

Lead with the finding or next useful action. Use plain language and brief connected paragraphs. Handle routine technical choices; ask only when a missing choice or access genuinely blocks the task. Explain sign-in steps one at a time. Offer more detail when useful, without making the researcher learn the internal machinery.

Report evidence and limits candidly. Avoid inflated claims, repeated future promises, contrast slogans, and needless new terminology. At every checkpoint ask whether the current task needs another file, service, or process. Reuse the notebook, Git, and existing tools whenever they suffice.
