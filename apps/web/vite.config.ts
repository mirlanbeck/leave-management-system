import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// В разработке /api проксируется на локальный API, как это делает nginx в compose.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
