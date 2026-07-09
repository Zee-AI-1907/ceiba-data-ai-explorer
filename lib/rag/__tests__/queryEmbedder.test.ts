/**
 * queryEmbedder.test.ts — hermetic unit tests for `lib/rag/queryEmbedder.ts`'s
 * production `EmbedQuery` (GAP #2 remediation; see that module's docstring for
 * the model/pooling/parity rationale).
 *
 * Fully hermetic (NL2SQL_PLAN.md §0 ground rule #4): NEVER downloads the real
 * `Xenova/bge-small-en-v1.5` model. `@huggingface/transformers`'s `pipeline()`
 * is mocked so these tests exercise this module's OWN logic — lazy load +
 * memoization, CLS-pooling/normalize option wiring, dimension validation, and
 * error-wrapping on a failed model load — without any network access or ONNX
 * runtime cost. A separate, NOT-CI, opt-in manual check
 * (`verifyEmbedderParity`) is what actually proves cross-space parity against
 * fastembed; see this file's last describe block for how to run that by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockPipelineFactory = vi.fn()

vi.mock('@huggingface/transformers', () => ({
  pipeline: (...args: unknown[]) => mockPipelineFactory(...args),
}))

describe('createLocalQueryEmbedder', () => {
  beforeEach(() => {
    vi.resetModules()
    mockPipelineFactory.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('lazily loads the pipeline — never touches @huggingface/transformers before the first embed() call', async () => {
    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    createLocalQueryEmbedder() // constructing the EmbedQuery must not load the model
    expect(mockPipelineFactory).not.toHaveBeenCalled()
  })

  it('requests feature-extraction on the pinned Xenova/bge-small-en-v1.5 model, fp32', async () => {
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 384 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder, LOCAL_QUERY_EMBEDDER_HF_MODEL } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await embed('heart rate over 120')

    expect(mockPipelineFactory).toHaveBeenCalledWith(
      'feature-extraction',
      LOCAL_QUERY_EMBEDDER_HF_MODEL,
      expect.objectContaining({ dtype: 'fp32' })
    )
  })

  it('calls the extractor with CLS pooling + L2 normalize (matches fastembed CLS-pooling behavior)', async () => {
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 384 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await embed('a clinical question')

    expect(fakeExtractor).toHaveBeenCalledWith('a clinical question', { pooling: 'cls', normalize: true })
  })

  it('memoizes the pipeline — a second embed() call does not reload the model', async () => {
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 384 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await embed('first question')
    await embed('second question')

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1)
    expect(fakeExtractor).toHaveBeenCalledTimes(2)
  })

  it('two independently-constructed embedders share the SAME memoized model load', async () => {
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 384 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    await createLocalQueryEmbedder()('q1')
    await createLocalQueryEmbedder()('q2')

    expect(mockPipelineFactory).toHaveBeenCalledTimes(1)
  })

  it('returns an L2-normalized Float32Array of the expected 384 dimension', async () => {
    const raw = Array.from({ length: 384 }, (_, i) => (i % 7) - 3)
    const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0))
    const normalized = raw.map((v) => v / norm)
    const fakeExtractor = vi.fn(async () => ({ data: normalized }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder, PRODUCTION_EMBEDDING_DIMENSION } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    const vector = await embed('any text')

    expect(vector).toBeInstanceOf(Float32Array)
    expect(vector.length).toBe(PRODUCTION_EMBEDDING_DIMENSION)
    const producedNorm = Math.sqrt(Array.from(vector).reduce((s, v) => s + v * v, 0))
    expect(producedNorm).toBeCloseTo(1, 5)
  })

  it('throws a clear error (not a hang) if the pipeline resolves an unexpected dimension', async () => {
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 123 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValue(fakeExtractor)

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await expect(embed('bad dimension')).rejects.toThrow(/384/)
  })

  it('wraps a failed model load (e.g. no network / model unavailable) in a clear, actionable error', async () => {
    mockPipelineFactory.mockRejectedValue(new Error('ENOTFOUND huggingface.co'))

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await expect(embed('anything')).rejects.toThrow(/local .* model|ONNX|cache/i)
  })

  it('allows a retry after a failed load (does not permanently poison the memoized promise)', async () => {
    mockPipelineFactory.mockRejectedValueOnce(new Error('temporary network blip'))
    const fakeExtractor = vi.fn(async () => ({ data: Array.from({ length: 384 }, () => 0.1) }))
    mockPipelineFactory.mockResolvedValueOnce(fakeExtractor)

    const { createLocalQueryEmbedder } = await import('../queryEmbedder')
    const embed = createLocalQueryEmbedder()
    await expect(embed('first try')).rejects.toThrow()
    await expect(embed('second try')).resolves.toBeInstanceOf(Float32Array)
    expect(mockPipelineFactory).toHaveBeenCalledTimes(2)
  })
})

/**
 * Cross-space parity against fastembed is NOT re-verified on every CI run (it
 * would require downloading the real model — the opposite of hermetic). It
 * was verified manually once (see queryEmbedder.ts's module docstring for the
 * measured cosine similarity, >= 0.9999992, against `prep/.venv`'s fastembed
 * 0.8.0 running the same BAAI/bge-small-en-v1.5 model). To re-verify by hand
 * after changing the pinned model id/revision:
 *
 *   1. Embed a few representative strings with `prep/.venv`'s fastembed
 *      (`FastEmbedEmbedder` / `TextEmbedding(model_name="BAAI/bge-small-en-v1.5")`),
 *      save the vectors to JSON.
 *   2. Embed the SAME strings with this module's `createLocalQueryEmbedder()`.
 *   3. Compute cosine similarity between the two vectors for each string (or
 *      call `verifyEmbedderParity(text, fastembedVector)` exported from this
 *      module) — expect >= 0.999.
 */
describe.skip('manual-only: cross-space parity against fastembed (see comment above; not run in CI)', () => {
  it('placeholder — see queryEmbedder.ts module docstring for the verified measurement', () => {})
})
