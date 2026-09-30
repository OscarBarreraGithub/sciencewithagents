# Setup and maintenance scripts

New installations follow [the setup guide](../docs/CONTRIBUTOR_SETUP.md). The scripts below
are maintained source, not the owner's test conversations or screenshots. Generated evidence,
fixtures and receipts belong under ignored `data/`; do not copy that directory when sharing
the repository.

| Purpose                         | Entry                                                | When to use it                                                                                                                                                                                                        |
| ------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source installation             | `setup.mjs`                                          | The setup agent checks prerequisites with `--check`, then installs/builds. No model prompt or login service.                                                                                                          |
| Mac app                         | `create-launcher.mjs`, `launcher.mjs`                | Build/open/stop this installation through its recorded paths. Do not overwrite an unrelated app or stop another process.                                                                                              |
| Optional shared usage reader    | `setup-usage-collector.mjs`                          | Setup handles an unavailable download separately from app readiness.                                                                                                                                                  |
| Source development              | `dev.mjs`, `pnpm`, `fix-pty.mjs`                     | Start the development server or use the pinned package manager. Close owned development processes afterward.                                                                                                          |
| Fresh source verification       | `smoke-fresh-setup.mjs`                              | Developer-only disposable installation check; unlike ordinary setup, it runs the full verification command. Requires `--run`.                                                                                         |
| Native/provider compatibility   | `smoke-*.mjs`                                        | Opt-in developer checks. Most use real native accounts and can consume allowance; inspect the particular script before running it. Some exercise retained classic controls or require an existing disposable fixture. |
| Editor bridge compatibility     | `probe-vscode-mirror.mjs`, `probe-claude-mirror.mjs` | Isolated live checks of the maintained companion, not ordinary installation or arbitrary terminal attachment. Preserve the active editor.                                                                             |
| Specific operational acceptance | `verify-phone-entry.mjs`, `verify-source-backup.mjs` | Check the named configured workflow only; read its prerequisites and scope first.                                                                                                                                     |
| Build artwork                   | `export-web-icons.mjs`                               | Regenerate app icon assets deliberately.                                                                                                                                                                              |
| Public website staging          | `build-public-site.mjs`                              | Combine `site/` with an explicitly supplied prebuilt public SyllabusGraph export. See the instructions below. This does not deploy or copy graph source projects.                                                     |
| Fake tool endpoints             | `fixtures/`                                          | Maintained test inputs; never configure them as ordinary user integrations.                                                                                                                                           |

Use focused checks for a change and `sh scripts/pnpm verify` at a meaningful checkpoint.
Browser checks are separate. Do not run every live smoke script as a setup step or repeat
passing suites merely to increase the test count. [Verification](../docs/VERIFICATION.md)
records what actually ran; a script's presence is not a current compatibility result.

The public site staging command is:

```sh
node scripts/build-public-site.mjs --graph /path/to/prebuilt/public/graph --out data/public-site-release
```

Use a new output directory inside an existing parent; add `--landing /path/to/site` to
stage another landing build. The landing is served at `/`, and the supplied graph export
at `/syllabusgraph/`. The build preserves graph payloads, scopes its Cloudflare headers,
repairs graph error-page links, and redirects old graph assets. A small generated browser
script forwards old root `#graph=...` links, preserving their query and fragment; ordinary
landing anchors stay on the landing. Source files are unchanged. The graph input must be
the public export with `catalog.json`, not a course project or the SyllabusGraph repository.
Only catalog-listed graph JSON is admitted, and symbolic links or unexpected files fail
the build. Generated output stays ignored and is deployed separately through the existing
site host. Run the focused fixture check with
`sh scripts/pnpm --filter @dock/server exec vitest run src/site-build.test.ts`.
The [website deployment runbook](../deployment/README.md) uses this repository's own
Cloudflare configuration for preview, release and rollback; the graph source repo's
old deployment command is not needed.
