import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ProxyOptions, type UserConfig } from 'vite';

const upstream: ProxyOptions = {
  target: process.env.SERVER_URL || 'http://server:2283/',
  secure: true,
  changeOrigin: true,
  ws: true,
};

const proxy: Record<string, string | ProxyOptions> = {
  '/api': upstream,
};

export default defineConfig({
  build: {
    target: 'es2022',
  },
  server: {
    proxy,
    allowedHosts: true,
  },
  preview: {
    proxy,
  },
  plugins: [tailwindcss(), sveltekit()],
  optimizeDeps: {
    entries: ['src/**/*.{svelte,ts,html}'],
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    globals: true,
    environment: 'happy-dom',
    sequence: {
      hooks: 'list',
    },
    env: {
      TZ: 'UTC',
    },
  },
} as UserConfig);
