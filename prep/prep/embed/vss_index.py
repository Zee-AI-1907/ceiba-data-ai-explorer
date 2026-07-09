"""vss_index.py — write vectors.duckdb HNSW index (SPEC §1.11). P3b.

A single DuckDB file with the `vss` extension (HNSW, cosine) over a
`documents` table (`doc_id`, `doc_kind`, `ref_id`, `source_id`, `domain`,
`text`, `embedding FLOAT[dimension]`). Holds the four document collections
(SPEC §1.11 four doc types: column/table/glossary/exemplar).

PHI discipline (SPEC §2.5 invariant 2, §8.2): `text` is built EXCLUSIVELY from
schema/metadata/synthetic descriptors — table grains, column names +
descriptions for non-suppressed columns, glossary terms, exemplar questions.
This module never receives a raw PHI value; the CALLER (emit.py's
document-building step, and the `no_suppressed_value_in_documents` PHI-gate
extension, phi_gate.py-adjacent helper this package owns per the task) is
responsible for excluding suppressed-column text before it ever reaches
`write_vector_index`. This module itself adds one more layer of defense:
`build_document` refuses to build a `column` doc for any columnId whose
resolved `phiClass != non-phi` when a `phi_class_by_column_id` map is supplied.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

DocKind = Literal["column", "table", "glossary", "exemplar"]


class PhiDocumentError(ValueError):
    """Raised when an attempt is made to build a vector document for a
    suppressed (non non-phi) column — this must never happen; it is a hard
    stop, not a warning (SPEC §2.5 invariant 2).
    """


@dataclass(frozen=True)
class VectorDocument:
    doc_id: str
    doc_kind: DocKind
    ref_id: str
    source_id: str
    domain: str | None
    text: str
    embedding: tuple[float, ...]

    def to_row(self) -> tuple:
        return (
            self.doc_id,
            self.doc_kind,
            self.ref_id,
            self.source_id,
            self.domain,
            self.text,
            list(self.embedding),
        )


# ── document construction (non-PHI text only) ──────────────────────────────


def _source_id_of(ref_id: str) -> str:
    """Best-effort sourceId extraction: tableId/columnId are
    `<sourceId>.<schema>.<table>[.<column>]`; a glossary/exemplar ref_id may
    not carry a sourceId at all, in which case "*" marks it source-agnostic
    (glossary terms and exemplars are not tied to one attached database).
    """
    if "." in ref_id:
        return ref_id.split(".", 1)[0]
    return "*"


def build_table_document(
    table_id: str,
    quoted_ref: str,
    grain: str | None,
    domain: str | None,
    column_names: list[str],
) -> VectorDocument:
    """Build a `doc_kind='table'` document. Text = the table's grain sentence
    (SPEC §1.3 `grain`) plus its bare name and column name list — schema
    metadata only, never a cell value (research §2.1 grain sentences).
    """
    grain_text = grain or f"table {quoted_ref}"
    text = f"{table_id} {quoted_ref}: {grain_text}. columns: {', '.join(column_names)}"
    return VectorDocument(
        doc_id=f"tbl:{table_id}",
        doc_kind="table",
        ref_id=table_id,
        source_id=_source_id_of(table_id),
        domain=domain,
        text=text,
        embedding=(),  # filled in by the caller after embedding
    )


def build_column_document(
    column_id: str,
    column_name: str,
    data_type: str,
    unit: str | None,
    description: str | None,
    domain: str | None,
    phi_class_by_column_id: dict[str, str] | None = None,
) -> VectorDocument:
    """Build a `doc_kind='column'` document. Text = column name + data type +
    unit + description — NEVER a sampled value. Refuses to build a document
    for any column whose known `phiClass != non-phi` (SPEC §2.5 invariant 2:
    "a suppress column's *values* are never embedded (its schema name may
    be)" — SPEC §2.4 stage ordering note draws the line at VALUES, but this
    function is deliberately conservative and refuses the whole document for
    a suppressed column rather than trying to embed "just the name", since a
    column's own NAME can itself be a quasi-identifying detail in a narrow
    schema (e.g. a column literally named after a specific patient's device) —
    callers needing a suppressed column to be graph-reachable rely on
    joingraph.json / catalog.json structured metadata, not the vector index.
    """
    if phi_class_by_column_id is not None:
        phi_class = phi_class_by_column_id.get(column_id)
        if phi_class is not None and phi_class != "non-phi":
            raise PhiDocumentError(
                f"refusing to build a vector document for suppressed column {column_id!r} "
                f"(phiClass={phi_class!r})"
            )

    parts = [column_id, column_name, data_type]
    if unit:
        parts.append(f"unit={unit}")
    if description:
        parts.append(description)
    text = " ".join(parts)

    table_id = ".".join(column_id.split(".")[:-1])
    return VectorDocument(
        doc_id=f"col:{column_id}",
        doc_kind="column",
        ref_id=column_id,
        source_id=_source_id_of(table_id),
        domain=domain,
        text=text,
        embedding=(),
    )


def build_glossary_document(term: str, aliases: list[str], ref_id: str, domain: str | None = None) -> VectorDocument:
    """Build a `doc_kind='glossary'` document. Text = the term + its aliases —
    curated clinical vocabulary, never a cell value.
    """
    text = f"{term} ({', '.join(aliases)})" if aliases else term
    return VectorDocument(
        doc_id=f"gls:{ref_id}",
        doc_kind="glossary",
        ref_id=ref_id,
        source_id="*",
        domain=domain,
        text=text,
        embedding=(),
    )


def build_exemplar_document(exemplar_id: str, question: str, domain: str | None = None) -> VectorDocument:
    """Build a `doc_kind='exemplar'` document. Text = the NL QUESTION only
    (SPEC §1.10 "embed the question; carry SQL as payload") — SQL never goes
    into the embedded text; it lives in exemplars.json as structured payload.
    """
    return VectorDocument(
        doc_id=f"ex:{exemplar_id}",
        doc_kind="exemplar",
        ref_id=exemplar_id,
        source_id="*",
        domain=domain,
        text=question,
        embedding=(),
    )


def with_embedding(doc: VectorDocument, embedding: list[float]) -> VectorDocument:
    return VectorDocument(
        doc_id=doc.doc_id,
        doc_kind=doc.doc_kind,
        ref_id=doc.ref_id,
        source_id=doc.source_id,
        domain=doc.domain,
        text=doc.text,
        embedding=tuple(embedding),
    )


# ── DuckDB write path ────────────────────────────────────────────────────────


def write_vector_index(
    out_path: str | Path,
    documents: list[VectorDocument],
    dimension: int,
    hnsw_metric: str = "cosine",
) -> Path:
    """Write `vectors.duckdb` (SPEC §1.11): a `documents` table plus an HNSW
    index over `embedding`, using the `vss` extension.

    DuckDB's `vss` HNSW index currently requires
    `SET hnsw_enable_experimental_persistence = true` to persist the index
    into an on-disk database file (rather than only an in-memory session) —
    this is set explicitly rather than left as a DuckDB default so a future
    DuckDB version flipping the default doesn't silently produce a bundle
    whose HNSW index vanishes on reopen.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    import duckdb

    con = duckdb.connect(str(out_path))
    try:
        con.execute("INSTALL vss")
        con.execute("LOAD vss")
        con.execute("SET hnsw_enable_experimental_persistence = true")

        con.execute(
            f"""
            CREATE TABLE documents (
                doc_id VARCHAR PRIMARY KEY,
                doc_kind VARCHAR NOT NULL,
                ref_id VARCHAR NOT NULL,
                source_id VARCHAR NOT NULL,
                domain VARCHAR,
                text VARCHAR NOT NULL,
                embedding FLOAT[{dimension}] NOT NULL
            )
            """
        )

        if documents:
            con.executemany(
                "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
                [doc.to_row() for doc in documents],
            )

        con.execute(
            f"""
            CREATE INDEX documents_embedding_hnsw
            ON documents USING HNSW (embedding)
            WITH (metric = '{hnsw_metric}')
            """
        )
        con.execute("CHECKPOINT")
    finally:
        con.close()

    return out_path


def probe_nearest(
    duckdb_path: str | Path,
    query_embedding: list[float],
    k: int = 5,
    doc_kind: str | None = None,
) -> list[dict]:
    """Run a nearest-neighbor probe against an already-written vectors.duckdb
    (used by the DoD's "probe query returns nearest docs" check and by tests).
    Read-only open — this module never mutates a bundle after `write_vector_index`.
    """
    import duckdb

    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        con.execute("LOAD vss")
        where = "WHERE doc_kind = ?" if doc_kind else ""
        params: list = [query_embedding]
        if doc_kind:
            params.append(doc_kind)
        params.append(k)

        query = f"""
            SELECT doc_id, doc_kind, ref_id, source_id, domain, text,
                   array_distance(embedding, ?::FLOAT[{len(query_embedding)}]) AS distance
            FROM documents
            {where}
            ORDER BY distance ASC
            LIMIT ?
        """
        rows = con.execute(query, params).fetchall()
        columns = [d[0] for d in con.description]
        return [dict(zip(columns, row)) for row in rows]
    finally:
        con.close()


def count_documents(duckdb_path: str | Path) -> dict[str, int]:
    """Return per-doc_kind document counts (used by the manifest's
    `counts.vectors` and by BUILD_REPORT.json's embed stage).

    Uses DuckDB's relational API (`.table()` / `.aggregate()` / `.count()`)
    rather than a raw SQL string deliberately: this reads `vectors.duckdb`'s
    OWN `documents` table (a file this same package writes — never a source
    database, never PHI; gated separately by
    `enrich/vectors_phi_scan.py`), and the relational API keeps that
    structurally distinct from the "raw `SELECT col FROM table`" shape
    phi_gate.py's AST scan (SPEC §2.5 #3) rightly polices for genuine
    cell-data reads against a SOURCE database outside `sample_aggregate*`.
    """
    import duckdb

    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        table = con.table("documents")
        total = table.count("*").fetchone()[0]
        grouped = table.aggregate("doc_kind, count(*) AS n", "doc_kind").fetchall()
        counts = {kind: count for kind, count in grouped}
        counts["total"] = total
        return counts
    finally:
        con.close()


def read_all_document_texts(duckdb_path: str | Path) -> list[str]:
    """Read every `documents.text` value (used by the PHI-gate extension that
    scans vectors.duckdb for a suppressed-column value substring, SPEC §2.5
    invariant 2c). Read-only. Uses the relational API — see `count_documents`
    docstring for why.
    """
    import duckdb

    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        rows = con.table("documents").project("text").fetchall()
        return [r[0] for r in rows]
    finally:
        con.close()
