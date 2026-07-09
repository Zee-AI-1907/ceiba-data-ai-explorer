/**
 * cli.ts — standalone CLI entry point for `eval/runEval.ts` (NL2SQL_PLAN.md
 * §P6). Kept as a separate file (rather than a `require.main === module`
 * guard inside `runEval.ts`) so `runEval.ts` has zero top-level side effects
 * regardless of how the module system resolves `require`/`import.meta` for
 * this project's mixed CJS/ESM/bundler toolchain — importing `runEval.ts`
 * from a test file never triggers a run; only executing THIS file does.
 *
 * Usage: `npx tsx eval/cli.ts` (synthetic mode, stub/recorded LLM, prints the
 * EvalReport as JSON to stdout).
 */

import { main } from './runEval'

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exitCode = 1
})
