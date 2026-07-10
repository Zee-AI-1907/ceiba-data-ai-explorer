"""exemplar_gen_config.py — config/exemplar_gen.yaml loader + validation.

Loads the configuration for the LLM exemplar-generation enrichment stage
(SPEC "W3 -> LLM exemplar-generation enrichment"): the one-time generation
model, per-category/attempt/sample-row targets, the exemplar-category
taxonomy, and the user-provided seed questions.

Mirrors the style of `prep/config.py` (frozen dataclasses, `ConfigError` on
any structural/semantic violation, a `_require` helper for mandatory keys,
`yaml.safe_load` with camelCase YAML keys mapped to snake_case fields).
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml


class ConfigError(ValueError):
    """Raised for any structurally or semantically invalid exemplar_gen.yaml."""


# ── defaults (SPEC "W3 -> Configuration") ──────────────────────────────────

DEFAULT_MODEL = "gpt-5.6-terra"
DEFAULT_PER_CATEGORY_COUNT = 3
DEFAULT_MAX_ATTEMPTS = 3
DEFAULT_SAMPLE_ROWS = 5


# ── dataclasses ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Category:
    id: str
    intent: str


@dataclass(frozen=True)
class ExemplarGenConfig:
    model: str
    per_category_count: int
    max_attempts: int
    sample_rows: int
    categories: list[Category]
    seeds: list[str]


# ── loader ──────────────────────────────────────────────────────────────────


def _require(mapping: dict, key: str, ctx: str) -> object:
    if key not in mapping or mapping[key] is None:
        raise ConfigError(f"{ctx}: missing required key {key!r}")
    return mapping[key]


def _parse_generation(raw: dict | None) -> tuple[str, int, int, int]:
    raw = raw or {}
    model = str(raw.get("model", DEFAULT_MODEL))
    per_category_count = int(raw.get("perCategoryCount", DEFAULT_PER_CATEGORY_COUNT))
    max_attempts = int(raw.get("maxAttemptsPerExemplar", DEFAULT_MAX_ATTEMPTS))
    sample_rows = int(raw.get("sampleRows", DEFAULT_SAMPLE_ROWS))
    return model, per_category_count, max_attempts, sample_rows


def _parse_category(raw: dict, ctx: str) -> Category:
    category_id = str(_require(raw, "id", ctx))
    intent = str(_require(raw, "intent", f"{ctx}[{category_id}]"))
    return Category(id=category_id, intent=intent)


def load_exemplar_gen_config(path: str | Path) -> ExemplarGenConfig:
    """Load and validate config/exemplar_gen.yaml.

    Raises ConfigError on a missing file, a non-mapping top level, a missing
    or empty `categories` list, or a malformed category entry. `generation.*`
    keys and `seeds` are optional — sensible defaults apply (see the DEFAULT_*
    constants above), and an absent `seeds` list yields an empty list.
    """
    path = Path(path)
    if not path.is_file():
        raise ConfigError(f"config file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top-level YAML must be a mapping")

    model, per_category_count, max_attempts, sample_rows = _parse_generation(
        raw.get("generation")
    )

    raw_categories = _require(raw, "categories", "<root>")
    if not isinstance(raw_categories, list) or not raw_categories:
        raise ConfigError("categories must be a non-empty list")
    categories = [_parse_category(c, "categories") for c in raw_categories]

    seeds = [str(s) for s in raw.get("seeds") or []]

    return ExemplarGenConfig(
        model=model,
        per_category_count=per_category_count,
        max_attempts=max_attempts,
        sample_rows=sample_rows,
        categories=categories,
        seeds=seeds,
    )
