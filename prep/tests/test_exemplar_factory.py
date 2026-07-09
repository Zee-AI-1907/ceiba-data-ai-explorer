"""test_exemplar_factory.py — P4 exemplar factory (golden corpus -> validated
few-shot exemplars), hermetic: tmp golden dirs + injected fake validators.
"""

from __future__ import annotations

import json
from pathlib import Path

from prep.exemplars import build_exemplars_json, build_golden_exemplars, seed_exemplars


def _write_golden(tmp_path: Path, records: list[dict], name: str = "canonical.jsonl") -> Path:
    golden_dir = tmp_path / "golden"
    golden_dir.mkdir(exist_ok=True)
    (golden_dir / name).write_text(
        "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
    )
    return golden_dir


def _record(golden_id: str = "g_test", question: str = "how many wards", **kw) -> dict:
    base = {
        "id": golden_id,
        "question": question,
        "goldSql": 'SELECT COUNT(*) FROM mock.public."WardRef" LIMIT 1000',
        "expectedTables": ["mock.public.WardRef"],
        "tags": ["aggregate"],
        "targetSource": "mock",
        "difficulty": "easy",
    }
    base.update(kw)
    return base


def test_factory_builds_validated_exemplars(tmp_path: Path):
    golden_dir = _write_golden(tmp_path, [_record()])
    exemplars = build_golden_exemplars(golden_dir, validator=lambda sql: True)
    assert len(exemplars) == 1
    ex = exemplars[0]
    assert ex.id == "ex_golden_g_test"
    assert ex.validated is True
    assert "difficulty:easy" in ex.tags
    assert ex.tables == ("mock.public.WardRef",)


def test_factory_excludes_entries_failing_validation(tmp_path: Path):
    golden_dir = _write_golden(
        tmp_path,
        [
            _record("g_good"),
            _record("g_bad", question="other question", goldSql="SELECT broken FROM nowhere"),
        ],
    )
    exemplars = build_golden_exemplars(golden_dir, validator=lambda sql: "nowhere" not in sql)
    ids = {e.id for e in exemplars}
    assert ids == {"ex_golden_g_good"}


def test_factory_excludes_seed_covered_questions(tmp_path: Path):
    seed_question = seed_exemplars()[0].question
    golden_dir = _write_golden(tmp_path, [_record("g_dup", question=seed_question)])
    exemplars = build_golden_exemplars(
        golden_dir,
        validator=lambda sql: True,
        exclude_questions={e.question for e in seed_exemplars()},
    )
    assert exemplars == []


def test_factory_without_validator_marks_unvalidated(tmp_path: Path):
    golden_dir = _write_golden(tmp_path, [_record()])
    exemplars = build_golden_exemplars(golden_dir)
    assert len(exemplars) == 1
    assert exemplars[0].validated is False


def test_factory_fails_open_on_missing_dir_and_garbage(tmp_path: Path):
    assert build_golden_exemplars(tmp_path / "nope") == []
    golden_dir = tmp_path / "golden"
    golden_dir.mkdir()
    (golden_dir / "bad.jsonl").write_text("not json\n{\"id\": \"x\"}\n", encoding="utf-8")
    assert build_golden_exemplars(golden_dir, validator=lambda sql: True) == []


def test_build_exemplars_json_dedups_extra_against_seeds(tmp_path: Path):
    golden_dir = _write_golden(
        tmp_path,
        [
            _record("g_new", question="brand new question"),
            _record("g_dup", question=seed_exemplars()[0].question),
        ],
    )
    extra = build_golden_exemplars(golden_dir, validator=lambda sql: True)
    doc = build_exemplars_json(include_staging=False, extra=extra)
    questions = [e["question"] for e in doc["exemplars"]]
    assert len(questions) == len(set(q.strip().lower() for q in questions))
    assert "brand new question" in questions


def test_real_golden_corpus_loads_cleanly():
    # The actual eval/golden corpus must parse into exemplars end to end
    # (no validator: shape check only).
    repo_root = Path(__file__).resolve().parents[2]
    exemplars = build_golden_exemplars(repo_root / "eval" / "golden")
    assert len(exemplars) >= 5
    assert all(e.id.startswith("ex_golden_") for e in exemplars)
    assert all(e.sql for e in exemplars)
