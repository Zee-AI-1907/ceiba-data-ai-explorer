"""vss.py — dense ANN retrieval against `vectors.duckdb` (ports
lib/rag/vssClient.ts's `VssClient`; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.1,
§3.1 `retrieval/vss.py`).

Opens the bundle's vectors.duckdb READ-ONLY and runs a cosine-distance
nearest-neighbor query via `array_distance`, optionally filtered by
`doc_kind` and/or `source_id` (mirrors the TS client's SQL verbatim so
retrieval results are identical between languages given the identical query
vector).

── Query-embedding parity win (plan §3.2) ────────────────────────────────────
Unlike the TS `VssClient`, which needed an INJECTABLE `EmbedQuery` because no
in-process bge-small ONNX runtime existed in Node, this Python module's
caller can embed the query with `ceiba_nl2sql.embed.local_embedder` directly
— the SAME code that embedded every document vector in `vectors.duckdb`. The
`EmbedQuery` protocol is kept here anyway (as a thin callable type alias) so
the retriever stays testable with a deterministic stub embedder, but in
production it is backed by the identical FastEmbedEmbedder/DeterministicHashEmbedder
used at bundle-build time — eliminating the JS-embedder parity risk (plan §0
gap #2) by construction.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

import duckdb

VssDocKind = str  # 'column' | 'table' | 'glossary' | 'exemplar'

# Injectable query-embedding function: text -> L2-normalized vector.
EmbedQuery = Callable[[str], Sequence[float]]


@dataclass(frozen=True)
class VssSearchHit:
    doc_id: str
    doc_kind: str
    ref_id: str
    source_id: str
    domain: str | None
    text: str
    distance: float


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class VssClient:
    """A read-only handle onto one bundle's `vectors.duckdb`. Opens lazily on
    first search; `dispose()` closes the underlying DuckDB connection. Mirrors
    lib/rag/vssClient.ts `VssClient`.
    """

    def __init__(self, db_path: str | Path, dimension: int) -> None:
        self._db_path = str(db_path)
        self._dimension = dimension
        self._conn: duckdb.DuckDBPyConnection | None = None

    def _ensure_open(self) -> duckdb.DuckDBPyConnection:
        if self._conn is None:
            self._conn = duckdb.connect(self._db_path, read_only=True)
            self._conn.execute("INSTALL vss")
            self._conn.execute("LOAD vss")
        return self._conn

    def dispose(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None

    def search(
        self,
        query_embedding: Sequence[float],
        *,
        doc_kind: str | None = None,
        source_ids: list[str] | None = None,
        ref_id_prefixes: list[str] | None = None,
        k: int = 20,
    ) -> list[VssSearchHit]:
        """Nearest-neighbor cosine search over `documents`, optionally
        filtered by `doc_kind` and/or `source_id`. `ref_id_prefixes`, when
        given, keeps only rows whose `ref_id` starts with one of the given
        prefixes (scopes column recall to survivor tableIds). Mirrors
        lib/rag/vssClient.ts `VssClient.search` SQL verbatim.
        """
        conn = self._ensure_open()

        conditions: list[str] = []
        if doc_kind:
            conditions.append(f"doc_kind = {_quote_literal(doc_kind)}")
        if source_ids:
            conditions.append("source_id IN (" + ", ".join(_quote_literal(s) for s in source_ids) + ")")
        if ref_id_prefixes:
            like_clauses = [f"ref_id LIKE {_quote_literal(p + '%')}" for p in ref_id_prefixes]
            conditions.append("(" + " OR ".join(like_clauses) + ")")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

        vector_literal = "[" + ", ".join(str(float(x)) for x in query_embedding) + f"]::FLOAT[{self._dimension}]"
        sql = f"""
            SELECT doc_id, doc_kind, ref_id, source_id, domain, text,
                   array_distance(embedding, {vector_literal}) AS distance
            FROM documents
            {where}
            ORDER BY distance ASC
            LIMIT {max(0, int(k))}
        """
        if k <= 0:
            return []
        cursor = conn.execute(sql)
        col_names = [d[0] for d in (cursor.description or [])]
        raw_rows = cursor.fetchall()
        hits: list[VssSearchHit] = []
        for raw_row in raw_rows:
            row = dict(zip(col_names, raw_row))
            hits.append(
                VssSearchHit(
                    doc_id=str(row["doc_id"]),
                    doc_kind=str(row["doc_kind"]),
                    ref_id=str(row["ref_id"]),
                    source_id=str(row["source_id"]),
                    domain=None if row.get("domain") is None else str(row["domain"]),
                    text=str(row["text"]),
                    distance=float(row["distance"]),
                )
            )
        return hits
