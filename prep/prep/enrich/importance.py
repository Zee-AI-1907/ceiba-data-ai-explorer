"""importance.py — importanceScore (SPEC §7, research §2.3a #3). P3b.

`importanceScore` is a 0..1 centrality prior written into `catalog.json`
table entries, used by the TS Retriever (SPEC §4.1 step 3) to bias table
recall toward tables that are more likely to be the "hub" of a question
(more join partners, larger, more clearly a fact/dimension table).

Formula (deterministic, no ML): a weighted sum of three normalized signals —

    importanceScore = w_fk * fk_in_degree_norm
                     + w_rows * row_count_norm
                     + w_shape * has_time_or_code_column

  - `fk_in_degree_norm`: how many OTHER tables' FKs point AT this table,
    normalized against the max in-degree observed across the whole catalog
    (a table everyone references — e.g. Patients, HospitalRef — is central).
  - `row_count_norm`: log-scaled `approxRowCount`, normalized against the max
    log-row-count in the catalog (a bigger fact table is usually more central
    to analytic questions than a tiny lookup table, but log-scaled so a
    337M-row table doesn't completely dominate a 5-row one on a linear scale).
  - `has_time_or_code_column`: 1.0 if the table has an `isTimeColumn` column
    OR a column whose name suggests a code/status/type discriminator, else 0
    (SPEC §7 "has-time/code column" — a temporal or coded table is more often
    what a clinical NL question is actually asking about).

This module also sets `isLargeTimeSeries` from `largeTableRowThreshold`
(prep.config.yaml `profile.largeTableRowThreshold`, SPEC §2.2) — P3a's cli.py
already computes this at introspect time (see cli.py `build_catalog_and_keys`
`is_large` local), but importance.py re-derives it here from the merged
catalog.json input so the P3b enrich stage can run standalone (e.g. from a
loaded catalog.json, not just from the in-memory introspection model) and so
a single function is the SPEC §7 authority for the flag.

── `timeVia` (cardinality-guard remediation, HR multi-hop query) ────────────
A large/time-series fact table does not always carry its OWN time column —
e.g. `MonitorMeasurements` (344M rows) has no `isTimeColumn` column at all;
its time dimension lives on the joined PARENT `Monitors.MeasuredDate`, one
hop away via `MonitorMeasurements.DeviceId -> Monitors.Id`. Without a hint,
neither the cardinality guard nor the generation prompt know this table CAN
be bounded via its parent's time column, so a genuinely-bounded query (a
time filter on `Monitors.MeasuredDate` reached by a correct join) gets
rejected as an unbounded scan (false negative).

`apply_time_via_hints` runs AFTER the join graph is built (it needs declared
FK edges) and, for every `isLargeTimeSeries` table with no own time column,
walks its declared FK edges (this table is the FK/"from" side) looking for a
parent ("to" side) table that DOES have a time column. When found, it writes
a `timeVia` hint onto the large table's catalog entry:
`{"table": <parentTableId>, "column": <parentTimeColumnBareName>,
"fromColumns": [...], "toColumns": [...]}` — the parent table id, its time
column, and the exact join columns (FK-side -> PK-side), so a downstream
consumer (the cardinality guard, the prompt's JOIN GRAPH renderer) never has
to re-derive or guess the relationship. Only a DECLARED (schema-enforced) FK
is trusted for this — an inferred/name-matched edge is not confident enough
to silently redirect the bounding policy to a different table.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

_CODE_COLUMN_NAME_HINTS = ("code", "status", "type", "category", "kind")


def _fk_in_degree(tables: list[dict], foreign_keys: list[dict]) -> dict[str, int]:
    """Count, per tableId, how many FK edges point AT it (in-degree)."""
    in_degree: dict[str, int] = {t["tableId"]: 0 for t in tables}
    for fk in foreign_keys:
        to_table = fk["toTable"]
        if to_table in in_degree:
            in_degree[to_table] += 1
        else:
            in_degree[to_table] = 1
    return in_degree


def _has_time_or_code_column(table: dict) -> bool:
    for col in table.get("columns", []):
        if col.get("isTimeColumn"):
            return True
        name_lower = str(col.get("name", "")).lower()
        if any(hint in name_lower for hint in _CODE_COLUMN_NAME_HINTS):
            return True
    return False


# ── Fix A-bonus: templated grain (Fix A-bonus §1) ───────────────────────────

_FACT_TABLE_NAME_SUFFIX_HINTS = ("measurements", "measurement", "readings", "events", "logs", "history")
_CODE_TABLE_NAME_SUFFIX_HINTS = ("types", "statuses", "categories", "codes", "ref")


def _fk_count(table: dict) -> int:
    """Approximates FK-column count from name-based heuristics already used
    elsewhere in this module (`_CODE_COLUMN_NAME_HINTS`'s "Id"-suffix
    convention) — a column literally named `<Something>Id` (other than the
    table's own PK) is treated as a probable FK for grain-templating purposes
    only; this is deliberately approximate (Fix A-bonus is templated text
    quality, not a hard-graded fix) and does not require joingraph.json.
    """
    count = 0
    for col in table.get("columns", []):
        if col.get("isPrimaryKey"):
            continue
        name = str(col.get("name", ""))
        if name.lower().endswith("id"):
            count += 1
    return count


def _non_fk_non_pk_column_count(table: dict) -> int:
    total = len(table.get("columns", []))
    return total - _fk_count(table) - sum(1 for c in table.get("columns", []) if c.get("isPrimaryKey"))


def derive_grain(table: dict) -> str:
    """Templated grain-sentence derivation (Fix A-bonus §1): deterministic,
    pattern-based — NOT NLP. Branches on FK count, time-column presence, and
    name-suffix heuristics (reusing the same kind of hints
    `_has_time_or_code_column`/`_CODE_COLUMN_NAME_HINTS` already apply):

      - Bridge/junction shape (>=2 FK-shaped columns AND few non-FK/PK
        columns) -> "one row per <name> linking A to B".
      - Fact/measurement shape (has a time column AND/OR a name matching the
        measurement/event suffix hints) -> "one row per <TableName> reading/
        event, keyed by <FK col>".
      - Code/lookup shape (name matches Types/Statuses/Categories/Codes/Ref
        suffix hints) -> "one row per <TableName> code/lookup value".
      - Else -> generic fallback "one row per <TableName> record".
    """
    name = table.get("name") or table["tableId"].split(".")[-1]
    name_lower = name.lower()
    fk_count = _fk_count(table)
    non_fk_non_pk_count = _non_fk_non_pk_column_count(table)
    has_time_column = any(c.get("isTimeColumn") for c in table.get("columns", []))
    fk_column_names = [c["name"] for c in table.get("columns", []) if not c.get("isPrimaryKey") and c["name"].lower().endswith("id")]

    if fk_count >= 2 and non_fk_non_pk_count <= 2:
        if len(fk_column_names) >= 2:
            return f"one row per {name} record linking {fk_column_names[0]} to {fk_column_names[1]}"
        return f"one row per {name} record linking related entities"

    if has_time_column or any(hint in name_lower for hint in _FACT_TABLE_NAME_SUFFIX_HINTS):
        if fk_column_names:
            return f"one row per {name} reading/event, keyed by {fk_column_names[0]}"
        return f"one row per {name} reading/event"

    if any(hint in name_lower for hint in _CODE_TABLE_NAME_SUFFIX_HINTS):
        return f"one row per {name} code/lookup value"

    return f"one row per {name} record"


@dataclass(frozen=True)
class ImportanceWeights:
    """Weights for the three importanceScore signals; must sum to 1.0 so the
    output stays in [0, 1] (each signal is itself normalized to [0, 1]).
    """

    fk_in_degree: float = 0.45
    row_count: float = 0.35
    has_time_or_code_column: float = 0.20

    def __post_init__(self) -> None:
        total = self.fk_in_degree + self.row_count + self.has_time_or_code_column
        if abs(total - 1.0) > 1e-9:
            raise ValueError(f"ImportanceWeights must sum to 1.0, got {total}")


DEFAULT_WEIGHTS = ImportanceWeights()


def compute_importance_scores(
    tables: list[dict],
    foreign_keys: list[dict],
    weights: ImportanceWeights = DEFAULT_WEIGHTS,
) -> dict[str, float]:
    """Compute importanceScore (SPEC §7) per tableId.

    `tables` is catalog.json's `tables` list (each entry: tableId,
    approxRowCount-bearing profile join is NOT required here — row count is
    read from the table's OWN `approxRowCount` field if present, else falls
    back to 0; callers that only have profiles.json's row counts should merge
    them into the table dict's `approxRowCount` field before calling this,
    matching how `apply_importance_and_large_flag` below does it end to end).
    """
    in_degree = _fk_in_degree(tables, foreign_keys)
    max_in_degree = max(in_degree.values(), default=0) or 1

    log_row_counts = {
        t["tableId"]: math.log1p(max(t.get("approxRowCount") or 0, 0)) for t in tables
    }
    max_log_rows = max(log_row_counts.values(), default=0.0) or 1.0

    scores: dict[str, float] = {}
    for t in tables:
        table_id = t["tableId"]
        fk_norm = in_degree.get(table_id, 0) / max_in_degree
        rows_norm = log_row_counts.get(table_id, 0.0) / max_log_rows
        shape_signal = 1.0 if _has_time_or_code_column(t) else 0.0

        score = (
            weights.fk_in_degree * fk_norm
            + weights.row_count * rows_norm
            + weights.has_time_or_code_column * shape_signal
        )
        scores[table_id] = round(min(max(score, 0.0), 1.0), 4)

    return scores


def apply_importance_and_large_flag(
    catalog: dict,
    foreign_keys: list[dict],
    row_counts_by_table_id: dict[str, int],
    large_table_row_threshold: int,
    weights: ImportanceWeights = DEFAULT_WEIGHTS,
) -> dict:
    """Write `importanceScore` and `isLargeTimeSeries` into every table entry
    of an in-memory catalog.json document (mutates a deep-ish copy, returns
    it — never mutates the caller's dict in place to keep this side-effect-free
    for tests). `row_counts_by_table_id` typically comes from profiles.json's
    `approxRowCount` per table (SPEC §1.6), since catalog.json's own
    `approxRowCount` field is P3b-owned and populated here for the first time.
    """
    tables_copy = [dict(t) for t in catalog.get("tables", [])]

    for t in tables_copy:
        table_id = t["tableId"]
        approx_rows = row_counts_by_table_id.get(table_id, 0)
        t["approxRowCount"] = approx_rows
        t["isLargeTimeSeries"] = approx_rows > large_table_row_threshold
        # Fix A-bonus: populate `grain` when the catalog doesn't already
        # carry one (e.g. a not-yet-enriched build, or a hand-authored
        # fixture) — never overwrite an already-populated grain.
        if not t.get("grain"):
            t["grain"] = derive_grain(t)

    scores = compute_importance_scores(tables_copy, foreign_keys, weights=weights)
    for t in tables_copy:
        t["importanceScore"] = scores.get(t["tableId"], 0.0)

    new_catalog = dict(catalog)
    new_catalog["tables"] = tables_copy
    return new_catalog


def _own_time_column(table: dict) -> dict | None:
    return next((c for c in table.get("columns", []) if c.get("isTimeColumn")), None)


def _best_time_column_for_bounding(table: dict) -> dict | None:
    """Picks the time column to record in a `timeVia` hint when a parent
    table has more than one (e.g. Monitors has CreatedDate, MeasuredDate, AND
    ValidationDate all flagged `isTimeColumn`). Prefers an INDEXED time
    column — the one actually cheap to filter on and the one the real
    schema names to convey "when this reading was taken" (`MeasuredDate`,
    isIndexed=True) rather than a bookkeeping timestamp (`CreatedDate`,
    isIndexed=False) — falling back to the first time column found when none
    is indexed, matching `_own_time_column`'s existing (first-match)
    behavior for the single-time-column case.
    """
    time_columns = [c for c in table.get("columns", []) if c.get("isTimeColumn")]
    if not time_columns:
        return None
    return next((c for c in time_columns if c.get("isIndexed")), time_columns[0])


def _declared_fk_edges_from(table_id: str, foreign_keys: list[dict]) -> list[dict]:
    """Declared FK edges where `table_id` is the FK ("from") side. Accepts
    either `keys.json` shape (`fromTable`/`fromColumns`/`toTable`/`toColumns`)
    or `joingraph.json` edge shape (`from`/`fromColumns`/`to`/`toColumns`) so
    this helper works whether the caller has keys.json's foreignKeys or an
    already-built joingraph.json's declared edges on hand.
    """
    edges = []
    for fk in foreign_keys:
        from_table = fk.get("fromTable", fk.get("from"))
        if from_table != table_id:
            continue
        edges.append(fk)
    return edges


def apply_time_via_hints(catalog: dict, foreign_keys: list[dict]) -> dict:
    """Populate a `timeVia` hint on every `isLargeTimeSeries` table entry that
    has NO own time column but has a declared FK edge to a parent table that
    DOES have one (see module docstring). Returns a new catalog document
    (never mutates the caller's `catalog` in place, matching
    `apply_importance_and_large_flag`'s side-effect-free contract).

    Must run AFTER `apply_importance_and_large_flag` (needs `isLargeTimeSeries`
    already set) and after the join graph's declared edges are available —
    callers typically pass `keys.json`'s `foreignKeys` (declared only; an
    inferred/name-matched edge is not trusted for this redirect) or the
    subset of `joingraph.json` edges whose `origin == "declared"`.
    """
    tables_by_id = {t["tableId"]: t for t in catalog.get("tables", [])}
    tables_copy = [dict(t) for t in catalog.get("tables", [])]

    for t in tables_copy:
        if not t.get("isLargeTimeSeries"):
            continue
        if _own_time_column(t):
            continue  # already has its own time column; no hint needed.

        best_hint: dict | None = None
        for fk in _declared_fk_edges_from(t["tableId"], foreign_keys):
            to_table_id = fk.get("toTable", fk.get("to"))
            parent = tables_by_id.get(to_table_id)
            if not parent:
                continue
            parent_time_col = _best_time_column_for_bounding(parent)
            if not parent_time_col:
                continue
            from_columns = list(fk.get("fromColumns", []))
            to_columns = list(fk.get("toColumns", []))
            best_hint = {
                "table": to_table_id,
                "column": parent_time_col["name"],
                "fromColumns": from_columns,
                "toColumns": to_columns,
            }
            break  # first declared parent with a time column wins (deterministic: FK order).

        if best_hint is not None:
            t["timeVia"] = best_hint

    new_catalog = dict(catalog)
    new_catalog["tables"] = tables_copy
    return new_catalog
