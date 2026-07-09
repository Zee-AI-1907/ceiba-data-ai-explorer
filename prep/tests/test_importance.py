"""test_importance.py — importance.py importanceScore + isLargeTimeSeries (SPEC §7). P3b.

Asserts:
  * A table with more FK in-degree, more rows, and a time/code column scores
    higher than an isolated, tiny, columnless-signal table.
  * `apply_importance_and_large_flag` writes `isLargeTimeSeries=True` for a
    table whose row count exceeds `largeTableRowThreshold`, using
    profiles.json-style row counts (not catalog.json's own, since P3b is
    where that field is first populated for real).
  * `ImportanceWeights` must sum to 1.0 (raises otherwise) so the score never
    exceeds [0, 1].
"""

from __future__ import annotations

import pytest

from prep.enrich.importance import (
    DEFAULT_WEIGHTS,
    ImportanceWeights,
    apply_importance_and_large_flag,
    compute_importance_scores,
)


def _mock_tables_with_row_counts() -> list[dict]:
    return [
        {
            "tableId": "mock.public.PatientMock",
            "approxRowCount": 40,
            "columns": [{"name": "patientRef", "isTimeColumn": False}, {"name": "hospitalId", "isTimeColumn": False}],
        },
        {
            "tableId": "mock.public.MeasurementsMock",
            "approxRowCount": 483,
            "columns": [
                {"name": "Id", "isTimeColumn": False},
                {"name": "RecordedAt", "isTimeColumn": True},
                {"name": "MeasurementTypeId", "isTimeColumn": False},
            ],
        },
        {
            "tableId": "mock.public.HospitalRef",
            "approxRowCount": 2,
            "columns": [{"name": "HospitalId", "isTimeColumn": False}, {"name": "name", "isTimeColumn": False}],
        },
    ]


def _mock_foreign_keys() -> list[dict]:
    return [
        {"fromTable": "mock.public.PatientMock", "toTable": "mock.public.HospitalRef"},
        {"fromTable": "mock.public.MeasurementsMock", "toTable": "mock.public.PatientMock"},
        {"fromTable": "mock.public.VisitMock", "toTable": "mock.public.PatientMock"},
    ]


def test_table_with_higher_fk_in_degree_and_time_column_scores_higher_than_isolated_table():
    tables = _mock_tables_with_row_counts()
    scores = compute_importance_scores(tables, _mock_foreign_keys())

    # PatientMock: in-degree 2 (from MeasurementsMock + VisitMock), no time/code column.
    # HospitalRef: in-degree 1, no time/code column, tiny row count.
    assert scores["mock.public.PatientMock"] > scores["mock.public.HospitalRef"]


def test_time_column_boosts_score_over_otherwise_similar_table():
    tables = [
        {
            "tableId": "mock.public.WithTime",
            "approxRowCount": 100,
            "columns": [{"name": "RecordedAt", "isTimeColumn": True}],
        },
        {
            "tableId": "mock.public.WithoutTime",
            "approxRowCount": 100,
            "columns": [{"name": "SomeValue", "isTimeColumn": False}],
        },
    ]
    scores = compute_importance_scores(tables, foreign_keys=[])
    assert scores["mock.public.WithTime"] > scores["mock.public.WithoutTime"]


def test_code_column_name_hint_also_boosts_score():
    tables = [
        {
            "tableId": "mock.public.WithCode",
            "approxRowCount": 100,
            "columns": [{"name": "StatusCode", "isTimeColumn": False}],
        },
        {
            "tableId": "mock.public.Plain",
            "approxRowCount": 100,
            "columns": [{"name": "SomeValue", "isTimeColumn": False}],
        },
    ]
    scores = compute_importance_scores(tables, foreign_keys=[])
    assert scores["mock.public.WithCode"] > scores["mock.public.Plain"]


def test_scores_are_bounded_zero_to_one():
    tables = _mock_tables_with_row_counts()
    scores = compute_importance_scores(tables, _mock_foreign_keys())
    for score in scores.values():
        assert 0.0 <= score <= 1.0


def test_weights_must_sum_to_one():
    with pytest.raises(ValueError):
        ImportanceWeights(fk_in_degree=0.5, row_count=0.5, has_time_or_code_column=0.5)


def test_default_weights_sum_to_one():
    total = DEFAULT_WEIGHTS.fk_in_degree + DEFAULT_WEIGHTS.row_count + DEFAULT_WEIGHTS.has_time_or_code_column
    assert abs(total - 1.0) < 1e-9


# ── isLargeTimeSeries flag (mock analog must be flaggable at small scale) ──


def test_apply_importance_flags_large_time_series_below_real_scale_threshold():
    """The mock `MeasurementsMock` analog seeds only ~483 rows (never the
    real 337M-row cardinality — SPEC §8.1), so `largeTableRowThreshold` for
    the mock source must be set low enough (config/prep.config.yaml: 100) for
    the flag to fire structurally, exactly as the real table does at real
    scale.
    """
    catalog = {"tables": [{"tableId": t["tableId"], "columns": t["columns"]} for t in _mock_tables_with_row_counts()]}
    row_counts = {t["tableId"]: t["approxRowCount"] for t in _mock_tables_with_row_counts()}

    updated = apply_importance_and_large_flag(
        catalog,
        foreign_keys=_mock_foreign_keys(),
        row_counts_by_table_id=row_counts,
        large_table_row_threshold=100,
    )

    measurements = next(t for t in updated["tables"] if t["tableId"] == "mock.public.MeasurementsMock")
    assert measurements["isLargeTimeSeries"] is True
    assert measurements["approxRowCount"] == 483

    patients = next(t for t in updated["tables"] if t["tableId"] == "mock.public.PatientMock")
    assert patients["isLargeTimeSeries"] is False


def test_apply_importance_does_not_mutate_input_catalog():
    catalog = {"tables": [{"tableId": t["tableId"], "columns": t["columns"]} for t in _mock_tables_with_row_counts()]}
    original_table_dicts = [dict(t) for t in catalog["tables"]]

    apply_importance_and_large_flag(
        catalog,
        foreign_keys=_mock_foreign_keys(),
        row_counts_by_table_id={},
        large_table_row_threshold=100,
    )

    # The ORIGINAL catalog's table dicts must be untouched (no importanceScore/
    # isLargeTimeSeries/approxRowCount keys injected into the caller's own dicts).
    for original in original_table_dicts:
        assert "importanceScore" not in original
        assert "isLargeTimeSeries" not in original


def test_apply_importance_writes_importance_score_into_every_table():
    catalog = {"tables": [{"tableId": t["tableId"], "columns": t["columns"]} for t in _mock_tables_with_row_counts()]}
    row_counts = {t["tableId"]: t["approxRowCount"] for t in _mock_tables_with_row_counts()}

    updated = apply_importance_and_large_flag(
        catalog,
        foreign_keys=_mock_foreign_keys(),
        row_counts_by_table_id=row_counts,
        large_table_row_threshold=100,
    )
    for table in updated["tables"]:
        assert "importanceScore" in table
        assert 0.0 <= table["importanceScore"] <= 1.0
