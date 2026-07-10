"""test_exemplars.py — exemplars.py seed content + real execution proof (SPEC §1.10). P3b.

Asserts:
  * The two canonical NL2SQL_PLAN questions are seeded, `validated: true`,
    with the question embedded conceptually (question is a plain field) and
    SQL carried as payload (not executed by this module itself).
  * `include_staging=False` (the `--only mock` default) excludes the
    staging-shaped worked example — a build that never touched staging must
    never claim that exemplar is "validated".
  * The seed exemplar SQL ACTUALLY EXECUTES cleanly against the real mock
    Postgres DB (skips cleanly if MOCK_DSN unset/unreachable — PLAN ground
    rule #4: no test requires the tunnel/mock DB to be up) — this is the
    literal proof behind exemplars.py's docstring claim that these are
    "hand-validated against the MOCK topology".
"""

from __future__ import annotations

import os

import pytest
import sqlalchemy as sa

from prep.exemplars import build_exemplars_json, load_additional_exemplars, seed_exemplars


def test_seed_exemplars_mock_only_excludes_staging_example():
    exemplars = seed_exemplars(include_staging=False)
    ids = {e.id for e in exemplars}
    assert "ex_heart_rate_over_120_last_3h" in ids
    assert "ex_patients_admitted_yesterday" in ids
    assert "ex_admitted_yesterday_hospital" not in ids


def test_seed_exemplars_include_staging_adds_worked_example():
    exemplars = seed_exemplars(include_staging=True)
    ids = {e.id for e in exemplars}
    assert "ex_admitted_yesterday_hospital" in ids


def test_seed_exemplars_are_validated_true():
    exemplars = seed_exemplars()
    assert all(e.validated is True for e in exemplars)


def test_seed_exemplars_carry_sql_as_payload_question_separate():
    exemplars = seed_exemplars()
    heart_rate = next(e for e in exemplars if e.id == "ex_heart_rate_over_120_last_3h")
    assert heart_rate.question == "heart rate > 120 in the last 3 hours"
    assert "SELECT" in heart_rate.sql
    assert heart_rate.question not in heart_rate.sql  # the question text itself never leaks into SQL


def test_build_exemplars_json_shape():
    doc = build_exemplars_json(include_staging=False)
    assert "exemplars" in doc
    assert len(doc["exemplars"]) == 2
    for ex in doc["exemplars"]:
        assert set(ex.keys()) == {
            "id",
            "question",
            "sql",
            "dialect",
            "tables",
            "tags",
            "validated",
            "sample",
            "category",
        }


def test_load_additional_exemplars_shape():
    raw = [
        {
            "id": "g_extra",
            "question": "extra golden question",
            "sql": "SELECT 1",
            "dialect": "postgres",
            "tables": ["mock.public.HospitalRef"],
            "tags": ["extra"],
            "validated": True,
        }
    ]
    loaded = load_additional_exemplars(raw)
    assert len(loaded) == 1
    assert loaded[0].id == "g_extra"
    assert loaded[0].validated is True


def test_build_exemplars_json_with_extra():
    from prep.exemplars import Exemplar

    extra = [
        Exemplar(
            id="ex_extra",
            question="an extra question",
            sql="SELECT 1",
            dialect="postgres",
            tables=(),
            tags=(),
            validated=False,
        )
    ]
    doc = build_exemplars_json(include_staging=False, extra=extra)
    assert len(doc["exemplars"]) == 3
    assert any(e["id"] == "ex_extra" for e in doc["exemplars"])


# ── real execution proof against the mock DB (skips cleanly if unreachable) ─


def _mock_dsn() -> str | None:
    return os.environ.get("MOCK_DSN")


def _reachable(dsn: str) -> bool:
    try:
        engine = sa.create_engine(dsn, connect_args={"options": "-c default_transaction_read_only=on"})
        with engine.connect() as conn:
            conn.execute(sa.text("SELECT 1"))
        engine.dispose()
        return True
    except Exception:
        return False


@pytest.fixture(scope="module")
def mock_engine():
    dsn = _mock_dsn()
    if not dsn or not _reachable(dsn):
        pytest.skip("MOCK_DSN not set or mock DB unreachable (not required for this task)")
    engine = sa.create_engine(dsn, connect_args={"options": "-c default_transaction_read_only=on"})
    yield engine
    engine.dispose()


def test_seed_exemplars_execute_on_mock_duckdb(mock_engine):
    """The literal execution proof behind exemplars.py's `validated: true`
    claim for the two canonical mock-shaped exemplars: both queries must run
    read-only against the real mock Postgres without error.
    """
    exemplars = seed_exemplars(include_staging=False)
    with mock_engine.connect() as conn:
        for exemplar in exemplars:
            result = conn.execute(sa.text(exemplar.sql))
            rows = result.fetchall()
            assert isinstance(rows, list)  # executes cleanly; row count itself is not asserted (seed data may shift)
