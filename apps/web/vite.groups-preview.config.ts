import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = resolve(projectRoot, 'apps/web/groups-preview');
const dependencyCache = resolve(projectRoot, 'apps/web/node_modules/.vite/deps');
const sourceRoots = [
  resolve(projectRoot, 'apps/web/src'),
  resolve(projectRoot, 'packages/shared/dist'),
  resolve(projectRoot, 'node_modules'),
  resolve(projectRoot, 'apps/web/node_modules'),
];
const within = (file: string, root: string) => file.startsWith(`${root}${sep}`);
const fixtureFiles = ['/bootstrap.ts', '/Fixture.tsx', '/fixture.css'];
export default defineConfig({
  root: fixtureRoot,
  publicDir: false,
  plugins: [
    react(),
    {
      name: 'groups-preview-no-backend',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          let staticAsset = false;
          try {
            // Decode before checking boundaries, and check real paths so symlinks cannot
            // expose runtime data through an otherwise allowed source/dependency path.
            const path = decodeURIComponent((request.url ?? '/').split('?')[0]!);
            if (!/[\\\0]/.test(path) && !/%[0-9a-f]{2}/i.test(path)) {
              staticAsset = ['/', '/@vite/client', '/@react-refresh'].includes(path);
              let file: string | undefined;
              let roots = sourceRoots;
              if (fixtureFiles.includes(path)) {
                file = resolve(fixtureRoot, `.${path}`);
                roots = [fixtureRoot];
              } else if (path.startsWith('/node_modules/.vite/deps/')) {
                file = resolve(dependencyCache, path.slice('/node_modules/.vite/deps/'.length));
                roots = [dependencyCache];
              } else if (path.startsWith('/@fs/')) {
                file = resolve(path.slice('/@fs'.length));
              }
              if (file) staticAsset = roots.some((root) => within(realpathSync(file!), root));
            }
          } catch {
            // Missing files, malformed escapes and inaccessible real paths are unavailable.
          }
          if (request.method !== 'GET' || !staticAsset) {
            response.statusCode = 403;
            response.end('Synthetic UI preview: backend unavailable.');
            return;
          }
          next();
        });
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5197,
    strictPort: true,
    hmr: false,
    watch: null,
    fs: { allow: [fixtureRoot, ...sourceRoots] },
  },
  build: { outDir: '../../../data/groups-ui/preview-build', emptyOutDir: true },
});
