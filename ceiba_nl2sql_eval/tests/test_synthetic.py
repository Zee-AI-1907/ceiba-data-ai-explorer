"""test_synthetic.py — ceiba_nl2sql_eval.synthetic.build_synthetic_topology
against the committed fixture bundle (docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§4.1, §5 Phase 5).
"""

from __future__ import annotations

from ceiba_nl2sql.engine.base import ExecuteOptions

from ceiba_nl2sql_eval.run_eval import DEFAULT_FIXTURE_BUNDLE_DIR
from ceiba_nl2sql_eval.synthetic import build_synthetic_topology


def test_builds_fk_consistent_tables_with_row_counts():
    topology = build_synthetic_topology(DEFAULT_FIXTURE_BUNDLE_DIR)
    try:
        assert topology.counts["PatientMock"] > 0
        assert topology.counts["MeasurementsMock"] > 0
        assert topology.counts["VisitMock"] > 0

        result = topology.engine.execute(
            'SELECT COUNT(*) AS n FROM mock.public."MeasurementsMock"', ExecuteOptions()
        )
        assert result.rows[0]["n"] == topology.counts["MeasurementsMock"]
    finally:
        topology.dispose()


def test_recent_window_rows_exist_for_heart_rate_query():
    topology = build_synthetic_topology(DEFAULT_FIXTURE_BUNDLE_DIR)
    try:
        result = topology.engine.execute(
            """SELECT COUNT(*) AS n FROM mock.public."MeasurementsMock"
            WHERE "RecordedAt" >= now() - INTERVAL '3 hours'""",
            ExecuteOptions(),
        )
        assert result.rows[0]["n"] > 0
    finally:
        topology.dispose()


def test_deterministic_across_runs_with_same_seed():
    t1 = build_synthetic_topology(DEFAULT_FIXTURE_BUNDLE_DIR, seed=42)
    t2 = build_synthetic_topology(DEFAULT_FIXTURE_BUNDLE_DIR, seed=42)
    try:
        assert t1.counts == t2.counts
        r1 = t1.engine.execute('SELECT * FROM mock.public."PatientMock" ORDER BY "patientRef" LIMIT 5', ExecuteOptions())
        r2 = t2.engine.execute('SELECT * FROM mock.public."PatientMock" ORDER BY "patientRef" LIMIT 5', ExecuteOptions())
        assert r1.rows == r2.rows
    finally:
        t1.dispose()
        t2.dispose()


def test_dispose_removes_temp_dir():
    topology = build_synthetic_topology(DEFAULT_FIXTURE_BUNDLE_DIR)
    work_dir = topology._work_dir
    assert work_dir is not None
    from pathlib import Path

    assert Path(work_dir).exists()
    topology.dispose()
    assert not Path(work_dir).exists()
