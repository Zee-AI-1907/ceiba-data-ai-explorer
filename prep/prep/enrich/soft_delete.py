"""soft_delete.py — P5 enrich pass: detect soft-delete / active-flag columns.

Nothing in the bundle previously surfaced logical-deletion semantics, so
generated SQL silently included dead rows — a silent-wrong answer class (the
worst kind: plausible numbers, no error). This pass detects the three common
conventions by column name + declared type and stamps a `softDelete` hint on
the catalog table entry; the prompt renders one line telling the model how to
exclude logically deleted rows.

Detection is deliberately name+type tight (high precision over recall):
  - deleted-flag       boolean  IsDeleted / Deleted / IsRemoved / SoftDeleted
  - deleted-timestamp  time     DeletedAt / DeletedDate / DeletedOn / RemovedAt …
  - active-flag        boolean  IsActive / Active
A name like `Cancelled` or `Closed` is a DOMAIN state, not soft deletion —
deliberately not matched. Pure function over the already-built catalog; no DB
access.
"""

from __future__ import annotations

_BOOL_TYPE_HINTS = ("bool",)
_TIME_TYPE_HINTS = ("timestamp", "date")

# normalized column name -> kind. Normalization: lowercase, underscores removed.
_DELETED_FLAG_NAMES = frozenset({"isdeleted", "deleted", "isremoved", "softdeleted", "issoftdeleted"})
_DELETED_TIMESTAMP_NAMES = frozenset(
    {"deletedat", "deleteddate", "deletedon", "deletiondate", "removedat", "removeddate", "softdeletedat"}
)
_ACTIVE_FLAG_NAMES = frozenset({"isactive", "active"})


def _normalize(name: str) -> str:
    return name.replace("_", "").lower()


def _is_bool(data_type: str) -> bool:
    lowered = data_type.lower()
    return any(hint in lowered for hint in _BOOL_TYPE_HINTS)


def _is_time(data_type: str) -> bool:
    lowered = data_type.lower()
    return any(hint in lowered for hint in _TIME_TYPE_HINTS)


def detect_soft_delete(columns: list[dict]) -> dict | None:
    """Return {"column": <name>, "kind": <kind>} for the first soft-delete
    column found on a catalog table's column list, else None. Precedence:
    deleted-timestamp > deleted-flag > active-flag (a timestamp carries the
    most information; an active flag is the weakest signal).
    """
    by_kind: dict[str, str] = {}
    for col in columns:
        name = col.get("name") or ""
        data_type = col.get("dataType") or ""
        normalized = _normalize(name)
        if normalized in _DELETED_TIMESTAMP_NAMES and _is_time(data_type):
            by_kind.setdefault("deleted-timestamp", name)
        elif normalized in _DELETED_FLAG_NAMES and _is_bool(data_type):
            by_kind.setdefault("deleted-flag", name)
        elif normalized in _ACTIVE_FLAG_NAMES and _is_bool(data_type):
            by_kind.setdefault("active-flag", name)
    for kind in ("deleted-timestamp", "deleted-flag", "active-flag"):
        if kind in by_kind:
            return {"column": by_kind[kind], "kind": kind}
    return None


def apply_soft_delete_hints(catalog: dict) -> dict:
    """Stamp `softDelete` onto every catalog table where a convention is
    detected (None otherwise, so consumers can .get() uniformly).
    """
    for table in catalog.get("tables", []):
        table["softDelete"] = detect_soft_delete(table.get("columns", []))
    return catalog
