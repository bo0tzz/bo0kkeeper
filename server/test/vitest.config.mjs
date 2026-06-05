import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  test: {
    name: 'server:unit',
    root: serverRoot,
    globals: true,
    include: ['src/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/services/**', 'src/utils/**', 'src/repositories/**'],
      exclude: ['src/services/index.ts', 'src/repositories/index.ts'],
    },
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
    env: {
      TZ: 'UTC',
      // Vitest 4 isolates workers more strictly than v3 — per-spec env vars
      // no longer leak across files. Set the loadConfig() required defaults
      // once here so every unit spec inherits them.
      OIDC_ISSUER: 'http://idp.test',
      OIDC_CLIENT_ID: 'test',
      OIDC_REDIRECT_URI: 'http://localhost/callback',
      CUTOVER_DATE: '2000-01-01',
    },
  },
  plugins: [swc.vite(), tsconfigPaths()],
});
