from ceiba_nl2sql_eval.live_bench_queries import QUERIES, BenchQuery

_VALID_MODES = {"scalar", "value", "group_top", "topk_keys"}


def test_reference_queries_well_formed():
    # 10 original + the P2 Task 6 windowed-trend query.
    assert len(QUERIES) == 11
    ids = [q.id for q in QUERIES]
    assert len(set(ids)) == len(ids), "duplicate query ids"
    for q in QUERIES:
        assert isinstance(q, BenchQuery)
        assert q.question.strip()
        assert q.reference_sql.strip()
        assert "SELECT" in q.reference_sql.upper()
        assert q.compare_mode in _VALID_MODES, q.compare_mode
        assert q.interpretation.strip()
