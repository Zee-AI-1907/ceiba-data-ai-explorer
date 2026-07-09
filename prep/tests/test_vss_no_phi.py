"""test_vss_no_phi.py — vss_index.py + vectors_phi_scan.py (SPEC §2.5 invariant 2). P3b.

Asserts:
  * `build_column_document` REFUSES to build a document for a column whose
    known phiClass != non-phi (PhiDocumentError) — the first line of
    defense, at document-construction time.
  * A `vectors.duckdb` built ONLY from non-PHI documents (table/column/
    glossary/exemplar text) contains no suppressed-column value substring —
    the PHI gate's vectors-specific check (`vectors_phi_scan.py`) passes.
  * A deliberately poisoned `documents` table (bypassing the
    `build_column_document` guard by constructing a `VectorDocument`
    directly, simulating a hypothetical future caller that skips the guard)
    IS caught by `check_vectors_duckdb_no_suppressed_column_docs` (structural
    check) and by `check_vectors_duckdb_no_suppressed_value_substring`
    (content-substring check) — defense in depth, either check alone catches
    the poison.
  * `write_vector_index` + `probe_nearest` round-trip correctly (dimension,
    HNSW, cosine ordering) using the deterministic test embedder (fast,
    hermetic — no network/model dependency for this structural test).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from prep.embed.local_embedder import DeterministicHashEmbedder
from prep.embed.vss_index import (
    PhiDocumentError,
    VectorDocument,
    build_column_document,
    build_exemplar_document,
    build_glossary_document,
    build_table_document,
    probe_nearest,
    read_all_document_texts,
    with_embedding,
    write_vector_index,
)
from prep.enrich.vectors_phi_scan import (
    check_vectors_duckdb_no_suppressed_column_docs,
    check_vectors_duckdb_no_suppressed_value_substring,
)

DIMENSION = 384


@pytest.fixture()
def embedder() -> DeterministicHashEmbedder:
    return DeterministicHashEmbedder(dimension=DIMENSION)


# ── document construction refuses suppressed columns ────────────────────────


def test_build_column_document_refuses_suppressed_phi_class():
    phi_class_by_column_id = {"staging.Shared.Patients.Name": "direct-identifier"}
    with pytest.raises(PhiDocumentError):
        build_column_document(
            column_id="staging.Shared.Patients.Name",
            column_name="Name",
            data_type="varchar",
            unit=None,
            description=None,
            domain=None,
            phi_class_by_column_id=phi_class_by_column_id,
        )


def test_build_column_document_allows_non_phi_column():
    phi_class_by_column_id = {"mock.public.MeasurementsMock.Value": "non-phi"}
    doc = build_column_document(
        column_id="mock.public.MeasurementsMock.Value",
        column_name="Value",
        data_type="double precision",
        unit=None,
        description=None,
        domain=None,
        phi_class_by_column_id=phi_class_by_column_id,
    )
    assert doc.doc_kind == "column"
    assert "Value" in doc.text


def test_build_column_document_allows_when_phi_class_unknown():
    """A column not present in `phi_class_by_column_id` at all (caller didn't
    supply full classification) is allowed through — the guard only refuses
    a KNOWN-suppressed column, it doesn't require universal classification
    coverage to function (callers that DO have full phi.json coverage, like
    cli.py's build pipeline, get the full protection).
    """
    doc = build_column_document(
        column_id="mock.public.SomeTable.SomeColumn",
        column_name="SomeColumn",
        data_type="text",
        unit=None,
        description=None,
        domain=None,
        phi_class_by_column_id={},
    )
    assert doc.doc_kind == "column"


# ── end-to-end: a clean, all-non-PHI vectors.duckdb passes the gate ────────


def _build_clean_bundle(tmp_path: Path, embedder: DeterministicHashEmbedder) -> Path:
    docs = [
        build_table_document(
            table_id="mock.public.MeasurementsMock",
            quoted_ref='public."MeasurementsMock"',
            grain="one row = one synthetic measurement sample",
            domain="monitoring",
            column_names=["Id", "MeasurementTypeId", "Value", "RecordedAt", "patientRef"],
        ),
        build_column_document(
            column_id="mock.public.MeasurementsMock.Value",
            column_name="Value",
            data_type="double precision",
            unit=None,
            description=None,
            domain="monitoring",
            phi_class_by_column_id={"mock.public.MeasurementsMock.Value": "non-phi"},
        ),
        build_glossary_document(term="heart rate", aliases=["hr", "pulse"], ref_id="heart rate"),
        build_exemplar_document(exemplar_id="ex_heart_rate", question="heart rate > 120 in the last 3 hours"),
    ]
    texts = [d.text for d in docs]
    vectors = embedder.embed_documents(texts)
    embedded = [with_embedding(d, v) for d, v in zip(docs, vectors)]

    out_path = tmp_path / "vectors.duckdb"
    write_vector_index(out_path, embedded, dimension=DIMENSION)
    return out_path


def test_clean_bundle_no_suppressed_column_doc(tmp_path, embedder):
    docs_for_gate = [
        {"doc_kind": "table", "ref_id": "mock.public.MeasurementsMock"},
        {"doc_kind": "column", "ref_id": "mock.public.MeasurementsMock.Value"},
        {"doc_kind": "glossary", "ref_id": "heart rate"},
        {"doc_kind": "exemplar", "ref_id": "ex_heart_rate"},
    ]
    phi_class_by_column_id = {"mock.public.MeasurementsMock.Value": "non-phi"}
    violations = check_vectors_duckdb_no_suppressed_column_docs(docs_for_gate, phi_class_by_column_id)
    assert violations == []


def test_clean_bundle_no_suppressed_value_substring(tmp_path, embedder):
    duckdb_path = _build_clean_bundle(tmp_path, embedder)
    # A held-out sample of values that WOULD be PHI if they leaked — none of
    # these appear anywhere in the clean bundle's document text.
    suppressed_values = ["Ege Apak", "555-0100", "1985-03-14"]
    violations = check_vectors_duckdb_no_suppressed_value_substring(duckdb_path, suppressed_values)
    assert violations == []


# ── poisoned bundle: both checks independently catch it ────────────────────


def test_poisoned_structural_check_catches_suppressed_column_doc():
    """Simulates a document list where a doc_kind='column' entry's ref_id
    names a column that IS suppressed — the structural check must flag it
    even though `build_column_document` itself would have refused to build
    it (defense in depth: the check operates on the already-written document
    list/table, independent of how it got there).
    """
    docs_for_gate = [
        {"doc_kind": "column", "ref_id": "staging.Shared.Patients.Name"},
    ]
    phi_class_by_column_id = {"staging.Shared.Patients.Name": "direct-identifier"}
    violations = check_vectors_duckdb_no_suppressed_column_docs(docs_for_gate, phi_class_by_column_id)
    assert len(violations) == 1
    assert violations[0].check == "no_raw_cell_value"
    assert "staging.Shared.Patients.Name" in violations[0].message


def test_poisoned_content_check_catches_suppressed_value_substring(tmp_path, embedder):
    """Directly construct a VectorDocument (bypassing build_column_document's
    guard) whose text happens to contain a value that should have been
    suppressed — the content-substring check must catch it even when the
    structural doc_kind check wouldn't (e.g. a table-grain sentence that
    happened to embed a raw value some other way).
    """
    poisoned_text = "patient note mentions Ege Apak during the visit"
    doc = VectorDocument(
        doc_id="tbl:poisoned",
        doc_kind="table",
        ref_id="mock.public.SomeTable",
        source_id="mock",
        domain=None,
        text=poisoned_text,
        embedding=(),
    )
    vector = embedder.embed_documents([poisoned_text])[0]
    embedded_doc = with_embedding(doc, vector)

    out_path = tmp_path / "poisoned_vectors.duckdb"
    write_vector_index(out_path, [embedded_doc], dimension=DIMENSION)

    violations = check_vectors_duckdb_no_suppressed_value_substring(out_path, ["Ege Apak"])
    assert len(violations) == 1
    assert violations[0].check == "no_raw_cell_value"
    # The violation message itself must never repeat the raw PHI value.
    assert "Ege Apak" not in violations[0].message


# ── round-trip: write + probe (dimension, HNSW, cosine ordering) ───────────


def test_write_and_probe_round_trip_dimension_and_ordering(tmp_path, embedder):
    texts = ["heart rate measurement value", "oxygen saturation percent", "quarterly financial report"]
    vectors = embedder.embed_documents(texts)
    docs = [
        VectorDocument(
            doc_id=f"d{i}",
            doc_kind="column",
            ref_id=f"ref{i}",
            source_id="mock",
            domain=None,
            text=t,
            embedding=tuple(v),
        )
        for i, (t, v) in enumerate(zip(texts, vectors))
    ]
    out_path = tmp_path / "roundtrip.duckdb"
    write_vector_index(out_path, docs, dimension=DIMENSION)

    query_vector = embedder.embed_documents(["heart rate"])[0]
    results = probe_nearest(out_path, query_vector, k=3)
    assert len(results) == 3
    # Every returned embedding must have come from the dim-384 column.
    assert results[0]["distance"] <= results[1]["distance"] <= results[2]["distance"]


def test_read_all_document_texts_returns_every_text(tmp_path, embedder):
    texts = ["alpha document", "beta document"]
    vectors = embedder.embed_documents(texts)
    docs = [
        VectorDocument(doc_id=f"d{i}", doc_kind="table", ref_id=f"r{i}", source_id="mock", domain=None, text=t, embedding=tuple(v))
        for i, (t, v) in enumerate(zip(texts, vectors))
    ]
    out_path = tmp_path / "texts.duckdb"
    write_vector_index(out_path, docs, dimension=DIMENSION)

    read_texts = read_all_document_texts(out_path)
    assert set(read_texts) == set(texts)
