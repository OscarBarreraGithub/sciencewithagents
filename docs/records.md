# Who did what, when, and why

Keep Git and the lab notebook as the scientific record. Add one private **Records/** folder per project for the native conversations and tool activity the host makes available. Preserve existing formats; no new event database or hand-maintained tool ledger is needed.

| Question | Evidence |
| --- | --- |
| What changed? | Git commits and the actual files |
| Who contributed, what did they decide, and why? | Dated notebook entries, task/participant tags, and commit attribution |
| What was actually said or called? | Authorized native conversations and tool records in Records/ |

The notebook is the normal reading path. Search the original records when a question needs the exchange or command. State what supports an answer and what is missing. Tool calls do not by themselves explain a choice: write the explicit scientific reason in the notebook when it is made. Do not invent unrecorded reasons or describe later reconstruction as contemporaneous evidence.

## What to preserve

Retain available manager and worker messages, tool requests/results, job receipts, and relevant session/model metadata in their native form. A manager transcript may contain only a worker's final report; locate the child record separately when accessible. Preserve session relationships and use distinct names or directories so concurrent exports do not overwrite one another.

JSONL is useful where supplied: one JSON value per line. Keep other native formats when that is what the host exports. [Format reference](https://jsonlines.org/)

In the notebook, identify the scientific task, contributor tag/role, observed or reported time, action, evidence, and consequential reason. Record the entry's author separately from the producer, reviewer, and integrator. Add the model when host metadata supports it; otherwise mark it unknown or self-reported. A requested model is not proof of the model that ran.

Note which private record was saved and its coverage, such as “native session available through this checkpoint; worker transcript unavailable.” Keep local paths and raw native identifiers in private records where appropriate. Public references should use the project's contributor/task tags. Private transcript references are not publicly inspectable evidence.

For example: “Worker w2 tested the adaptive integrator. Reviewer r1 found the requested tolerance insufficient. Manager m1 retained the earlier method because the convergence check failed; see the two output files and the check. The original exchange is retained privately.”

Use task and agent tags in commit messages to connect the notebook to Git. No separate manual commit map is needed. Git author/time identifies a checkpoint; it does not prove who performed every action or when a calculation ran. [Git trailer syntax](https://git-scm.com/docs/git-interpret-trailers)

## Establish recording for the current host

1. Establish the actual project and participating sessions. Inspect the host's supported export, local history, event stream, and retention settings using current documentation. Collect only authorized project records, not every chat on the device.
2. Before copying, put `/Records/` in the actual project's .gitignore. Verify it is ignored and contains no already tracked files. Use storage with the intended access permissions; .gitignore is not access control, encryption, or an instruction to other backup tools.
3. Prefer a supported export. Otherwise retain stable copies of accessible native files. Preserve provenance, original relationships, and complete records. A snapshot of a live session must state its last observed coverage; repeated copying must not silently truncate earlier saved evidence.
4. Save available updates at meaningful checkpoints, handoffs, and completion. Use a small native copying hook only if it is supported and useful. A reminder to follow instructions does not record tools. A host's cleanup can delete unarchived history, and a crash may leave a gap before the next copy. Report failed saves and missing intervals.
5. Check the route on actual work: find a known tool call and its outcome, a worker exchange when used, and the corresponding notebook/Git checkpoint. Record the host/version and untested coverage. Never reconstruct a complete-looking tool trace from an agent's memory.

Codex documents JSONL event output for noninteractive `exec --json` runs. It includes commands, changes, and tool activity; treat the entire stream as private. That capability does not establish identical capture for every Codex interface. [Codex event output](https://learn.chatgpt.com/docs/non-interactive-mode#make-output-machine-readable)

Claude Code documents separate subagent transcripts, cleanup retention, and native hook fields identifying parent/child records. Verify the current installation before using its paths. [Subagent persistence](https://code.claude.com/docs/en/sub-agents#resume-subagents) · [Hooks](https://code.claude.com/docs/en/hooks#subagentstop)

Browser chats may expose only an export or report. Save what is actually available and label the gap. An unknown actor or outcome stays unknown. These are documented source options; installing this repository does not activate a recorder.

## Privacy and durability

**All raw Records content is private.** Agent-to-agent messages can quote personal prompts, and tool outputs can echo them. Removing user-role messages is insufficient. Never automatically publish Records, copy it into shared Git history, or treat it as safe because the project repository is private.

The notebook contains scientific task summaries, decisions, and evidence without personal prompt text or private conversational context. Shared group correspondence is deliberately authored for its recipients; it does not mirror private chats. Another person asking for an audit gets only evidence they are authorized to inspect.

The default project push excludes Records. Establish a separate authorized private backup if these originals must survive device loss or be available remotely. A provider's temporary history is not a durable archive. Until private records are reachable, a remote agent can answer from the notebook and Git but must not claim to have inspected the original conversation. Provider-side retention is governed by the selected service.

## The package submitted with a paper

On request, select the scientific files at a known Git checkpoint and assemble an ordinary ZIP. Include a short guide mapping each derivation, figure, table, and claim to its assumptions, conventions, methods, inputs, results, contributors, and important choices. Keep relevant failures and unresolved checks visible.

Include exact code/configuration, environment, derivations, and data or precise external references. A Git commit identifies an executed version only if the run used those bytes; otherwise preserve the exact snapshot or patch. For restricted or large data, record version/checksum, access conditions, retrieval instructions, and which checks are possible without it.

Include the relevant scientific notebook excerpts and contribution/decision account. Readers can ask who did what and why from this material while personal conversations remain private. Say which attributions or reasons are reported rather than independently supported by shareable evidence.

Build from an explicit selected-file list, excluding Records/, .git/, private chats, unrelated material, and credentials. Review actual contents, including notebook outputs, comments, and metadata. A private sentence can be copied into an otherwise legitimate scientific file; file exclusion and secret scanning cannot guarantee its absence.

Check the package against the paper's results and try the reproduction instructions from the extracted ZIP where feasible. State unavailable inputs, expensive unperformed reruns, and limits. Record the source revision and package checksum. Successful execution, a metadata check, and scientific correctness are separate claims. A withheld indispensable prompt/input means reproduction is limited; privacy remains the rule.

There is no standing release directory. RO-Crate is an optional metadata export when useful to a venue or collaborator. Ordinary scientific files and a README are the default. The project can later attach numerical, formal, experimental, or human checks to specific result versions without choosing one verification company.

## What has been checked

Prior synthetic packaging work checked selected-file exclusion, an extracted-ZIP rerun, changed/missing inputs, and malformed metadata. A candidate broad recorder retained ordinary private prose from prompts and tool output, so its defaults are unsuitable here. Those findings do not establish live automatic capture or a general privacy guarantee.

Before relying on a recording setup, verify successful/failed calls, a worker exchange, interruption/resume, and checkpoints against known events. Use synthetic private text in a prompt, worker message, and tool output to check that it stays out of shared records and the ZIP. Also check accidental copying into a selected file. Preserve incomplete coverage honestly. [Current scope](coverage.md)

[Guide](README.md) · [Working agreement](working-agreement.md)
