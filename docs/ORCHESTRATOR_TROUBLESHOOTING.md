# Troubleshooting

For users, start with the app's error and retry action or ask the setup agent to follow
[Operations](OPERATIONS.md). Keep private logs, account details and device receipts out of Git.

| Symptom                                              | Check and recovery                                                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Mac app cannot find a provider or connector      | Inspect its recorded stable executable paths; rebuild only this launcher's configuration using the setup guide. Finder need not inherit a terminal's PATH. |
| A package install reports a cache/permission problem | Inspect the actual error and project-local cache settings. Do not assume ownership corruption or use a global permission repair.                           |
| Phone address is online but pairing is unavailable   | Confirm the authenticated entry and an active invitation. Connector readiness is not enrollment readiness.                                                 |
| An old icon cannot reopen a paired workspace         | Preserve the working browser; pair before adding a new Home Screen icon. Browser/app storage can differ. Follow the real-device checklist.                 |
| Native account login works but discovery fails       | Retry metadata discovery and inspect the provider error before asking for another login. Do not substitute another model/provider silently.                |
| Usage is unavailable                                 | Show unknown/stale, retain quota protection and retry the shared reader. Do not treat a missing reading as unused allowance.                               |
| A stopped turn still says running                    | Wait for the native completion/stop event; acknowledgement alone is not completion. Inspect the exact owned run before further control.                    |
| A request timed out after submission                 | Reconcile its durable receipt/status before retrying. Never create a fresh request key just to replay an uncertain side effect.                            |
| A reconnect lost the intended screen                 | Restore saved host/project/conversation identity separately from ephemeral transport IDs. Reconnect is not a new message.                                  |
| A native helper has incomplete history               | Retain observed identity/evidence and label missing counters. Do not infer a complete hierarchy or double-charge its parent's inclusive total.             |
| Review repeats without progress                      | Shrink the task, fix a concrete finding or record the bounded manager disposition. Research results need not manufacture a code merge.                     |
| A recovery database is unusable by itself            | Validate the consistent snapshot and manifest; do not copy an active WAL database as unrelated files. Restore into an unused directory.                    |
| An error is hidden behind a dialog                   | Keep pending, failure and retry status in the active control surface. Preserve the user's input.                                                           |

After a provider update, inspect the installed schema/transport and run a bounded compatibility
check for the changed boundary. Preserve the working native session. Do not patch a vendor UI,
create a generic replacement framework or broaden permissions to make a failed check pass.

Current limits belong in [Status](STATUS.md); provider-specific procedures live in
[compatibility](PROVIDER_COMPATIBILITY.md) and [bridge maintenance](VSCODE_MIRROR.md).
The historical incident narratives are available in Git history, not active setup instructions.
