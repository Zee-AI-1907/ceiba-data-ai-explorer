"""llm_enrich.py — P3: one-time LLM enrichment pass at prep build time.

Prep is otherwise purely heuristic: `grain` is a template guess, `unit` is
None everywhere pg_description/glossary didn't supply one, and descriptions
exist only where a DBA wrote a comment. This optional stage (--llm-enrich)
sends SCHEMA METADATA ONLY — table/column names, types, declared values, FK
shapes; never a sampled cell — to the driving LLM once per bundle build and
folds the answers into catalog.json. The cost is cents once per build; every
future query benefits with zero added runtime latency or tokens.

Egress class: this prompt is `schema-metadata` by construction (the always-
allowed class in ceiba_nl2sql.compliance.egress) — the SPEC §2.5 rule
"metadata introspection of the real schema is allowed" extends to sending
that same metadata for annotation.

Application discipline (anti-hallucination):
  - fills ONLY empty slots — a pg_description comment or curator-seeded
    value is never overwritten;
  - applies only to table/column ids that exist in the catalog (unknown ids
    from the model are dropped);
  - strings are length-capped; units must be short (<= 16 chars) and the
    model is instructed to emit null unless confident;
  - everything applied is recorded in the returned report (audit trail,
    surfaced in BUILD_REPORT.json).
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

logger = logging.getLogger("prep.enrich.llm_enrich")

MAX_DESCRIPTION_CHARS = 300
MAX_UNIT_CHARS = 16
TABLES_PER_CALL = 6


@dataclass
class LlmEnrichmentReport:
    """Audit record of everything the pass applied (and spent)."""

    tables_enriched: int = 0
    columns_enriched: int = 0
    units_filled: int = 0
    grains_filled: int = 0
    llm_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    applied: list[dict] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "tablesEnriched": self.tables_enriched,
            "columnsEnriched": self.columns_enriched,
            "unitsFilled": self.units_filled,
            "grainsFilled": self.grains_filled,
            "llmCalls": self.llm_calls,
            "promptTokens": self.prompt_tokens,
            "completionTokens": self.completion_tokens,
            "applied": self.applied,
        }


def build_enrichment_prompt(tables: list[dict]) -> str:
    """One annotation request for a chunk of catalog tables. Schema metadata
    only: names, types, declared values, PK/time flags. The model must return
    strict JSON keyed by the EXACT tableId/column names given.
    """
    table_blocks: list[str] = []
    for table in tables:
        column_lines = []
        for col in table.get("columns", []):
            parts = [f"{col['name']} ({col['dataType']}"]
            if col.get("isPrimaryKey"):
                parts.append(", PK")
            if col.get("isTimeColumn"):
                parts.append(", time")
            parts.append(")")
            if col.get("allowedValues"):
                parts.append(f" values={col['allowedValues'][:12]}")
            column_lines.append("  - " + "".join(parts))
        table_blocks.append(f"tableId: {table['tableId']}\ncolumns:\n" + "\n".join(column_lines))

    return "\n".join(
        [
            "You are annotating a CLINICAL DATABASE SCHEMA for an NL->SQL system.",
            "For each table below, provide:",
            '- "description": one sentence, what a row represents and what the table is for.',
            '- "grain": a sentence of the form "one row per <entity>".',
            '- per column: "description" (short, only when the name is not self-explanatory,'
            " else null) and \"unit\" (the measurement unit like 'bpm', 'mmHg', '°C', ONLY"
            " when you are confident from the name; else null — NEVER guess a unit).",
            "",
            "Respond with STRICT JSON only, shaped exactly:",
            '{"tables": [{"tableId": "<exactly as given>", "description": "...", "grain": "...",',
            ' "columns": [{"name": "<exactly as given>", "description": "..." | null, "unit": "..." | null}]}]}',
            "",
            "SCHEMA (metadata only):",
            "",
            "\n\n".join(table_blocks),
        ]
    )


def parse_enrichment_response(text: str) -> dict[str, dict]:
    """Model text -> {tableId: {description, grain, columns: {name: {...}}}}.
    Tolerates a fenced JSON block. Fail-open: unparseable -> {}.
    """
    stripped = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped)
    if fence:
        stripped = fence.group(1).strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        logger.warning("llm-enrich: unparseable enrichment response; chunk skipped")
        return {}
    result: dict[str, dict] = {}
    for entry in parsed.get("tables", []) if isinstance(parsed, dict) else []:
        if not isinstance(entry, dict) or not entry.get("tableId"):
            continue
        columns = {}
        for col in entry.get("columns", []) or []:
            if isinstance(col, dict) and col.get("name"):
                columns[col["name"]] = {
                    "description": col.get("description"),
                    "unit": col.get("unit"),
                }
        result[entry["tableId"]] = {
            "description": entry.get("description"),
            "grain": entry.get("grain"),
            "columns": columns,
        }
    return result


def _clean_text(value, max_chars: int) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned:
        return None
    return cleaned[:max_chars]


def apply_enrichment(catalog: dict, parsed: dict[str, dict], report: LlmEnrichmentReport) -> None:
    """Fold parsed annotations into the catalog IN PLACE — empty slots only,
    known ids only, length-capped. Records each application in the report.
    """
    for table in catalog.get("tables", []):
        entry = parsed.get(table["tableId"])
        if not entry:
            continue
        description = _clean_text(entry.get("description"), MAX_DESCRIPTION_CHARS)
        if description and not table.get("description"):
            table["description"] = description
            report.tables_enriched += 1
            report.applied.append({"tableId": table["tableId"], "field": "description"})
        grain = _clean_text(entry.get("grain"), MAX_DESCRIPTION_CHARS)
        if grain and not table.get("grain"):
            table["grain"] = grain
            report.grains_filled += 1
            report.applied.append({"tableId": table["tableId"], "field": "grain"})
        column_entries = entry.get("columns", {})
        for col in table.get("columns", []):
            col_entry = column_entries.get(col["name"])
            if not col_entry:
                continue
            col_description = _clean_text(col_entry.get("description"), MAX_DESCRIPTION_CHARS)
            if col_description and not col.get("description"):
                col["description"] = col_description
                report.columns_enriched += 1
                report.applied.append({"columnId": col["columnId"], "field": "description"})
            unit = _clean_text(col_entry.get("unit"), MAX_UNIT_CHARS)
            if unit and not col.get("unit"):
                col["unit"] = unit
                report.units_filled += 1
                report.applied.append({"columnId": col["columnId"], "field": "unit"})


async def enrich_catalog_with_llm(catalog: dict, llm, *, tables_per_call: int = TABLES_PER_CALL) -> LlmEnrichmentReport:
    """Run the pass over the whole catalog in chunks. `llm` is any
    ceiba_nl2sql LlmClient; every call goes through the `call_llm` choke
    point with the schema-metadata egress class. A failed chunk is skipped
    (fail-open) — enrichment must never fail a build.
    """
    from ceiba_nl2sql.generation.llm import call_llm

    report = LlmEnrichmentReport()
    tables = catalog.get("tables", [])
    for start in range(0, len(tables), tables_per_call):
        chunk = tables[start : start + tables_per_call]
        prompt = build_enrichment_prompt(chunk)
        try:
            completion = await call_llm(llm, prompt, "schema-metadata")
        except Exception as exc:  # noqa: BLE001 - enrichment is best-effort
            logger.warning("llm-enrich: chunk %d failed: %s", start // tables_per_call, exc)
            continue
        report.llm_calls += 1
        report.prompt_tokens += completion.usage.prompt_tokens
        report.completion_tokens += completion.usage.completion_tokens
        apply_enrichment(catalog, parse_enrichment_response(completion.text), report)
    return report
