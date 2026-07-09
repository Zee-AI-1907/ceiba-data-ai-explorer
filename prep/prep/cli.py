"""cli.py — build | verify | diff | introspect entry points (SPEC §2.1).

    ceiba-nl2sql-prep build       --config prep.config.yaml [--out artifacts/bundles] [--only staging] [--no-embed] [--test-fallback-embedder]
    ceiba-nl2sql-prep verify      --bundle artifacts/bundles/<version>
    ceiba-nl2sql-prep diff        --a <bundle> --b <bundle>
    ceiba-nl2sql-prep introspect  --config prep.config.yaml --dry-run

`build` runs stages [1]->[7] (SPEC §2.4): [1] CONNECT, [2] INTROSPECT, [3]
PROFILE, [4] CLASSIFY (P3a, unchanged); [5] ENRICH, [6] EMBED+INDEX, and the
FULL [7] EMIT — manifest.json/BUILD_REPORT.json/joingraph.json/glossary.json/
exemplars.json/vectors.duckdb + `latest` symlink — are P3b
(`_run_build_pipeline_p3b`, wired in below `cmd_build`). `--no-embed` skips
stage [6] (the bundle still emits, minus vectors.duckdb). Embedding is LOCAL
ONLY (`fastembed`/`BAAI/bge-small-en-v1.5`, SPEC §2.5 invariant 4);
`--test-fallback-embedder` is the ONLY way to opt into the deterministic
hash-based test embedder (`prep.embed.local_embedder.DeterministicHashEmbedder`)
— never the default, exists solely for hermetic/offline test runs. `build`
exits non-zero if the PHI gate fails, INCLUDING a scan of the embedded
vectors.duckdb documents — this is the CI gate (SPEC §2.5).
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
    """Stages [1]-[7] (SPEC §2.4). P3a implemented [1]-[4] + a partial [7];
    P3b (this extension) wires [5] ENRICH, [6] EMBED+INDEX, and the full [7]
    EMIT (manifest.json/BUILD_REPORT.json/joingraph.json/glossary.json/
    exemplars.json/vectors.duckdb + `latest` symlink), and gates the build on
    the FULL PhiGateReport — including a scan of the embedded vectors.duckdb
    documents, per this task's explicit requirement — not just the P3a-scope
    JSON artifacts. `--no-embed` genuinely skips stage [6] now (P3a's comment
    describing it as always-skipped no longer applies): the bundle is still
    emitted, just without vectors.duckdb, and `counts.vectors` is 0.
    """
    config = load_config(args.config)
    sources = config.sources if not args.only else [config.source(s) for s in args.only]

    phi_columnset = load_phi_columnset(str(REPO_ROOT))

    models = []
    profile_parts = []
    phi_parts = []
    source_manifest_entries = []
    stage_durations: dict[str, float] = {}

    import time

    connect_start = time.monotonic()
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

    stage_durations["connect_introspect_profile_classify"] = time.monotonic() - connect_start

    catalog, keys = build_catalog_and_keys(
        models, large_table_row_threshold=sources[0].profile.large_table_row_threshold
    )
    profiles = _merge_profiles_json(profile_parts)
    phi = _merge_phi_json(phi_parts, phi_columnset.columnset_hash)

    return _run_build_pipeline_p3b(
        args=args,
        config=config,
        sources=sources,
        models=models,
        catalog=catalog,
        keys=keys,
        profiles=profiles,
        phi=phi,
        phi_columnset=phi_columnset,
        stage_durations=stage_durations,
    )


def _row_counts_by_table_id(models: list[dict]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for model in models:
        source_id = model["source_id"]
        for schema_entry in model["schemas"]:
            schema = schema_entry["schema"]
            for table_entry in schema_entry["tables"]:
                table_id = _table_id(source_id, schema, table_entry["table"].name)
                counts[table_id] = table_entry["approx_row_count"]
    return counts


def _run_build_pipeline_p3b(
    *,
    args: argparse.Namespace,
    config: PrepConfig,
    sources: list,
    models: list[dict],
    catalog: dict,
    keys: dict,
    profiles: dict,
    phi: dict,
    phi_columnset,
    stage_durations: dict[str, float],
) -> int:
    """P3b stages [5] ENRICH -> [6] EMBED+INDEX -> [7] EMIT (full bundle)."""
    import time

    from prep.embed.local_embedder import (
        DeterministicHashEmbedder,
        assert_fingerprint_matches_expected,
        build_embedder,
    )
    from prep.embed.vss_index import (
        build_column_document,
        build_exemplar_document,
        build_glossary_document,
        build_table_document,
        count_documents,
        with_embedding,
        write_vector_index,
    )
    from prep.emit import (
        SourceManifestEntry,
        BuildStage,
        build_build_report,
        build_manifest,
        compute_schema_fingerprint,
        emit_full_bundle_files,
        finalize_bundle_directory,
        new_bundle_version,
        update_latest_symlink,
        write_manifest_and_report,
    )
    from prep.enrich.glossary import build_glossary_from_seed_file
    from prep.enrich.importance import apply_importance_and_large_flag
    from prep.enrich.joingraph import build_join_graph
    from prep.enrich.vectors_phi_scan import run_gate_including_vectors
    from prep.exemplars import build_exemplars_json

    stages: list[BuildStage] = []
    stages.append(
        BuildStage(
            stage="connect_introspect_profile_classify",
            ok=True,
            duration_ms=int(stage_durations.get("connect_introspect_profile_classify", 0) * 1000),
            extra={"sources": len(sources), "tables": len(catalog["tables"]), "columns": sum(len(t["columns"]) for t in catalog["tables"])},
        )
    )

    # [5] ENRICH: importance + isLargeTimeSeries, join graph, glossary.
    enrich_start = time.monotonic()
    row_counts = _row_counts_by_table_id(models)
    large_threshold = sources[0].profile.large_table_row_threshold
    catalog = apply_importance_and_large_flag(
        catalog,
        foreign_keys=keys["foreignKeys"],
        row_counts_by_table_id=row_counts,
        large_table_row_threshold=large_threshold,
    )
    joingraph = build_join_graph(
        tables=catalog["tables"],
        primary_keys=keys["primaryKeys"],
        foreign_keys=keys["foreignKeys"],
        min_confidence=config.enrich.infer_join_edges.min_confidence,
    )
    glossary_seed_path = REPO_ROOT / config.enrich.glossary
    glossary = build_glossary_from_seed_file(catalog, glossary_seed_path)
    include_staging_exemplars = any(s.source_id == "staging" for s in sources)
    exemplars = build_exemplars_json(include_staging=include_staging_exemplars)
    stages.append(
        BuildStage(
            stage="enrich",
            ok=True,
            duration_ms=int((time.monotonic() - enrich_start) * 1000),
            extra={
                "inferredJoinEdges": sum(1 for e in joingraph["edges"] if e["origin"] == "inferred"),
                "glossaryTerms": len(glossary["synonyms"]),
            },
        )
    )

    # [6] EMBED+INDEX: local embedder only (SPEC §2.5 invariant 4), non-PHI
    # documents only (column docs for suppressed columns are refused inside
    # vss_index.build_column_document itself).
    embed_start = time.monotonic()
    phi_class_by_column_id = {c["columnId"]: c["phiClass"] for c in phi["columns"]}
    unit_by_column_id = {
        col["columnId"]: col.get("unit")
        for table in catalog["tables"]
        for col in table["columns"]
    }

    documents = []
    for table in catalog["tables"]:
        column_names = [c["name"] for c in table["columns"]]
        documents.append(
            build_table_document(
                table_id=table["tableId"],
                quoted_ref=table["quotedRef"],
                grain=table.get("grain"),
                domain=table.get("domain"),
                column_names=column_names,
            )
        )
        for col in table["columns"]:
            column_id = col["columnId"]
            phi_class = phi_class_by_column_id.get(column_id)
            if phi_class is not None and phi_class != "non-phi":
                continue  # never embed a suppressed column's schema doc either — conservative (vss_index.py docstring)
            documents.append(
                build_column_document(
                    column_id=column_id,
                    column_name=col["name"],
                    data_type=col["dataType"],
                    unit=col.get("unit"),
                    description=None,
                    domain=table.get("domain"),
                    phi_class_by_column_id=phi_class_by_column_id,
                )
            )

    for syn in glossary["synonyms"]:
        documents.append(
            build_glossary_document(term=syn["term"], aliases=syn["aliases"], ref_id=syn["term"])
        )

    for ex in exemplars["exemplars"]:
        documents.append(build_exemplar_document(exemplar_id=ex["id"], question=ex["question"]))

    embedding_dimension = config.embedding.dimension
    if args.no_embed:
        embedder = None
        embedded_documents: list = []
        fingerprint_json = {"id": config.embedding.model_id, "dimension": embedding_dimension, "normalization": "l2", "revision": "not-embedded (--no-embed)"}
        fingerprint_summary = {"id": config.embedding.model_id, "dim": embedding_dimension, "lib": "none", "revision": "not-embedded (--no-embed)"}
    else:
        test_fallback = getattr(args, "test_fallback_embedder", False)
        # `--test-fallback-embedder` OVERRIDES the configured model id with
        # the test-only sentinel — `prep.config.yaml` always names the real
        # `bge-small-en-v1.5` (it should never itself declare a test model
        # id), so `allow_test_fallback=True` alone would have no effect
        # without this substitution. The resulting manifest.embeddingModel.id
        # will honestly read "test-deterministic-hash-v1", never masquerade
        # as the real model (see DeterministicHashEmbedder's fingerprint()).
        effective_model_id = (
            DeterministicHashEmbedder.MODEL_ID if test_fallback else config.embedding.model_id
        )
        embedder = build_embedder(
            provider=config.embedding.provider,
            model_id=effective_model_id,
            dimension=embedding_dimension,
            allow_test_fallback=test_fallback,
        )
        texts = [d.text for d in documents]
        vectors = embedder.embed_documents(texts) if texts else []
        embedded_documents = [with_embedding(d, v) for d, v in zip(documents, vectors)]
        fingerprint = embedder.fingerprint()
        # Guard against the embedder silently producing vectors under a
        # DIFFERENT model id than the one `build_embedder` was asked to
        # construct (e.g. a future embedder implementation bug) — compares
        # against `effective_model_id` (what we intended), not
        # `fingerprint.id` (what came out), which would make this a no-op
        # tautology.
        assert_fingerprint_matches_expected(fingerprint, expected_model_id=effective_model_id)
        fingerprint_json = fingerprint.to_json()
        fingerprint_summary = fingerprint.to_manifest_summary()

    stages.append(
        BuildStage(
            stage="embed",
            ok=True,
            duration_ms=int((time.monotonic() - embed_start) * 1000),
            extra={"vectors": len(embedded_documents), "model": fingerprint_summary["id"]},
        )
    )

    # [7] EMIT: full bundle.
    emit_start = time.monotonic()
    timestamp_stem = new_bundle_version()
    out_root = Path(args.out) if args.out else REPO_ROOT / "artifacts" / "bundles"

    # First pass: write sibling JSON files into a PROVISIONAL directory named
    # by the timestamp stem alone (the final `<stem>_<hash>` name depends on
    # the manifest body, which depends on these files' hashes — see
    # emit.py `finalize_bundle_directory` docstring for the two-pass reason).
    provisional_dir = out_root / timestamp_stem
    from prep.emit import emit_partial_bundle

    partial_result = emit_partial_bundle(provisional_dir, catalog=catalog, keys=keys, profiles=profiles, phi=phi)
    full_file_hashes = dict(partial_result.file_hashes)
    full_file_hashes.update(emit_full_bundle_files(provisional_dir, joingraph=joingraph, glossary=glossary, exemplars=exemplars))

    duckdb_path = provisional_dir / "vectors.duckdb"
    if embedded_documents:
        write_vector_index(duckdb_path, embedded_documents, dimension=embedding_dimension)
        full_file_hashes["vectors.duckdb"] = _sha256_of(duckdb_path)
        vector_counts = count_documents(duckdb_path)
    else:
        vector_counts = {"total": 0}

    index_duration_ms = int((time.monotonic() - emit_start) * 1000)
    stages.append(BuildStage(stage="index", ok=True, duration_ms=index_duration_ms, extra={"hnsw": bool(embedded_documents)}))

    source_manifest_entries = []
    for src in sources:
        model = next(m for m in models if m["source_id"] == src.source_id)
        source_tables = [t for t in catalog["tables"] if t["sourceId"] == src.source_id]
        source_keys = {
            "primaryKeys": [pk for pk in keys["primaryKeys"] if pk["tableId"].startswith(f"{src.source_id}.")],
            "foreignKeys": [fk for fk in keys["foreignKeys"] if fk["fromTable"].startswith(f"{src.source_id}.")],
        }
        fingerprint_hash = compute_schema_fingerprint(source_tables, source_keys)
        source_manifest_entries.append(
            SourceManifestEntry(
                source_id=src.source_id,
                engine=src.engine,
                engine_version="unknown",
                database=src.source_id,
                schema_fingerprint=fingerprint_hash,
                introspected_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            )
        )

    counts = {
        "schemas": len(catalog["schemas"]),
        "tables": len(catalog["tables"]),
        "columns": sum(len(t["columns"]) for t in catalog["tables"]),
        "foreignKeys": len(keys["foreignKeys"]),
        "inferredJoinEdges": sum(1 for e in joingraph["edges"] if e["origin"] == "inferred"),
        "glossaryTerms": len(glossary["synonyms"]),
        "exemplars": len(exemplars["exemplars"]),
        "vectors": vector_counts.get("total", 0),
    }

    # PHI gate — including the vectors.duckdb scan (this task's explicit
    # requirement: exit non-zero over the EMBEDDED documents too).
    vectors_documents_for_gate = [
        {"doc_kind": d.doc_kind, "ref_id": d.ref_id} for d in embedded_documents
    ]
    if embedded_documents:
        gate_report = run_gate_including_vectors(
            repo_root=REPO_ROOT,
            config=config,
            phi_json=phi,
            profiles_json=profiles,
            duckdb_path=duckdb_path,
            vectors_documents=vectors_documents_for_gate,
            suppressed_sample_values=[],
            glossary_json=glossary,
            exemplars_json=exemplars,
        )
        gate_report_json = gate_report.to_json()
    else:
        from prep.phi_gate import run_gate as _run_gate_json_only

        base_report = _run_gate_json_only(
            repo_root=REPO_ROOT,
            config=config,
            phi_json=phi,
            profiles_json=profiles,
            glossary_json=glossary,
            exemplars_json=exemplars,
        )
        gate_report_json = base_report.to_json()

    manifest_body = build_manifest(
        bundle_version=timestamp_stem,
        created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        builder_version="0.1.0",
        git_sha=_current_git_sha(),
        embedding_model_summary=fingerprint_json,
        sources=source_manifest_entries,
        counts=counts,
        file_hashes=full_file_hashes,
        phi_gate_result=gate_report_json,
    )

    final_bundle_dir, finalized_manifest = finalize_bundle_directory(out_root, timestamp_stem, manifest_body)

    # Move the provisional directory to its final, hash-suffixed name.
    if final_bundle_dir != provisional_dir:
        if final_bundle_dir.exists():
            import shutil

            shutil.rmtree(final_bundle_dir)
        provisional_dir.rename(final_bundle_dir)

    stages.append(BuildStage(stage="emit", ok=True, duration_ms=int((time.monotonic() - emit_start) * 1000), extra={}))

    build_report = build_build_report(finalized_manifest["bundleVersion"], stages, gate_report_json)
    write_manifest_and_report(final_bundle_dir, finalized_manifest, build_report)
    update_latest_symlink(out_root, final_bundle_dir.name)

    passed = gate_report_json["passed"]
    print(f"build: wrote full bundle to {final_bundle_dir}")
    print(f"build: PHI gate {'PASSED' if passed else 'FAILED'}")
    if not passed:
        for violation in gate_report_json["violations"]:
            print(f"  - [{violation['check']}] {violation['message']} ({violation['location']})", file=sys.stderr)
        return 1
    return 0


def _sha256_of(path: Path) -> str:
    from prep.emit import sha256_file

    return sha256_file(path)


def _current_git_sha() -> str | None:
    import subprocess

    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


# ── verify command ───────────────────────────────────────────────────────────


def cmd_verify(args: argparse.Namespace) -> int:
    """Re-run the PHI gate AND re-verify every `manifest.json.files` sha256
    against the bundle's on-disk bytes (SPEC §2.1 `verify`: "re-run PHI gate +
    integrity hashes"). When the bundle has a `manifest.json` (full P3b
    bundle), integrity checking + the vectors.duckdb PHI scan both run; a
    bundle with only the P3a-scope files (no manifest.json yet) falls back to
    the JSON-only gate, unchanged from P3a's behavior.
    """
    config = load_config(args.config) if args.config else _default_config_for_verify()
    bundle_dir = Path(args.bundle)
    manifest_path = bundle_dir / "manifest.json"

    if not manifest_path.is_file():
        report = run_gate_from_bundle_dir(REPO_ROOT, config, args.bundle)
        print(f"verify: PHI gate {'PASSED' if report.passed else 'FAILED'} ({report.checked_files} file(s) checked)")
        if not report.passed:
            for violation in report.violations:
                print(f"  - [{violation.check}] {violation.message} ({violation.location})", file=sys.stderr)
            return 1
        return 0

    from prep.emit import sha256_file
    from prep.enrich.vectors_phi_scan import run_gate_including_vectors

    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)

    hash_mismatches: list[str] = []
    for filename, expected_hash in manifest.get("files", {}).items():
        file_path = bundle_dir / filename
        if not file_path.is_file():
            hash_mismatches.append(f"{filename}: missing")
            continue
        actual_hash = sha256_file(file_path)
        if actual_hash != expected_hash:
            hash_mismatches.append(f"{filename}: expected {expected_hash}, got {actual_hash}")

    def _load(name: str) -> dict | None:
        path = bundle_dir / name
        if not path.is_file():
            return None
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    phi_json = _load("phi.json")
    profiles_json = _load("profiles.json")
    glossary_json = _load("glossary.json")
    exemplars_json = _load("exemplars.json")

    duckdb_path = bundle_dir / "vectors.duckdb"
    if duckdb_path.is_file():
        from prep.embed.vss_index import read_all_document_texts  # noqa: F401 (import proves the module is reachable)

        gate_report = run_gate_including_vectors(
            repo_root=REPO_ROOT,
            config=config,
            phi_json=phi_json or {"phiColumnsetHash": None, "columns": []},
            profiles_json=profiles_json or {"tables": []},
            duckdb_path=duckdb_path,
            vectors_documents=[],  # structural doc-list check already covered at build time; verify re-checks text substrings
            suppressed_sample_values=[],
            glossary_json=glossary_json,
            exemplars_json=exemplars_json,
        )
        gate_passed = gate_report.passed
        violations = [v.to_json() for v in gate_report.all_violations]
        checked_files = gate_report.base.checked_files + 1
    else:
        base_report = run_gate_from_bundle_dir(REPO_ROOT, config, args.bundle)
        gate_passed = base_report.passed
        violations = [v.to_json() for v in base_report.violations]
        checked_files = base_report.checked_files

    overall_passed = gate_passed and not hash_mismatches

    print(
        f"verify: PHI gate {'PASSED' if gate_passed else 'FAILED'} ({checked_files} file(s) checked); "
        f"integrity {'PASSED' if not hash_mismatches else 'FAILED'} ({len(manifest.get('files', {}))} file(s) hashed)"
    )
    if hash_mismatches:
        for m in hash_mismatches:
            print(f"  - [integrity] {m}", file=sys.stderr)
    if not gate_passed:
        for v in violations:
            print(f"  - [{v['check']}] {v['message']} ({v['location']})", file=sys.stderr)

    return 0 if overall_passed else 1


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
    build_parser.add_argument(
        "--test-fallback-embedder",
        action="store_true",
        dest="test_fallback_embedder",
        help=(
            "TEST-ONLY: use prep.embed.local_embedder.DeterministicHashEmbedder "
            "instead of the real fastembed/bge-small-en-v1.5 model. Never the "
            "default; for hermetic/offline test runs only."
        ),
    )
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
