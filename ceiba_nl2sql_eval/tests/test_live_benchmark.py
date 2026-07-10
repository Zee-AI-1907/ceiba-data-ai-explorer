from ceiba_nl2sql_eval.live_benchmark import compare, sql_coverage_ok

_PATIENTS_PER_HOSPITAL_REF = '''SELECT h."Id", count(DISTINCT a."PatientId")
    FROM "Shared"."Acceptances" a
    JOIN "Shared"."Units" u ON a."UnitId"=u."Id"
    JOIN "Shared"."Departments" d ON u."DepartmentId"=d."Id"
    JOIN "Shared"."Hospitals" h ON d."HospitalId"=h."Id"
    GROUP BY h."Id"'''


def test_coverage_guard_fails_single_table_when_reference_joins():
    # luna+strict's real failure: SELECT COUNT(*) FROM Patients for a 4-table,
    # 3-join, grouped reference — trivially binds and has no invented join, but
    # answers nothing. Coverage must reject it.
    gen = 'SELECT count(*) FROM "Shared"."Patients"'
    assert sql_coverage_ok(gen, _PATIENTS_PER_HOSPITAL_REF, dialect="duckdb") is False


def test_coverage_guard_fails_missing_group_by_when_reference_groups():
    # Same tables and joins as the reference, but no GROUP BY — isolates the
    # grouping rule: a per-entity rollup collapsed to one aggregate row.
    gen = '''SELECT count(DISTINCT a."PatientId") FROM "Shared"."Acceptances" a
        JOIN "Shared"."Units" u ON a."UnitId"=u."Id"
        JOIN "Shared"."Departments" d ON u."DepartmentId"=d."Id"
        JOIN "Shared"."Hospitals" h ON d."HospitalId"=h."Id"'''
    assert sql_coverage_ok(gen, _PATIENTS_PER_HOSPITAL_REF, dialect="duckdb") is False


def test_coverage_guard_passes_when_shape_matches_or_exceeds():
    # Reordered joins / different aliasing but same structural shape → pass.
    matches = '''SELECT h."Id", count(DISTINCT a."PatientId") FROM "Shared"."Hospitals" h
        JOIN "Shared"."Departments" d ON d."HospitalId"=h."Id"
        JOIN "Shared"."Units" u ON u."DepartmentId"=d."Id"
        JOIN "Shared"."Acceptances" a ON a."UnitId"=u."Id"
        GROUP BY h."Id"'''
    assert sql_coverage_ok(matches, _PATIENTS_PER_HOSPITAL_REF, dialect="duckdb") is True
    # More joins/tables than the reference also passes (never penalize extra).
    exceeds = matches.replace(
        'GROUP BY h."Id"',
        'JOIN "Shared"."Organizations" o ON h."OrganizationId"=o."Id" GROUP BY h."Id"',
    )
    assert sql_coverage_ok(exceeds, _PATIENTS_PER_HOSPITAL_REF, dialect="duckdb") is True


def test_coverage_guard_fails_anti_join_collapsed_to_single_table():
    # luna+strict's anti-join collapse: SELECT Id FROM Acceptances LIMIT 1000
    # vs a 2-join NOT EXISTS reference — no invented join, but answers nothing.
    ref = '''SELECT count(DISTINCT a."PatientId") FROM "Shared"."Acceptances" a
        JOIN "Shared"."Monitors" m ON m."AcceptanceId"=a."Id"
        WHERE NOT EXISTS (
          SELECT 1 FROM "Shared"."MonitorMeasurements" mm
          JOIN "Shared"."Monitors" m2 ON mm."DeviceId"=m2."Id"
          WHERE m2."AcceptanceId"=a."Id")'''
    gen = 'SELECT "Id" FROM "Shared"."Acceptances" LIMIT 1000'
    assert sql_coverage_ok(gen, ref, dialect="duckdb") is False


def test_coverage_guard_unparseable_generation_fails_closed():
    # A generation the parser cannot read cannot be confirmed complete → False,
    # and must not raise (run_cell records binds/joins around it).
    assert sql_coverage_ok("SELECT FROM WHERE )))", _PATIENTS_PER_HOSPITAL_REF, dialect="duckdb") is False


def test_scalar_exact_and_within_tolerance():
    assert compare("scalar", [{"n": 21}], [(21,)]) is True
    assert compare("scalar", [{"n": 21}], [(25,)]) is False
    # 2% tolerance absorbs small live-data drift
    assert compare("scalar", [{"n": 101}], [(100,)]) is True
    # small counts get the max(1, ...) floor
    assert compare("scalar", [{"n": 4}], [(5,)]) is True
    assert compare("scalar", [{"n": 3}], [(5,)]) is False


def test_value_compares_leading_cell_only():
    # worst-HR: value in col 0 matches even if the patient id differs
    assert compare("value", [{"Value": 145.0, "PatientId": 705}], [(145.0, 999)]) is True
    assert compare("value", [{"Value": 130.0, "PatientId": 705}], [(145.0, 705)]) is False


def test_group_top_is_order_and_count_free_on_keys():
    got = [{"UnitId": 843, "occupied": 10}, {"UnitId": 806, "occupied": 5}]
    ref = [(806, 249), (843, 53)]
    assert compare("group_top", got, ref) is True
    # a missing key fails
    assert compare("group_top", [{"UnitId": 806, "occupied": 5}], ref) is False


def test_topk_keys_set_equality():
    got = [{"PatientId": 24625}, {"PatientId": 24644}]
    ref = [(24644,), (24625,)]
    assert compare("topk_keys", got, ref) is True


def test_empty_results_do_not_falsely_pass_group_modes():
    assert compare("group_top", [], []) is False


def test_unknown_mode_raises():
    import pytest
    with pytest.raises(ValueError):
        compare("bogus", [(1,)], [(1,)])
