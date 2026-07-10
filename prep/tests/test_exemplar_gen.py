"""test_exemplar_gen.py — TDD for exemplar candidate generation (Task 6, the
generation half of the W3 LLM exemplar-generation enrichment stage) and the
Task 7 generate -> validate -> scrub -> emit orchestrator.

Hermetic: StubLlmClient / a FAKE llm+engine only, no network, no DB. Covers
the happy path, fenced-JSON tolerance (reusing
`llm_enrich.parse_enrichment_response`'s regex approach), fail-open on
malformed JSON, dropping entries missing `question`/`sql` (Task 6), and the
orchestrator's structural join gate + regeneration loop (Task 7).
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

from ceiba_nl2sql.generation.llm import LlmCompletion, StubLlmClient, TokenUsage

from prep.enrich.exemplar_gen import generate_candidates, run_exemplar_generation
from prep.enrich.exemplar_gen_config import Category, ExemplarGenConfig
from prep.enrich.output_scrub import SUPPRESSED

_SCHEMA_TEXT = "tableId: src.public.Vitals\ncolumns:\n  - HeartRate (double precision)"
_JOIN_HINTS_TEXT = "src.public.Vitals.PatientId -> src.public.Patients.PatientId"
_CATEGORY = Category(id="vitals", intent="Questions about vital-sign readings over time.")
_SEEDS = ["heart rate > 120 in the last 3 hours"]


def _completion(payload: dict) -> str:
    return json.dumps(payload)


_GOOD_PAYLOAD = {
    "exemplars": [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]
}


def test_generate_candidates_parses_canned_json():
    llm = StubLlmClient([_completion(_GOOD_PAYLOAD)])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]


def test_generate_candidates_tolerates_fenced_json_block():
    fenced = "```json\n" + _completion(_GOOD_PAYLOAD) + "\n```"
    llm = StubLlmClient([fenced])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [
        {"question": "q1", "sql": "SELECT 1"},
        {"question": "q2", "sql": "SELECT 2"},
    ]


def test_generate_candidates_fails_open_on_malformed_json():
    llm = StubLlmClient(["this is not json at all"])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == []


def test_generate_candidates_drops_entries_missing_sql():
    payload = {
        "exemplars": [
            {"question": "q1", "sql": "SELECT 1"},
            {"question": "q2 missing sql"},
        ]
    }
    llm = StubLlmClient([_completion(payload)])

    result = asyncio.run(
        generate_candidates(_SCHEMA_TEXT, _JOIN_HINTS_TEXT, _CATEGORY, _SEEDS, 2, llm)
    )

    assert result == [{"question": "q1", "sql": "SELECT 1"}]


# ── Task 7: run_exemplar_generation — generate -> validate -> scrub -> emit ─


class _FakeEngine:
    """`explain` always binds clean; `execute` always returns the same canned
    row. The loop's actual filtering under test is join-structure (Task 4),
    not engine fussiness — a real engine's EXPLAIN/EXECUTE behavior is
    covered by the engine's own tests, not this orchestrator's."""

    def __init__(self, rows: list[dict]):
        self._rows = rows

    def explain(self, sql: str, **kwargs) -> SimpleNamespace:
        return SimpleNamespace(ok=True)

    def execute(self, sql: str, opts) -> SimpleNamespace:
        return SimpleNamespace(rows=self._rows)


class _FakeLlm:
    """Always returns the same canned `{exemplars: [...]}` payload — used
    both to prove the invented-join candidate is dropped on every round it
    appears in, and to count how many generation rounds were attempted."""

    def __init__(self, payload: dict):
        self._payload = payload
        self.calls = 0

    async def complete(self, prompt: str) -> LlmCompletion:
        self.calls += 1
        return LlmCompletion(
            text=json.dumps(self._payload), usage=TokenUsage(), model="fake-model"
        )


_ORCH_EDGES = [
    {
        "from": "db.public.Visits",
        "fromColumns": ["PatientId"],
        "to": "db.public.Patients",
        "toColumns": ["Id"],
    }
]

_ORCH_CATALOG = {
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
                {
                    "columnId": "db.public.Visits.ExternalId",
                    "name": "ExternalId",
                    "dataType": "text",
                },
            ],
        },
        {
            "tableId": "db.public.Patients",
            "name": "Patients",
            "columns": [
                {"columnId": "db.public.Patients.Id", "name": "Id", "dataType": "integer"},
                {"columnId": "db.public.Patients.Name", "name": "Name", "dataType": "text"},
                {
                    "columnId": "db.public.Patients.ExternalId",
                    "name": "ExternalId",
                    "dataType": "text",
                },
            ],
        },
    ]
}

# Deliberately mixes a non-phi and a direct-identifier column so a kept
# exemplar's `sample` proves scrubbing actually ran, not just that it was
# called: `visit_id` (Visits.Id) must survive, `patient_name` (Patients.Name)
# must come back as `SUPPRESSED`.
_ORCH_PHI_COLUMNS_JSON = [
    {"columnId": "db.public.Visits.Id", "phiClass": "non-phi"},
    {"columnId": "db.public.Visits.PatientId", "phiClass": "non-phi"},
    {"columnId": "db.public.Patients.Name", "phiClass": "direct-identifier"},
]

_DECLARED_JOIN_SQL = (
    'SELECT v."Id" AS visit_id, p."Name" AS patient_name '
    'FROM "Visits" v JOIN "Patients" p ON v."PatientId" = p."Id"'
)
# Both tables happen to have an ExternalId column, but NO joingraph edge
# connects them on it — this join is structurally invented and must be
# dropped by `join_check.join_predicates_are_declared`, not silently kept.
_INVENTED_JOIN_SQL = (
    'SELECT v."Id" AS visit_id, p."Name" AS patient_name '
    'FROM "Visits" v JOIN "Patients" p ON v."ExternalId" = p."ExternalId"'
)

_TWO_CANDIDATE_PAYLOAD = {
    "exemplars": [
        {"question": "declared-join question", "sql": _DECLARED_JOIN_SQL},
        {"question": "invented-join question", "sql": _INVENTED_JOIN_SQL},
    ]
}


def _orch_config(*, per_category_count: int, max_attempts: int = 3) -> ExemplarGenConfig:
    category = Category(id="visits", intent="Questions relating visits to patients.")
    return ExemplarGenConfig(
        model="fake-model",
        per_category_count=per_category_count,
        max_attempts=max_attempts,
        sample_rows=5,
        categories=[category],
        seeds=["a style-anchor seed question"],
    )


def test_run_exemplar_generation_drops_invented_join_keeps_declared_join_scrubbed():
    llm = _FakeLlm(_TWO_CANDIDATE_PAYLOAD)
    engine = _FakeEngine(rows=[{"visit_id": 42, "patient_name": "Jane Doe"}])
    config = _orch_config(per_category_count=1)

    exemplars = asyncio.run(
        run_exemplar_generation(
            _ORCH_CATALOG, _ORCH_EDGES, _ORCH_PHI_COLUMNS_JSON, engine, llm, config
        )
    )

    # (1) the invented-join candidate never appears in the output at all.
    assert all(ex.sql != _INVENTED_JOIN_SQL for ex in exemplars)

    # (2) the declared-join candidate IS kept, with `category` set and a
    # PHI-scrubbed `sample` (non-phi cell survives, direct-identifier cell
    # is replaced by the SUPPRESSED sentinel).
    assert len(exemplars) == 1
    kept = exemplars[0]
    assert kept.sql == _DECLARED_JOIN_SQL
    assert kept.category == "visits"
    assert kept.validated is True
    assert kept.sample == ({"visit_id": 42, "patient_name": SUPPRESSED},)


def test_run_exemplar_generation_regenerates_when_category_falls_short():
    llm = _FakeLlm(_TWO_CANDIDATE_PAYLOAD)
    engine = _FakeEngine(rows=[{"visit_id": 42, "patient_name": "Jane Doe"}])
    # Only ONE of the two candidates returned per round is ever keepable (the
    # invented-join one drops on every round), so asking for 2 per category
    # forces the orchestrator to attempt a second generate round.
    config = _orch_config(per_category_count=2, max_attempts=3)

    exemplars = asyncio.run(
        run_exemplar_generation(
            _ORCH_CATALOG, _ORCH_EDGES, _ORCH_PHI_COLUMNS_JSON, engine, llm, config
        )
    )

    # (3) regeneration happened: more than one generate round was attempted.
    assert llm.calls > 1
    assert len(exemplars) == 2
    assert all(ex.sql == _DECLARED_JOIN_SQL for ex in exemplars)
    assert len({ex.id for ex in exemplars}) == 2  # unique ids across rounds


def test_run_exemplar_generation_gives_up_after_max_attempts_without_raising():
    # An LLM that returns ONLY the invented-join candidate can never satisfy
    # the category — the orchestrator must exhaust max_attempts and return
    # whatever it validated (zero, here) rather than raise or loop forever.
    payload = {"exemplars": [{"question": "invented-join only", "sql": _INVENTED_JOIN_SQL}]}
    llm = _FakeLlm(payload)
    engine = _FakeEngine(rows=[{"visit_id": 42, "patient_name": "Jane Doe"}])
    config = _orch_config(per_category_count=1, max_attempts=2)

    exemplars = asyncio.run(
        run_exemplar_generation(
            _ORCH_CATALOG, _ORCH_EDGES, _ORCH_PHI_COLUMNS_JSON, engine, llm, config
        )
    )

    assert exemplars == []
    assert llm.calls == 2  # exhausted max_attempts, never more
