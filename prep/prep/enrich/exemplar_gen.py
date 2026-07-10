"""exemplar_gen.py — W3: LLM exemplar-generation enrichment, generation half.

Prompts the driving LLM with the rendered schema, the declared join hints, a
`Category` (id + intent) from `exemplar_gen_config`, and the curator-seeded
questions as style anchors; parses the response into `{question, sql}`
candidate dicts. Validation, PHI scrubbing, and embedding happen in later
tasks — this module ONLY generates and parses candidates.

Egress class: `schema-metadata` (SPEC §2.5's always-allowed class) — the
prompt carries schema text and join hints only, never a sampled cell, same
discipline as `llm_enrich.py`'s enrichment pass.

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

from prep.enrich.exemplar_gen_config import Category

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
