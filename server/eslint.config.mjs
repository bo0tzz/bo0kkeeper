import js from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import eslintPluginUnicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import typescriptEslint from 'typescript-eslint';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default typescriptEslint.config([
  eslintPluginUnicorn.configs.recommended,
  eslintPluginPrettierRecommended,
  js.configs.recommended,
  typescriptEslint.configs.recommended,
  {
    ignores: ['eslint.config.mjs', 'dist/**'],
  },
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },

      parser: typescriptEslint.parser,
      ecmaVersion: 5,
      sourceType: 'module',

      parserOptions: {
        project: 'tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },

    rules: {
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'require-await': 'off',
      '@typescript-eslint/require-await': 'error',
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/filename-case': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-top-level-await': 'off',
      'unicorn/prefer-event-target': 'off',
      'unicorn/no-thenable': 'off',
      'unicorn/import-style': 'off',
      'unicorn/prefer-structured-clone': 'off',
      'unicorn/no-for-loop': 'off',
      // unicorn v68 additions — disabled below because:
      //   - name-replacements: suggestions are contradictory (`req → request`
      //     AND `jobRepository → jobRepo`) and the churn is enormous.
      //   - consistent-class-member-order: alphabetic-by-default ordering
      //     fights deliberate grouping (constructor, lifecycle, public, helpers).
      //   - no-non-function-verb-prefix: bans verb-prefixed property names like
      //     `getInfo` on controllers, which fights NestJS route conventions.
      //   - max-nested-calls: zod schemas (`z.object({ a: z.array(z.string()) })`)
      //     legitimately nest more than 3 levels deep.
      //   - prefer-https: only fires on test-fixture URLs (`http://idp.test`,
      //     `http://localhost`) which are deliberately HTTP.
      //   - no-useless-coercion: incorrectly strips `BigInt(x as bigint | string)`
      //     calls. We use that pattern because pg serializes bigint columns as
      //     strings at runtime; the cast hints the type, the BigInt() call does
      //     the actual coercion. Removing it breaks at runtime.
      //   - prefer-await: our `main().catch(handler)` top-level error handler in
      //     bin/ scripts is the established convention; the rule wants top-level
      //     await + try/catch, which is purely a re-write with no behavior change.
      //   - no-break-in-nested-loop: `continue`/`break` inside a for-of loop to
      //     skip an item is idiomatic — the suggested refactor (extract to a
      //     function with early-return) is more code for the same logic.
      //   - no-top-level-assignment-in-function: triggers on the standard
      //     `beforeAll(async () => { privateKey = await … })` test pattern.
      //   - prefer-minimal-ternary: stylistic preference; some of our existing
      //     ternaries read more naturally in the non-minimal form.
      //   - prefer-number-coercion: wants `Number.parseInt(x, 10)` → `Number(x)`,
      //     but `parseInt` is more explicit about the integer intent.
      'unicorn/name-replacements': 'off',
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/no-non-function-verb-prefix': 'off',
      'unicorn/max-nested-calls': 'off',
      'unicorn/prefer-https': 'off',
      'unicorn/no-useless-coercion': 'off',
      'unicorn/prefer-await': 'off',
      'unicorn/no-break-in-nested-loop': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
      'unicorn/prefer-minimal-ternary': 'off',
      'unicorn/prefer-number-coercion': 'off',
      // `Uint8Array.fromBase64` / `toBase64` is a stage-3 proposal; not in
      // Node 24's runtime yet (`typeof Uint8Array.fromBase64 === 'undefined'`)
      // even though TS's `esnext` lib advertises it. `Buffer.from/toString`
      // stays correct.
      'unicorn/prefer-uint8array-base64': 'off',
      curly: 2,
      'prettier/prettier': 0,
      'object-shorthand': ['error', 'always'],

      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['.*'],
              message: 'Relative imports are not allowed.',
            },
          ],
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // bin/ files are CLI entrypoints; process.exit and unconditional async are fine.
    files: ['src/bin/**/*.ts'],
    rules: {
      'unicorn/no-process-exit': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    // Kysely + nestjs-kysely are the DB access layer. Only repositories may
    // import them; everything else (services, controllers, jobs, etc.) talks
    // to the DB via a repository. Exemptions:
    //   - src/repositories/**: the layer that owns DB queries.
    //   - src/schema/**: Kysely type defs for the DB shape.
    //   - src/utils/database.ts + src/utils/migrations.ts: build the Kysely
    //     instance the repos consume.
    //   - src/app.module.ts: registers KyselyModule at app startup.
    //   - src/bin/**: CLI compositions that wire up a Kysely + repos locally.
    files: ['src/**/*.ts'],
    ignores: [
      'src/repositories/**',
      'src/schema/**',
      'src/utils/database.ts',
      'src/utils/migrations.ts',
      'src/app.module.ts',
      'src/bin/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['.*'],
              message: 'Relative imports are not allowed.',
            },
            {
              group: ['kysely', 'kysely/*', 'nestjs-kysely'],
              message:
                'Direct DB access is restricted to src/repositories/**. Add a method to the relevant repository instead.',
            },
          ],
        },
      ],
    },
  },
]);
