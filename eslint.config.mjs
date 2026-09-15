// JavaScript-only lint config. TypeScript files (components/ui, hooks, lib/*.ts,
// tests/e2e) are type-checked by next build with the native TypeScript 7
// compiler and are not linted here, because typescript-eslint does not support
// TypeScript 7 yet.
import { defineConfig, globalIgnores } from 'eslint/config';
import nextPlugin from '@next/eslint-plugin-next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores([
    'node_modules/**',
    '.next/**',
    'app/.well-known/workflow/**',
    '.workflow-data/**',
    'data/**',
    // Tool worktrees (Claude Code workflows) are checked out under .claude/.
    '.claude/**',
    // Vendored Coss UI registry files: re-add from the registry, do not lint.
    'components/ui/**',
    'playwright-report/**',
    'test-results/**',
    // TypeScript is type-checked by next build, not linted (see above).
    '**/*.ts',
    '**/*.tsx',
    '**/*.d.ts',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    extends: [
      nextPlugin.configs['core-web-vitals'],
      react.configs.flat['jsx-runtime'],
      reactHooks.configs.flat.recommended,
      jsxA11y.flatConfigs.recommended,
    ],
    rules: {
      // The mount effects in app/ and components/focus read browser-only
      // state (location.search, the next-themes hydration guard) before
      // setting state, which this React Compiler rule flags. Keep it visible
      // as a warning until those effects are restructured.
      'react-hooks/set-state-in-effect': 'warn',
      // Base UI's render prop takes an empty element (`render={<a href />}`)
      // that receives the Button's children at render time, so the rule
      // cannot see the anchor's content and reports every such link.
      'jsx-a11y/anchor-has-content': 'off',
    },
  },
]);
