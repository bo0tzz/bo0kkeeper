import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  test: {
    name: 'server:medium',
    root: serverRoot,
    globals: true,
    include: ['test/medium/**/*.spec.ts'],
    globalSetup: ['test/medium/globalSetup.ts'],
    // Run medium tests serially in a single fork — every test creates a fresh DB by
    // cloning the template, which doesn't parallelise well past a few concurrent runs.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
    env: {
      TZ: 'UTC',
      // Config defaults so loadConfig() doesn't blow up on tests that don't
      // bring their own env. Per-spec `process.env.X ??= ...` blocks still
      // work — these are just the fallback. Vitest 4 isolates workers more
      // strictly than v3, so per-spec env no longer leaks across files.
      OIDC_ISSUER: 'http://idp.test',
      OIDC_CLIENT_ID: 'test',
      OIDC_REDIRECT_URI: 'http://localhost/callback',
      CUTOVER_DATE: '2000-01-01',
    },
  },
  plugins: [swc.vite(), tsconfigPaths()],
});
