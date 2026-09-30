# sciencewithagents public site

The public landing page for sciencewithagents. Static HTML, CSS and JavaScript, ported
from the Sketchcoded site's layout and style. No build step, package, account or backend.
It is not part of the pnpm workspace.

## Files

- `index.html`: the landing page. The hero illustration is an HTML/CSS drawing of the app
  with sample content, labelled as an illustration; it shows no live data.
- `styles.css`: all styles. The illustration scales with its frame using container query units.
- `site.js`: link configuration, the generated setup prompt, Copy prompt and the scroll hint.
  Links also have plain `href` fallbacks in the HTML, so the page works without JavaScript.
- `assets/favicon.svg`: the owner's alien-and-saucer mark, shared with the app.
- `assets/fonts/`: DM Sans, Caveat and Newsreader (SIL Open Font License), copied from the
  Sketchcoded site. Each bundled family includes its complete licence; `NOTICE.txt`
  records the included weights and verified distribution provenance. Nothing is loaded
  from third parties.

## Integration assumptions

- Serve this directory as the web root. Asset URLs are root-absolute (`/styles.css`,
  `/site.js`, `/assets/...`), so opening `index.html` from disk will not load them.
- `/syllabusgraph/` is served by the migrated SyllabusGraph site. The header, footer and
  project card link there.
- GitHub links point at `https://github.com/OscarBarreraGithub/sciencewithagents`; the
  feature-map and machine-support links assume a public `main` branch with
  `docs/FEATURES.md` and `docs/CONTRIBUTOR_SETUP.md`. Change the addresses in `site.js`
  and the matching HTML fallbacks.
- The setup prompt follows the repository README. Keep it in step with
  `docs/CONTRIBUTOR_SETUP.md`. It exists twice: in `site.js` and as fallback text in
  `index.html`.
- No `_headers` file and no `og:image` are included. Sketchcoded's `_headers` used
  `nosniff`, `strict-origin-when-cross-origin`, `SAMEORIGIN` and a one-year immutable cache
  for `/assets/fonts/*`. If you add headers, scope them so they also suit `/syllabusgraph/`.

## Preview locally

From this directory, run `python3 -m http.server 8080 --bind 127.0.0.1`, open
http://127.0.0.1:8080, then stop the server with Ctrl+C.

Check 412×915, 360×800, 915×412 and desktop. As on Sketchcoded, the page is a fixed window
with a scrolling reading panel and a **More below** hint on a reserved bottom rail.

For combined staging, Cloudflare preview, release and rollback, use the
[public website deployment runbook](../deployment/README.md). Publishing this directory
alone omits the graph; the production artifact must come from the combined build.
