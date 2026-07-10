"""Tests for the universal default-LIMIT guard (P2 Task 1/2).

The guard operates on the OUTERMOST query only and classifies per the
rollup-safe decision tree:
  - pure scalar aggregate (aggregate, no GROUP BY, <=1 row) -> pass
  - GROUP BY WITH ORDER BY, no LIMIT                        -> repair (append)
  - GROUP BY WITHOUT ORDER BY, no LIMIT                     -> reject (rollup-safe)
  - plain non-aggregate SELECT, no LIMIT                    -> repair (append)
  - outer LIMIT already present                             -> pass
"""
from ceiba_nl2sql.guard.limit import enforce_default_limit


def test_appends_limit_to_unlimited_plain_select():
    v = enforce_default_limit('SELECT "Id" FROM "Shared"."Patients"', default_limit=1000, dialect="duckdb")
    assert v.action == "repair"
    assert v.repaired_sql is not None and "LIMIT 1000" in v.repaired_sql


def test_skips_scalar_aggregate_no_group_by():
    # count(*) with no GROUP BY returns exactly one row — a LIMIT is pointless
    # and would be noise. Must pass untouched.
    v = enforce_default_limit('SELECT count(*) FROM "Shared"."Patients"', default_limit=1000, dialect="duckdb")
    assert v.action == "pass"
    assert v.repaired_sql is None


def test_scalar_aggregate_over_grouped_subquery_passes():
    # avg_spo2 shape: outer is a scalar count(*) over a grouped subquery. The
    # OUTER query is <=1 row, so pass — the inner GROUP BY must not be seen.
    sql = '''SELECT count(*) FROM (
        SELECT a."PatientId", avg(mm."Value") FROM "Shared"."MonitorMeasurements" mm
        GROUP BY a."PatientId") s'''
    v = enforce_default_limit(sql, default_limit=1000, dialect="duckdb")
    assert v.action == "pass"


def test_appends_to_group_by_with_order_by():
    # A grouped query that already ORDERs BY is a deterministic top-N; appending
    # a LIMIT is safe and intended.
    sql = '''SELECT "UnitId", count(*) AS occ FROM "Shared"."Beds"
        GROUP BY "UnitId" ORDER BY occ DESC'''
    v = enforce_default_limit(sql, default_limit=1000, dialect="duckdb")
    assert v.action == "repair"
    assert "LIMIT 1000" in v.repaired_sql


def test_rejects_group_by_without_order_by():
    # THE load-bearing case: appending a LIMIT to an unordered GROUP BY would
    # return an arbitrary subset of groups with no error — silent wrong answer.
    sql = 'SELECT "UnitId", count(*) FROM "Shared"."Beds" GROUP BY "UnitId"'
    v = enforce_default_limit(sql, default_limit=1000, dialect="duckdb")
    assert v.action == "reject"
    assert v.repaired_sql is None
    assert v.repair_hint and "ORDER BY" in v.repair_hint


def test_noop_when_outer_limit_present():
    v = enforce_default_limit('SELECT "Id" FROM "Shared"."Patients" LIMIT 50', default_limit=1000, dialect="duckdb")
    assert v.action == "pass"


def test_ignores_limit_inside_subquery_and_appends_to_outer():
    # A LIMIT buried in a subquery does not bound the outer result set.
    sql = '''SELECT p."Id" FROM "Shared"."Patients" p
        WHERE p."Id" IN (SELECT "PatientId" FROM "Shared"."Acceptances" LIMIT 5)'''
    v = enforce_default_limit(sql, default_limit=1000, dialect="duckdb")
    assert v.action == "repair"
    assert "LIMIT 1000" in v.repaired_sql


def test_unparseable_defers_to_pass():
    # A syntax error is the EXPLAIN step's job to report with a good message;
    # the limit guard must not raise or reject on it.
    v = enforce_default_limit("SELECT FROM WHERE )))", default_limit=1000, dialect="duckdb")
    assert v.action == "pass"
