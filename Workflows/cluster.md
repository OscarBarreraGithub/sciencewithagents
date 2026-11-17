# Continue an established cluster workflow

Read the project notebook, previous successful submissions, saved environment, and current jobs. Establish the user's own authorized cluster access and the institution's current rules. Reuse saved non-secret setup before asking the researcher to repeat it. Do not borrow another collaborator's credentials.

Derive the proposed run from the actual prior job: partition/queue, account, nodes/cores/GPUs, memory, wall time, environment, storage, inputs, and submission script. Compare the scientific change and its likely resource effect. A small source edit can still change job cost. Verify available quotas and avoid overwriting prior outputs or duplicating a running job.

For the A/B collaboration: B established the successful recipe; A changes the derivation. A's agent can use that recipe within A's existing authority after the relevant checks. It does not need B merely to type a known submission command. A change outside the established limits or an unresolved scientific/access choice waits for the appropriate answer while unrelated work continues.

If there is no successful precedent, establish the workflow from institutional documentation and a bounded authorized first run. Do not pretend inference from filenames establishes a safe configuration.

Save the exact code/input version, configuration, submission receipt, and job identifier. Submission means pending; inspect completion, logs, outputs, and scientific checks before claiming success. Preserve failed runs when informative. Respect pause/stop scope using the scheduler's actual controls, and inspect uncertain submissions before retrying.

Leave nonurgent questions as addressed shared correspondence. Record the answer and resulting change in the notebook when the collaborator returns. Raw access/session records remain private.
