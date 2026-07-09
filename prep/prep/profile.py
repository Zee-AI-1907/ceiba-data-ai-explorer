"""profile.py — stage [3]; wraps sample_aggregate -> AggregateProfile (SPEC §2.3, §2.5).

`sample_aggregate` (invoked here via `sample_aggregate_from_rows`, the
DB-agnostic reducer both Introspector implementations call into) is the ONLY
data-touching path in the whole prep toolchain. Every other module reads
information_schema/pg_catalog metadata only.

This module MIRRORS `lib/phiScrubber.ts` `buildAggregateProfile` semantics
EXACTLY (same constants, same branching, same shape) so a column classifies
identically whether reduced by the TS runtime or the Python prep tool:

  - HIGH_CARDINALITY_ABSOLUTE = 20   (distinct-count ceiling for "low cardinality")
  - MAX_TOP_CATEGORIES = 8           (cap on emitted category labels)
  - kind ∈ {"numeric", "categorical", "phi-suppressed"}
  - PHI columns → kind="phi-suppressed", counts only, NEVER a value
  - Numeric columns (>=80% of non-null values numeric) → min/max/mean, no topCategories
  - Categorical, non-PHI, distinct<=20 → up to 8 top category labels with counts
  - Categorical, non-PHI, distinct>20 → counts only (no topCategories) — "high-cardinality
    suppressed": could be an identifier, so no label is emitted even though the
    column itself is not on the PHI allowlist.

`approx_row_count` is sourced from `pg_class.reltuples` (or the DB-agnostic
equivalent), never `COUNT(*)`, so the 337M-row tables are never fully scanned.
"""

from __future__ import annotations

import numbers
from dataclasses import dataclass, field
from typing import Literal

from prep.classify_phi import classify_column, normalize_key

# ── constants mirrored VERBATIM from lib/phiScrubber.ts ─────────────────────
MAX_TOP_CATEGORIES = 8
HIGH_CARDINALITY_ABSOLUTE = 20

ColumnKind = Literal["numeric", "categorical", "phi-suppressed"]


@dataclass(frozen=True)
class TopCategory:
    value: str
    count: int

    def to_json(self) -> dict:
        return {"value": self.value, "count": self.count}


@dataclass(frozen=True)
class ColumnAggregate:
    key: str
    label: str
    type: str
    kind: ColumnKind
    non_null_count: int
    distinct_count: int
    min: float | None = None
    max: float | None = None
    mean: float | None = None
    top_categories: tuple[TopCategory, ...] | None = None

    def to_json(self) -> dict:
        out: dict = {
            "key": self.key,
            "label": self.label,
            "type": self.type,
            "kind": self.kind,
            "nonNullCount": self.non_null_count,
            "distinctCount": self.distinct_count,
        }
        if self.kind == "numeric":
            out["min"] = self.min
            out["max"] = self.max
            out["mean"] = self.mean
        if self.top_categories:
            out["topCategories"] = [c.to_json() for c in self.top_categories]
        return out


@dataclass(frozen=True)
class AggregateProfile:
    total_rows: int
    sampled_rows: int
    columns: tuple[ColumnAggregate, ...]

    def to_json(self) -> dict:
        return {
            "totalRows": self.total_rows,
            "sampledRows": self.sampled_rows,
            "columns": [c.to_json() for c in self.columns],
        }


@dataclass(frozen=True)
class ProfileColumn:
    """Minimal column descriptor sample_aggregate needs: name/key + declared type."""

    key: str
    label: str
    type: str = "text"


def _is_finite_number(value: object) -> bool:
    # Mirror TS `isFiniteNumber`: real numbers only, not bool (bool is a
    # numbers.Number subclass in Python — explicitly excluded so True/False
    # never get treated as 1/0 numerics, matching JS typeof semantics).
    if isinstance(value, bool):
        return False
    return isinstance(value, numbers.Real) and _is_finite(value)


def _is_finite(value: numbers.Real) -> bool:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return False
    return f == f and f not in (float("inf"), float("-inf"))  # noqa: PLR0124 (NaN check)


def sample_aggregate_from_rows(
    rows: list[dict[str, object]],
    columns: list[ProfileColumn],
    phi_columns: frozenset[str],
    max_sample_rows: int = 5000,
) -> AggregateProfile:
    """The DB-agnostic reducer: raw sampled rows -> AggregateProfile.

    This is the ONLY function in the prep toolchain that inspects individual
    cell values. Both Introspector implementations' `sample_aggregate` methods
    call this after fetching a bounded sample (never a raw SELECT of full
    columns — see phi_gate.py's AST scan). It never returns a value for a PHI
    column; only counts.

    Suppression uses the FULL `classify_phi.classify_column` decision (not
    just flat PHI_COLUMNS membership): a column is suppressed to
    `kind="phi-suppressed"` whenever its `phiClass` != "non-phi" — this
    includes the authoritative allowlist (direct/quasi-identifier) AND the
    free-text heuristic (SPEC §1.7 "free-text -> suppress (free text may
    embed names)"). A notes/comments column can carry a name or other PHI in
    free text even though it is not itself on the PHI_COLUMNS allowlist; if
    profiling only checked the flat allowlist, a coincidentally low-cardinality
    notes column could leak its literal string values as `topCategories` —
    exactly the violation the PHI gate (phi_gate.py check 2b) exists to catch.
    """
    sample = rows[:max_sample_rows]

    column_aggregates: list[ColumnAggregate] = []
    for col in columns:
        phi_class, _matched_rule = classify_column(col.key, phi_columns, col.type)
        phi = phi_class != "non-phi"

        non_null_count = 0
        distinct: set[str] = set()
        category_counts: dict[str, int] = {}
        numeric_min = float("inf")
        numeric_max = float("-inf")
        numeric_sum = 0.0
        numeric_count = 0

        for row in sample:
            value = row.get(col.key)
            if value is None or value == "":
                continue
            non_null_count += 1

            if _is_finite_number(value):
                numeric_count += 1
                numeric_sum += float(value)
                if float(value) < numeric_min:
                    numeric_min = float(value)
                if float(value) > numeric_max:
                    numeric_max = float(value)

            as_string = str(value)
            distinct.add(as_string)
            if not phi:
                category_counts[as_string] = category_counts.get(as_string, 0) + 1

        # PHI columns: suppress entirely — only counts leave, never a value.
        if phi:
            column_aggregates.append(
                ColumnAggregate(
                    key=col.key,
                    label=col.label,
                    type=col.type,
                    kind="phi-suppressed",
                    non_null_count=non_null_count,
                    distinct_count=len(distinct),
                )
            )
            continue

        # Numeric columns: emit min/max/mean, never raw values.
        mostly_numeric = numeric_count > 0 and numeric_count >= non_null_count * 0.8
        if mostly_numeric:
            column_aggregates.append(
                ColumnAggregate(
                    key=col.key,
                    label=col.label,
                    type=col.type,
                    kind="numeric",
                    non_null_count=non_null_count,
                    distinct_count=len(distinct),
                    min=numeric_min if numeric_count else None,
                    max=numeric_max if numeric_count else None,
                    mean=round((numeric_sum / numeric_count) * 1000) / 1000 if numeric_count else None,
                )
            )
            continue

        # Categorical: only surface labels when the column is low-cardinality AND
        # not PHI. High-cardinality columns could be identifiers -> counts only.
        low_cardinality = 0 < len(distinct) <= HIGH_CARDINALITY_ABSOLUTE
        top_categories = None
        if low_cardinality:
            ranked = sorted(category_counts.items(), key=lambda kv: kv[1], reverse=True)
            top_categories = tuple(
                TopCategory(value=v, count=c) for v, c in ranked[:MAX_TOP_CATEGORIES]
            )

        column_aggregates.append(
            ColumnAggregate(
                key=col.key,
                label=col.label,
                type=col.type,
                kind="categorical",
                non_null_count=non_null_count,
                distinct_count=len(distinct),
                top_categories=top_categories,
            )
        )

    return AggregateProfile(
        total_rows=len(rows),
        sampled_rows=len(sample),
        columns=tuple(column_aggregates),
    )


# ── table-level profiling orchestration ─────────────────────────────────────


@dataclass(frozen=True)
class TableProfileResult:
    """profiles.json per-table entry (SPEC §1.6)."""

    table_id: str
    approx_row_count: int
    row_count_source: str
    columns: tuple[dict, ...]  # each entry: {"columnId", **ColumnAggregate.to_json() minus key/label}

    def to_json(self) -> dict:
        return {
            "tableId": self.table_id,
            "approxRowCount": self.approx_row_count,
            "rowCountSource": self.row_count_source,
            "columns": list(self.columns),
        }


def build_table_profile(
    table_id: str,
    approx_row_count: int,
    profile: AggregateProfile,
    column_id_prefix: str,
    row_count_source: str = "pg_class.reltuples",
) -> TableProfileResult:
    """Adapt an AggregateProfile (keyed by bare column name) into the
    profiles.json per-table shape (SPEC §1.6), keyed by full columnId.
    """
    columns: list[dict] = []
    for col in profile.columns:
        entry = col.to_json()
        bare_key = entry.pop("key")
        entry.pop("label", None)
        entry["columnId"] = f"{column_id_prefix}.{bare_key}"
        columns.append(entry)
    return TableProfileResult(
        table_id=table_id,
        approx_row_count=approx_row_count,
        row_count_source=row_count_source,
        columns=tuple(columns),
    )


def normalize_column_key(key: str) -> str:
    """Re-exported for callers that only need the normalization, not the PHI
    membership test (e.g. synthetic.json generator descriptor emission).
    """
    return normalize_key(key)
