# Slurm site rule sets

Each `<id>.md` file holds dated excerpts from a site's public documentation for the Slurm
submission review. They are evidence for the reviewer, not hard-coded limits: native Slurm
readings and the owner's lab rules stay separate, and native Slurm stays authoritative.

The owner selects a rule set in the submission policy (`siteRules`). To refresh one without
changing app source or any project, write the updated copy to
`data/slurm-site-rules/<id>.md` in this app's private data folder; it takes precedence over
the bundled file here. Keep the front matter: `title`, `retrieved` (YYYY-MM-DD), optional
`page-updated`, and a `sources` list of `https://` URLs. Quote limits with their wording,
mark summaries as such, and keep the file under 12 KB.

Changing a rule set's text changes the policy hash, so earlier approvals are not reused.
