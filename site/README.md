# Public redirect

`_redirects` sends the public root and `/index.html` to the GitHub repository. Its README
is the landing page. `index.html` is a minimal link fallback for plain static previews.
The shared alien favicon remains; the unused promotional design and fonts were removed.

Use [the deployment runbook](../deployment/README.md) to build the combined artifact, retaining
existing `/syllabusgraph/` links. Do not deploy this directory alone. Root `#graph=...`
bookmarks currently follow the GitHub redirect; direct graph links remain available.

A plain static server does not apply Cloudflare `_redirects`. Use Wrangler preview for
routing checks and close it afterward. Dedicated website design is deferred; the earlier
implementation remains recoverable from Git history.
