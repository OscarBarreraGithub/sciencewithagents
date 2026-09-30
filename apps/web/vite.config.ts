import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
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
