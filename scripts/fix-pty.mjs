import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
// node-pty 1.1.0's packaged macOS helper can lose its executable bit under pnpm.
// Resolve only this installed dependency, never an operator-supplied path.
if (process.platform === 'darwin') {
  const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
  const root = dirname(require.resolve('node-pty/package.json'));
  const helper = join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
}
