"""exemplar_gen.py — W3: LLM exemplar-generation enrichment.

Prompts the driving LLM with the rendered schema, the declared join hints, a
`Category` (id + intent) from `exemplar_gen_config`, and the curator-seeded
questions as style anchors; parses the response into `{question, sql}`
candidate dicts (`generate_candidates`, Task 6).

Task 7 adds the orchestrator (`run_exemplar_generation`) that wires
generation together with the two validation gates built in earlier tasks and
emits PHI-scrubbed, validated `Exemplar` records:

  generate (Task 6) -> structural join gate (Task 4, `join_check`) ->
  engine EXPLAIN + a real EXECUTE for a non-empty sample -> PHI scrub of that
  sample (Task 5, `output_scrub`) -> `Exemplar` (Task 3's dataclass, extended).

Egress class: `schema-metadata` (SPEC §2.5's always-allowed class) — the
generation prompt carries schema text and join hints only, never a sampled
cell, same discipline as `llm_enrich.py`'s enrichment pass. The one place a
sampled cell DOES leave the DB (the kept candidate's own executed sample) is
scrubbed by `output_scrub.scrub_output_sample` BEFORE it is embedded anywhere
downstream — this module never hands a raw row to the LLM.

Structured output: the caller MUST construct its `LlmClient` with
`use_structured_output=False` (see `llm.py::build_llm_client`'s docstring —
R3's `{sql, description}` json_schema response_format would otherwise force
every completion into the wrong shape, exactly the P3 defect memorialized in
`llm_enrich.py`'s module docstring). This module's prompt instead instructs
the model directly to emit strict JSON shaped `{"exemplars": [...]}`.

The parser reuses `llm_enrich.parse_enrichment_response`'s fenced-JSON
tolerance approach (strip a ```json ... ``` fence if present, `json.loads`,
fail-open to `[]` on `JSONDecodeError`) so a build never fails because a
model wrapped its JSON in prose or a markdown fence.
"""

from __future__ import annotations

import json
import logging
import re

import sqlglot
from sqlglot import exp

from ceiba_nl2sql.engine.base import ExecuteOptions
from prep.enrich.exemplar_gen_config import Category, ExemplarGenConfig
from prep.enrich.join_check import join_predicates_are_declared
from prep.enrich.output_scrub import scrub_output_sample
from prep.exemplars import Exemplar

logger = logging.getLogger("prep.enrich.exemplar_gen")


def build_generation_prompt(
    schema_text: str,
    join_hints_text: str,
    category: Category,
    seeds: list[str],
    count: int,
) -> str:
    """Build the exemplar-generation prompt: schema + declared joins + the
    category's intent + the curator seed questions as style anchors, with an
    instruction to produce `count` clinical questions and their DuckDB SQL
    using ONLY the declared joins, strict JSON only.
    """
    seed_lines = "\n".join(f"  - {seed}" for seed in seeds) if seeds else "  (none provided)"
    return "\n".join(
        [
            "You are generating FEW-SHOT NL->SQL EXEMPLARS for a clinical database "
            "NL->SQL system.",
            "",
            f"Category: {category.id}",
            f"Category intent: {category.intent}",
            "",
            "Style anchors — example questions a clinician might ask (match this "
            "register and specificity, do not copy them verbatim):",
            seed_lines,
            "",
            "SCHEMA (metadata only):",
            "",
            schema_text,
            "",
            "DECLARED JOINS (use ONLY these joins — never invent a join path that "
            "is not listed here):",
            "",
            join_hints_text,
            "",
            f"Produce exactly {count} clinical questions that fit the category "
            "intent above, each paired with a single read-only DuckDB SQL "
            "statement that answers it, using ONLY the declared joins and the "
            "tables/columns given in the schema.",
            "",
            "Respond with STRICT JSON only, shaped exactly:",
            '{"exemplars": [{"question": "...", "sql": "..."}]}',
        ]
    )


def parse_generation_response(text: str) -> list[dict]:
    """Model text -> list of `{question, sql}` candidate dicts.

    Tolerates a fenced ```json block (same regex approach as
    `llm_enrich.parse_enrichment_response`). Fail-open: an unparseable
    response yields `[]`, never an exception. Only entries that are dicts
    with a non-empty `question` AND a non-empty `sql` are kept — anything
    else (missing keys, wrong type, empty string) is silently dropped.
    """
    stripped = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped)
    if fence:
        stripped = fence.group(1).strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        logger.warning("exemplar-gen: unparseable generation response; batch skipped")
        return []

    candidates: list[dict] = []
    raw_exemplars = parsed.get("exemplars", []) if isinstance(parsed, dict) else []
    for entry in raw_exemplars:
        if not isinstance(entry, dict):
            continue
        question = entry.get("question")
        sql = entry.get("sql")
        if not question or not isinstance(question, str):
            continue
        if not sql or not isinstance(sql, str):
            continue
        candidates.append({"question": question, "sql": sql})
    return candidates


async def generate_candidates(
    schema_text: str,
    join_hints_text: str,
    category: Category,
    seeds: list[str],
    count: int,
    llm,
) -> list[dict]:
    """Ask the driving LLM for `count` exemplar candidates for `category` and
    return the parsed `{question, sql}` dicts. Goes through the `call_llm`
    choke point with the `schema-metadata` egress class — this prompt carries
    schema metadata and join hints only, never a sampled cell.

    Fail-open: any parse failure yields `[]`, never an exception. An LLM
    transport failure (network, upstream error) is NOT caught here — callers
    that need per-category fail-open behavior (matching `llm_enrich`'s
    per-chunk `try/except`) should wrap this call themselves.
    """
    from ceiba_nl2sql.generation.llm import call_llm

    prompt = build_generation_prompt(schema_text, join_hints_text, category, seeds, count)
    completion = await call_llm(llm, prompt, "schema-metadata")
    return parse_generation_response(completion.text)


# ── Task 7: orchestrator — generate -> validate -> scrub -> emit ────────────


def _render_schema_text(catalog: dict) -> str:
    """Render `catalog.json`'s `tables` list into the plain-text schema block
    the generation prompt expects (`build_generation_prompt`'s `schema_text`
    arg): one `table <tableId>:` header per table, one `- <name> (<type>)`
    line per column. Best-effort/defensive against missing keys — a
    malformed table or column entry contributes an empty label rather than
    raising, since a bad prompt is still better than a failed build."""
    lines: list[str] = []
    for table in catalog.get("tables", []) or []:
        table_id = table.get("tableId") or table.get("name") or ""
        lines.append(f"table {table_id}:")
        for column in table.get("columns", []) or []:
            column_name = column.get("name", "")
            data_type = column.get("dataType", "")
            lines.append(f"  - {column_name} ({data_type})")
    return "\n".join(lines) if lines else "(no tables)"


def _render_join_hints_text(edges: list[dict]) -> str:
    """Render joingraph edges into the plain-text join-hints block the
    generation prompt expects (`build_generation_prompt`'s `join_hints_text`
    arg): one `<from> -> <to> ON <fromCol>=<toCol>[, ...]` line per edge."""
    lines: list[str] = []
    for edge in edges or []:
        from_table = edge.get("from", "")
        to_table = edge.get("to", "")
        from_columns = edge.get("fromColumns") or []
        to_columns = edge.get("toColumns") or []
        column_pairs = ", ".join(
            f"{from_column}={to_column}"
            for from_column, to_column in zip(from_columns, to_columns)
        )
        lines.append(f"{from_table} -> {to_table} ON {column_pairs}")
    return "\n".join(lines) if lines else "(no declared joins)"


def _build_phi_columns(phi_columns_json: list[dict]) -> dict[str, str]:
    """`phi.json`'s `columns` list -> `output_scrub.scrub_output_sample`'s
    `phi_columns` map. Per that module's docstring (the contract Task 7 must
    honor): reduce each entry's `columnId` (`sourceId.schema.table.column`,
    e.g. `staging.Shared.Patients.Name`) to its LAST TWO dot-segments, BOTH
    lowercased, joined by `.` (`"patients.name"`), keyed to its `phiClass`.
    An entry missing `columnId`/`phiClass`, or whose `columnId` has fewer
    than two dot-segments, is skipped (never crashes the build)."""
    phi_columns: dict[str, str] = {}
    for entry in phi_columns_json or []:
        column_id = entry.get("columnId")
        phi_class = entry.get("phiClass")
        if not column_id or not phi_class:
            continue
        segments = column_id.split(".")
        if len(segments) < 2:
            continue
        bare_table, column_name = segments[-2], segments[-1]
        key = f"{bare_table.lower()}.{column_name.lower()}"
        phi_columns[key] = phi_class
    return phi_columns


def _build_qualify_schema(catalog: dict) -> dict[str, dict[str, str]]:
    """`catalog.json`'s `tables` list -> `output_scrub.scrub_output_sample`'s
    `schema` map (`dict[bare_table_name, dict[column_name, type]]`), for
    sqlglot's `qualify()` to bind unqualified columns. Keyed by each table's
    bare `name` (not the full `tableId`), matching how `join_check`/
    `output_scrub` resolve a SQL table qualifier to a bare table name."""
    schema: dict[str, dict[str, str]] = {}
    for table in catalog.get("tables", []) or []:
        bare_table_name = table.get("name") or ""
        if not bare_table_name:
            continue
        schema[bare_table_name] = {
            column.get("name", ""): column.get("dataType", "")
            for column in table.get("columns", []) or []
            if column.get("name")
        }
    return schema


def _tables_referenced(sql: str, dialect: str = "postgres") -> tuple[str, ...]:
    """Best-effort extraction of the bare table names a candidate's SQL
    references (for `Exemplar.tables`), via the same `find_all(exp.Table)`
    idiom `join_check`/`output_scrub` use for their alias maps. Fails open to
    `()` on any parse error — an exemplar with unresolved `tables` is still
    validated and kept; `tables` is metadata, not a validation gate."""
    try:
        tree = sqlglot.parse_one(sql, dialect=dialect)
    except Exception:
        return ()
    if tree is None:
        return ()
    seen: set[str] = set()
    ordered_names: list[str] = []
    for table in tree.find_all(exp.Table):
        name = table.name
        if name and name not in seen:
            seen.add(name)
            ordered_names.append(name)
    return tuple(ordered_names)


async def run_exemplar_generation(
    catalog: dict,
    edges: list[dict],
    phi_columns_json: list[dict],
    engine,
    llm,
    config: ExemplarGenConfig,
) -> list[Exemplar]:
    """The Task 7 orchestrator: generate -> validate -> scrub -> emit, with
    regeneration, per `config.categories`.

    Per category, repeats up to `config.max_attempts` generate-rounds until
    `config.per_category_count` candidates are KEPT. A candidate is kept iff
    ALL of:
      1. `engine.explain(sql).ok` — the SQL binds against this build's real
         topology (dry-run, zero rows, NL2SQL_SPEC.md §5.5 discipline).
      2. `join_check.join_predicates_are_declared(sql, edges)[0]` — every
         JOIN predicate is backed by a real joingraph edge, never an
         invented column-name-coincidence join.
      3. `engine.execute(sql, ExecuteOptions(max_rows=config.sample_rows))`
         returns at least one row — an exemplar with zero real matches is a
         template, not a validated example.

    A kept candidate's sample rows are scrubbed via
    `output_scrub.scrub_output_sample` (fail-closed PHI redaction) BEFORE
    being carried on the `Exemplar`. Every drop is logged with its reason
    (invented join / explain failure / no rows) so a build's logs explain
    exactly why a category came up short.

    Fails open per-candidate: an `engine.explain`/`engine.execute` exception
    drops just that candidate (logged), never aborts the whole run. A
    category that never reaches `per_category_count` after `max_attempts`
    rounds contributes however many it DID validate (possibly zero) — this
    function never raises for an under-filled category.
    """
    schema_text = _render_schema_text(catalog)
    join_hints_text = _render_join_hints_text(edges)
    phi_columns = _build_phi_columns(phi_columns_json)
    qualify_schema = _build_qualify_schema(catalog)

    all_exemplars: list[Exemplar] = []
    for category in config.categories:
        kept: list[Exemplar] = []
        exemplar_ordinal = 0

        for attempt in range(1, config.max_attempts + 1):
            still_needed = config.per_category_count - len(kept)
            if still_needed <= 0:
                break

            candidates = await generate_candidates(
                schema_text, join_hints_text, category, config.seeds, still_needed, llm
            )
            if not candidates:
                logger.info(
                    "exemplar-gen[%s]: attempt %d/%d produced no candidates",
                    category.id,
                    attempt,
                    config.max_attempts,
                )
                continue

            for candidate in candidates:
                if len(kept) >= config.per_category_count:
                    break
                question = candidate["question"]
                sql = candidate["sql"]

                try:
                    plan = engine.explain(sql)
                except Exception as exc:  # noqa: BLE001 - a bad candidate must never abort the run
                    logger.info(
                        "exemplar-gen[%s]: dropped %r (explain raised: %s)",
                        category.id,
                        question,
                        exc,
                    )
                    continue
                if not getattr(plan, "ok", False):
                    logger.info(
                        "exemplar-gen[%s]: dropped %r (explain failed)",
                        category.id,
                        question,
                    )
                    continue

                join_ok, violations = join_predicates_are_declared(sql, edges)
                if not join_ok:
                    logger.info(
                        "exemplar-gen[%s]: dropped %r (invented join: %s)",
                        category.id,
                        question,
                        violations,
                    )
                    continue

                try:
                    execute_result = engine.execute(
                        sql, ExecuteOptions(max_rows=config.sample_rows)
                    )
                    rows = execute_result.rows
                except Exception as exc:  # noqa: BLE001 - a bad candidate must never abort the run
                    logger.info(
                        "exemplar-gen[%s]: dropped %r (execute raised: %s)",
                        category.id,
                        question,
                        exc,
                    )
                    continue
                if not rows:
                    logger.info(
                        "exemplar-gen[%s]: dropped %r (no rows)",
                        category.id,
                        question,
                    )
                    continue

                scrubbed_sample = scrub_output_sample(
                    sql, rows, phi_columns, qualify_schema, sample_rows=config.sample_rows
                )
                exemplar_ordinal += 1
                kept.append(
                    Exemplar(
                        id=f"gen:{category.id}:{exemplar_ordinal}",
                        question=question,
                        sql=sql,
                        dialect="duckdb",
                        tables=_tables_referenced(sql),
                        tags=(category.id, "difficulty:generated"),
                        validated=True,
                        sample=tuple(scrubbed_sample),
                        category=category.id,
                    )
                )

        if len(kept) < config.per_category_count:
            logger.warning(
                "exemplar-gen[%s]: only %d/%d exemplars validated after %d attempt(s)",
                category.id,
                len(kept),
                config.per_category_count,
                config.max_attempts,
            )
        all_exemplars.extend(kept)

    return all_exemplars
