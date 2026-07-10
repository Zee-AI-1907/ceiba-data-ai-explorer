"""test_cli_generate_exemplars.py — TDD for Task 8: wiring
`--generate-exemplars` into `ceiba-nl2sql-prep build` (the W3 LLM
exemplar-generation stage's build-time entry point, `cli.py`'s
`_run_exemplar_generation_stage` helper called from
`_run_build_pipeline_p3b`'s P4 exemplar block).

Hermetic: a FAKE engine (`.explain`/`.execute`/`.dialect`, mirroring
`test_exemplar_gen.py`'s `_FakeEngine`) + `ceiba_nl2sql.generation.llm.
build_llm_client` monkeypatched to hand back a `StubLlmClient` queued with
one declared-join candidate — no network, no real DB, no OpenAI call. Covers:

1. `build_arg_parser()`'s `--generate-exemplars` flag (default False, True
   when passed) — mirrors `--llm-enrich`'s own flag test.
2. `_run_exemplar_generation_stage`: given the fakes above, returns >=1
   validated `Exemplar` AND persists them to the JSONL `out_path`, one JSON
   object per line matching each `Exemplar.to_json()` — proving the
   generated exemplars would reach `build_exemplar_document`/`exemplars.json`
   via the `extra=golden_exemplars + generated_exemplars` fold in
   `_run_build_pipeline_p3b`.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import ceiba_nl2sql.generation.llm as llm_module
from ceiba_nl2sql.generation.llm import StubLlmClient

from prep.cli import _run_exemplar_generation_stage, build_arg_parser
from prep.exemplars import Exemplar


# ── Test 1: flag parsing ─────────────────────────────────────────────────────


def test_build_parser_generate_exemplars_defaults_false():
    parser = build_arg_parser()
    args = parser.parse_args(["build", "--config", "some.yaml"])
    assert args.generate_exemplars is False


def test_build_parser_generate_exemplars_true_when_passed():
    parser = build_arg_parser()
    args = parser.parse_args(["build", "--config", "some.yaml", "--generate-exemplars"])
    assert args.generate_exemplars is True


# ── Test 2: the extracted generation+persist helper ─────────────────────────


class _FakeEngine:
    """Same shape as `test_exemplar_gen.py`'s `_FakeEngine`: `explain` always
    binds clean, `execute` always returns the same canned non-empty row set —
    the orchestrator's real filtering under test elsewhere is join-structure,
    not engine fussiness."""

    def __init__(self, rows: list[dict], dialect: str = "duckdb"):
        self._rows = rows
        self._dialect = dialect

    def dialect(self) -> str:
        return self._dialect

    def explain(self, sql: str, **kwargs) -> SimpleNamespace:
        return SimpleNamespace(ok=True)

    def execute(self, sql: str, opts) -> SimpleNamespace:
        return SimpleNamespace(rows=self._rows)


_EDGES = [
    {
        "from": "db.public.Visits",
        "fromColumns": ["PatientId"],
        "to": "db.public.Patients",
        "toColumns": ["Id"],
    }
]

_CATALOG = {
    "tables": [
        {
            "tableId": "db.public.Visits",
            "name": "Visits",
            "columns": [
                {"columnId": "db.public.Visits.Id", "name": "Id", "dataType": "integer"},
                {
                    "columnId": "db.public.Visits.PatientId",
                    "name": "PatientId",
                    "dataType": "integer",
                },
            ],
        },
        {
            "tableId": "db.public.Patients",
            "name": "Patients",
            "columns": [
                {"columnId": "db.public.Patients.Id", "name": "Id", "dataType": "integer"},
                {"columnId": "db.public.Patients.Name", "name": "Name", "dataType": "text"},
            ],
        },
    ]
}

_PHI_COLUMNS_JSON = [
    {"columnId": "db.public.Visits.Id", "phiClass": "non-phi"},
    {"columnId": "db.public.Visits.PatientId", "phiClass": "non-phi"},
    {"columnId": "db.public.Patients.Name", "phiClass": "direct-identifier"},
]

_DECLARED_JOIN_SQL = (
    'SELECT v."Id" AS visit_id, p."Name" AS patient_name '
    'FROM "Visits" v JOIN "Patients" p ON v."PatientId" = p."Id"'
)

_ONE_CANDIDATE_PAYLOAD = {
    "exemplars": [{"question": "declared-join question", "sql": _DECLARED_JOIN_SQL}]
}


def _write_config(tmp_path: Path) -> Path:
    config_path = tmp_path / "exemplar_gen.yaml"
    config_path.write_text(
        "\n".join(
            [
                "generation:",
                "  model: fake-model",
                "  perCategoryCount: 1",
                "  maxAttemptsPerExemplar: 1",
                "  sampleRows: 5",
                "categories:",
                "  - id: visits",
                "    intent: Questions relating visits to patients.",
                "seeds:",
                "  - a style-anchor seed question",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return config_path


def test_run_exemplar_generation_stage_returns_exemplars_and_persists_jsonl(tmp_path, monkeypatch):
    stub_llm = StubLlmClient([json.dumps(_ONE_CANDIDATE_PAYLOAD)])

    def _fake_build_llm_client(*, api_key, model, use_structured_output):
        # Proves the required-by-contract flag was threaded through — the
        # generation prompt has its own {exemplars:[...]} JSON contract, so
        # forcing R3's {sql,description} response_format would silently
        # yield zero exemplars (same defect class as the P3 --llm-enrich fix).
        assert use_structured_output is False
        assert api_key == "fake-api-key"
        assert model == "fake-model"
        return stub_llm

    monkeypatch.setattr(llm_module, "build_llm_client", _fake_build_llm_client)

    engine = _FakeEngine(rows=[{"visit_id": 42, "patient_name": "Jane Doe"}])
    config_path = _write_config(tmp_path)
    out_path = tmp_path / "exemplars.generated.jsonl"

    exemplars = _run_exemplar_generation_stage(
        catalog=_CATALOG,
        joingraph={"edges": _EDGES},
        phi={"columns": _PHI_COLUMNS_JSON},
        engine=engine,
        config_path=config_path,
        api_key="fake-api-key",
        out_path=out_path,
    )

    # >=1 validated Exemplar reaches the caller (folded into `extra=` and
    # thus into build_exemplars_json -> build_exemplar_document downstream).
    assert len(exemplars) == 1
    assert all(isinstance(e, Exemplar) for e in exemplars)
    kept = exemplars[0]
    assert kept.sql == _DECLARED_JOIN_SQL
    assert kept.validated is True
    assert kept.category == "visits"

    # Persisted as one JSON line per exemplar, matching to_json() exactly.
    assert out_path.is_file()
    lines = out_path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0]) == kept.to_json()


def test_run_exemplar_generation_stage_overwrites_out_path_each_call(tmp_path, monkeypatch):
    # A previous build's stale generated exemplars must not linger if this
    # build's category comes up empty (config asks for a category with no
    # keepable candidate) — the file always reflects THIS run.
    monkeypatch.setattr(
        llm_module,
        "build_llm_client",
        lambda *, api_key, model, use_structured_output: StubLlmClient(
            [json.dumps({"exemplars": []})]
        ),
    )

    engine = _FakeEngine(rows=[{"visit_id": 42, "patient_name": "Jane Doe"}])
    config_path = _write_config(tmp_path)
    out_path = tmp_path / "exemplars.generated.jsonl"
    out_path.write_text('{"stale": true}\n', encoding="utf-8")

    exemplars = _run_exemplar_generation_stage(
        catalog=_CATALOG,
        joingraph={"edges": _EDGES},
        phi={"columns": _PHI_COLUMNS_JSON},
        engine=engine,
        config_path=config_path,
        api_key="fake-api-key",
        out_path=out_path,
    )

    assert exemplars == []
    assert out_path.read_text(encoding="utf-8") == ""
