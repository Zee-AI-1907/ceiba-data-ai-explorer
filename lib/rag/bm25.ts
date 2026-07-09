/**
 * bm25.ts — lexical BM25 index built at load time over the bundle's document
 * text (NL2SQL_SPEC.md §4.1 stage 3-4: "hybrid dense + BM25"). No external
 * service: pure in-memory inverted index over the same document set the
 * dense/vector index (`vssClient.ts`) is built from (table grains, column
 * names/descriptions, glossary terms, exemplar questions — SPEC §1.11 four
 * doc kinds).
 *
 * Standard Okapi BM25 (k1=1.5, b=0.75 — conventional defaults; SPEC does not
 * mandate specific constants). Tokenization is deliberately simple and
 * identifier-aware: lowercase, split on non-alphanumeric boundaries, AND also
 * split camelCase/PascalCase identifiers into sub-tokens (`HeartRate` ->
 * `heart`, `rate`, plus the identifier itself) so a lexical query for
 * "heart rate" matches a column literally named `HeartRate`, and a query
 * containing the exact identifier (e.g. "MeasurementsMock") still matches
 * even though the dense embedding may not preserve exact identifier casing/
 * spelling (this is precisely the failure mode BM25 exists to catch per
 * SPEC §4.1 "BM25 finds an exact identifier the dense side would garble").
 */

export interface Bm25Document {
  docId: string
  text: string
}

interface IndexedDocument {
  docId: string
  termFrequencies: Map<string, number>
  length: number
}

export interface Bm25SearchResult {
  docId: string
  score: number
}

/** Splits on non-alphanumeric boundaries AND camelCase/PascalCase boundaries, lowercased. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  // First split on any run of non-alphanumeric characters.
  const words = text.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0)
  for (const word of words) {
    tokens.push(word.toLowerCase())
    // Sub-tokenize camelCase/PascalCase/snake-ish identifiers, e.g.
    // "HeartRate" -> ["heart", "rate"], "RecordedAt" -> ["recorded", "at"].
    const subParts = word
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/)
      .filter((p) => p.length > 0)
    if (subParts.length > 1) {
      for (const part of subParts) tokens.push(part.toLowerCase())
    }
  }
  return tokens
}

const BM25_K1 = 1.5
const BM25_B = 0.75

/**
 * BM25Index — an in-memory Okapi BM25 index over a fixed document set. Build
 * once (at bundle load time), query many times.
 */
export class Bm25Index {
  private readonly documents: IndexedDocument[] = []
  private readonly docIndexById = new Map<string, number>()
  private readonly documentFrequency = new Map<string, number>()
  private averageDocLength = 0

  constructor(documents: Bm25Document[]) {
    for (const doc of documents) {
      const tokens = tokenize(doc.text)
      const termFrequencies = new Map<string, number>()
      for (const token of tokens) {
        termFrequencies.set(token, (termFrequencies.get(token) ?? 0) + 1)
      }
      const indexed: IndexedDocument = { docId: doc.docId, termFrequencies, length: tokens.length }
      this.docIndexById.set(doc.docId, this.documents.length)
      this.documents.push(indexed)
      for (const term of termFrequencies.keys()) {
        this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1)
      }
    }
    const totalLength = this.documents.reduce((sum, d) => sum + d.length, 0)
    this.averageDocLength = this.documents.length > 0 ? totalLength / this.documents.length : 0
  }

  get size(): number {
    return this.documents.length
  }

  private idf(term: string): number {
    const n = this.documents.length
    const df = this.documentFrequency.get(term) ?? 0
    // Standard BM25 IDF with the +1 smoothing term to keep it non-negative for
    // terms present in every document.
    return Math.log(1 + (n - df + 0.5) / (df + 0.5))
  }

  /**
   * Scores every indexed document against the query and returns the top `k`
   * by descending BM25 score. `docIdFilter`, when given, restricts scoring to
   * only those docIds (SPEC §4.1 stage 4: "scoped to the recalled tables
   * only") — filtering happens BEFORE scoring, not as a post-hoc slice, so
   * IDF stays computed against the full corpus (standard BM25 semantics; only
   * the candidate result set is scoped).
   */
  search(query: string, k: number, docIdFilter?: Set<string>): Bm25SearchResult[] {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0 || this.documents.length === 0) return []

    const uniqueQueryTerms = Array.from(new Set(queryTokens))
    const idfByTerm = new Map<string, number>()
    for (const term of uniqueQueryTerms) idfByTerm.set(term, this.idf(term))

    const scores: Bm25SearchResult[] = []
    for (const doc of this.documents) {
      if (docIdFilter && !docIdFilter.has(doc.docId)) continue
      let score = 0
      for (const term of uniqueQueryTerms) {
        const tf = doc.termFrequencies.get(term)
        if (!tf) continue
        const idf = idfByTerm.get(term) ?? 0
        const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (this.averageDocLength || 1))
        score += idf * ((tf * (BM25_K1 + 1)) / denom)
      }
      if (score > 0) scores.push({ docId: doc.docId, score })
    }

    scores.sort((a, b) => b.score - a.score)
    return scores.slice(0, k)
  }

  /** True if the exact (lowercased) identifier token appears verbatim in the given document's tokens. */
  hasExactToken(docId: string, token: string): boolean {
    const idx = this.docIndexById.get(docId)
    if (idx === undefined) return false
    return this.documents[idx]!.termFrequencies.has(token.toLowerCase())
  }
}

/** Builds a Bm25Index from bundle documents, scoped to a single doc_kind (SPEC §4.1's hierarchical two-stage lookup). */
export function buildBm25Index(documents: Bm25Document[]): Bm25Index {
  return new Bm25Index(documents)
}
