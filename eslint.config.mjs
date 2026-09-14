import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';

export default defineConfig([
  ...nextVitals,
  globalIgnores([
    'node_modules/**',
    '.next/**',
    'data/**',
    // Vendored Coss UI registry files: re-add from the registry, do not lint.
    'components/ui/**',
  ]),
  {
    rules: {
      // The mount effects in app/ and components/focus read browser-only
      // state (location.search, the next-themes hydration guard) before
      // setting state, which this React Compiler rule flags. Keep it visible
      // as a warning until those effects are restructured.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
]);
