# Public website deployment

This is the maintainer runbook for the promotional website. It is separate from
installing or updating the private sciencewithagents app. No app database, chat,
provider credentials, private graph source, phone connection or local server is
published. The owner must authorize a production release; preparing a build or
running the dry run below does not publish anything.

The combined artifact contains the landing at `/` and the supplied public graph
export at `/syllabusgraph/`. Its build script preserves old `#graph=...` links,
redirects old graph assets, relocates the graph's headers and repairs its 404 page.
Font licence notices are included under `/assets/fonts/`.

## Prepare one immutable release directory

Run these commands from this repository with Node 24+ and its pnpm wrapper. Wrangler
is invoked at a pinned version, so normal app installations do not need another
dependency. The first invocation downloads the tool into the package-manager cache.

Choose an existing **prebuilt public SyllabusGraph export**, containing `index.html`,
`catalog.json` and its catalog-listed `data/*.json`. The graph builder already selects
the publishable material; this repository does not rebuild or read its private sources.
Keep the original graph checkout and its unrelated work unchanged.

```sh
mkdir -p data
node scripts/build-public-site.mjs --graph /path/to/prebuilt/public/graph --out data/public-site-release
sh scripts/pnpm dlx wrangler@4.132.0 deploy --config deployment/public-site.wrangler.jsonc --env production --dry-run --outdir data/public-site-dry-run
```

The builder refuses to overwrite an existing directory. For a later release, use a
new directory and pass it to every Wrangler command with `--assets`; keep the last
verified artifact until the replacement works. For example, use
`--assets "$PWD/data/public-site-next"` after building `data/public-site-next`.
Never deploy `site/` alone: that would remove the graph tab's destination.

## Check the artifact locally

```sh
sh scripts/pnpm dlx wrangler@4.132.0 dev --config deployment/public-site.wrangler.jsonc --ip 127.0.0.1 --port 8787 --persist-to data/site-preview-state
```

Open that loopback address and verify the landing, GitHub destination, copyable setup
prompt, `/syllabusgraph/` graph loading, an existing root `#graph=...` link, a graph
404 and `/assets/fonts/NOTICE.txt`. Check the landing at desktop, 412×915, 360×800 and
915×412. Stop this owned preview when done. A successful dry run checks packaging;
it does not establish these browser journeys or account access.

## Publish the reviewed artifact

Check that the public GitHub links exist, the release's source licence has been
chosen, and the artifact passed the browser checks. Authenticate to the intended
Cloudflare account with native Wrangler sign-in if it is not already available;
never put credentials in this repository. Record the currently deployed version
before replacing it:

```sh
sh scripts/pnpm dlx wrangler@4.132.0 whoami
sh scripts/pnpm dlx wrangler@4.132.0 deployments list --config deployment/public-site.wrangler.jsonc --env production
sh scripts/pnpm dlx wrangler@4.132.0 deploy --config deployment/public-site.wrangler.jsonc --env production
```

Production intentionally retains the existing Worker name `syllabusgraph` and the
domains `sciencewithagents.com` and `www.sciencewithagents.com`; the Worker name is
an infrastructure identity, not the website title. This configuration is the new
deployment source of truth. **Do not use the SyllabusGraph repository's old deploy
command or its old automatic deployment workflow:** those publish a graph-only
root and would overwrite the landing. If that repository has an automated deploy
configured in Cloudflare or CI, disable or move that deploy job before this release.
Graph updates should produce a fresh public export, then run this combined build.

After deployment, repeat the critical routes on both public domains and record the
new version ID. If the release breaks a journey, restore the recorded previous
version rather than changing or deleting graph sources:

```sh
sh scripts/pnpm dlx wrangler@4.132.0 rollback PREVIOUS_VERSION_ID --config deployment/public-site.wrangler.jsonc --env production --message "Restore the previous verified website"
```

The optional `preview` environment has a separate Worker and workers.dev address;
deploying it still publishes a website. Forks must change Worker names, domain
routes and GitHub links to their own choices before any publication. The graph
export stays an explicit input and is not bundled into this public source repository.

Configuration follows Cloudflare's [static assets documentation](https://developers.cloudflare.com/workers/static-assets/),
[Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/),
[custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/),
and [deployment commands](https://developers.cloudflare.com/workers/wrangler/commands/).
