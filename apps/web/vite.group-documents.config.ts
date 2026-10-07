import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'group-documents-preview',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5199, strictPort: true },
  build: { outDir: '../../../data/group-documents-ui/build', emptyOutDir: true },
});
