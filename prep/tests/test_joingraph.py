"""test_joingraph.py — join graph builder (SPEC §1.5). P3b.

Asserts:
  * A declared FK edge from a mock table (e.g. MeasurementsMock ->
    MeasurementTypeRef) lifts into joingraph.json with origin="declared",
    confidence=1.0.
  * The documented cross-source edge
    (staging.Shared.Acceptances.HospitalId -> mock.public.HospitalRef.HospitalId,
    SPEC §1.5, PLAN §0a decision #1) appears as origin="inferred",
    crossSource=true, confidence >= the configured minConfidence threshold —
    WHEN both sides' tables are present in the build's catalog.
  * That same edge does NOT appear when only `mock` is introspected (a
    `--only mock` build never fabricates a `staging` node it never saw).
  * A generic bare "Id"-only name match is NOT inferred (too weak a signal).
  * `min_confidence` gates inferred edges: raising the threshold above an
    edge's confidence drops it.
"""

from __future__ import annotations

from prep.enrich.joingraph import (
    CROSS_SOURCE_CORRELATIONS,
    build_curated_cross_source_edges,
    build_declared_edges,
    build_inferred_name_match_edges,
    build_join_graph,
)


def _mock_catalog_tables() -> list[dict]:
    return [
        {
            "tableId": "mock.public.MeasurementsMock",
            "columns": [
                {"name": "Id"},
                {"name": "MeasurementTypeId"},
                {"name": "patientRef"},
                {"name": "Value"},
                {"name": "RecordedAt"},
            ],
        },
        {
            "tableId": "mock.public.MeasurementTypeRef",
            "columns": [{"name": "MeasurementTypeId"}, {"name": "name"}, {"name": "unit"}],
        },
        {
            "tableId": "mock.public.PatientMock",
            "columns": [{"name": "patientRef"}, {"name": "hospitalId"}, {"name": "wardId"}],
        },
        {
            "tableId": "mock.public.HospitalRef",
            "columns": [{"name": "HospitalId"}, {"name": "name"}, {"name": "region"}],
        },
    ]


def _mock_primary_keys() -> list[dict]:
    return [
        {"tableId": "mock.public.MeasurementsMock", "columns": ["Id"]},
        {"tableId": "mock.public.MeasurementTypeRef", "columns": ["MeasurementTypeId"]},
        {"tableId": "mock.public.PatientMock", "columns": ["patientRef"]},
        {"tableId": "mock.public.HospitalRef", "columns": ["HospitalId"]},
    ]


def _mock_foreign_keys() -> list[dict]:
    return [
        {
            "fkId": "mock.public.MeasurementsMock.MeasurementTypeId->mock.public.MeasurementTypeRef.MeasurementTypeId",
            "fromTable": "mock.public.MeasurementsMock",
            "fromColumns": ["MeasurementTypeId"],
            "toTable": "mock.public.MeasurementTypeRef",
            "toColumns": ["MeasurementTypeId"],
            "constraintName": "MeasurementsMock_MeasurementTypeId_fkey",
            "origin": "declared",
        },
        {
            "fkId": "mock.public.MeasurementsMock.patientRef->mock.public.PatientMock.patientRef",
            "fromTable": "mock.public.MeasurementsMock",
            "fromColumns": ["patientRef"],
            "toTable": "mock.public.PatientMock",
            "toColumns": ["patientRef"],
            "constraintName": "MeasurementsMock_patientRef_fkey",
            "origin": "declared",
        },
        {
            "fkId": "mock.public.PatientMock.hospitalId->mock.public.HospitalRef.HospitalId",
            "fromTable": "mock.public.PatientMock",
            "fromColumns": ["hospitalId"],
            "toTable": "mock.public.HospitalRef",
            "toColumns": ["HospitalId"],
            "constraintName": "PatientMock_hospitalId_fkey",
            "origin": "declared",
        },
    ]


# ── declared edges ───────────────────────────────────────────────────────────


def test_declared_edge_from_measurements_mock_to_type_ref():
    edges = build_declared_edges(_mock_foreign_keys(), _mock_primary_keys())
    match = next(
        e
        for e in edges
        if e.from_table == "mock.public.MeasurementsMock" and e.to_table == "mock.public.MeasurementTypeRef"
    )
    assert match.origin == "declared"
    assert match.confidence == 1.0
    assert match.join_cardinality == "many-to-one"
    assert match.cross_source is False
    assert match.from_columns == ("MeasurementTypeId",)
    assert match.to_columns == ("MeasurementTypeId",)


def test_declared_edges_cover_all_three_mock_fks():
    edges = build_declared_edges(_mock_foreign_keys(), _mock_primary_keys())
    assert len(edges) == 3
    assert all(e.origin == "declared" and e.confidence == 1.0 for e in edges)


# ── inferred cross-source edge (the federation test edge) ──────────────────


def test_cross_source_correlation_declares_the_documented_edge():
    """The curated correlation list itself must contain the SPEC §1.5 /
    PLAN §0a decision #1 documented edge verbatim.
    """
    primary = next(
        c
        for c in CROSS_SOURCE_CORRELATIONS
        if c.shared_column_name == "HospitalId"
    )
    assert primary.to_table_id == "mock.public.HospitalRef"
    assert primary.to_column == "HospitalId"
    assert primary.from_table_id == "staging.Shared.Acceptances"
    assert primary.from_column == "HospitalId"
    assert primary.confidence >= 0.8


def test_cross_source_edge_appears_when_both_sides_in_catalog():
    tables = _mock_catalog_tables() + [
        {
            "tableId": "staging.Shared.Acceptances",
            "columns": [{"name": "Id"}, {"name": "HospitalId"}, {"name": "PatientId"}],
        }
    ]
    edges = build_curated_cross_source_edges(tables, declared_edge_keys=set(), min_confidence=0.8)
    assert len(edges) == 1
    edge = edges[0]
    assert edge.from_table == "staging.Shared.Acceptances"
    assert edge.from_columns == ("HospitalId",)
    assert edge.to_table == "mock.public.HospitalRef"
    assert edge.to_columns == ("HospitalId",)
    assert edge.origin == "inferred"
    assert edge.cross_source is True
    assert edge.confidence >= 0.8


def test_cross_source_edge_absent_when_staging_not_introspected():
    """A `--only mock` build's catalog never contains
    `staging.Shared.Acceptances` — the curated correlation must NOT fabricate
    that node; the edge simply doesn't appear.
    """
    tables = _mock_catalog_tables()  # no staging.* table present
    edges = build_curated_cross_source_edges(tables, declared_edge_keys=set(), min_confidence=0.8)
    assert edges == []


def test_full_join_graph_includes_cross_source_edge_when_both_sources_present():
    tables = _mock_catalog_tables() + [
        {"tableId": "staging.Shared.Acceptances", "columns": [{"name": "Id"}, {"name": "HospitalId"}, {"name": "PatientId"}]},
        {"tableId": "staging.Shared.Patients", "columns": [{"name": "Id"}]},
    ]
    primary_keys = _mock_primary_keys() + [
        {"tableId": "staging.Shared.Acceptances", "columns": ["Id"]},
        {"tableId": "staging.Shared.Patients", "columns": ["Id"]},
    ]
    foreign_keys = _mock_foreign_keys() + [
        {
            "fkId": "staging.Shared.Acceptances.PatientId->staging.Shared.Patients.Id",
            "fromTable": "staging.Shared.Acceptances",
            "fromColumns": ["PatientId"],
            "toTable": "staging.Shared.Patients",
            "toColumns": ["Id"],
            "constraintName": "fk_acceptances_patient",
            "origin": "declared",
        }
    ]

    graph = build_join_graph(tables, primary_keys, foreign_keys, min_confidence=0.8)

    cross_source_edges = [e for e in graph["edges"] if e["crossSource"] is True]
    assert len(cross_source_edges) == 1
    edge = cross_source_edges[0]
    assert edge["from"] == "staging.Shared.Acceptances"
    assert edge["fromColumns"] == ["HospitalId"]
    assert edge["to"] == "mock.public.HospitalRef"
    assert edge["toColumns"] == ["HospitalId"]
    assert edge["origin"] == "inferred"
    assert edge["confidence"] >= 0.8
    assert "mock.public.HospitalRef" in graph["nodes"]
    assert "staging.Shared.Acceptances" in graph["nodes"]


def test_full_join_graph_mock_only_has_no_cross_source_edge():
    tables = _mock_catalog_tables()
    primary_keys = _mock_primary_keys()
    foreign_keys = _mock_foreign_keys()

    graph = build_join_graph(tables, primary_keys, foreign_keys, min_confidence=0.8)

    assert all(e["crossSource"] is False for e in graph["edges"])
    assert all(not node.startswith("staging.") for node in graph["nodes"])


# ── inferred name-match edges: generic-id guard + confidence gating ────────


def test_generic_bare_id_match_is_not_inferred():
    tables = [
        {"tableId": "mock.public.A", "columns": [{"name": "Id"}]},
        {"tableId": "mock.public.B", "columns": [{"name": "Id"}]},  # unrelated table also has a bare "Id"
    ]
    primary_keys = [{"tableId": "mock.public.A", "columns": ["Id"]}]
    edges = build_inferred_name_match_edges(tables, primary_keys, declared_edge_keys=set(), min_confidence=0.5)
    assert edges == []


def test_shared_id_space_name_match_is_inferred_same_source():
    tables = [
        {"tableId": "mock.public.WardRef", "columns": [{"name": "WardId"}, {"name": "name"}, {"name": "hospitalId"}]},
        {"tableId": "mock.public.SomeOtherTable", "columns": [{"name": "WardId"}]},
    ]
    primary_keys = [{"tableId": "mock.public.WardRef", "columns": ["WardId"]}]
    edges = build_inferred_name_match_edges(tables, primary_keys, declared_edge_keys=set(), min_confidence=0.8)
    assert len(edges) == 1
    assert edges[0].origin == "inferred"
    assert edges[0].cross_source is False
    assert edges[0].confidence >= 0.8


def test_min_confidence_gates_inferred_edges():
    tables = _mock_catalog_tables() + [
        {"tableId": "staging.Shared.Acceptances", "columns": [{"name": "Id"}, {"name": "HospitalId"}]},
    ]
    # At the SPEC-documented confidence (0.86), the edge passes a 0.8 gate...
    edges_low_gate = build_curated_cross_source_edges(tables, declared_edge_keys=set(), min_confidence=0.8)
    assert len(edges_low_gate) == 1
    # ...but not a gate set ABOVE its own confidence.
    edges_high_gate = build_curated_cross_source_edges(tables, declared_edge_keys=set(), min_confidence=0.95)
    assert edges_high_gate == []


def test_declared_edge_not_duplicated_by_inference():
    """If an edge already exists as a declared FK, the name-match inference
    pass must not emit a duplicate.
    """
    tables = _mock_catalog_tables()
    primary_keys = _mock_primary_keys()
    foreign_keys = _mock_foreign_keys()
    declared = build_declared_edges(foreign_keys, primary_keys)
    declared_keys = {e.dedupe_key() for e in declared}

    inferred = build_inferred_name_match_edges(tables, primary_keys, declared_keys, min_confidence=0.8)
    inferred_keys = {e.dedupe_key() for e in inferred}
    assert declared_keys.isdisjoint(inferred_keys)
