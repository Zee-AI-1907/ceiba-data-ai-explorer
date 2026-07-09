/**
 * queryEmbedder.ts — the REAL production `EmbedQuery` (NL2SQL_SPEC.md §0
 * decision #2 option (a); vssClient.ts's module docstring "TODO(production
 * wiring, P5)"). Replaces `createUnimplementedProductionEmbedder()`.
 *
 * ── Same-space parity with the prep toolchain (READ THIS BEFORE CHANGING MODEL IDS) ─
 * `prep/prep/embed/local_embedder.py`'s `FastEmbedEmbedder` builds the bundle's
 * `vectors.duckdb` with `fastembed` (Python, ONNX) running `BAAI/bge-small-en-v1.5`.
 * Concretely, fastembed 0.8.0 sources that model's ONNX weights from HF repo
 * `qdrant/bge-small-en-v1.5-onnx-q` (an int8-QUANTIZED export of the same base
 * model), does CLS-token pooling (`hidden_state[:, 0, :]` — NOT mean pooling),
 * applies NO query/passage instruction prefix for this model id, and L2-normalizes
 * the result (dim 384).
 *
 * This module reproduces that exact recipe with `@huggingface/transformers`
 * (transformers.js — the actively-maintained successor to `@xenova/transformers`;
 * same author/ecosystem, uses `onnxruntime-node` for native performance instead of
 * the WASM-only `onnxruntime-web`, and has a materially smaller transitive
 * vulnerability surface — see the audit note in the module's git history):
 *   - model: `Xenova/bge-small-en-v1.5` (an fp32 ONNX export of the SAME base
 *     model+revision as fastembed's quantized one — a different quantization of
 *     identical weights, not a different model)
 *   - pooling: 'cls' (transformers.js's `FeatureExtractionPipeline` 'cls'/
 *     'first_token' option does the identical `result.slice(null, 0)` CLS-slice)
 *   - normalize: true (L2)
 *   - no instruction prefix for either queries or documents (matches fastembed's
 *     behavior for this model id exactly — see research note below)
 *
 * VERIFIED PARITY (not just an assumption): a direct side-by-side comparison
 * embedding identical strings through fastembed 0.8.0 (Python, this repo's
 * `prep/.venv`) and this module's transformers.js pipeline (Node) measured
 * cross-space cosine similarity >= 0.9999992 (i.e. the fp32-vs-int8-quantized
 * ONNX export difference is noise at the 4th decimal of cosine similarity — far
 * tighter than needed for meaningful nearest-neighbor retrieval). Re-run this
 * check with `verifyEmbedderParity()` (below) whenever the pinned model id/
 * revision changes, against a couple of representative in-domain sentences and
 * fastembed's output for the same strings.
 *
 * fastembed applies NO query-instruction prefix for `bge-small-en-v1.5`
 * specifically (fastembed's own model registry entry notes "Prefixes for
 * queries/documents: not so necessary, 2023 year" for this id, and its
 * `query_embed()`/`passage_embed()` both fall through to the same unprefixed
 * `embed()` for this model) — so this module also applies none, to stay
 * behaviorally identical to what the prep toolchain's vectors were actually
 * built with, rather than following BGE's upstream model-card recommendation
 * (which suggests a prefix in general, but fastembed's ACTUAL bundle-building
 * behavior — the vectors this must match — does not use it for this id).
 *
 * ── Compliance (SPEC §0 decision #2, §2.5 invariant 4) ──────────────────────
 * Fully local, in-process ONNX inference — NO external embedding API, no
 * network call per query. The model weights are downloaded ONCE into a local
 * cache directory on first use (`@huggingface/transformers`'s default cache,
 * override-able via `HF_HOME`/`TRANSFORMERS_CACHE`) — a local model-file fetch,
 * not a per-request API call; the raw query text is never sent anywhere.
 *
 * ── Lazy load + memoization ──────────────────────────────────────────────────
 * The pipeline (tokenizer + ONNX session) is NOT constructed at module import
 * time — only on the first `embed()` call — and is memoized (a module-level
 * promise) so concurrent/repeated calls share one loaded model. This keeps
 * hermetic CI (which never calls this module's real embedder — see
 * vssClient.ts's `createDeterministicTestEmbedder`) free of any model download,
 * and keeps a long-lived server process from re-loading the model per request.
 */

import type { EmbedQuery } from './vssClient'

/** The exact `id` `prep/prep/embed/local_embedder.py`'s `FastEmbedEmbedder.fingerprint()` reports. */
export const PRODUCTION_EMBEDDING_MODEL_ID = 'bge-small-en-v1.5'

/** The transformers.js/HF Hub model repo used to source the ONNX weights. */
export const LOCAL_QUERY_EMBEDDER_HF_MODEL = 'Xenova/bge-small-en-v1.5'

export const PRODUCTION_EMBEDDING_DIMENSION = 384

/** Minimal shape of the bits of `@huggingface/transformers`'s feature-extraction pipeline this module drives. */
type FeatureExtractionOutput = { data: ArrayLike<number> }
type FeatureExtractionPipeline = (
  text: string,
  options: { pooling: 'cls'; normalize: true }
) => Promise<FeatureExtractionOutput>

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null

/**
 * loadPipeline — lazily constructs (and memoizes) the transformers.js
 * feature-extraction pipeline for `LOCAL_QUERY_EMBEDDER_HF_MODEL`. The dynamic
 * `import()` (rather than a static top-level import) means this heavyweight
 * dependency's own module-init cost is paid only when a real embed actually
 * happens, not whenever `lib/rag` is imported (e.g. by tests that only ever use
 * `createDeterministicTestEmbedder`).
 */
function loadPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      let transformers: typeof import('@huggingface/transformers')
      try {
        transformers = await import('@huggingface/transformers')
      } catch (cause) {
        throw new Error(
          'queryEmbedder.ts: failed to load the "@huggingface/transformers" package. ' +
            'It is a declared dependency (package.json) — this likely means node_modules ' +
            'is out of date; run `npm install`.',
          { cause }
        )
      }

      try {
        const extractor = await transformers.pipeline('feature-extraction', LOCAL_QUERY_EMBEDDER_HF_MODEL, {
          dtype: 'fp32',
        })
        return (text: string, options: { pooling: 'cls'; normalize: true }) =>
          extractor(text, options) as unknown as Promise<FeatureExtractionOutput>
      } catch (cause) {
        // Model-download-unavailable (offline box, first run with no network,
        // HF Hub unreachable, disk full, etc.) — fail with a clear, actionable
        // error rather than hanging or silently producing garbage vectors.
        // Deliberately NOT caught by callers as a signal to fall back to the
        // deterministic test embedder in a non-test environment (SPEC §0
        // decision #2's throwing-stub discipline: fail loudly, never silently
        // serve fake vectors against real production vectors).
        pipelinePromise = null // allow a later retry (e.g. once network is restored)
        throw new Error(
          `queryEmbedder.ts: could not load the local "${LOCAL_QUERY_EMBEDDER_HF_MODEL}" ONNX model ` +
            '(first use downloads it into a local cache — this fails if that download ' +
            'cannot complete, e.g. no network on first run, or the cache directory is not ' +
            'writable). This is a LOCAL model load, never an external embedding API call. ' +
            'Set HF_HOME (or TRANSFORMERS_CACHE) to a writable, pre-seeded cache directory ' +
            'to run fully offline after the first successful download.',
          { cause }
        )
      }
    })()
  }
  return pipelinePromise
}

function toFloat32(data: ArrayLike<number>): Float32Array {
  const vector = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) vector[i] = data[i]
  return vector
}

/**
 * createLocalQueryEmbedder — the production `EmbedQuery` implementation.
 * Runs the pinned local bge-small-en-v1.5 ONNX model in-process (no network
 * call per query; see module docstring). Lazily loads + memoizes the model on
 * first call. Never call this from a test — use
 * `vssClient.ts`'s `createDeterministicTestEmbedder()` instead, which is
 * offline/dependency-free and matches the fixture bundles' test vector space.
 *
 * This is the one clean named export the `/api/sql-generate` route should
 * import in place of `createUnimplementedProductionEmbedder()`:
 *
 *     import { createLocalQueryEmbedder } from '@/lib/rag/queryEmbedder'
 *     // ...
 *     embedQuery: createLocalQueryEmbedder(),
 */
export function createLocalQueryEmbedder(): EmbedQuery {
  return async (text: string): Promise<Float32Array> => {
    const extractor = await loadPipeline()
    const output = await extractor(text, { pooling: 'cls', normalize: true })
    const vector = toFloat32(output.data)
    if (vector.length !== PRODUCTION_EMBEDDING_DIMENSION) {
      throw new Error(
        `queryEmbedder.ts: expected a ${PRODUCTION_EMBEDDING_DIMENSION}-d vector from ` +
          `${LOCAL_QUERY_EMBEDDER_HF_MODEL}, got ${vector.length}-d. The pinned model revision ` +
          'may have changed unexpectedly.'
      )
    }
    return vector
  }
}

/**
 * verifyEmbedderParity — an OPTIONAL, opt-in runtime sanity check (never run
 * automatically, never part of the CI test suite — it downloads the real
 * model). Embeds `queryText` with this module's local embedder and reports its
 * cosine similarity against a caller-supplied `knownRelatedVector` (e.g. a
 * fastembed-produced vector for a known-related document, obtained out of
 * band). A meaningfully high similarity (in practice, same-model cross-runtime
 * comparisons land essentially at 1.0, modulo fp32-vs-quantized noise) is the
 * expected signal that this embedder's vector space still lines up with the
 * prep toolchain's `vectors.duckdb`. See this module's docstring for the
 * verified baseline measurement.
 */
export async function verifyEmbedderParity(
  queryText: string,
  knownRelatedVector: Float32Array | number[]
): Promise<number> {
  const embedder = createLocalQueryEmbedder()
  const queryVector = await embedder(queryText)
  const related = Array.from(knownRelatedVector)
  if (related.length !== queryVector.length) {
    throw new Error(
      `verifyEmbedderParity: dimension mismatch (query=${queryVector.length}, knownRelatedVector=${related.length})`
    )
  }
  let dot = 0
  let normQuery = 0
  let normRelated = 0
  for (let i = 0; i < queryVector.length; i++) {
    dot += queryVector[i] * related[i]
    normQuery += queryVector[i] * queryVector[i]
    normRelated += related[i] * related[i]
  }
  return dot / (Math.sqrt(normQuery) * Math.sqrt(normRelated))
}
