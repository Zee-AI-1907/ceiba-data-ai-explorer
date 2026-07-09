/**
 * generate.ts — the NL→SQL generation pipeline + self-repair loop
 * (NL2SQL_SPEC.md §5.1, §5.5; NL2SQL_PLAN.md §P5).
 *
 * ── The pipeline (SPEC §5.1) ──────────────────────────────────────────────────
 *   question (untrusted)
 *     → [A] retrieve          Retriever.retrieve(question)          → SchemaContext
 *     → [B] assemble prompt    assemblePrompt(ctx, question, caps)  (H25-delimited)
 *     → [C] LLM                llm.complete(prompt)                 → candidate text
 *     → [D] extract SQL        strip code fences / prose            → sql
 *     → [E] guardSql           reject non-read / unsafe / multi-stmt
 *     → [F] cardinalityGuard   pass | repair (LIMIT) | reject (unbounded scan)
 *     → [G] engine.explain     dry-run validate (NO rows egress)
 *     → self-repair (≤2 rounds) on any [E]/[F]/[G] failure that is repairable
 *   → final read-only SQL (executed later by POST /api/query, NOT here)
 *
 * ── EGRESS GATE (SPEC §5.6, invariants §8.2) ──────────────────────────────────
 * The prompt the LLM receives contains SCHEMA / METADATA / GLOSSARY / EXEMPLARS
 * ONLY — never a raw patient-row value. That class of content is inherently
 * BAA-safe (it is the same class the route already sent), so generation is NOT
 * behind the OPENAI_BAA_SIGNED row-egress gate. To keep that guarantee explicit
 * and future-proof, every LLM call in this module goes through `callLlm`, which
 * takes an `egressClass` and — for anything patient-row-derived — routes through
 * `assertEgressAllowed()` before the network call. Today the only egress class
 * used is `'schema-metadata'` (always allowed); if a future change ever adds
 * row-derived context to a prompt it MUST pass `'patient-derived'` and will then
 * be gated closed by default. See `LlmEgressClass`.
 *
 * ── explain-not-execute (SPEC §5.5) ───────────────────────────────────────────
 * The repair VALIDATOR is `engine.explain()`, never `engine.execute()`. EXPLAIN
 * binds/parses the SQL in the target dialect and returns the plan text to no one
 * that matters here — it returns ZERO data rows. So the self-repair loop can
 * validate that the model's SQL is well-formed against the real topology without
 * a single patient row ever being read or egressed. `execute()` is only ever run
 * later, at POST /api/query, on the (re-guarded) returned SQL.
 *
 * ── The generated SQL is UNTRUSTED ────────────────────────────────────────────
 * Retrieval + self-repair change HOW the SQL is produced, never WHETHER it is
 * re-validated before execution. The returned `sql` is untrusted model output
 * and is re-guarded by `guardSql` at POST /api/query before Trino/DuckDB runs it
 * (SPEC invariant §8.6). This module's guardSql/cardinalityGuard passes are a
 * generation-time quality gate, not the execution security boundary.
 */

import type { EngineCapabilities, QueryEngine, SqlDialect } from '../engine/QueryEngine'
import { assertEgressAllowed } from '../phiScrubber'
import { guardSql, type TableAllowlistCheck } from '../sqlGuard'
import { cardinalityGuardFromContext } from './cardinalityGuard'
import { assemblePrompt, assembleRepairPrompt, type PromptAssemblyOptions } from './promptAssembly'
import type { Retriever, RetrieveOptions, SchemaContext } from './Retriever'

// ── LLM seam (SPEC §5.1 [C]) ──────────────────────────────────────────────────

/**
 * LlmClient — the ONLY seam to a driving LLM. Injected so tests stub it (no
 * network, no BAA, no model download — NL2SQL_PLAN.md §0a decision #3 "CI uses a
 * stubbed/recorded driving LLM"). `complete` takes the assembled prompt string
 * and returns the model's raw text (from which candidate SQL is extracted).
 */
export interface LlmClient {
  complete(prompt: string): Promise<string>
}

/**
 * The egress class of a single LLM call. `schema-metadata` is inherently
 * BAA-safe (schema/metadata/glossary/exemplars — never raw rows) and is always
 * permitted. `patient-derived` (aggregates or any row-derived text) is gated by
 * `assertEgressAllowed()` / OPENAI_BAA_SIGNED and defaults CLOSED. Generation
 * only ever uses `schema-metadata`; the class exists so a future row-derived
 * prompt cannot silently bypass the gate.
 */
export type LlmEgressClass = 'schema-metadata' | 'patient-derived'

/** Thrown when a patient-row-derived LLM call is attempted while egress is gated closed. */
export class EgressBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EgressBlockedError'
  }
}

/**
 * callLlm — the single choke point for every LLM call in generation. Enforces
 * the egress gate BEFORE the prompt leaves the process for a `patient-derived`
 * call, then delegates to the injected client. Documented so the compliance
 * boundary is one auditable function, not scattered across the pipeline.
 */
async function callLlm(llm: LlmClient, prompt: string, egressClass: LlmEgressClass): Promise<string> {
  if (egressClass === 'patient-derived') {
    const decision = assertEgressAllowed()
    if (!decision.allowed) {
      throw new EgressBlockedError(decision.message)
    }
  }
  return llm.complete(prompt)
}

// ── SqlGenerateResponse (SPEC §5.2) ───────────────────────────────────────────

export interface SqlGenerateResponse {
  /** UNTRUSTED model output; re-guarded by /api/query before execution. */
  sql: string
  description: string
  /** The dialect the SQL targets (fixes the hardcoded-"PostgreSQL" bug, H11). */
  dialect: SqlDialect
  retrieval: {
    tables: string[] // tableIds fed to the model (observability)
    exemplarsUsed: string[]
    cardinalityWarnings: string[]
  }
  /** Present when self-repair ran (SPEC §5.5). */
  repair?: { rounds: number; lastError?: string }
  cached: boolean
  /** Out-of-clinical-scope (unchanged semantics from the legacy route). */
  error?: 'scope'
}

// ── options ───────────────────────────────────────────────────────────────────

export interface GenerateOptions {
  /** Retrieval budget/knobs forwarded to Retriever.retrieve(). */
  retrieve?: Partial<RetrieveOptions>
  /** Max self-repair rounds after the initial attempt (SPEC §5.5: <= 2). Default 2. */
  maxRepairRounds?: number
  /** Row cap the model is told to LIMIT to, and the cardinality auto-repair LIMIT. Default 1000. */
  defaultLimit?: number
  /** Optional table-allowlist policy wired into guardSql (H25 seam). Default permissive. */
  tableAllowlist?: TableAllowlistCheck
  /** Extra prompt-assembly options. */
  promptAssembly?: PromptAssemblyOptions
}

export interface GenerateSqlParams {
  question: string
  engine: QueryEngine
  retriever: Retriever
  llm: LlmClient
  /**
   * The dialect the response should target. Defaults to `engine.dialect()`.
   * A caller-supplied override (SPEC §5.2 `SqlGenerateRequest.dialect`) is
   * honored in the response's `dialect` field and the prompt's dialect line.
   */
  dialect?: SqlDialect
  options?: GenerateOptions
  /** Marks the response `cached:false` by default; the route sets/reads the cache itself. */
  cached?: boolean
}

const DEFAULT_TOKEN_BUDGET = 2500
const DEFAULT_MAX_TABLES = 6
const DEFAULT_MAX_REPAIR_ROUNDS = 2
const DEFAULT_LIMIT = 1000

/** Out-of-scope sentinel a model may return (unchanged legacy semantics). */
const SCOPE_SENTINEL = /^\s*\{?\s*"?error"?\s*:?\s*"?scope"?\s*\}?\s*$/i

// ── SQL extraction (SPEC §5.1 [D]) ────────────────────────────────────────────

/**
 * extractSql — recover a single SQL statement from the model's raw completion.
 * Handles the common shapes a driving model emits: a fenced ```sql block, a
 * JSON `{ "sql": "...", "description": "..." }` object (the legacy contract),
 * or bare SQL text. Returns `{ sql, description }`. The extracted SQL is still
 * UNTRUSTED — guardSql is the gate, not this parser.
 */
export function extractSql(raw: string): { sql: string; description: string } {
  const text = raw.trim()

  // 1. JSON object shape: { "sql": "...", "description": "..." }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { sql?: unknown; description?: unknown }
      if (typeof parsed.sql === 'string') {
        return {
          sql: parsed.sql.trim(),
          description: typeof parsed.description === 'string' ? parsed.description : '',
        }
      }
    } catch {
      // fall through to fenced/bare extraction
    }
  }

  // 2. Fenced code block ```sql ... ``` (or a bare ``` ... ```).
  const fence = text.match(/```(?:sql)?\s*([\s\S]*?)```/i)
  if (fence && fence[1]) {
    return { sql: fence[1].trim(), description: '' }
  }

  // 3. Bare text — take it verbatim.
  return { sql: text, description: '' }
}

// ── the pipeline ────────────────────────────────────────────────────────────

/** A per-attempt failure carried between self-repair rounds. */
interface AttemptFailure {
  error: string
  hint?: string
  /** The exact SQL that failed (fed back to the repair prompt). */
  failedSql: string
}

/**
 * validateCandidate — runs the guardSql → cardinalityGuard → explain chain on
 * one candidate SQL. Returns either the accepted (possibly auto-repaired) SQL,
 * or a failure describing why it was rejected (for the next repair round).
 *
 * CRITICAL: uses `engine.explain` (NOT execute) — zero rows egress.
 */
async function validateCandidate(
  candidateSql: string,
  context: SchemaContext,
  engine: QueryEngine,
  opts: { defaultLimit: number; tableAllowlist?: TableAllowlistCheck }
): Promise<{ ok: true; sql: string } | { ok: false; failure: AttemptFailure }> {
  // [E] guardSql — read-only / single-statement / (optional) table allowlist.
  const guardVerdict = guardSql(candidateSql, { tableAllowlist: opts.tableAllowlist })
  if (!guardVerdict.allowed) {
    return {
      ok: false,
      failure: {
        error: guardVerdict.reason ?? 'SQL rejected by the read-only guard.',
        hint: 'Produce a single read-only SELECT (or WITH ... SELECT). No writes, DDL, or multiple statements.',
        failedSql: candidateSql,
      },
    }
  }

  // [F] cardinalityGuard — bounded scan of large time-series tables.
  const cardVerdict = cardinalityGuardFromContext(candidateSql, context, opts.defaultLimit)
  let sqlForExplain = candidateSql
  if (cardVerdict.action === 'reject') {
    return {
      ok: false,
      failure: {
        error: cardVerdict.reason ?? 'Query would scan a large table unbounded.',
        hint: cardVerdict.repairHint,
        failedSql: candidateSql,
      },
    }
  }
  if (cardVerdict.action === 'repair' && cardVerdict.repairedSql) {
    // Safe, meaning-preserving auto-repair (e.g. appended LIMIT) — adopt it and
    // continue to explain the repaired form.
    sqlForExplain = cardVerdict.repairedSql
  }

  // [G] engine.explain — dry-run validate in the target dialect. NO ROWS.
  const explainVerdict = await engine.explain(sqlForExplain, {})
  if (!explainVerdict.ok) {
    return {
      ok: false,
      failure: {
        error: explainVerdict.error,
        hint: 'The SQL failed to parse/bind against the schema. Fix the table/column names or syntax for the stated dialect.',
        failedSql: sqlForExplain,
      },
    }
  }

  return { ok: true, sql: sqlForExplain }
}

/**
 * generateSql — the SPEC §5.1 pipeline as an injectable, testable function.
 * Retrieves schema context, prompts the (injected) LLM, guards + cardinality-
 * checks + explains the candidate, and self-repairs (≤ maxRepairRounds) on any
 * repairable failure. Returns a `SqlGenerateResponse` whose `sql` is the final
 * read-only, bounded, explain-clean SQL (still untrusted — re-guarded at
 * /api/query). Throws only on retrieval/LLM/egress infrastructure errors; a SQL
 * that cannot be made safe within the repair budget throws a `GenerationError`.
 */
export async function generateSql(params: GenerateSqlParams): Promise<SqlGenerateResponse> {
  const { question, engine, retriever, llm } = params
  const options = params.options ?? {}
  const dialect = params.dialect ?? engine.dialect()
  const capabilities: EngineCapabilities = engine.capabilities()
  const defaultLimit = options.defaultLimit ?? DEFAULT_LIMIT
  const maxRepairRounds = Math.min(options.maxRepairRounds ?? DEFAULT_MAX_REPAIR_ROUNDS, 2)

  // [A] retrieve — schema/metadata/glossary/exemplars only (never raw rows).
  const retrieveOptions: RetrieveOptions = {
    tokenBudget: options.retrieve?.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    maxTables: options.retrieve?.maxTables ?? DEFAULT_MAX_TABLES,
    sourceScope: options.retrieve?.sourceScope,
    recallTables: options.retrieve?.recallTables,
    recallColumns: options.retrieve?.recallColumns,
    exemplarK: options.retrieve?.exemplarK,
  }
  const context = await retriever.retrieve(question, retrieveOptions)

  const promptOptions: PromptAssemblyOptions = { defaultLimit, ...options.promptAssembly }

  // [B]+[C] assemble prompt + first LLM call. Egress class is schema-metadata:
  // the prompt is BAA-safe by construction (no patient-row values).
  const initialPrompt = assemblePrompt(context, question, capabilities, dialect, promptOptions)
  let completion = await callLlm(llm, initialPrompt, 'schema-metadata')

  // [D] extract candidate SQL.
  let { sql: candidateSql, description } = extractSql(completion)

  // Out-of-scope sentinel — the model declined the request (unchanged semantics).
  if (SCOPE_SENTINEL.test(completion.trim()) || SCOPE_SENTINEL.test(candidateSql)) {
    return {
      sql: '',
      description: '',
      dialect,
      retrieval: retrievalSummary(context),
      cached: params.cached ?? false,
      error: 'scope',
    }
  }

  let rounds = 0
  let lastError: string | undefined

  // Initial validation.
  let validation = await validateCandidate(candidateSql, context, engine, {
    defaultLimit,
    tableAllowlist: options.tableAllowlist,
  })

  // Self-repair loop (SPEC §5.5): on a repairable failure, feed the error +
  // failed SQL back to the LLM and re-validate. Bounded to maxRepairRounds.
  while (!validation.ok && rounds < maxRepairRounds) {
    rounds += 1
    lastError = validation.failure.error

    const repairPrompt = assembleRepairPrompt(
      context,
      question,
      capabilities,
      dialect,
      {
        failedSql: validation.failure.failedSql,
        error: validation.failure.error,
        hint: validation.failure.hint,
      },
      promptOptions
    )
    // Sequential by necessity: each repair round consumes the PREVIOUS round's
    // failure, so these awaits cannot be parallelised (bounded to maxRepairRounds).
    // eslint-disable-next-line no-await-in-loop
    completion = await callLlm(llm, repairPrompt, 'schema-metadata')
    const extracted = extractSql(completion)
    candidateSql = extracted.sql
    if (extracted.description) description = extracted.description

    // eslint-disable-next-line no-await-in-loop
    validation = await validateCandidate(candidateSql, context, engine, {
      defaultLimit,
      tableAllowlist: options.tableAllowlist,
    })
  }

  if (!validation.ok) {
    lastError = validation.failure.error
    throw new GenerationError(
      `Could not produce safe, executable SQL within ${maxRepairRounds} repair round(s).`,
      { rounds, lastError }
    )
  }

  return {
    sql: validation.sql,
    description,
    dialect,
    retrieval: retrievalSummary(context),
    ...(rounds > 0 ? { repair: { rounds, lastError } } : {}),
    cached: params.cached ?? false,
  }
}

/** Thrown when the pipeline cannot produce guard-passing, explain-clean SQL within the repair budget. */
export class GenerationError extends Error {
  readonly rounds: number
  readonly lastError?: string
  constructor(message: string, detail: { rounds: number; lastError?: string }) {
    super(message)
    this.name = 'GenerationError'
    this.rounds = detail.rounds
    this.lastError = detail.lastError
  }
}

function retrievalSummary(context: SchemaContext): SqlGenerateResponse['retrieval'] {
  return {
    tables: context.tables.map((t) => t.tableId),
    exemplarsUsed: context.exemplars.map((e) => e.id),
    cardinalityWarnings: context.cardinalityWarnings.map((w) => w.message),
  }
}
