"""test_eval.py — reproduces eval/__tests__/eval.test.ts's assertions against
the Python eval harness (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4.1, §5 Phase 5,
§9 Phase 5 DoD "Python eval reproduces TS eval scores on fixture bundle").
"""

from __future__ import annotations

import dataclasses
import json
import os

import pytest

from ceiba_nl2sql_eval.run_eval import (
    DEFAULT_FIXTURE_BUNDLE_DIR,
    RunEvalOptions,
    load_adversarial_set,
    load_golden_set,
    run_adversarial,
    run_eval,
)


class TestGoldenSetSynthetic:
    async def test_loads_full_golden_set_with_expected_tags(self):
        golden = load_golden_set()
        assert len(golden) >= 10

        all_tags = {t for g in golden for t in g.tags}
        assert "temporal" in all_tags
        assert "aggregate" in all_tags
        assert "join" in all_tags
        assert "multi-db" in all_tags

    async def test_canonical_questions_execute_cleanly(self):
        golden = load_golden_set()
        canonical = [g for g in golden if g.id in ("g_hr_over_120_last_3h", "g_patients_admitted_yesterday")]
        assert len(canonical) == 2

        result = await run_eval(canonical)

        assert result.mode == "synthetic"
        assert len(result.report.bundle_version) > 0
        assert len(result.report.driving_model) > 0

        for item in result.items:
            assert item.error is None, f'question "{item.question}" errored: {item.error}'
            assert item.score.guard_passes is True, f'guard_passes for "{item.question}"'
            assert item.score.parses is True, f'parses for "{item.question}"'
            assert item.score.cardinality_bounded is True, f'cardinality_bounded for "{item.question}"'
            assert item.score.executes is True, f'executes for "{item.question}"'
            assert item.score.references_real_tables is True, f'references_real_tables for "{item.question}"'
            assert item.usage is not None

    async def test_full_golden_set_produces_well_formed_report(self):
        golden = load_golden_set()
        result = await run_eval(golden)

        assert result.mode == "synthetic"
        assert len(result.items) == len(golden)
        assert result.report.overall.guard_pass_rate > 0
        assert result.report.overall.parse_rate > 0
        assert result.report.overall.execution_accuracy > 0
        assert result.report.overall.valid_table_rate == 1
        assert result.report.latency_ms_p50 >= 0
        assert result.report.token_cost_total > 0
        assert len(result.report.per_tag) > 0

        # NEW (Phase 5 cost deliverable): every scored item burns (synthetic)
        # tokens through generate_sql's usage metering.
        assert result.report.cost.total_llm_calls >= len(result.items)

        guard_passing_items = [i for i in result.items if i.score.guard_passes]
        assert len(guard_passing_items) == len(result.items)
        for item in guard_passing_items:
            assert item.score.executes is True, f'executes for "{item.question}" (sql: {item.sql})'
            assert item.usage is not None

    async def test_cross_source_join_question_validates(self):
        golden = load_golden_set()
        cross_source = next((g for g in golden if g.id == "g_patients_by_hospital_region"), None)
        assert cross_source is not None

        result = await run_eval([cross_source])
        assert len(result.items) == 1
        assert result.items[0].score.guard_passes is True
        assert result.items[0].score.executes is True

    async def test_resolves_default_fixture_bundle_dir(self):
        assert str(DEFAULT_FIXTURE_BUNDLE_DIR).endswith(os.path.join("fixtures", "bundles", "mock-v1"))
        assert DEFAULT_FIXTURE_BUNDLE_DIR.is_dir()


class TestAdversarialSet:
    async def test_loads_adversarial_set_with_injection_tag(self):
        adversarial = load_adversarial_set()
        assert len(adversarial) >= 5
        all_tags = {t for a in adversarial for t in a.tags}
        assert "injection" in all_tags

    async def test_every_adversarial_item_is_rejected_hard_failure_parity(self):
        adversarial = load_adversarial_set()
        results = await run_adversarial(adversarial)

        assert len(results) == len(adversarial)
        for result in results:
            assert result.score.guard_passes is False, f'guard_passes for adversarial "{result.question}"'
            # Hard failure: a rejected candidate is NEVER explained or
            # executed, so every other dimension must also read false/None.
            assert result.score.parses is False, f'parses for adversarial "{result.question}"'
            assert result.score.cardinality_bounded is False, f'cardinality_bounded for adversarial "{result.question}"'
            assert result.score.executes is False, f'executes for adversarial "{result.question}"'
            assert result.score.result_match is None, f'result_match for adversarial "{result.question}"'


class TestGatedStagingStaysOffByDefault:
    async def test_falls_back_to_synthetic_without_allow_gated_staging_and_staging_dsn(self, monkeypatch):
        golden = load_golden_set()
        canonical = [g for g in golden if g.id == "g_hr_over_120_last_3h"]

        monkeypatch.delenv("STAGING_DSN", raising=False)
        result = await run_eval(canonical, RunEvalOptions(mode="gated-staging"))
        assert result.mode == "synthetic"


class TestReportSerialization:
    async def test_eval_report_json_round_trips(self):
        golden = load_golden_set()
        canonical = [g for g in golden if g.id == "g_hr_over_120_last_3h"]
        result = await run_eval(canonical)

        report_dict = dataclasses.asdict(result.report)
        # Must be JSON-serializable with no special handling.
        raw = json.dumps(report_dict)
        round_tripped = json.loads(raw)
        assert round_tripped["bundle_version"] == result.report.bundle_version
        assert round_tripped["cost"]["total_estimated_cost_usd"] == result.report.cost.total_estimated_cost_usd

    async def test_full_golden_set_cost_summary_is_non_zero(self):
        golden = load_golden_set()
        result = await run_eval(golden)

        assert result.report.cost.total_estimated_cost_usd > 0
        assert result.report.cost.mean_cost_usd_per_question > 0
        assert result.report.cost.priced_question_count == len(result.items)
        assert result.report.cost.model == "gpt-4o-mini"
