"""cli.py — build | verify | diff | introspect entry points (SPEC §2.1).

    ceiba-nl2sql-prep build       --config prep.config.yaml [--out artifacts/bundles] [--only staging] [--no-embed]
    ceiba-nl2sql-prep verify      --bundle artifacts/bundles/<version>
    ceiba-nl2sql-prep diff        --a <bundle> --b <bundle>
    ceiba-nl2sql-prep introspect  --config prep.config.yaml --dry-run

`build` runs stages [1]->[7] (SPEC §2.4). At the P3a scope, stages [1]
CONNECT, [2] INTROSPECT, [3] PROFILE, [4] CLASSIFY are fully implemented here;
[5] ENRICH / [6] EMBED+INDEX are P3b and are skipped when unavailable (with a
clear stage marker so BUILD_REPORT.json — also P3b — can later show them as
not-yet-run rather than silently omitted). Stage [7] EMIT is the P3a-scoped
partial emit (`prep.emit.emit_partial_bundle`) plus the PHI gate. `build`
exits non-zero if the PHI gate fails — this is the CI gate (SPEC §2.5).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from prep.classify_phi import build_phi_json, load_phi_columnset
from prep.config import ConfigError, PrepConfig, load_config
from prep.introspect.engine import ColumnMeta, TableMeta
from prep.introspect.sqlalchemy_introspector import SqlAlchemyIntrospector
from prep.phi_gate import run_gate, run_gate_from_bundle_dir
from prep.profile import ProfileColumn, build_table_profile, sample_aggregate_from_rows

REPO_ROOT = Path(__file__).resolve().parents[2]


# ── shared introspection/profiling orchestration ────────────────────────────


def _table_id(source_id: str, schema: str, name: str) -> str:
    return f"{source_id}.{schema}.{name}"


def _column_id(table_id: str, column_name: str) -> str:
    return f"{table_id}.{column_name}"


def _quoted_ref_for(schema: str, name: str) -> str:
    return f'"{schema}"."{name}"'


def introspect_source(
    introspector: SqlAlchemyIntrospector,
    source_id: str,
    dsn: str,
    include_schemas: list[str],
    exclude_schemas: list[str],
) -> dict:
    """Stages [1] CONNECT + [2] INTROSPECT for one source. Returns an
    in-memory model with schemas/tables/columns/keys/indexes — the shape
    `build_catalog_and_keys` below serializes into catalog.json/keys.json.
    """
    introspector.connect_read_only(source_id, dsn)

    all_schemas = introspector.list_schemas(source_id)
    exclude_set = set(exclude_schemas)
    if include_schemas:
        schemas = [s for s in all_schemas if s in include_schemas and s not in exclude_set]
    else:
        schemas = [s for s in all_schemas if s not in exclude_set]

    model: dict = {"source_id": source_id, "schemas": []}
    for schema in schemas:
        tables = introspector.list_tables(source_id, schema)
        table_entries = []
        for table in tables:
            columns, key_meta, indexes = introspector.describe_table(table)
            approx_rows = introspector.approx_row_count(table)
            table_entries.append(
                {
                    "table": table,
                    "columns": columns,
                    "keys": key_meta,
                    "indexes": indexes,
                    "approx_row_count": approx_rows,
                }
            )
        model["schemas"].append({"schema": schema, "tables": table_entries})
    return model


def build_catalog_and_keys(models: list[dict], large_table_row_threshold: int) -> tuple[dict, dict]:
    """Fold introspection models (one per source) into catalog.json + keys.json
    shapes (SPEC §1.3, §1.4).
    """
    catalog_schemas: list[dict] = []
    catalog_tables: list[dict] = []
    primary_keys: list[dict] = []
    foreign_keys: list[dict] = []

    for model in models:
        source_id = model["source_id"]
        for schema_entry in model["schemas"]:
            schema = schema_entry["schema"]
            table_count = len(schema_entry["tables"])
            catalog_schemas.append(
                {
                    "sourceId": source_id,
                    "schema": schema,
                    "domain": None,
                    "tableCount": table_count,
                }
            )
            for table_entry in schema_entry["tables"]:
                table: TableMeta = table_entry["table"]
                columns: list[ColumnMeta] = table_entry["columns"]
                approx_rows: int = table_entry["approx_row_count"]
                table_id = _table_id(source_id, schema, table.name)
                is_large = approx_rows > large_table_row_threshold

                column_json = []
                indexed_names = {
                    c for idx in table_entry["indexes"] for c in idx.columns
                }
                for col in columns:
                    column_json.append(
                        {
                            "columnId": _column_id(table_id, col.name),
                            "name": col.name,
                            "quotedName": col.quoted_name,
                            "dataType": col.data_type,
                            "nullable": col.nullable,
                            "isPrimaryKey": col.is_primary_key,
                            "isTimeColumn": _looks_like_time_column(col),
                            "isIndexed": col.is_indexed or col.name in indexed_names,
                            "unit": None,
                            "ordinalPosition": col.ordinal_position,
                        }
                    )

                catalog_tables.append(
                    {
                        "tableId": table_id,
                        "sourceId": source_id,
                        "schema": schema,
                        "name": table.name,
                        "quotedRef": _quoted_ref_for(schema, table.name),
                        "grain": None,
                        "domain": None,
                        "isLargeTimeSeries": is_large,
                        "importanceScore": None,
                        "columns": column_json,
                        "indexes": [
                            {
                                "name": idx.name,
                                "columns": idx.columns,
                                "unique": idx.unique,
                                "method": idx.method,
                            }
                            for idx in table_entry["indexes"]
                        ],
                    }
                )

                key_meta = table_entry["keys"]
                if key_meta.primary_key:
                    primary_keys.append({"tableId": table_id, "columns": key_meta.primary_key})
                for fk in key_meta.foreign_keys:
                    fk_id = (
                        f"{table_id}.{'+'.join(fk.from_columns)}->"
                        f"{fk.to_table}.{'+'.join(fk.to_columns)}"
                    )
                    foreign_keys.append(
                        {
                            "fkId": fk_id,
                            "fromTable": table_id,
                            "fromColumns": fk.from_columns,
                            "toTable": fk.to_table,
                            "toColumns": fk.to_columns,
                            "constraintName": fk.constraint_name,
                            "origin": "declared",
                        }
                    )

    catalog = {"schemas": catalog_schemas, "tables": catalog_tables}
    keys = {"primaryKeys": primary_keys, "foreignKeys": foreign_keys}
    return catalog, keys


_TIME_COLUMN_TYPE_HINTS = ("timestamp", "date", "time")


def _looks_like_time_column(col: ColumnMeta) -> bool:
    return any(hint in col.data_type.lower() for hint in _TIME_COLUMN_TYPE_HINTS)


def profile_source(
    introspector: SqlAlchemyIntrospector,
    model: dict,
    sample_rows_per_table: int,
    large_table_row_threshold: int,
    time_windowed_tables: list[str],
) -> dict:
    """Stage [3] PROFILE for one already-introspected source model. Returns
    the profiles.json shape (SPEC §1.6) for this source's tables.
    """
    source_id = model["source_id"]
    table_profiles: list[dict] = []

    for schema_entry in model["schemas"]:
        schema = schema_entry["schema"]
        for table_entry in schema_entry["tables"]:
            table: TableMeta = table_entry["table"]
            columns: list[ColumnMeta] = table_entry["columns"]
            approx_rows: int = table_entry["approx_row_count"]
            table_id = _table_id(source_id, schema, table.name)
            qualified_name = f"{schema}.{table.name}"

            is_large = approx_rows > large_table_row_threshold
            if is_large and qualified_name in time_windowed_tables:
                time_col = next(
                    (c.name for c in columns if _looks_like_time_column(c) and c.is_indexed),
                    None,
                )
                if time_col is not None:
                    aggregate_profile = introspector.sample_aggregate_time_windowed(
                        table, columns, sample_rows_per_table, time_col
                    )
                else:
                    aggregate_profile = introspector.sample_aggregate(
                        table, columns, sample_rows_per_table
                    )
            else:
                aggregate_profile = introspector.sample_aggregate(
                    table, columns, sample_rows_per_table
                )

            result = build_table_profile(
                table_id=table_id,
                approx_row_count=approx_rows,
                profile=aggregate_profile,
                column_id_prefix=table_id,
            )
            table_profiles.append(result.to_json())

    return {"tables": table_profiles}


def classify_source(model: dict, phi_columns: frozenset[str], phi_columnset_hash: str) -> dict:
    """Stage [4] CLASSIFY PHI for one already-introspected source model.

    Passes each column's declared SQL data type through to classification so
    the free-text heuristic can catch unbounded text/varchar narrative columns
    (e.g. KVC.Anamneses.Complaint/Story/FamilyHistory on the real staging
    schema) that a name-only heuristic would miss — see classify_phi.py
    `classify_column`'s `data_type` parameter.
    """
    source_id = model["source_id"]
    triples: list[tuple[str, str, str]] = []
    for schema_entry in model["schemas"]:
        schema = schema_entry["schema"]
        for table_entry in schema_entry["tables"]:
            table: TableMeta = table_entry["table"]
            table_id = _table_id(source_id, schema, table.name)
            for col in table_entry["columns"]:
                triples.append((_column_id(table_id, col.name), col.name, col.data_type))
    return build_phi_json(triples, phi_columns, phi_columnset_hash)


def _merge_phi_json(parts: list[dict], phi_columnset_hash: str) -> dict:
    columns: list[dict] = []
    for part in parts:
        columns.extend(part["columns"])
    return {"phiColumnsetHash": phi_columnset_hash, "columns": columns}


def _merge_profiles_json(parts: list[dict]) -> dict:
    tables: list[dict] = []
    for part in parts:
        tables.extend(part["tables"])
    return {"tables": tables}


# ── introspect command ───────────────────────────────────────────────────────


def cmd_introspect(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    sources = config.sources if not args.only else [config.source(s) for s in args.only]

    models = []
    for src in sources:
        dsn = src.resolve_dsn()
        introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))
        model = introspect_source(
            introspector,
            src.source_id,
            dsn,
            src.introspect.include_schemas,
            src.introspect.exclude_schemas,
        )
        models.append(model)
        introspector.dispose(src.source_id)

    catalog, keys = build_catalog_and_keys(
        models, large_table_row_threshold=sources[0].profile.large_table_row_threshold
    )

    out_dir = Path(args.out) if args.out else REPO_ROOT / "artifacts" / "introspect-dry-run"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "catalog.json").write_text(
        json.dumps(catalog, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    (out_dir / "keys.json").write_text(
        json.dumps(keys, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    total_tables = len(catalog["tables"])
    total_fks = len(keys["foreignKeys"])
    print(
        f"introspect: {len(sources)} source(s), {total_tables} table(s), "
        f"{total_fks} foreign key(s) -> {out_dir}"
    )
    if args.dry_run:
        print("dry-run: stopped after stage [2] INTROSPECT (no profile/embed/emit).")
    return 0


# ── build command ────────────────────────────────────────────────────────────


def cmd_build(args: argparse.Namespace) -> int:
    config = load_config(args.config)
    sources = config.sources if not args.only else [config.source(s) for s in args.only]

    phi_columnset = load_phi_columnset(str(REPO_ROOT))

    models = []
    profile_parts = []
    phi_parts = []

    for src in sources:
        dsn = src.resolve_dsn()
        introspector = SqlAlchemyIntrospector(repo_root=str(REPO_ROOT))

        # [1] CONNECT + [2] INTROSPECT
        model = introspect_source(
            introspector,
            src.source_id,
            dsn,
            src.introspect.include_schemas,
            src.introspect.exclude_schemas,
        )
        models.append(model)

        # [3] PROFILE (the only data-touching stage)
        profile_parts.append(
            profile_source(
                introspector,
                model,
                sample_rows_per_table=src.profile.sample_rows_per_table,
                large_table_row_threshold=src.profile.large_table_row_threshold,
                time_windowed_tables=src.profile.time_windowed_sample_for,
            )
        )

        # [4] CLASSIFY PHI
        phi_parts.append(classify_source(model, phi_columnset.columns, phi_columnset.columnset_hash))

        introspector.dispose(src.source_id)

    catalog, keys = build_catalog_and_keys(
        models, large_table_row_threshold=sources[0].profile.large_table_row_threshold
    )
    profiles = _merge_profiles_json(profile_parts)
    phi = _merge_phi_json(phi_parts, phi_columnset.columnset_hash)

    # [5] ENRICH / [6] EMBED+INDEX are P3b — not run here. `--no-embed` is
    # accepted (and is currently always the effective behavior at P3a scope)
    # so the CLI surface matches the SPEC §2.1 signature ahead of P3b landing.
    if not args.no_embed:
        print(
            "build: --no-embed not passed, but stage [6] EMBED+INDEX is not yet "
            "implemented (lands in P3b) — continuing without embedding.",
            file=sys.stderr,
        )

    # [7] EMIT (partial: catalog/keys/profiles/phi) + PHI gate
    from prep.emit import emit_partial_bundle

    version = f"v{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out_dir = Path(args.out) if args.out else REPO_ROOT / "artifacts" / "bundles"
    bundle_dir = out_dir / version

    emit_partial_bundle(bundle_dir, catalog=catalog, keys=keys, profiles=profiles, phi=phi)

    gate_report = run_gate(
        repo_root=REPO_ROOT,
        config=config,
        phi_json=phi,
        profiles_json=profiles,
    )
    (bundle_dir / "phi_gate_report.json").write_text(
        json.dumps(gate_report.to_json(), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    print(f"build: wrote partial bundle to {bundle_dir}")
    print(f"build: PHI gate {'PASSED' if gate_report.passed else 'FAILED'}")
    if not gate_report.passed:
        for violation in gate_report.violations:
            print(f"  - [{violation.check}] {violation.message} ({violation.location})", file=sys.stderr)
        return 1
    return 0


# ── verify command ───────────────────────────────────────────────────────────


def cmd_verify(args: argparse.Namespace) -> int:
    config = load_config(args.config) if args.config else _default_config_for_verify()
    report = run_gate_from_bundle_dir(REPO_ROOT, config, args.bundle)
    print(f"verify: PHI gate {'PASSED' if report.passed else 'FAILED'} ({report.checked_files} file(s) checked)")
    if not report.passed:
        for violation in report.violations:
            print(f"  - [{violation.check}] {violation.message} ({violation.location})", file=sys.stderr)
        return 1
    return 0


def _default_config_for_verify() -> PrepConfig:
    default_path = REPO_ROOT / "config" / "prep.config.yaml"
    return load_config(default_path)


# ── diff command (stub — full drift report lands with P3b's manifest work) ──


def cmd_diff(args: argparse.Namespace) -> int:
    print(
        "diff: schema-fingerprint drift report requires manifest.json "
        "(P3b) — not yet implemented.",
        file=sys.stderr,
    )
    return 1


# ── argument parsing ─────────────────────────────────────────────────────────


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ceiba-nl2sql-prep")
    subparsers = parser.add_subparsers(dest="command", required=True)

    introspect_parser = subparsers.add_parser("introspect", help="stages [1]-[2] only, no profile/embed/emit")
    introspect_parser.add_argument("--config", required=True)
    introspect_parser.add_argument("--out", default=None)
    introspect_parser.add_argument("--only", nargs="*", default=None)
    introspect_parser.add_argument("--dry-run", action="store_true")
    introspect_parser.set_defaults(func=cmd_introspect)

    build_parser = subparsers.add_parser("build", help="stages [1]-[7]")
    build_parser.add_argument("--config", required=True)
    build_parser.add_argument("--out", default=None)
    build_parser.add_argument("--only", nargs="*", default=None)
    build_parser.add_argument("--no-embed", action="store_true")
    build_parser.set_defaults(func=cmd_build)

    verify_parser = subparsers.add_parser("verify", help="re-run PHI gate + integrity hashes")
    verify_parser.add_argument("--bundle", required=True)
    verify_parser.add_argument("--config", default=None)
    verify_parser.set_defaults(func=cmd_verify)

    diff_parser = subparsers.add_parser("diff", help="schema-fingerprint drift report")
    diff_parser.add_argument("--a", required=True)
    diff_parser.add_argument("--b", required=True)
    diff_parser.set_defaults(func=cmd_diff)

    return parser


def main() -> int:
    """Console-script entry point."""
    parser = build_arg_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except ConfigError as exc:
        print(f"config error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
