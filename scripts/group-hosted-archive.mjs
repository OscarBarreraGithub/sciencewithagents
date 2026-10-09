#!/usr/bin/env node
// Read-only private local archive verification. No network or SQL execution.
import { resolve, join } from 'node:path';
const [command, appData, archiveId, ...extra] = process.argv.slice(2);
if (command !== 'verify' || !appData || !archiveId || extra.length) {
  console.error(
    'Usage: node scripts/group-hosted-archive.mjs verify /absolute/app-data archive-uuid',
  );
  process.exitCode = 1;
} else {
  try {
    if (resolve(appData) !== appData) throw new Error('Use the saved absolute app-data directory.');
    const { verifyHostedArchive } = await import('../apps/server/dist/group-hosted-archive.js');
    console.log(JSON.stringify(verifyHostedArchive(join(appData, 'groups'), archiveId)));
  } catch {
    console.error(
      'Archive verification failed. Preserve the archive and check the app-data directory, archive identity, file permissions and current server build. No restore was attempted.',
    );
    process.exitCode = 1;
  }
}
