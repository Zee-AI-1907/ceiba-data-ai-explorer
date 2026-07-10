from ceiba_nl2sql_eval.live_benchmark import compare


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
