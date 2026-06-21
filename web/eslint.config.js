import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import eslintPluginSvelte from 'eslint-plugin-svelte';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import parser from 'svelte-eslint-parser';
import typescriptEslint from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default typescriptEslint.config(
  ...eslintPluginSvelte.configs.recommended,
  eslintPluginUnicorn.configs.recommended,
  js.configs.recommended,
  prettier,
  {
    ignores: [
      '**/.DS_Store',
      '**/node_modules',
      'build',
      '.svelte-kit',
      'package',
      '**/.env',
      '**/.env.*',
      '!**/.env.example',
      '**/pnpm-lock.yaml',
      '**/svelte.config.js',
      'eslint.config.js',
      'coverage',
      // Playwright e2e specs run under @playwright/test, not SvelteKit's
      // tsconfig — they have their own (TS still typechecks via the runner).
      // eslint's tsconfig-aware rules need the file to be in the project,
      // which we don't want to widen for what's effectively a separate runtime.
      'e2e',
      'playwright.config.ts',
      'playwright-report',
      'test-results',
    ],
  },
  typescriptEslint.configs.recommended,
  {
    plugins: {
      svelte: eslintPluginSvelte,
    },

    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        NodeJS: true,
      },

      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: 'module',

      parserOptions: {
        extraFileExtensions: ['.svelte'],
        tsconfigRootDir: __dirname,
        project: ['./tsconfig.json'],
      },
    },

    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_$',
          varsIgnorePattern: '^_$',
        },
      ],
      curly: 2,
      'unicorn/no-null': 'off',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/import-style': 'off',
      // See server/eslint.config.mjs for the rationale on these unicorn v68
      // additions; same rules don't fit our codebase here either.
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/max-nested-calls': 'off',
      'unicorn/prefer-https': 'off',
      'unicorn/no-useless-coercion': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/no-break-in-nested-loop': 'off',
      'unicorn/prefer-minimal-ternary': 'off',
      'unicorn/prefer-number-coercion': 'off',
      'unicorn/prefer-uint8array-base64': 'off',
      // Svelte 5's `$state`-bound module-level reactive variables are
      // *intended* to be reassigned from event handlers, which trips this rule
      // hundreds of times. The pattern is the whole point of $state().
      'unicorn/no-top-level-assignment-in-function': 'off',
      'svelte/button-has-type': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      'object-shorthand': ['error', 'always'],
    },
  },
  {
    files: ['**/*.svelte'],

    languageOptions: {
      parser: parser,
      ecmaVersion: 5,
      sourceType: 'script',

      parserOptions: {
        parser: typescriptEslint.parser,
      },
    },

    rules: {
      // unicorn v68's consistent-boolean-name crashes when walking Svelte
      // files (calls `findParameter` on a node it can't iterate). Disable
      // here; the rule still runs on TS via the block above.
      'unicorn/consistent-boolean-name': 'off',
    },
  },
  {
    // All backend traffic must go through $lib/services/* (which routes via
    // api.ts and gets auth-retry + error parsing for free). Direct `fetch(…)`
    // calls outside the services layer would bypass that, so we ban them.
    // Type annotations like `fetchFn?: typeof fetch` and identifier
    // references (passing `fetch` as a parameter) are unaffected — the
    // selector only matches an invocation of the global `fetch` identifier.
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    ignores: ['src/lib/services/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.type='Identifier'][callee.name='fetch']",
          message: 'Direct fetch() is restricted to $lib/services/**. Add a service function instead.',
        },
      ],
    },
  },
);
