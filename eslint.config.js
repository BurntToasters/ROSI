import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import nounsanitized from 'eslint-plugin-no-unsanitized';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'as' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The renderer wires async handlers into DOM callbacks and modal button
      // actions throughout; ROSI has always allowed that pattern.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // Flag unsanitized DOM sinks (innerHTML/insertAdjacentHTML/etc.) in the
    // renderer, where untrusted yt-dlp/queue data is rendered.
    files: ['src/**/*.ts'],
    ignores: ['src/tests/**'],
    plugins: { 'no-unsanitized': nounsanitized },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    files: ['scripts/**/*.{js,ts}', 'e2e/**/*.js'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'public/**'],
  },
];
