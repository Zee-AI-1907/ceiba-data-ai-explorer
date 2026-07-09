import { NextRequest, NextResponse } from 'next/server'
import { sqlCache, tenantCacheKey } from '@/lib/cache'
import { requireAuthWithPermission } from '@/lib/apiAuth'
import { rateLimit } from '@/lib/rateLimiter'
import { enforceBodySize, parseBody, SqlGenerateBodySchema } from '@/lib/validation'
import { ErrorCodes, errorResponse, safeError } from '@/lib/errors'
import type { QueryEngine, SqlDialect } from '@/lib/engine/QueryEngine'
import { getQueryEngine } from '@/lib/engine/provisioning'
import { HybridRetriever } from '@/lib/rag/Retriever'
import { createLocalQueryEmbedder } from '@/lib/rag/queryEmbedder'
import {
  generateSql,
  GenerationError,
  type LlmClient,
  type SqlGenerateResponse,
} from '@/lib/rag/generate'

/**
 * POST /api/sql-generate — NL→SQL generation (NL2SQL_SPEC.md §5, §5.6; §P5).
 *
 * ── EGRESS MODEL (unchanged class, now explicit) ──────────────────────────────
 * This route sends the user's natural-language request + RETRIEVED SCHEMA
 * CONTEXT (table/column names, grains, glossary hits, cardinality warnings, and
 * few-shot NL→SQL exemplars) to the driving LLM. It sends NO patient-row values
 * — the retriever (lib/rag/Retriever.ts) draws from a PHI-classified artifact
 * bundle that holds metadata + aggregate/synthetic descriptors only. So this is
 * the same BAA-safe egress class the route always used; it is NOT behind the
 * OPENAI_BAA_SIGNED row-egress gate. lib/rag/generate.ts routes every LLM call
 * through its `callLlm` choke point so a future row-derived prompt would be
 * gated. What the model returns is UNTRUSTED output.
 *
 * ── SECURITY BOUNDARY IS DOWNSTREAM (unchanged, H25/§8.6) ─────────────────────
 * The generated SQL is NOT executed here. POST /api/query re-parses it through
 * guardSql (single statement, read-only, table/statement allowlist) before any
 * engine runs it. This route MUST NOT be trusted to have produced safe SQL. In
 * generation we additionally guardSql + cardinalityGuard + engine.EXPLAIN the
 * candidate (explain, never execute — no rows egress; SPEC §5.5) as a quality
 * gate + self-repair driver, but the query route remains the boundary.
 *
 * ── H10 (client contract) ─────────────────────────────────────────────────────
 * This route returns a proper JSON `SqlGenerateResponse` (application/json), NOT
 * an event-stream. The legacy client page (app/data-explorer/page.tsx) branches
 * on `content-type: text/event-stream` and, for JSON, only reads `scopeError` /
 * `error`. Its JSON branch already handles a non-stream response, but it does
 * not yet read the new `{ sql, dialect, retrieval, repair, cached }` shape —
 * updating that client to consume this JSON (set the SQL editor from
 * `json.sql`, surface `json.error === 'scope'`) is a follow-up (P-later, out of
 * this phase's scope). Server-side, H10 is addressed: one clean JSON contract,
 * correct content-type, dialect from the engine.
 *
 * ── H11 (dialect) ─────────────────────────────────────────────────────────────
 * `response.dialect` comes from the QueryEngine (engine.dialect(), or the
 * caller's optional `dialect` override), NOT the hardcoded "PostgreSQL" the old
 * prompt used.
 */

/** Env var naming the artifact bundle directory the retriever loads (SPEC §1.1). */
const BUNDLE_DIR_ENV = 'NL2SQL_BUNDLE_DIR'

// ── injectable dependency provider (test seam) ────────────────────────────────

/**
 * The dependencies generateSql needs. Assembled once and memoized (the bundle +
 * DuckDB engine + retriever are expensive to build). A test injects a stub set
 * via `__setGenerationDepsForTest` so the route runs fully hermetically (no
 * network, no live DB, no model download) — see the route test.
 */
export interface GenerationDeps {
  engine: QueryEngine
  retriever: HybridRetriever
  llm: LlmClient
}

let cachedDeps: GenerationDeps | null = null
let cachedDepsPromise: Promise<GenerationDeps> | null = null

/** TEST-ONLY: inject a stub dependency set (bypasses bundle/engine/LLM construction). */
// eslint-disable-next-line no-underscore-dangle
export function __setGenerationDepsForTest(deps: GenerationDeps | null): void {
  cachedDeps = deps
  cachedDepsPromise = null
}

/**
 * OpenAI-backed LlmClient (the production driving model). Kept minimal: the
 * prompt is the assembled system+user text; the model is asked for SQL only.
 * H20: never forward a raw OpenAI error body — surface a generic upstream error.
 */
function createOpenAiLlmClient(apiKey: string): LlmClient {
  return {
    async complete(prompt: string): Promise<string> {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 600,
          temperature: 0.1,
        }),
      })
      if (!response.ok) {
        await response.text().catch(() => '')
        throw new Error(`OpenAI status ${response.status}`)
      }
      const data = await response.json()
      return data.choices?.[0]?.message?.content ?? ''
    },
  }
}

/** Build + memoize the real generation dependencies. Throws if the bundle isn't configured. */
async function getGenerationDeps(): Promise<GenerationDeps> {
  if (cachedDeps) return cachedDeps
  if (cachedDepsPromise) return cachedDepsPromise

  cachedDepsPromise = (async () => {
    const bundleDir = process.env[BUNDLE_DIR_ENV]
    if (!bundleDir) {
      throw new Error(`${BUNDLE_DIR_ENV} is not set; no NL2SQL artifact bundle is configured.`)
    }
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set; the driving LLM is not configured.')
    }

    // Use the SHARED runtime engine (lib/engine/provisioning.ts). This is the SAME
    // engine instance /api/query executes against, so the dialect this route
    // EXPLAIN-validates candidate SQL against is IDENTICAL to the dialect execution
    // runs it on (the P1 dialect-mismatch fix — one engine, one dialect, one attach
    // topology). Trino stays swappable behind this seam via NL2SQL_ENGINE.
    const engine = await getQueryEngine()
    // Production query embedding is not wired up yet (vssClient.ts documents the
    // local-only options (a)/(b)); this throwing embedder fails loudly rather
    // than silently returning garbage vectors. A real local embedder replaces it.
    const retriever = new HybridRetriever({
      embedQuery: createLocalQueryEmbedder(),
      dialect: engine.dialect(),
    })
    await retriever.load(bundleDir)

    const deps: GenerationDeps = { engine, retriever, llm: createOpenAiLlmClient(apiKey) }
    cachedDeps = deps
    return deps
  })()

  return cachedDepsPromise
}

export async function POST(req: NextRequest) {
  // 1. auth (+permission) — UNCHANGED hardened wrapper.
  const { session, error } = await requireAuthWithPermission(req, 'query:run')
  if (error) return error

  // 2. rate limit — UNCHANGED.
  const limited = rateLimit(session, 'sql-generate')
  if (limited) return limited

  // 3. body size — UNCHANGED.
  const sizeErr = enforceBodySize(req)
  if (sizeErr) return sizeErr

  // 4. parse + validate (schema additively extended with sourceScope/dialect).
  const { data, error: parseErr } = await parseBody(req, SqlGenerateBodySchema)
  if (parseErr) return parseErr
  const { userMessage, sourceScope, dialect: dialectOverride } = data

  let deps: GenerationDeps
  try {
    deps = await getGenerationDeps()
  } catch {
    return errorResponse(500, ErrorCodes.INTERNAL, 'AI service is not configured.')
  }

  const targetDialect: SqlDialect = dialectOverride ?? deps.engine.dialect()

  // Tenant-scoped cache key (N4): include session.orgId (via tenantCacheKey) so
  // one org can never read another's cached SQL. Keyed on the question AND the
  // resolved dialect + source scope so a duckdb vs postgres (H11) request or a
  // scoped request never collides with a differently-targeted one.
  const cacheKey = tenantCacheKey(
    session,
    'sql-generate',
    userMessage,
    targetDialect,
    (sourceScope ?? []).join(',')
  )
  const cached = sqlCache.get(cacheKey)
  if (cached) {
    const cachedResponse: SqlGenerateResponse = {
      sql: cached.sql,
      description: cached.description,
      dialect: targetDialect,
      retrieval: { tables: [], exemplarsUsed: [], cardinalityWarnings: [] },
      cached: true,
    }
    return NextResponse.json(cachedResponse)
  }

  try {
    const result = await generateSql({
      question: userMessage,
      engine: deps.engine,
      retriever: deps.retriever,
      llm: deps.llm,
      dialect: targetDialect,
      options: {
        retrieve: sourceScope ? { sourceScope } : undefined,
      },
    })

    // Out-of-clinical-scope — the model declined (422, unchanged semantics).
    if (result.error === 'scope') {
      return errorResponse(422, ErrorCodes.SCOPE, 'I can only generate clinical and healthcare SQL.')
    }

    // Cache the (untrusted) SQL for this org; re-guarded at /api/query on execute.
    sqlCache.set(cacheKey, { sql: result.sql, description: result.description }, 30 * 60 * 1000)

    return NextResponse.json(result satisfies SqlGenerateResponse)
  } catch (e) {
    if (e instanceof GenerationError) {
      // Well-formed request, but no safe SQL could be produced in the repair
      // budget — a semantic 422, not a server fault. No internal leakage.
      return errorResponse(
        422,
        ErrorCodes.SCOPE,
        'Could not generate a safe, bounded SQL query for that request. Try rephrasing or narrowing it.'
      )
    }
    return safeError(e, { context: 'sql-generate', status: 502 })
  }
}
