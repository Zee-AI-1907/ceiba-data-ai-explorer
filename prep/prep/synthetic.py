"""synthetic.py — stage [3] synthetic DESCRIPTOR builder (SPEC §1.8).

Builds the `synthetic.json` document: generator DESCRIPTORS a synthetic-data
generator (SPEC §6.2, `eval/synthetic/loadSynthetic.ts`) consumes to fabricate
schema-conformant, FK-consistent, SHAPE-PRESERVING fixture rows — never a raw
patient cell, and never anywhere near the real row count (SPEC §8.1 "no 337M
row synthetic data").

Derivation is entirely from already-computed, already-PHI-safe inputs:
  * `catalog.json` tables/columns (shape: names, types, isPrimaryKey, isTimeColumn)
  * `keys.json` foreign keys (FK integrity -> `surrogate-fk` generator)
  * `profiles.json` per-column `AggregateProfile` (numeric min/max/mean;
    non-PHI low-cardinality `topCategories`)
  * `phi.json` per-column `phiClass` (drives PHI -> synthetic-but-fake
    generator selection; NEVER raw/real values)

One generator descriptor per column, keyed by the SAME `columnId` used
everywhere else in the bundle, `kind`-dispatched from `profiles.json`:

  - numeric              -> {"generator": "numeric", "params": {min, max, mean, unit}}
  - categorical, non-phi -> {"generator": "categorical", "params": {labels, weights}}
                             (labels come from `topCategories` — the SAME
                             non-PHI low-cardinality strings `profiles.json`
                             already allows; NEVER a raw cell beyond that)
  - phi-suppressed OR
    categorical w/ phiClass != non-phi
    OR high-cardinality
    (no topCategories)    -> a FAKE-shape generator that never touches a real
                             value: "surrogate-fk" (if the column is a
                             declared FK — references the parent's key space)
                             else "synthetic-identifier" (an opaque
                             deterministic fake-id/fake-label template, e.g.
                             "SYN-000042" — shape-preserving, zero raw content)
  - time column           -> {"generator": "timestamp", "params": {start, end,
                             recentWindow, monotonicPerGroup?}} — carries BOTH
                             a wide historical range AND a short "recent
                             window" hint so temporal NL questions ("last 3
                             hours", "yesterday") have guaranteed matching rows
                             once synthesized (SPEC §1.8 RecordedAt note).

`syntheticRowTarget` per table is a small, explicitly SCALED-DOWN row count
(SPEC §1.8 "never 337M") derived from the real `approxRowCount` via a capped
log-scale-down function — never a 1:1 passthrough of the real cardinality,
and never below a minimum floor so FK-referencing child tables still have
something to reference.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

# ── row-target scaling (SPEC §1.8 "scaled-DOWN shape, never 337M") ──────────

_MIN_ROW_TARGET = 5
_MAX_ROW_TARGET = 5000


def scale_down_row_target(
    approx_row_count: int, min_target: int = _MIN_ROW_TARGET, max_target: int = _MAX_ROW_TARGET
) -> int:
    """Deterministic, monotonic log-scale-down of a real row count into a
    small synthetic fixture target. NEVER returns anything close to the real
    cardinality (a 337,000,000-row table maps to `max_target`, same as a
    50,000-row table would) — this is a SHAPE-preserving fixture size, not a
    sample fraction of the real data (SPEC §6.3 "thousands ... never 337M").
    """
    if approx_row_count <= 0:
        return min_target
    # log1p keeps small tables' targets small (a 4-row lookup table stays
    # tiny) while any "large" table saturates at max_target well before real
    # staging cardinalities (337M) are anywhere near the log curve's domain.
    scaled = int(math.log1p(approx_row_count) * 120)
    return max(min_target, min(max_target, scaled))


# ── generator descriptor dataclasses ────────────────────────────────────────


@dataclass(frozen=True)
class ColumnGeneratorDescriptor:
    column_id: str
    generator: str
    params: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"columnId": self.column_id, "generator": self.generator, "params": self.params}


@dataclass(frozen=True)
class TableSyntheticDescriptor:
    table_id: str
    synthetic_row_target: int
    columns: tuple[ColumnGeneratorDescriptor, ...]

    def to_json(self) -> dict:
        return {
            "tableId": self.table_id,
            "syntheticRowTarget": self.synthetic_row_target,
            "columns": [c.to_json() for c in self.columns],
        }


# ── FK lookup helpers ────────────────────────────────────────────────────────


def _fk_target_by_from_column(foreign_keys: list[dict]) -> dict[str, str]:
    """Map a fully-qualified `<tableId>.<columnName>` FROM-column to the
    parent `<toTable>.<toColumn>` key space it references (SPEC §1.8
    `surrogate-fk` `params.references`). Only single-column FKs are mapped
    this way (the overwhelming common case in this schema); composite FKs
    fall through to the generic identifier generator below rather than guess.
    """
    mapping: dict[str, str] = {}
    for fk in foreign_keys:
        if len(fk.get("fromColumns", [])) != 1 or len(fk.get("toColumns", [])) != 1:
            continue
        from_table = fk["fromTable"]
        from_column = fk["fromColumns"][0]
        to_table = fk["toTable"]
        to_column = fk["toColumns"][0]
        mapping[f"{from_table}.{from_column}"] = f"{to_table}.{to_column}"
    return mapping


def _primary_key_columns_by_table(primary_keys: list[dict]) -> dict[str, str]:
    """First (or only) PK column per table — used so a table's OWN primary
    key gets a `surrogate-pk` generator (a fresh synthetic key space, not an
    FK reference to anyone else).
    """
    out: dict[str, str] = {}
    for pk in primary_keys:
        columns = pk.get("columns") or []
        if columns:
            out[pk["tableId"]] = columns[0]
    return out


# ── per-column profile/PHI lookups ──────────────────────────────────────────


def _profile_columns_by_id(profiles_json: dict) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for table in profiles_json.get("tables", []):
        for col in table.get("columns", []):
            out[col["columnId"]] = col
    return out


def _phi_class_by_id(phi_json: dict) -> dict[str, str]:
    return {c["columnId"]: c["phiClass"] for c in phi_json.get("columns", [])}


# ── time-column generator ───────────────────────────────────────────────────


# Column-name hints -> (recentWindow ISO-8601 duration, optional anchor).
# Mirrors glossary.json's temporal phrase table (SPEC §1.9): a
# "measurement"/"recorded"-shaped time column is the target of "last N
# hours"-style questions (short window), while an "admit"/"discharge"-shaped
# time column is the target of "yesterday"/day-anchored questions (SPEC §1.9
# "admitted" -> AcceptanceDate-style temporal-column). Falls back to a
# generic short window when the name doesn't match either hint, so every
# time column still gets SOME guaranteed-recent rows.
_RECENT_WINDOW_HINTS: tuple[tuple[tuple[str, ...], str, str | None], ...] = (
    (("admit", "accept", "arrival", "checkin", "check_in"), "P1D", "previous-day"),
    (("discharge", "checkout", "check_out", "departure"), "P7D", None),
    (("record", "measure", "reading", "sample", "observ"), "PT3H", None),
)
_DEFAULT_RECENT_WINDOW = "PT3H"


def _recent_window_for_column_name(column_name: str) -> tuple[str, str | None]:
    normalized = column_name.lower()
    for hints, window, anchor in _RECENT_WINDOW_HINTS:
        if any(hint in normalized for hint in hints):
            return window, anchor
    return _DEFAULT_RECENT_WINDOW, None


def _timestamp_descriptor(
    column_id: str,
    *,
    column_name: str,
    fk_reference_group: str | None,
    history_window: str = "-30d",
) -> ColumnGeneratorDescriptor:
    """`generator: "timestamp"` — carries a wide historical range (`start`)
    PLUS a short `recentWindow` ISO-8601 duration hint (SPEC §1.8 note: "so
    temporal queries have matching rows"). `loadSynthetic.ts` is expected to
    guarantee at least a handful of rows land inside `recentWindow` of "now"
    at synthesis time, mirroring the canonical "last 3 hours"/"yesterday"
    golden questions. The window (and, for admission-shaped columns, an
    `anchor`) is picked from the column's OWN name via
    `_recent_window_for_column_name` — a `RecordedAt`-shaped column gets a
    short "last 3 hours" window, an `admittedAt`-shaped column gets a
    day-anchored "yesterday" window, matching the SEMANTICS glossary.json
    already encodes for these two golden-question shapes (SPEC §1.9's
    "generator picks the time column by the fact being filtered" principle,
    applied here to WHICH window gets guaranteed matching rows).
    `monotonicPerGroup`, when present, hints that values for the same FK
    group (e.g. per-patient) should be non-decreasing — useful for
    admission/discharge-shaped pairs; left to the caller to set since it is a
    per-column-pair concern, not a per-column one.
    """
    recent_window, anchor = _recent_window_for_column_name(column_name)
    params: dict[str, Any] = {
        "distribution": "uniform",
        "start": history_window,
        "end": "now",
        "recentWindow": recent_window,
    }
    if anchor:
        params["recentWindowAnchor"] = anchor
    if fk_reference_group:
        params["monotonicPerGroup"] = fk_reference_group
    return ColumnGeneratorDescriptor(column_id=column_id, generator="timestamp", params=params)


# ── main per-column dispatch ────────────────────────────────────────────────


def _fake_shape_descriptor(
    column_id: str,
    *,
    column_name: str,
    references: str | None,
) -> ColumnGeneratorDescriptor:
    """PHI / suppressed / high-cardinality columns NEVER get a real-value-
    derived generator. Two safe shapes only:
      - `surrogate-fk`: the column IS a declared FK -> synthesize ids that
        stay inside the referenced parent's synthetic key space (FK
        integrity), never a value copied from a real row.
      - `synthetic-identifier`: opaque, deterministic FAKE label/id template
        (e.g. "SYN-000042") — a shape-preserving placeholder with zero
        cell-derived content, safe for a direct-identifier, quasi-identifier,
        or free-text column (names, addresses, notes, etc all collapse to
        this one fake-but-plausible-shaped generator).
    """
    if references:
        return ColumnGeneratorDescriptor(
            column_id=column_id, generator="surrogate-fk", params={"references": references}
        )
    return ColumnGeneratorDescriptor(
        column_id=column_id,
        generator="synthetic-identifier",
        params={"prefix": "SYN", "padWidth": 6},
    )


def build_column_descriptor(
    *,
    column_id: str,
    column_name: str,
    is_time_column: bool,
    profile_col: dict | None,
    phi_class: str | None,
    fk_reference: str | None,
    is_primary_key: bool,
    monotonic_group: str | None = None,
) -> ColumnGeneratorDescriptor:
    """Single-column descriptor dispatch (SPEC §1.8). Order of precedence:

      1. FK column (declared, single-column)      -> surrogate-fk, ALWAYS —
         even if it happens to also look numeric; FK integrity must win so
         child rows always reference a live parent id.
      2. Own primary key, non-FK                    -> surrogate-pk (fresh
         synthetic key space sized to syntheticRowTarget).
      3. Time column                                 -> timestamp (range +
         recent-window hint), regardless of PHI class (a RecordedAt/
         admittedAt column is structurally never PHI on its own, but even if
         classified free-text by an over-eager heuristic, shape must still be
         a timestamp, not a fake string).
      4. PHI (`phiClass != non-phi`)                  -> fake-shape generator
         (surrogate-fk already handled above; here it's a plain suppressed
         non-FK column) — NEVER a value-shaped generator.
      5. Non-PHI numeric (profiles.json kind=numeric) -> numeric generator
         from min/max/mean (already-safe aggregate descriptors).
      6. Non-PHI categorical WITH topCategories       -> categorical generator
         using those exact labels (already-safe, already-allowed strings).
      7. Non-PHI categorical WITHOUT topCategories
         (high-cardinality, could be an identifier)   -> fake-shape generator
         (never invent labels for a column profiles.json itself suppressed).
    """
    if fk_reference:
        return ColumnGeneratorDescriptor(
            column_id=column_id, generator="surrogate-fk", params={"references": fk_reference}
        )

    if is_primary_key:
        return ColumnGeneratorDescriptor(
            column_id=column_id, generator="surrogate-pk", params={"start": 1}
        )

    if is_time_column:
        return _timestamp_descriptor(
            column_id, column_name=column_name, fk_reference_group=monotonic_group
        )

    is_phi = phi_class is not None and phi_class != "non-phi"
    if is_phi:
        return _fake_shape_descriptor(column_id, column_name=column_name, references=None)

    kind = (profile_col or {}).get("kind")
    if kind == "numeric":
        return ColumnGeneratorDescriptor(
            column_id=column_id,
            generator="numeric",
            params={
                "min": profile_col.get("min"),
                "max": profile_col.get("max"),
                "mean": profile_col.get("mean"),
            },
        )

    top_categories = (profile_col or {}).get("topCategories")
    if kind == "categorical" and top_categories:
        total = sum(c["count"] for c in top_categories) or 1
        return ColumnGeneratorDescriptor(
            column_id=column_id,
            generator="categorical",
            params={
                "labels": [c["value"] for c in top_categories],
                "weights": [round(c["count"] / total, 4) for c in top_categories],
            },
        )

    # High-cardinality non-PHI categorical (no topCategories) or any other
    # unclassified shape — never invent label content; fall back to the same
    # safe opaque-identifier generator PHI columns use.
    return _fake_shape_descriptor(column_id, column_name=column_name, references=None)


# ── table-level + full-document builders ────────────────────────────────────


def build_table_synthetic_descriptor(
    *,
    table: dict,
    approx_row_count: int,
    profile_columns_by_id: dict[str, dict],
    phi_class_by_id: dict[str, str],
    fk_target_by_from_column: dict[str, str],
    primary_key_column_by_table: dict[str, str],
) -> TableSyntheticDescriptor:
    """Build one `synthetic.json` `tables[]` entry from a single catalog.json
    table entry plus the cross-referenced profiles/phi/keys lookups.
    """
    table_id = table["tableId"]
    pk_column_name = primary_key_column_by_table.get(table_id)

    column_descriptors: list[ColumnGeneratorDescriptor] = []
    for col in table.get("columns", []):
        column_id = col["columnId"]
        column_name = col["name"]
        fk_reference = fk_target_by_from_column.get(f"{table_id}.{column_name}")
        is_pk = col.get("isPrimaryKey", False) or column_name == pk_column_name

        column_descriptors.append(
            build_column_descriptor(
                column_id=column_id,
                column_name=column_name,
                is_time_column=bool(col.get("isTimeColumn")),
                profile_col=profile_columns_by_id.get(column_id),
                phi_class=phi_class_by_id.get(column_id),
                fk_reference=fk_reference,
                is_primary_key=is_pk,
            )
        )

    return TableSyntheticDescriptor(
        table_id=table_id,
        synthetic_row_target=scale_down_row_target(approx_row_count),
        columns=tuple(column_descriptors),
    )


def build_synthetic_json(
    *,
    catalog: dict,
    keys: dict,
    profiles: dict,
    phi: dict,
) -> dict:
    """Build the full `synthetic.json` document (SPEC §1.8) from the four
    already-computed, already-PHI-safe bundle artifacts. This is the stage
    [3] PROFILE extension point cli.py calls right after `profiles.json` is
    assembled — see cli.py `_run_build_pipeline_p3b` / `build_synthetic_source`.

    Pure function of already-safe inputs: touches no database connection, no
    raw row, and never invents a label string not already present in
    `profiles.json.topCategories` (itself already gated non-PHI + low
    cardinality upstream in profile.py). This is what makes `synthetic.json`
    safe to run the CI PHI gate's `check_synthetic_json` over.
    """
    foreign_keys = keys.get("foreignKeys", [])
    primary_keys = keys.get("primaryKeys", [])

    fk_target_by_from_column = _fk_target_by_from_column(foreign_keys)
    primary_key_column_by_table = _primary_key_columns_by_table(primary_keys)
    profile_columns_by_id = _profile_columns_by_id(profiles)
    phi_class_by_id = _phi_class_by_id(phi)

    row_count_by_table_id = {
        t["tableId"]: t.get("approxRowCount", 0) for t in profiles.get("tables", [])
    }

    tables: list[dict] = []
    for table in catalog.get("tables", []):
        table_id = table["tableId"]
        descriptor = build_table_synthetic_descriptor(
            table=table,
            approx_row_count=row_count_by_table_id.get(table_id, 0),
            profile_columns_by_id=profile_columns_by_id,
            phi_class_by_id=phi_class_by_id,
            fk_target_by_from_column=fk_target_by_from_column,
            primary_key_column_by_table=primary_key_column_by_table,
        )
        tables.append(descriptor.to_json())

    return {"tables": tables}
