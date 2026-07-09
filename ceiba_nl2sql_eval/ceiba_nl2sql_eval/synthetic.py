"""synthetic.py — synthetic execution topology for the Python eval harness
(ports eval/synthetic/loadSynthetic.ts; docs/PYTHON_NL2SQL_SERVICE_PLAN.md
§4.1, §5 Phase 5).

DESCRIPTOR-DRIVEN: builds a hermetic DuckDB-native schema by reading
`synthetic.json` (the generator descriptors the Python `prep` toolchain
emits, `ceiba_nl2sql_prep`/SPEC §1.8) out of a bundle directory
(`catalog.json` + `keys.json` + `synthetic.json`), fabricating FK-consistent
rows from those descriptors, then attaching the built DuckDB file read-only
via `ceiba_nl2sql.engine.duckdb_engine.DuckDbEngine` under alias `mock`.

── Per-generator semantics (mirrors loadSynthetic.ts / SPEC §1.8) ───────────
  - `surrogate-pk`: sequential synthetic ids `start..start+rowTarget-1`.
  - `surrogate-fk`: an id drawn from the already-generated parent table's
    surrogate-pk pool (`params.references`) — never a dangling reference.
    Tables are synthesized in FK-dependency order (parents before children;
    self-referencing FKs never create an ordering edge).
  - `numeric`: uniform-random value in `[params.min, params.max]`.
  - `categorical`: weighted-random pick from `params.labels`/`params.weights`.
  - `timestamp`: uniform-random instant across `[params.start, "now"]`, plus
    a guaranteed subset of rows forced inside `params.recentWindow`
    (`params.recentWindowAnchor == "previous-day"` anchors the window to
    yesterday's UTC calendar day rather than a rolling window — this is what
    guarantees the canonical "heart rate > 120 in the last 3 hours" /
    "patients admitted yesterday" golden questions always have matching
    rows).
  - `synthetic-identifier`: opaque deterministic fake label
    (`{prefix}-{padded sequence}`).

── Determinism ───────────────────────────────────────────────────────────────
Uses Python's `random.Random(seed)` (does NOT need to bit-match the TS
mulberry32 PRNG — this is an independent Python implementation, not required
to produce byte-identical rows to the TS version). What matters: it is
deterministic across runs of the SAME process/seed, produces FK-consistent,
time-windowed rows per SPEC §1.8, and never touches the network or a real
patient cell (NL2SQL_SPEC.md §8.2 invariant #4).

`SYNTHETIC_SEED = 20260709` is kept as a literal continuity marker with the
TS module's constant of the same name/value, even though the RNG algorithm
differs — it documents "this is the eval harness's synthetic seed", not a
promise of cross-language row-identical output.
"""

from __future__ import annotations

import random
import re
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import duckdb

from ceiba_nl2sql.engine.base import AttachSpec
from ceiba_nl2sql.engine.duckdb_engine import DuckDbEngine

SYNTHETIC_SEED = 20260709

_DDL_TYPE_OVERRIDES: dict[str, str] = {
    "double precision": "DOUBLE",
    "character varying": "VARCHAR",
    "timestamp without time zone": "TIMESTAMP",
    "timestamp with time zone": "TIMESTAMPTZ",
}


def _ddl_type(data_type: str) -> str:
    return _DDL_TYPE_OVERRIDES.get(data_type.lower(), data_type.upper())


def _quote_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


# ── ISO-8601 duration parsing (subset: P<n>Y, P<n>M, P<n>D, T<n>H<n>M<n>S —
#    enough for the recentWindow/start-window hints synthetic.json emits) ────

_ISO_DURATION_RE = re.compile(
    r"^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$"
)


def _iso_duration_to_timedelta(iso: str) -> timedelta:
    match = _ISO_DURATION_RE.match(iso)
    if not match:
        raise ValueError(f"buildSyntheticTopology: unparseable ISO-8601 duration {iso!r}")
    years, months, days, hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    return timedelta(
        days=years * 365 + months * 30 + days,
        hours=hours,
        minutes=minutes,
        seconds=seconds,
    )


_RELATIVE_OFFSET_RE = re.compile(r"^-(\d+)([dhm])$")


def _relative_offset_to_datetime(expr: str, now: datetime) -> datetime:
    if expr == "now":
        return now
    match = _RELATIVE_OFFSET_RE.match(expr)
    if not match:
        raise ValueError(f"buildSyntheticTopology: unparseable relative offset {expr!r}")
    amount, unit = int(match.group(1)), match.group(2)
    delta = {
        "d": timedelta(days=amount),
        "h": timedelta(hours=amount),
        "m": timedelta(minutes=amount),
    }[unit]
    return now - delta


def _random_instant_in_recent_window(
    rand: random.Random, now: datetime, recent_window_iso: str, anchor: str | None
) -> datetime:
    """Mirrors loadSynthetic.ts `randomInstantInRecentWindow`: a rolling
    window by default, or a calendar-day-anchored window (yesterday) when
    `anchor == "previous-day"`. `now` is naive local wall-clock time (see
    `build_synthetic_topology`'s docstring note on why), so "yesterday" here
    is the LOCAL calendar day, matching what `date_trunc('day', now())`
    computes when the golden question's own SQL runs against the same local
    session default.
    """
    if anchor == "previous-day":
        today_start = datetime(now.year, now.month, now.day)
        yesterday_start = today_start - timedelta(days=1)
        return yesterday_start + timedelta(seconds=rand.random() * (86400 - 1))
    window = _iso_duration_to_timedelta(recent_window_iso)
    window_seconds = max(window.total_seconds() - 1, 1)
    return now - timedelta(seconds=rand.random() * window_seconds)


def _guaranteed_recent_row_indices(row_count: int) -> set[int]:
    """Deterministic ~1-in-8 subset (minimum 3, capped at row_count) forced
    into the recent window for any table with a `timestamp` column. Mirrors
    loadSynthetic.ts `guaranteedRecentRowIndices`.
    """
    count = max(3, row_count // 8)
    indices: set[int] = set()
    for i in range(count):
        if i >= row_count:
            break
        indices.add((i * 8) % row_count)
    return indices


def _pick_weighted(rand: random.Random, labels: list[str], weights: list[float] | None) -> str:
    if not weights or len(weights) != len(labels):
        return labels[int(rand.random() * len(labels))]
    total = sum(weights) or 1
    roll = rand.random() * total
    for label, weight in zip(labels, weights):
        roll -= weight
        if roll <= 0:
            return label
    return labels[-1]


@dataclass
class _GenerationContext:
    rand: random.Random
    now: datetime
    pk_pools_by_column_id: dict[str, list[int]] = field(default_factory=dict)


def _generate_column_value(
    descriptor: dict[str, Any],
    ctx: _GenerationContext,
    row_index: int,
    force_recent_window: bool,
) -> tuple[str, int | None]:
    """Returns `(sql_literal, pk_value_if_surrogate_pk)`."""
    generator = descriptor["generator"]
    params: dict[str, Any] = descriptor.get("params") or {}

    if generator == "surrogate-pk":
        start = int(params.get("start", 1))
        value = start + row_index
        return str(value), value

    if generator == "surrogate-fk":
        references = str(params["references"])
        pool = ctx.pk_pools_by_column_id.get(references)
        if not pool:
            return "NULL", None
        chosen = pool[int(ctx.rand.random() * len(pool))]
        return str(chosen), None

    if generator == "numeric":
        lo = float(params.get("min", 0))
        hi = float(params.get("max", lo + 1))
        value = lo + ctx.rand.random() * (hi - lo)
        return f"{value:.4f}", None

    if generator == "categorical":
        labels = params.get("labels") or ["synthetic"]
        weights = params.get("weights")
        label = _pick_weighted(ctx.rand, labels, weights)
        return _quote_literal(label), None

    if generator == "timestamp":
        start_expr = str(params.get("start", "-30d"))
        history_start = _relative_offset_to_datetime(start_expr, ctx.now)
        recent_window_iso = params.get("recentWindow")
        anchor = params.get("recentWindowAnchor")

        if force_recent_window and recent_window_iso:
            instant = _random_instant_in_recent_window(ctx.rand, ctx.now, recent_window_iso, anchor)
        else:
            span_seconds = max((ctx.now - history_start).total_seconds(), 1)
            instant = history_start + timedelta(seconds=ctx.rand.random() * span_seconds)
        literal = instant.strftime("%Y-%m-%d %H:%M:%S.%f")
        return f"TIMESTAMP '{literal}'", None

    # synthetic-identifier (and any unrecognized generator falls back here,
    # mirroring loadSynthetic.ts's `default:` case).
    prefix = str(params.get("prefix", "SYN"))
    pad_width = int(params.get("padWidth", 6))
    label = f"{prefix}-{str(row_index + 1).zfill(pad_width)}"
    return _quote_literal(label), None


def _topological_table_order(table_ids: list[str], foreign_keys: list[dict]) -> list[str]:
    """Parents before children; self-referencing FKs never create an
    ordering edge; a dependency cycle falls back to declaration order rather
    than raising. Mirrors loadSynthetic.ts `topologicalTableOrder`.
    """
    depends_on: dict[str, set[str]] = {tid: set() for tid in table_ids}
    for fk in foreign_keys:
        from_table, to_table = fk["fromTable"], fk["toTable"]
        if from_table == to_table:
            continue
        if from_table in depends_on:
            depends_on[from_table].add(to_table)

    ordered: list[str] = []
    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(node: str) -> None:
        if node in visited or node in visiting:
            return
        visiting.add(node)
        for dep in depends_on.get(node, ()):  # pragma: no branch
            visit(dep)
        visiting.discard(node)
        visited.add(node)
        ordered.append(node)

    for tid in table_ids:
        visit(tid)
    return ordered


def _bare_schema_qualified_ref(quoted_ref: str) -> str:
    """`"public"."PatientMock"` -> `public."PatientMock"` (drop the outer
    quotes from the schema segment only, matching loadSynthetic.ts's
    `public.${table.quotedRef.split('.').slice(1).join('.')}` pattern applied
    to this bundle's `quotedRef` shape, which has no sourceId prefix).
    """
    parts = quoted_ref.split(".")
    if len(parts) >= 2 and parts[0].startswith('"') and parts[0].endswith('"'):
        return "public." + ".".join(parts[1:])
    return f"public.{quoted_ref}"


def _insert_batched(conn: duckdb.DuckDBPyConnection, quoted_table: str, rows: list[str], batch_size: int = 500) -> None:
    for i in range(0, len(rows), batch_size):
        batch = rows[i : i + batch_size]
        if not batch:
            continue
        conn.execute(f"INSERT INTO {quoted_table} VALUES {', '.join(batch)}")


@dataclass
class SyntheticTopology:
    """A ready-to-use hermetic DuckDB execution target (mirrors
    loadSynthetic.ts's `SyntheticTopology`).
    """

    db_path: str
    engine: DuckDbEngine
    counts: dict[str, int]
    _work_dir: str | None = None
    _disposed: bool = False

    def dispose(self) -> None:
        if self._disposed:
            return
        self._disposed = True
        self.engine.dispose()
        if self._work_dir and Path(self._work_dir).exists():
            shutil.rmtree(self._work_dir, ignore_errors=True)


def build_synthetic_topology(
    bundle_dir: str | Path,
    *,
    seed: int = SYNTHETIC_SEED,
    db_path: str | None = None,
) -> SyntheticTopology:
    """Reads `catalog.json` + `keys.json` + `synthetic.json` out of
    `bundle_dir`, synthesizes an FK-consistent, seeded DuckDB dataset from the
    descriptors, then attaches it via `DuckDbEngine` under alias `mock`
    (matching the fixture bundle's `sourceId`). Mirrors loadSynthetic.ts
    `buildSyntheticTopology`.

    Builds the working DuckDB file in a fresh temp dir (unless an explicit
    `db_path` is given) so parallel/CI runs never collide — mirrors the TS
    module's temp-dir-per-run behavior.
    """
    import json

    bundle_dir = Path(bundle_dir)
    rand = random.Random(seed)
    # LOCAL wall-clock time (no tzinfo), NOT UTC: DuckDB's `now()` returns the
    # host session's local wall-clock time for both a naive TIMESTAMP column
    # (the fixture bundle's RecordedAt/admittedAt/etc columns are all plain
    # TIMESTAMP, not TIMESTAMPTZ) and — via its own session default
    # timezone — for a TIMESTAMPTZ column's absolute-instant "now" too. A
    # naive `TIMESTAMP '...'` literal is interpreted as-is (wall clock) by
    # the writer and compared as-is by a later reader's `now()`, so anchoring
    # generation to the SAME local wall-clock "now" the eventual `now() -
    # INTERVAL '...'` comparison will use is what keeps the guaranteed-
    # recent-window rows inside that window regardless of host UTC offset.
    now = datetime.now()

    catalog = json.loads((bundle_dir / "catalog.json").read_text(encoding="utf-8"))
    keys = json.loads((bundle_dir / "keys.json").read_text(encoding="utf-8"))
    synthetic = json.loads((bundle_dir / "synthetic.json").read_text(encoding="utf-8"))

    tables_by_id: dict[str, dict] = {t["tableId"]: t for t in catalog["tables"]}
    descriptors_by_id: dict[str, dict] = {t["tableId"]: t for t in synthetic["tables"]}
    ordered_table_ids = _topological_table_order(
        [t["tableId"] for t in catalog["tables"]], keys.get("foreignKeys", [])
    )

    owns_temp_dir = db_path is None
    work_dir = tempfile.mkdtemp(prefix="nl2sql-eval-synthetic-") if owns_temp_dir else None
    resolved_db_path = db_path or str(Path(work_dir) / "synthetic.duckdb")  # type: ignore[arg-type]

    build_conn = duckdb.connect(resolved_db_path)
    build_conn.execute("CREATE SCHEMA IF NOT EXISTS public")

    ctx = _GenerationContext(rand=rand, now=now)
    counts: dict[str, int] = {}

    for table_id in ordered_table_ids:
        table = tables_by_id.get(table_id)
        descriptor = descriptors_by_id.get(table_id)
        if not table or not descriptor:
            continue  # defensive: synthetic.json and catalog.json are expected to agree on table sets

        descriptor_by_column_id = {c["columnId"]: c for c in descriptor["columns"]}
        quoted_table = _bare_schema_qualified_ref(table["quotedRef"])

        # ── DDL ──
        column_ddls = []
        for col in table["columns"]:
            type_name = _ddl_type(col["dataType"])
            pk_suffix = " PRIMARY KEY" if col.get("isPrimaryKey") else ""
            quoted_name = col.get("quotedName") or f'"{col["name"]}"'
            column_ddls.append(f"{quoted_name} {type_name}{pk_suffix}")
        build_conn.execute(f"CREATE TABLE {quoted_table} ({', '.join(column_ddls)})")

        # ── rows ──
        row_count = max(int(descriptor.get("syntheticRowTarget", 0)), 0)
        recent_row_indices = _guaranteed_recent_row_indices(row_count)
        rows: list[str] = []
        pk_values_this_table: list[int] = []
        pk_column_id: str | None = None

        for row_index in range(row_count):
            values: list[str] = []
            for col in table["columns"]:
                col_descriptor = descriptor_by_column_id.get(col["columnId"])
                if not col_descriptor:
                    values.append("NULL")
                    continue
                force_recent = col_descriptor["generator"] == "timestamp" and row_index in recent_row_indices
                literal, pk_value = _generate_column_value(col_descriptor, ctx, row_index, force_recent)
                values.append(literal)
                if pk_value is not None:
                    pk_column_id = col_descriptor["columnId"]
                    pk_values_this_table.append(pk_value)
            rows.append(f"({', '.join(values)})")

        _insert_batched(build_conn, quoted_table, rows)
        counts[table["name"]] = len(rows)
        if pk_column_id:
            ctx.pk_pools_by_column_id[pk_column_id] = pk_values_this_table

    # Helpful indexes on every isTimeColumn column (query-plan realism, not
    # required for correctness — mirrors loadSynthetic.ts).
    for table in catalog["tables"]:
        for col in table["columns"]:
            if not col.get("isTimeColumn"):
                continue
            quoted_table = _bare_schema_qualified_ref(table["quotedRef"])
            index_name = f"ix_{table['name'].lower()}_{col['name'].lower()}"
            quoted_name = col.get("quotedName") or f'"{col["name"]}"'
            build_conn.execute(f"CREATE INDEX IF NOT EXISTS {index_name} ON {quoted_table} ({quoted_name})")

    build_conn.close()

    # ── attach read-only via the real QueryEngine (mirrors runtime/eval usage) ──
    engine = DuckDbEngine()
    engine.attach([AttachSpec(source_id="mock", engine="duckdb", dsn=resolved_db_path, read_only=True, alias="mock")])

    return SyntheticTopology(db_path=resolved_db_path, engine=engine, counts=counts, _work_dir=work_dir)
