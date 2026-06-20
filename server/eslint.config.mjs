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
