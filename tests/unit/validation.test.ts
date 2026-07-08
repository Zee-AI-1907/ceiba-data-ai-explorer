/**
 * Unit tests for lib/validation.ts — the request-body validation helper (N5),
 * body-size guard (§6a), and pagination helpers (§6a / H22).
 *
 * These are plain Node-environment tests: `parseBody` takes a standard
 * `Request`, and the helpers return `NextResponse` (whose `.json()` / `.status`
 * we assert on). No DOM, no mocking of external services.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  parseBody,
  enforceBodySize,
  clampLimit,
  parsePagination,
  QueryBodySchema,
  ChartSuggestBodySchema,
  DEFAULT_MAX_BODY_BYTES,
  MAX_PAGE_LIMIT,
} from '@/lib/validation'

const TestSchema = z.object({ name: z.string().min(1), age: z.number().int() })

function jsonRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

describe('parseBody', () => {
  it('returns a 400 error on malformed / non-JSON body', async () => {
    const req = jsonRequest('{ not valid json ')
    const { data, error } = await parseBody(req, TestSchema)

    expect(data).toBeNull()
    expect(error).not.toBeNull()
    expect(error!.status).toBe(400)
    const payload = await error!.json()
    expect(payload.error.code).toBe('VALIDATION')
    expect(payload.error.message).toBe('Malformed JSON body.')
  })

  it('returns a 400 error when the body fails the schema', async () => {
    const req = jsonRequest(JSON.stringify({ name: '', age: 'oops' }))
    const { data, error } = await parseBody(req, TestSchema)

    expect(data).toBeNull()
    expect(error!.status).toBe(400)
    const payload = await error!.json()
    expect(payload.error.code).toBe('VALIDATION')
    // Field paths surface, but the received values must NOT leak.
    expect(payload.error.message).toContain('name')
    expect(payload.error.message).toContain('age')
    expect(payload.error.message).not.toContain('oops')
  })

  it('returns typed data on a valid body', async () => {
    const req = jsonRequest(JSON.stringify({ name: 'Ada', age: 42 }))
    const { data, error } = await parseBody(req, TestSchema)

    expect(error).toBeNull()
    expect(data).toEqual({ name: 'Ada', age: 42 })
    // Type-level: `data` is narrowed to the schema type when error is null.
    expect(data!.name).toBe('Ada')
  })

  it('validates the shared QueryBodySchema (requires non-empty sql)', async () => {
    const bad = await parseBody(jsonRequest(JSON.stringify({ sql: '' })), QueryBodySchema)
    expect(bad.error!.status).toBe(400)

    const good = await parseBody(
      jsonRequest(JSON.stringify({ sql: 'SELECT 1', database: 'eclinics', limit: 10 })),
      QueryBodySchema
    )
    expect(good.error).toBeNull()
    expect(good.data).toMatchObject({ sql: 'SELECT 1', database: 'eclinics', limit: 10 })
  })

  it('rejects the chart-suggest N5 crash shape (missing columns)', async () => {
    // The route did `columns.map(...)` before try — an absent `columns` was the crash.
    const { error } = await parseBody(
      jsonRequest(JSON.stringify({ rows: [], userMessage: 'plot it' })),
      ChartSuggestBodySchema
    )
    expect(error!.status).toBe(400)
  })
})

describe('enforceBodySize', () => {
  it('allows a request within the cap', () => {
    const req = jsonRequest('{}', { 'content-length': '2' })
    expect(enforceBodySize(req)).toBeNull()
  })

  it('allows a request with no content-length header', () => {
    const req = new Request('http://localhost/api/test', { method: 'POST' })
    expect(enforceBodySize(req)).toBeNull()
  })

  it('rejects a request over the cap with 413', () => {
    const req = jsonRequest('{}', { 'content-length': String(DEFAULT_MAX_BODY_BYTES + 1) })
    const res = enforceBodySize(req)
    expect(res).not.toBeNull()
    expect(res!.status).toBe(413)
  })

  it('honours a custom cap', () => {
    const req = jsonRequest('{}', { 'content-length': '100' })
    expect(enforceBodySize(req, 50)!.status).toBe(413)
    expect(enforceBodySize(req, 200)).toBeNull()
  })
})

describe('clampLimit', () => {
  it('clamps above the max', () => {
    expect(clampLimit(999999)).toBe(MAX_PAGE_LIMIT)
  })
  it('floors below 1', () => {
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
  })
  it('falls back on non-numeric input', () => {
    expect(clampLimit('abc', { fallback: 25 })).toBe(25)
    expect(clampLimit(undefined, { fallback: 25 })).toBe(25)
  })
  it('coerces numeric strings and floors floats', () => {
    expect(clampLimit('50')).toBe(50)
    expect(clampLimit(50.9)).toBe(50)
  })
  it('respects a custom max', () => {
    expect(clampLimit(500, { max: 100 })).toBe(100)
  })
})

describe('parsePagination', () => {
  it('parses limit + cursor from a URL', () => {
    const p = parsePagination('http://localhost/api/list?limit=25&cursor=abc')
    expect(p.limit).toBe(25)
    expect(p.cursor).toBe('abc')
  })
  it('clamps an over-max limit and defaults a missing cursor', () => {
    const p = parsePagination('http://localhost/api/list?limit=100000')
    expect(p.limit).toBe(MAX_PAGE_LIMIT)
    expect(p.cursor).toBeNull()
  })
  it('rejects an absurdly long cursor', () => {
    const long = 'x'.repeat(600)
    const p = parsePagination(`http://localhost/api/list?cursor=${long}`)
    expect(p.cursor).toBeNull()
  })
})
