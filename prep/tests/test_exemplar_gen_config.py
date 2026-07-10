"""test_exemplar_gen_config.py — TDD for the exemplar_gen.yaml config loader.

Covers: `load_exemplar_gen_config` parses a minimal YAML (1 category, 1 seed)
into the frozen `ExemplarGenConfig`/`Category` dataclasses with the documented
defaults, and raises a clear `ConfigError` when the required `categories` key
is missing. See docs/superpowers/specs/2026-07-10-exemplar-gen-and-prompt-
steering-benchmark-design.md, "W3 -> Configuration" for the source-of-truth YAML.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from prep.enrich.exemplar_gen_config import (
    Category,
    ConfigError,
    ExemplarGenConfig,
    load_exemplar_gen_config,
)


def _write(tmp_path: Path, text: str) -> Path:
    path = tmp_path / "exemplar_gen.yaml"
    path.write_text(textwrap.dedent(text), encoding="utf-8")
    return path


def test_parses_minimal_yaml_with_one_category_and_one_seed(tmp_path):
    path = _write(
        tmp_path,
        """
        generation:
          model: gpt-5.6-terra
          perCategoryCount: 3
          maxAttemptsPerExemplar: 3
          sampleRows: 5
        categories:
          - id: admissions
            intent: "When patients were admitted; admissions over time windows."
        seeds:
          - "can you bring me patients admitted in the last day?"
        """,
    )

    config = load_exemplar_gen_config(path)

    assert isinstance(config, ExemplarGenConfig)
    assert config.model == "gpt-5.6-terra"
    assert config.per_category_count == 3
    assert config.max_attempts == 3
    assert config.sample_rows == 5
    assert config.categories == [
        Category(
            id="admissions",
            intent="When patients were admitted; admissions over time windows.",
        )
    ]
    assert config.seeds == ["can you bring me patients admitted in the last day?"]


def test_defaults_apply_when_generation_keys_are_absent(tmp_path):
    path = _write(
        tmp_path,
        """
        categories:
          - id: admissions
            intent: "When patients were admitted."
        seeds:
          - "a seed question"
        """,
    )

    config = load_exemplar_gen_config(path)

    assert config.model == "gpt-5.6-terra"
    assert config.per_category_count == 3
    assert config.max_attempts == 3
    assert config.sample_rows == 5


def test_missing_categories_key_raises_clear_config_error(tmp_path):
    path = _write(
        tmp_path,
        """
        generation:
          model: gpt-5.6-terra
        seeds:
          - "a seed question"
        """,
    )

    with pytest.raises(ConfigError, match="categories"):
        load_exemplar_gen_config(path)


def test_missing_file_raises_config_error(tmp_path):
    missing = tmp_path / "does_not_exist.yaml"

    with pytest.raises(ConfigError, match="not found"):
        load_exemplar_gen_config(missing)


def test_category_is_frozen_and_comparable():
    a = Category(id="admissions", intent="x")
    b = Category(id="admissions", intent="x")
    assert a == b
    with pytest.raises(Exception):
        a.id = "other"  # type: ignore[misc]
