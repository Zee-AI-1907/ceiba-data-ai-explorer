/**
 * sqlGenerateClient.test.ts — unit tests for the client's
 * `POST /api/sql-generate` response-classification helper (GAP #3 remediation).
 * Pure function, no DOM/fetch/jsdom needed — asserts against the ACTUAL shapes
 * `app/api/sql-generate/route.ts` returns: a 200 `SqlGenerateResponse` (SPEC
 * §5.2) on success, or a `lib/errors.ts` `ErrorEnvelope` on any failure
 * (422 SCOPE for out-of-clinical-scope / unrepairable generation, and the
 * other standard statuses for validation/rate-limit/auth/server errors).
 */

import { describe, expect, it } from 'vitest'
import { interpretSqlGenerateResponse, type SqlGenerateSuccess } from '../sqlGenerateClient'

const GOOD_RESPONSE: SqlGenerateSuccess = {
  sql: 'SELECT 1',
  description: 'a trivial query',
  dialect: 'duckdb',
  retrieval: { tables: ['mock.public.VisitMock'], exemplarsUsed: [], cardinalityWarnings: [] },
  cached: false,
}

describe('interpretSqlGenerateResponse — success (200 SqlGenerateResponse)', () => {
  it('classifies a 200 JSON body as success and passes the response through untouched', () => {
    const result = interpretSqlGenerateResponse(200, GOOD_RESPONSE)
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.response.sql).toBe('SELECT 1')
      expect(result.response.dialect).toBe('duckdb')
      expect(result.response.cached).toBe(false)
    }
  })

  it('classifies a cached response (cached:true) as success too', () => {
    const result = interpretSqlGenerateResponse(200, { ...GOOD_RESPONSE, cached: true })
    expect(result.kind).toBe('success')
  })

  it('carries through repair info when present', () => {
    const result = interpretSqlGenerateResponse(200, {
      ...GOOD_RESPONSE,
      repair: { rounds: 1, lastError: 'missing LIMIT' },
    })
    expect(result.kind).toBe('success')
    if (result.kind === 'success') {
      expect(result.response.repair).toEqual({ rounds: 1, lastError: 'missing LIMIT' })
    }
  })
})

describe('interpretSqlGenerateResponse — scope decline (422 { error: { code: "SCOPE" } })', () => {
  it('classifies 422 + code SCOPE as a scope decline, surfacing the safe message', () => {
    const result = interpretSqlGenerateResponse(422, {
      error: { code: 'SCOPE', message: 'I can only generate clinical and healthcare SQL.' },
    })
    expect(result.kind).toBe('scope')
    if (result.kind === 'scope') {
      expect(result.message).toBe('I can only generate clinical and healthcare SQL.')
    }
  })

  it('classifies the unrepairable-generation 422 SCOPE variant as scope too', () => {
    const result = interpretSqlGenerateResponse(422, {
      error: { code: 'SCOPE', message: 'Could not generate a safe, bounded SQL query for that request.' },
    })
    expect(result.kind).toBe('scope')
  })
})

describe('interpretSqlGenerateResponse — other errors (envelope at a non-scope status/code)', () => {
  it('a 400 VALIDATION envelope is an error, not scope', () => {
    const result = interpretSqlGenerateResponse(400, { error: { code: 'VALIDATION', message: 'userMessage is required' } })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.code).toBe('VALIDATION')
      expect(result.message).toBe('userMessage is required')
    }
  })

  it('a 429 RATE_LIMITED envelope is an error', () => {
    const result = interpretSqlGenerateResponse(429, { error: { code: 'RATE_LIMITED', message: 'Too many requests.' } })
    expect(result.kind).toBe('error')
  })

  it('a 500/502 envelope with a correlationId is an error, message only (no leakage of correlationId into the UI text)', () => {
    const result = interpretSqlGenerateResponse(502, {
      error: { code: 'UPSTREAM', message: 'An upstream service failed to respond. Please try again.', correlationId: 'abc-123' },
    })
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      expect(result.message).not.toContain('abc-123')
    }
  })

  it('a 422 envelope with a DIFFERENT code than SCOPE is still classified as error, not scope', () => {
    const result = interpretSqlGenerateResponse(422, { error: { code: 'SOME_OTHER_CODE', message: 'x' } })
    expect(result.kind).toBe('error')
  })
})

describe('interpretSqlGenerateResponse — malformed/unexpected bodies', () => {
  it('throws on a body that is neither a success shape nor an error envelope', () => {
    expect(() => interpretSqlGenerateResponse(200, { unexpected: true })).toThrow(/unexpected response shape/i)
  })

  it('throws on null', () => {
    expect(() => interpretSqlGenerateResponse(200, null)).toThrow()
  })

  it('throws on the OLD legacy shape ({ scopeError: true }) — proves the stale client contract is gone', () => {
    expect(() => interpretSqlGenerateResponse(200, { scopeError: true })).toThrow()
  })
})
