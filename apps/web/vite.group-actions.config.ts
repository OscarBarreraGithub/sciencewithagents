import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'group-actions-preview',
  plugins: [react()],
  publicDir: false,
  server: { host: '127.0.0.1', port: 5289, strictPort: true, hmr: false, watch: null },
  build: { outDir: '../../../data/group-actions/ui-build', emptyOutDir: true },
});
