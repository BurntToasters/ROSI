import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import nounsanitized from 'eslint-plugin-no-unsanitized';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      'dist/',
      'release/',
      'node_modules/',
      '._temp_*/',
      '*.js',
      'src/renderer/**/*.js',
      'src/renderer/**/*.js.map',
      '!eslint.config.mjs',
      '!build-scripts/*.js',
    ],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { disallowTypeAnnotations: false },
      ],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',

      'no-console': ['warn', { allow: ['warn', 'error'] }],

      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-async-promise-executor': 'warn',
      'no-case-declarations': 'warn',
      'no-useless-escape': 'warn',

      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],

      // Type-aware unsafe-data-flow rules. Kept as warnings so they surface
      // risky `any` flows without breaking the build; promote to 'error' as the
      // remaining warnings are burned down.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  {
    // Flag unsanitized DOM sinks (innerHTML/insertAdjacentHTML/etc.) in the
    // renderer, where untrusted yt-dlp/queue data is rendered.
    files: ['src/renderer/**/*.ts'],
    plugins: { 'no-unsanitized': nounsanitized },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        URL: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        FocusEvent: 'readonly',
        MouseEvent: 'readonly',
        DragEvent: 'readonly',
        PointerEvent: 'readonly',
        DOMException: 'readonly',
        Node: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLImageElement: 'readonly',
        HTMLIFrameElement: 'readonly',
        MediaQueryList: 'readonly',
        NodeListOf: 'readonly',
        GlobalEventHandlers: 'readonly',
        requestAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        getComputedStyle: 'readonly',
      },
    },
  },
  {
    files: ['src/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // Test mocks are intentionally loose-typed; the unsafe-data-flow
      // rules fire on nearly every vi.fn() call and mock object. Keep them
      // off in tests so lint stays actionable in production code.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['build-scripts/*.{js,cjs}'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'no-control-regex': 'off',
    },
  }
);
