import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const BACKEND_URL = 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    // Listen on all interfaces and accept cloudflared quick-tunnel hostnames.
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    // One origin for phones: Socket.IO (HTTP long-polling + WebSocket) goes through Vite.
    proxy: {
      '/socket.io': { target: BACKEND_URL, ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.{js,jsx}'],
  },
});
