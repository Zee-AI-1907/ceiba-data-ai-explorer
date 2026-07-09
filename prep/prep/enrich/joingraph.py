"""joingraph.py — declared FKs + inferred edges + confidence (SPEC §1.5). P3b.

Builds the traversable join graph (`joingraph.json`, SPEC §1.5) from P3a's
`keys.json` (declared FKs) plus two additional edge sources this module owns:

  1. **Declared edges** — a 1:1 lift of `keys.json.foreignKeys` into the
     `joingraph.json` edge shape, with `joinCardinality` inferred from
     PK-membership (an FK's target columns forming the target table's full PK
     -> the target side is "one"; the source side is "many" unless the source
     FK columns are themselves that source table's PK, in which case it is
     "one" too — one-to-one).
  2. **Inferred name-match edges** — column-name equality against a primary
     key of another table (`nameMatchStrategy: "col-eq-pk"`, SPEC §2.2 config),
     scored by a deterministic confidence heuristic (see `_confidence_for_match`).
     A column named `HospitalId` that matches another table's PK column
     `HospitalId` is a strong candidate; a bare `Id`-only match against an
     unrelated table is not (too likely to be coincidental / a false positive).
  3. **Curated cross-source correlations** — SPEC's federation topology names
     specific columns that share an id space across independently-introspected
     sources (docs/mock-topology.md "shared id space") even when the two
     partner tables were never introspected together in the same build (e.g. a
     `--only mock` build never sees `staging.Shared.Acceptances`). These are
     declared once, here, as data (not hardcoded per-table logic sprinkled
     through the enrich stage) and only ever surface an edge whose `to` side
     genuinely exists in the current build's catalog — never a phantom node.

Every edge in the emitted graph mirrors SPEC §1.5 exactly: `from`, `fromColumns`,
`to`, `toColumns`, `joinCardinality`, `crossSource`, `origin`, `confidence`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

JoinCardinality = Literal["one-to-one", "many-to-one", "one-to-many", "many-to-many"]
EdgeOrigin = Literal["declared", "inferred"]


# ── curated cross-source correlations (SPEC §0a decision #1, docs/mock-topology.md) ──
#
# These describe id spaces that are SHARED across sources that may never be
# introspected in the same build (e.g. `--only mock`). Each entry names the
# "home" side (where the id is a genuine PK — the join TARGET) and the known
# "correlate" side(s) elsewhere. The inference pass below only ever emits an
# edge when BOTH sides are present in the actual catalog being built — this
# list is a hint set, not a fabrication of nodes that don't exist in the run.
@dataclass(frozen=True)
class CrossSourceCorrelation:
    """One shared-id-space correlation between a target PK and a candidate
    source-side FK-shaped column living in a different sourceId.
    """

    shared_column_name: str  # bare column name shared across sources, e.g. "HospitalId"
    to_table_id: str  # PK "home" table, e.g. "mock.public.HospitalRef"
    to_column: str
    from_table_id: str  # candidate correlate, e.g. "staging.Shared.Acceptances"
    from_column: str
    confidence: float
    join_cardinality: JoinCardinality = "many-to-one"


CROSS_SOURCE_CORRELATIONS: tuple[CrossSourceCorrelation, ...] = (
    # The primary federation test edge (SPEC §1.5 example, PLAN §0a #1,
    # mock-topology.md "shared id space" table row 1).
    CrossSourceCorrelation(
        shared_column_name="HospitalId",
        to_table_id="mock.public.HospitalRef",
        to_column="HospitalId",
        from_table_id="staging.Shared.Acceptances",
        from_column="HospitalId",
        confidence=0.86,
    ),
    # MeasurementTypeId: shared reference vocabulary correlation
    # (mock-topology.md row 2) — lower confidence than the primary edge since
    # the staging table name is itself a plural/compound ("MeasurementTypes")
    # rather than an exact column-name echo of a table.
    CrossSourceCorrelation(
        shared_column_name="MeasurementTypeId",
        to_table_id="mock.public.MeasurementTypeRef",
        to_column="MeasurementTypeId",
        from_table_id="staging.Shared.MonitorMeasurementTypes",
        from_column="MeasurementTypeId",
        confidence=0.82,
    ),
)


@dataclass(frozen=True)
class JoinEdge:
    from_table: str
    from_columns: tuple[str, ...]
    to_table: str
    to_columns: tuple[str, ...]
    join_cardinality: JoinCardinality
    cross_source: bool
    origin: EdgeOrigin
    confidence: float

    def to_json(self) -> dict:
        return {
            "from": self.from_table,
            "fromColumns": list(self.from_columns),
            "to": self.to_table,
            "toColumns": list(self.to_columns),
            "joinCardinality": self.join_cardinality,
            "crossSource": self.cross_source,
            "origin": self.origin,
            "confidence": self.confidence,
        }

    def dedupe_key(self) -> tuple:
        return (
            self.from_table,
            self.from_columns,
            self.to_table,
            self.to_columns,
        )


def _source_id_of(table_id: str) -> str:
    """tableId shape is `<sourceId>.<schema>.<table>` (SPEC §1.3) — sourceId is
    always the first dot-segment.
    """
    return table_id.split(".", 1)[0]


def _pk_columns_by_table(primary_keys: list[dict]) -> dict[str, tuple[str, ...]]:
    return {pk["tableId"]: tuple(pk["columns"]) for pk in primary_keys}


def _declared_cardinality(
    from_table: str,
    from_columns: tuple[str, ...],
    to_table: str,
    to_columns: tuple[str, ...],
    pk_by_table: dict[str, tuple[str, ...]],
) -> JoinCardinality:
    """Infer joinCardinality for a declared FK edge from PK membership.

    The target side of a normal FK references the target's PK -> "one" on that
    side. If the *source* FK columns are ALSO that source table's full PK, the
    relationship is one-to-one (a shared/extension-table pattern); otherwise
    it is many-to-one (the common case: many child rows reference one parent).
    """
    source_pk = pk_by_table.get(from_table)
    if source_pk is not None and set(source_pk) == set(from_columns):
        return "one-to-one"
    return "many-to-one"


def build_declared_edges(
    foreign_keys: list[dict],
    primary_keys: list[dict],
) -> list[JoinEdge]:
    """Lift keys.json.foreignKeys (SPEC §1.4) into joingraph.json edges (SPEC
    §1.5). `origin` is always "declared"; `confidence` is always 1.0 (SPEC
    §1.5 "1.0 for declared").
    """
    pk_by_table = _pk_columns_by_table(primary_keys)
    edges: list[JoinEdge] = []
    for fk in foreign_keys:
        from_table = fk["fromTable"]
        to_table = fk["toTable"]
        from_columns = tuple(fk["fromColumns"])
        to_columns = tuple(fk["toColumns"])
        cardinality = _declared_cardinality(from_table, from_columns, to_table, to_columns, pk_by_table)
        edges.append(
            JoinEdge(
                from_table=from_table,
                from_columns=from_columns,
                to_table=to_table,
                to_columns=to_columns,
                join_cardinality=cardinality,
                cross_source=_source_id_of(from_table) != _source_id_of(to_table),
                origin="declared",
                confidence=1.0,
            )
        )
    return edges


# ── inferred name-match edges (nameMatchStrategy: "col-eq-pk") ─────────────

# Bare PK column names too generic to trust as a name-match signal on their
# own (nearly every table has an "Id" surrogate key; matching on that alone
# would produce a combinatorial explosion of false-positive edges). A name
# match is only inferred when the shared column name is more specific than
# this denylist, UNLESS the column name also appears in a positive
# shared-id-space allowlist (see `_SHARED_ID_SPACE_HINTS`).
_GENERIC_PK_NAME_DENYLIST = frozenset({"id", "pk", "key", "rowid", "guid", "uuid"})

# Column-name substrings that indicate a genuinely shared, correlatable id
# space (SPEC §0a decision #1: HospitalId / MeasurementTypeId / WardId) even
# when they end in the generic word "Id" — these get a confidence boost
# because they encode WHAT the id identifies, not just that it is an id.
_SHARED_ID_SPACE_HINTS = ("hospitalid", "measurementtypeid", "wardid", "patientid", "visitid")


def _confidence_for_match(
    shared_column_name: str,
    from_table: str,
    to_table: str,
    cross_source: bool,
) -> float | None:
    """Deterministic confidence heuristic for a col-eq-pk name match.

    Returns None when the match should NOT be inferred at all (too generic a
    signal — e.g. a bare "Id" match between two otherwise-unrelated tables).
    Otherwise returns a confidence in (0, 1]. Cross-source matches get a
    modest confidence discount relative to same-source matches (SPEC §1.5
    example: 0.86 for the documented cross-source edge vs 1.0 for declared),
    reflecting the extra uncertainty of correlating two independently
    introspected schemas without a DB-enforced constraint.
    """
    normalized = shared_column_name.lower()
    is_generic = normalized in _GENERIC_PK_NAME_DENYLIST
    is_shared_id_space = any(hint in normalized for hint in _SHARED_ID_SPACE_HINTS)

    if is_generic and not is_shared_id_space:
        return None

    # Base confidence: a specific, non-generic column name matching a PK
    # column-for-column is a strong signal.
    base = 0.92 if is_shared_id_space else 0.85

    if cross_source:
        base -= 0.06  # matches the SPEC §1.5 example's 0.86 for the cross-source edge

    return round(base, 2)


def build_inferred_name_match_edges(
    tables: list[dict],
    primary_keys: list[dict],
    declared_edge_keys: set[tuple],
    min_confidence: float = 0.8,
) -> list[JoinEdge]:
    """Infer edges by "col-eq-pk" name matching (SPEC §2.2 `nameMatchStrategy`):
    for every table T with a single-column PK named C, every OTHER table with
    a column also named C (and not already a declared-FK source for that
    exact (fromTable, fromColumns, toTable, toColumns) tuple) gets an inferred
    edge T'.C -> T.C, gated at `min_confidence` (prep.config.yaml
    `enrich.inferJoinEdges.minConfidence`, default 0.8 — SPEC §2.2).

    `tables` is catalog.json's `tables` list (SPEC §1.3): each entry has
    `tableId` and `columns` (each with `name`). Only single-column PKs are
    considered join targets for name-matching (a composite PK is not a single
    shared scalar id space, so col-eq-pk does not apply).
    """
    pk_by_table = _pk_columns_by_table(primary_keys)
    single_col_pk_targets: dict[str, str] = {
        table_id: cols[0] for table_id, cols in pk_by_table.items() if len(cols) == 1
    }

    columns_by_table: dict[str, list[str]] = {
        t["tableId"]: [c["name"] for c in t["columns"]] for t in tables
    }

    edges: list[JoinEdge] = []
    seen: set[tuple] = set()

    for to_table, pk_column in single_col_pk_targets.items():
        for from_table, column_names in columns_by_table.items():
            if from_table == to_table:
                continue
            if pk_column not in column_names:
                continue

            from_columns = (pk_column,)
            to_columns = (pk_column,)
            key = (from_table, from_columns, to_table, to_columns)
            if key in declared_edge_keys or key in seen:
                continue

            cross_source = _source_id_of(from_table) != _source_id_of(to_table)
            confidence = _confidence_for_match(pk_column, from_table, to_table, cross_source)
            if confidence is None or confidence < min_confidence:
                continue

            seen.add(key)
            edges.append(
                JoinEdge(
                    from_table=from_table,
                    from_columns=from_columns,
                    to_table=to_table,
                    to_columns=to_columns,
                    join_cardinality="many-to-one",
                    cross_source=cross_source,
                    origin="inferred",
                    confidence=confidence,
                )
            )

    return edges


def build_curated_cross_source_edges(
    tables: list[dict],
    declared_edge_keys: set[tuple],
    min_confidence: float = 0.8,
) -> list[JoinEdge]:
    """Emit the curated `CROSS_SOURCE_CORRELATIONS` (SPEC §0a decision #1)
    whenever BOTH the `to_table_id` (join target) and the `from_table_id`
    (correlate) genuinely exist in the current build's catalog. A `--only
    mock` build, which never introspects `staging.Shared.Acceptances`, will
    NOT emit that specific edge (the node simply doesn't exist in that run's
    catalog) — this function never fabricates a node.

    This is how the documented cross-source edge
    (`staging.Shared.Acceptances.HospitalId -> mock.public.HospitalRef.HospitalId`)
    surfaces whenever a build actually introspects both `staging` and `mock`.
    """
    table_ids = {t["tableId"] for t in tables}
    edges: list[JoinEdge] = []

    for corr in CROSS_SOURCE_CORRELATIONS:
        if corr.to_table_id not in table_ids or corr.from_table_id not in table_ids:
            continue
        if corr.confidence < min_confidence:
            continue

        from_columns = (corr.from_column,)
        to_columns = (corr.to_column,)
        key = (corr.from_table_id, from_columns, corr.to_table_id, to_columns)
        if key in declared_edge_keys:
            continue

        edges.append(
            JoinEdge(
                from_table=corr.from_table_id,
                from_columns=from_columns,
                to_table=corr.to_table_id,
                to_columns=to_columns,
                join_cardinality=corr.join_cardinality,
                cross_source=_source_id_of(corr.from_table_id) != _source_id_of(corr.to_table_id),
                origin="inferred",
                confidence=corr.confidence,
            )
        )

    return edges


def build_join_graph(
    tables: list[dict],
    primary_keys: list[dict],
    foreign_keys: list[dict],
    min_confidence: float = 0.8,
) -> dict:
    """Build the full joingraph.json document (SPEC §1.5).

    `tables` / `primary_keys` / `foreign_keys` are catalog.json's `tables` and
    keys.json's `primaryKeys` / `foreignKeys` (already merged across sources
    by the caller — see emit.py's manifest builder / cli.py's build orchestration).
    """
    declared = build_declared_edges(foreign_keys, primary_keys)
    declared_keys = {e.dedupe_key() for e in declared}

    inferred_name_match = build_inferred_name_match_edges(
        tables, primary_keys, declared_keys, min_confidence=min_confidence
    )
    inferred_keys = declared_keys | {e.dedupe_key() for e in inferred_name_match}

    curated_cross_source = build_curated_cross_source_edges(
        tables, inferred_keys, min_confidence=min_confidence
    )

    all_edges = declared + inferred_name_match + curated_cross_source

    nodes: set[str] = set()
    for edge in all_edges:
        nodes.add(edge.from_table)
        nodes.add(edge.to_table)
    # Every table in the catalog is a potential graph node even if it has no
    # edges yet (an isolated table is still retrievable; the graph-expand step
    # in the TS Retriever, SPEC §4.1 step 5, simply finds nothing to expand).
    for t in tables:
        nodes.add(t["tableId"])

    return {
        "nodes": sorted(nodes),
        "edges": [e.to_json() for e in sorted(all_edges, key=lambda e: e.dedupe_key())],
    }
