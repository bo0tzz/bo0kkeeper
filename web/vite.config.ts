import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type ProxyOptions, type UserConfig } from 'vite';

const upstream: ProxyOptions = {
  target: process.env.SERVER_URL || 'http://localhost:2283/',
  secure: true,
  // Keep the original Host header (`localhost:3000`) so the backend reconstructs
  // the callback URL against the frontend port. Critical for the OIDC token
  // exchange: openid-client derives `redirect_uri` from the request URL, and the
  // IDP rejects the exchange if it doesn't match the URL given to /authorize.
  changeOrigin: false,
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
