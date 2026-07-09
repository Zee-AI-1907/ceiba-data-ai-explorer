"""test_soft_delete.py — P5 soft-delete/active-flag detection (enrich pass)."""

from __future__ import annotations

from prep.enrich.soft_delete import apply_soft_delete_hints, detect_soft_delete


def _col(name: str, data_type: str) -> dict:
    return {"name": name, "dataType": data_type}


def test_detects_deleted_timestamp():
    assert detect_soft_delete([_col("Id", "bigint"), _col("DeletedAt", "timestamp with time zone")]) == {
        "column": "DeletedAt",
        "kind": "deleted-timestamp",
    }


def test_detects_deleted_flag_bool_only():
    assert detect_soft_delete([_col("IsDeleted", "boolean")]) == {
        "column": "IsDeleted",
        "kind": "deleted-flag",
    }
    # An integer IsDeleted (bitmask? enum?) is ambiguous — not matched.
    assert detect_soft_delete([_col("IsDeleted", "integer")]) is None


def test_detects_active_flag():
    assert detect_soft_delete([_col("IsActive", "boolean")]) == {
        "column": "IsActive",
        "kind": "active-flag",
    }


def test_timestamp_wins_over_flags():
    columns = [_col("IsDeleted", "boolean"), _col("DeletedAt", "timestamp")]
    assert detect_soft_delete(columns)["kind"] == "deleted-timestamp"


def test_domain_states_not_matched():
    # Cancelled/Closed/Archived-at-heart domain states must not be flagged.
    assert detect_soft_delete([_col("Cancelled", "boolean")]) is None
    assert detect_soft_delete([_col("ClosedAt", "timestamp")]) is None
    assert detect_soft_delete([_col("Status", "text")]) is None


def test_snake_case_normalization():
    assert detect_soft_delete([_col("is_deleted", "boolean")])["kind"] == "deleted-flag"
    assert detect_soft_delete([_col("deleted_at", "timestamptz")])["kind"] == "deleted-timestamp"


def test_apply_stamps_every_table():
    catalog = {
        "tables": [
            {"tableId": "a", "columns": [_col("DeletedAt", "timestamp")]},
            {"tableId": "b", "columns": [_col("Value", "double precision")]},
        ]
    }
    apply_soft_delete_hints(catalog)
    assert catalog["tables"][0]["softDelete"]["column"] == "DeletedAt"
    assert catalog["tables"][1]["softDelete"] is None
