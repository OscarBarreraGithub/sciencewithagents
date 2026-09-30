import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const requireShared = createRequire(require.resolve('@dock/shared/package.json'));
await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['vscode'],
  outfile: 'dist/extension.cjs',
});
const licenses = await Promise.all(
  ['ws', 'zod', 'acorn', 'acorn-walk'].map(async (name) => {
    const root = dirname(
      (name === 'zod' ? requireShared : require).resolve(`${name}/package.json`),
    );
    return `${name}\n${await readFile(join(root, 'LICENSE'), 'utf8')}`;
  }),
);
await writeFile('dist/THIRD_PARTY_LICENSES.txt', licenses.join('\n\n'));
