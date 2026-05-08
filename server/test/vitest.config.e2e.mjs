import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  test: {
    name: 'server:e2e',
    root: serverRoot,
    globals: true,
    include: ['test/e2e/**/*.spec.ts'],
    globalSetup: ['test/medium/globalSetup.ts'],
    // E2E specs boot a real Nest app + fake IDP per suite. They read env at
    // module-load time, so we want each spec file in its own fork (no shared
    // module cache / no cross-suite env bleed).
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    server: {
      deps: {
        fallbackCJS: true,
      },
    },
    env: {
      TZ: 'UTC',
    },
  },
  plugins: [swc.vite(), tsconfigPaths()],
});
