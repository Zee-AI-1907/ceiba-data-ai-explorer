import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Vitest config for unit + integration tests.
//
// Scope note (see docs/TEST_STRATEGY.md §9): this config intentionally does NOT set up a
// jsdom/React environment yet — the example tests in this pass are plain Node-environment
// unit tests against lib/ modules with no DOM/React dependency. Add `environment: 'jsdom'`
// (per-file via a `// @vitest-environment jsdom` docblock, or globally) when component tests
// are introduced in a later pass.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors tsconfig.json's "@/*" path mapping so tests can import with the same
      // aliases as application code.
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      // NL2SQL: co-located lib unit tests and the eval harness (SPEC §7). Additive —
      // the tests/** globs above are unchanged.
      'lib/**/__tests__/*.test.ts',
      'eval/**/*.test.ts',
      // NL2SQL P5: co-located API route tests (e.g. app/api/sql-generate). Additive.
      'app/**/__tests__/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      // Only measure coverage for modules that currently have tests targeting them.
      // Expand this list as each blocked test area (see docs/TEST_STRATEGY.md §7) unblocks
      // and gains real tests — do not add a file here without a corresponding test.
      include: ['lib/permissions.ts', 'lib/phiScrubber.ts'],
      thresholds: {
        'lib/permissions.ts': { lines: 100, branches: 100, functions: 100, statements: 100 },
        'lib/phiScrubber.ts': { lines: 90, branches: 85, functions: 90, statements: 90 },
      },
    },
  },
})
