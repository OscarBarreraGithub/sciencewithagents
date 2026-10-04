import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const pdfRoot = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'));
export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: ['cmaps', 'standard_fonts', 'wasm', 'iccs'].map((dir) => ({
        src: join(pdfRoot, dir),
        dest: 'pdf-assets',
      })),
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:4330', changeOrigin: false, ws: true },
      '/local-access': { target: 'http://127.0.0.1:4330', changeOrigin: false },
    },
  },
  preview: { host: '127.0.0.1' },
});
