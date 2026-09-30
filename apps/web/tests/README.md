# Browser checks

- `home/` tests the current interface and connected workflows, including phone touch
  layouts, WebKit, offline recovery, empty/stale readings and the phone lock.
- `classic/` retains regression coverage for the previous workspace while its screens
  are rebuilt. Its fixture deliberately selects that interface; authentication remains.

From the repository root, `sh scripts/pnpm test:e2e` checks the current interface.
The previous interface is checked with `sh scripts/pnpm --filter @dock/web test:e2e:classic`.
Build first with `sh scripts/pnpm build`.

Tests use a disposable demo server and make no real model calls. Browser profiles,
screenshots, traces and runtime databases live only under ignored `data/`. They are not
part of the shared source or normal installation. Do not point tests at an owner's data.
