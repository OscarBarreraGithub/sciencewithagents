// Test-only installed Git discovery; production still accepts protected absolute paths.
import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
export function fixtureGitExecutable(): string {
  const override = process.env.GROUP_GIT_TEST_EXECUTABLE;
  const candidates = override
    ? [override]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((path) => join(path, 'git'));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      /* Try the next installed executable. */
    }
  }
  throw new Error('Git fixture requires an installed absolute Git executable.');
}
