# What Groups stores and syncs

One creator hosts the group's service in their Cloudflare account. Joining members use
that service; removing the group from one app does not remove its hosted history or
other members. Each member keeps their own agent, provider sign-in and local work folder.

| Action                                        | Where the data goes                                                                                                                                                 | Model allowance                                                                              |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Read messages, reports or saved agent results | Authorized reads from the creator's service and local saved records                                                                                                 | None                                                                                         |
| Send a group message                          | The shared original, source identity and delivery receipt go to the hosted database; the sender keeps the original request and receipt locally                      | No model call for delivery; an enabled optional summary agent can use the sender's allowance |
| Ask or Work with My group agent               | The member's own provider runs the request. Saved shared requests and retained results are published with exact source identities; private histories remain private | Uses that member's allowance                                                                 |
| Summarize shared activity                     | An enabled local agent produces a summary linked to retained shared originals                                                                                       | Uses the summary owner's allowance                                                           |
| Sync project files                            | Native Git fetches and publishes reviewed, applied commits to the intended private GitHub repository                                                                | None for Git transport                                                                       |
| Share a report                                | Explicitly selected, captured file bytes and their immutable manifest are uploaded to the hosted report tables                                                      | None for transport; creating the report with Work uses allowance                             |
| Copy a setup prompt                           | The prompt is copied locally. The setup agent uses the person's own accounts when they submit it                                                                    | Copying uses none; running the agent uses allowance                                          |

## Database contents

The hosted SQLite database contains membership and invitation records, credential hashes,
revocation evidence, exact shared message/source identities and original chunks, delivery
receipts, summaries, shared action proposals and selected report manifests/file chunks.
A summary is an additional view of its sources; it does not automatically erase them.
No private conversation is uploaded merely because someone joins or reads the group.
The Worker never receives the member's provider sign-in or starts their native agent.

Protected local databases retain enrollment capabilities, shared/private context bindings,
drafts, original request keys, native results, delivery recovery records, captured reports
and selected folder/Git settings. They belong under the installation's ignored private
`data/` directory. Project sync must exclude these databases, credentials and logs.

## Files and reports

Choose the project folder in the app. Its files stay there. The setup agent preserves
existing history, configures the intended private repository and checks each member's own
GitHub access. Joining Groups does not grant repository access. Verified new connections
start automatic sync; an existing saved pause remains paused.

Work uses task worktrees. Independent review and the exact apply step precede publication.
Git sync fast-forwards a clean checkout; unfinished edits or divergent history require
attention and are preserved. It does not upload every untracked file or overwrite a dirty
checkout. See [shared files](GROUP_NATIVE_GIT.md).

Report sharing currently stores the selected bytes in Cloudflare, separately from Git.
A report present in the repository is not automatically a hosted report. The hosted quota
can refuse a bundle even when each individual file is valid. See [report access and limits](GROUP_DOCUMENTS.md).

## Staying on Free

Cloudflare's [Durable Objects Free limits](https://developers.cloudflare.com/durable-objects/platform/pricing/)
are shared across the creator's account, including other applications. Group membership,
originals, receipts and hosted report bytes all count toward storage; idle reads also count
toward daily requests and database work. The app's own admission limits are separate from
Cloudflare's account quota. Current limits and acceptance gates are documented in
[hosting](GROUP_HOSTING.md), [delivery](GROUP_DELIVERY.md) and [publication](GROUP_PUBLICATION.md).

Use Git for project files rather than repeatedly attaching them to the hosted database.
Recovery keeps exact identities: filling a quota must not trigger a new request key,
automatic replay, deleted history or a paid-plan change. A finite Free account cannot
retain unlimited originals and reports forever. Limits must be explained before new
uploads, while existing authorized history and recovery remain available within the
provider's current quota.
