import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default defineConfig([
  globalIgnores(['dist/**', 'data/**', 'scripts/archive/**']),
  ...tseslint.configs.recommended,
  {
    rules: {
      // Warnings, not errors: unused symbols are cleanup, not build breakers.
      '@typescript-eslint/no-unused-vars': 'warn',
    },
  },
  {
    files: ['ingestion/**/*.ts'],
    rules: {
      // Pre-v2 ingestion modules retain legacy dynamic payload types.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
]);
