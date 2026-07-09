"""bm25.py — lexical BM25 index (ports lib/rag/bm25.ts verbatim;
docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1, §3.1 `retrieval/bm25.py`).

Standard Okapi BM25 (k1=1.5, b=0.75 — same constants as the TS port).
Tokenization is deliberately simple and identifier-aware: lowercase, split on
non-alphanumeric boundaries, AND also split camelCase/PascalCase identifiers
into sub-tokens (`HeartRate` -> `heart`, `rate`, plus the identifier itself)
so a lexical query for "heart rate" matches a column literally named
`HeartRate`, mirroring lib/rag/bm25.ts `tokenize` exactly (same regex
approach, ported to Python's `re`).
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

_WORD_SPLIT = re.compile(r"[^A-Za-z0-9]+")
_LOWER_UPPER_BOUNDARY = re.compile(r"([a-z0-9])([A-Z])")
_ACRONYM_BOUNDARY = re.compile(r"([A-Z]+)([A-Z][a-z])")
_WHITESPACE = re.compile(r"\s+")

BM25_K1 = 1.5
BM25_B = 0.75


def tokenize(text: str) -> list[str]:
    """Splits on non-alphanumeric boundaries AND camelCase/PascalCase
    boundaries, lowercased. Mirrors lib/rag/bm25.ts `tokenize` exactly.
    """
    tokens: list[str] = []
    words = [w for w in _WORD_SPLIT.split(text) if w]
    for word in words:
        tokens.append(word.lower())
        sub = _LOWER_UPPER_BOUNDARY.sub(r"\1 \2", word)
        sub = _ACRONYM_BOUNDARY.sub(r"\1 \2", sub)
        sub_parts = [p for p in _WHITESPACE.split(sub) if p]
        if len(sub_parts) > 1:
            for part in sub_parts:
                tokens.append(part.lower())
    return tokens


@dataclass(frozen=True)
class Bm25Document:
    doc_id: str
    text: str


@dataclass(frozen=True)
class Bm25SearchResult:
    doc_id: str
    score: float


@dataclass
class _IndexedDocument:
    doc_id: str
    term_frequencies: dict[str, int]
    length: int


class Bm25Index:
    """In-memory Okapi BM25 index over a fixed document set. Build once (at
    bundle load time), query many times. Mirrors lib/rag/bm25.ts `Bm25Index`.
    """

    def __init__(self, documents: list[Bm25Document]) -> None:
        self._documents: list[_IndexedDocument] = []
        self._doc_index_by_id: dict[str, int] = {}
        self._document_frequency: dict[str, int] = {}

        for doc in documents:
            tokens = tokenize(doc.text)
            term_frequencies: dict[str, int] = {}
            for token in tokens:
                term_frequencies[token] = term_frequencies.get(token, 0) + 1
            indexed = _IndexedDocument(doc_id=doc.doc_id, term_frequencies=term_frequencies, length=len(tokens))
            self._doc_index_by_id[doc.doc_id] = len(self._documents)
            self._documents.append(indexed)
            for term in term_frequencies:
                self._document_frequency[term] = self._document_frequency.get(term, 0) + 1

        total_length = sum(d.length for d in self._documents)
        self._average_doc_length = total_length / len(self._documents) if self._documents else 0.0

    @property
    def size(self) -> int:
        return len(self._documents)

    def _idf(self, term: str) -> float:
        n = len(self._documents)
        df = self._document_frequency.get(term, 0)
        return math.log(1 + (n - df + 0.5) / (df + 0.5))

    def search(self, query: str, k: int, doc_id_filter: set[str] | None = None) -> list[Bm25SearchResult]:
        """Scores every indexed document against the query and returns the
        top `k` by descending BM25 score. `doc_id_filter`, when given,
        restricts scoring to only those docIds — filtering happens BEFORE
        scoring so IDF stays computed against the full corpus (mirrors
        lib/rag/bm25.ts `search`).
        """
        query_tokens = tokenize(query)
        if not query_tokens or not self._documents:
            return []

        unique_terms = list(dict.fromkeys(query_tokens))
        idf_by_term = {term: self._idf(term) for term in unique_terms}

        scores: list[Bm25SearchResult] = []
        for doc in self._documents:
            if doc_id_filter is not None and doc.doc_id not in doc_id_filter:
                continue
            score = 0.0
            for term in unique_terms:
                tf = doc.term_frequencies.get(term)
                if not tf:
                    continue
                idf = idf_by_term.get(term, 0.0)
                denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (self._average_doc_length or 1))
                score += idf * ((tf * (BM25_K1 + 1)) / denom)
            if score > 0:
                scores.append(Bm25SearchResult(doc_id=doc.doc_id, score=score))

        scores.sort(key=lambda r: r.score, reverse=True)
        return scores[:k]

    def has_exact_token(self, doc_id: str, token: str) -> bool:
        idx = self._doc_index_by_id.get(doc_id)
        if idx is None:
            return False
        return token.lower() in self._documents[idx].term_frequencies


def build_bm25_index(documents: list[Bm25Document]) -> Bm25Index:
    return Bm25Index(documents)
