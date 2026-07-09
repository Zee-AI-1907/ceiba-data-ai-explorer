"""test_prompt.py — ceiba_nl2sql.generation.prompt (Fix A JOIN GRAPH + Fix D
SEMANTIC HINTS + Fix B source-qualified refs). NEW test file (none existed
covering prompt.py's rendering functions before this fix).

Hermetic: builds `RenderedTable`/`JoinHint`/`JoinPath`/`GlossaryHit` fixtures
directly (no bundle/retriever needed) so these are pure unit tests of the
rendering functions.
"""

from __future__ import annotations

from ceiba_nl2sql.engine.base import EngineCapabilities
from ceiba_nl2sql.generation.prompt import (
    _render_join_graph,
    _render_semantic_hints,
    _source_qualified_ref,
    assemble_prompt,
)
from ceiba_nl2sql.retrieval.retriever import (
    CardinalityWarning,
    GlossaryHit,
    JoinHint,
    JoinPath,
    RenderedColumn,
    RenderedTable,
    TimeVia,
    build_cardinality_warning_message,
)

CAPS = EngineCapabilities(
    identifier_quote='"', interval_syntax="postgres", supports_cross_catalog_join=True, supports_explain=True
)


def _measurements_table(role: str = "primary") -> RenderedTable:
    return RenderedTable(
        table_id="mock.public.MeasurementsMock",
        quoted_ref='"public"."MeasurementsMock"',
        grain="one row per MeasurementsMock reading",
        columns=[
            RenderedColumn(name="Id", quoted_name='"Id"', data_type="BIGINT", unit=None, is_time_column=False, is_foreign_key_or_primary_key=True),
            RenderedColumn(name="DeviceId", quoted_name='"DeviceId"', data_type="INTEGER", unit=None, is_time_column=False, is_foreign_key_or_primary_key=True),
            RenderedColumn(name="Value", quoted_name='"Value"', data_type="DOUBLE PRECISION", unit=None, is_time_column=False),
            RenderedColumn(name="RecordedAt", quoted_name='"RecordedAt"', data_type="TIMESTAMP", unit=None, is_time_column=True, is_indexed=True),
        ],
        approx_row_count=483,
        is_large_time_series=True,
        required_time_column='"RecordedAt"',
        role=role,
    )


def _patients_table(role: str = "primary") -> RenderedTable:
    return RenderedTable(
        table_id="mock.public.PatientMock",
        quoted_ref='"public"."PatientMock"',
        grain="one row per PatientMock record",
        columns=[
            RenderedColumn(name="patientRef", quoted_name='"patientRef"', data_type="INTEGER", unit=None, is_time_column=False, is_foreign_key_or_primary_key=True),
        ],
        approx_row_count=40,
        is_large_time_series=False,
        role=role,
    )


def _monitors_bridge_table() -> RenderedTable:
    return RenderedTable(
        table_id="staging.Shared.Monitors",
        quoted_ref='"Shared"."Monitors"',
        grain="one row per Monitors record",
        columns=[
            RenderedColumn(name="Id", quoted_name='"Id"', data_type="INTEGER", unit=None, is_time_column=False, is_foreign_key_or_primary_key=True),
            RenderedColumn(name="AcceptanceId", quoted_name='"AcceptanceId"', data_type="INTEGER", unit=None, is_time_column=False, is_foreign_key_or_primary_key=True),
        ],
        approx_row_count=1000,
        is_large_time_series=False,
        role="bridge",
    )


# ── Fix B: source-qualified refs ────────────────────────────────────────────


def test_source_qualified_ref_prefixes_source_id():
    table = _measurements_table()
    assert _source_qualified_ref(table) == 'mock."public"."MeasurementsMock"'


def test_assemble_prompt_table_header_includes_source_qualified_ref():
    prompt = assemble_prompt([_measurements_table()], [], "heart rate", CAPS, "duckdb")
    assert 'mock."public"."MeasurementsMock"' in prompt


# ── Fix A: JOIN GRAPH rendering ─────────────────────────────────────────────


def test_render_join_graph_edge_format_exact():
    hint = JoinHint(
        from_ref='"public"."MeasurementsMock"',
        from_columns=["patientRef"],
        to_ref='"public"."PatientMock"',
        to_columns=["patientRef"],
        join_cardinality="many-to-one",
        cross_source=False,
    )
    rendered = _render_join_graph([hint], [], [_measurements_table(), _patients_table()])
    assert 'mock."public"."MeasurementsMock"."patientRef" = mock."public"."PatientMock"."patientRef" [N:1]' in rendered


def test_render_join_graph_includes_bridge_table_stub_section():
    path = JoinPath(
        nodes=["mock.public.MeasurementsMock", "staging.Shared.Monitors", "mock.public.PatientMock"],
        edges=[
            JoinHint(
                from_ref='"public"."MeasurementsMock"',
                from_columns=["DeviceId"],
                to_ref='"Shared"."Monitors"',
                to_columns=["Id"],
                join_cardinality="many-to-one",
                cross_source=False,
            ),
            JoinHint(
                from_ref='"Shared"."Monitors"',
                from_columns=["AcceptanceId"],
                to_ref='"public"."PatientMock"',
                to_columns=["patientRef"],
                join_cardinality="many-to-one",
                cross_source=False,
            ),
        ],
        hop_count=2,
    )
    tables = [_measurements_table(), _patients_table(), _monitors_bridge_table()]
    rendered = _render_join_graph([], [path], tables)
    assert "BRIDGE tables" in rendered
    assert 'staging."Shared"."Monitors"' in rendered
    assert "Multi-hop path" in rendered


def test_render_join_graph_cardinality_tags():
    for cardinality, tag in [
        ("many-to-one", "[N:1]"),
        ("one-to-many", "[1:N]"),
        ("one-to-one", "[1:1]"),
        ("many-to-many", "[N:N]"),
    ]:
        hint = JoinHint(
            from_ref='"public"."A"', from_columns=["x"], to_ref='"public"."B"', to_columns=["y"],
            join_cardinality=cardinality, cross_source=False,
        )
        a = RenderedTable(table_id="mock.public.A", quoted_ref='"public"."A"', grain="g", columns=[], approx_row_count=1, is_large_time_series=False)
        b = RenderedTable(table_id="mock.public.B", quoted_ref='"public"."B"', grain="g", columns=[], approx_row_count=1, is_large_time_series=False)
        rendered = _render_join_graph([hint], [], [a, b])
        assert tag in rendered


# ── Fix D: SEMANTIC HINTS rendering ─────────────────────────────────────────


def test_render_semantic_hints_literal_code_filter_and_provenance_comment():
    hit = GlossaryHit(
        term="heart rate",
        resolved_column_id="mock.public.MeasurementsMock.Value",
        time_column_id="mock.public.MeasurementsMock.RecordedAt",
        unit="bpm",
        hosting_table_id="mock.public.MeasurementsMock",
        confidence=1.0,
        code_value=2,
        code_label="HR",
        code_column_id="mock.public.MeasurementsMock.MeasurementTypeId",
    )
    rendered = _render_semantic_hints([hit], [_measurements_table()])
    assert '"public"."MeasurementsMock"."MeasurementTypeId" = 2' in rendered
    assert "-- code 2 = 'HR'" in rendered
    assert '"public"."MeasurementsMock"."Value" (unit=bpm)' in rendered
    assert '"public"."MeasurementsMock"."RecordedAt"' in rendered


def test_render_semantic_hints_caps_at_max_hints():
    hits = [
        GlossaryHit(term=f"term{i}", resolved_column_id=f"mock.public.MeasurementsMock.col{i}")
        for i in range(10)
    ]
    rendered = _render_semantic_hints(hits, [_measurements_table()])
    assert rendered.count("- \"term") <= 6


# ── Section ordering: SCHEMA -> SEMANTIC HINTS -> JOIN GRAPH -> CARDINALITY ─


def test_assemble_prompt_section_order():
    hit = GlossaryHit(
        term="heart rate",
        resolved_column_id="mock.public.MeasurementsMock.Value",
        hosting_table_id="mock.public.MeasurementsMock",
        code_value=2,
        code_column_id="mock.public.MeasurementsMock.MeasurementTypeId",
    )
    hint = JoinHint(
        from_ref='"public"."MeasurementsMock"', from_columns=["patientRef"],
        to_ref='"public"."PatientMock"', to_columns=["patientRef"],
        join_cardinality="many-to-one", cross_source=False,
    )
    tables = [_measurements_table(), _patients_table()]
    warnings = [
        CardinalityWarning(
            table_id="mock.public.MeasurementsMock",
            approx_row_count=483,
            required_time_column='"RecordedAt"',
            message="test warning",
        )
    ]
    prompt = assemble_prompt(
        tables, warnings, "heart rate over 120", CAPS, "duckdb",
        join_hints=[hint], glossary_hits=[hit], token_budget=2500,
    )
    schema_idx = prompt.index("SCHEMA CONTEXT")
    semantic_idx = prompt.index("SEMANTIC HINTS")
    join_idx = prompt.index("JOIN GRAPH")
    cardinality_idx = prompt.index("CARDINALITY WARNINGS")
    assert schema_idx < semantic_idx < join_idx < cardinality_idx


def test_assemble_prompt_omits_semantic_hints_and_join_graph_when_absent():
    prompt = assemble_prompt([_measurements_table()], [], "q", CAPS, "duckdb")
    assert "SEMANTIC HINTS" not in prompt
    assert "JOIN GRAPH" not in prompt


def test_assemble_repair_prompt_inherits_join_graph_and_semantic_hints():
    hit = GlossaryHit(
        term="heart rate",
        resolved_column_id="mock.public.MeasurementsMock.Value",
        hosting_table_id="mock.public.MeasurementsMock",
        code_value=2,
        code_column_id="mock.public.MeasurementsMock.MeasurementTypeId",
    )
    hint = JoinHint(
        from_ref='"public"."MeasurementsMock"', from_columns=["patientRef"],
        to_ref='"public"."PatientMock"', to_columns=["patientRef"],
        join_cardinality="many-to-one", cross_source=False,
    )
    from ceiba_nl2sql.generation.prompt import assemble_repair_prompt

    prompt = assemble_repair_prompt(
        [_measurements_table(), _patients_table()],
        [],
        "heart rate over 120",
        CAPS,
        "duckdb",
        failed_sql="SELECT 1",
        error="bad join",
        join_hints=[hint],
        glossary_hits=[hit],
        token_budget=2500,
    )
    assert "SEMANTIC HINTS" in prompt
    assert "JOIN GRAPH" in prompt
    assert "REPAIR REQUIRED" in prompt


# ── preamble rule ────────────────────────────────────────────────────────────


def test_preamble_includes_distinct_fanout_rule():
    prompt = assemble_prompt([_measurements_table()], [], "q", CAPS, "duckdb")
    assert "COUNT(DISTINCT" in prompt


# ── cardinality-guard remediation: multi-hop chain clarity + dialect note ──


def test_render_join_graph_multi_hop_chain_states_exact_table_qualified_join_columns():
    """Prompt-accuracy fix: the arrow-chain format used to render bare
    `→(DeviceId=Id, N:1)` with no indication of which side each column
    belongs to. A diagnosed staging benchmark showed the model join on the
    wrong column pair (mm."Id" = m."Id" instead of mm."DeviceId" = m."Id")
    despite this same join being named in the chain — the fully-qualified
    `sourceRef."fromCol"=targetRef."toCol"` form must appear so there is no
    shorthand left to misread.
    """
    path = JoinPath(
        nodes=["mock.public.MeasurementsMock", "staging.Shared.Monitors", "mock.public.PatientMock"],
        edges=[
            JoinHint(
                from_ref='"public"."MeasurementsMock"',
                from_columns=["DeviceId"],
                to_ref='"Shared"."Monitors"',
                to_columns=["Id"],
                join_cardinality="many-to-one",
                cross_source=False,
            ),
            JoinHint(
                from_ref='"Shared"."Monitors"',
                from_columns=["AcceptanceId"],
                to_ref='"public"."PatientMock"',
                to_columns=["patientRef"],
                join_cardinality="many-to-one",
                cross_source=False,
            ),
        ],
        hop_count=2,
    )
    tables = [_measurements_table(), _patients_table(), _monitors_bridge_table()]
    rendered = _render_join_graph([], [path], tables)
    assert 'mock."public"."MeasurementsMock"."DeviceId"=staging."Shared"."Monitors"."Id"' in rendered
    assert 'staging."Shared"."Monitors"."AcceptanceId"=mock."public"."PatientMock"."patientRef"' in rendered


def test_assemble_prompt_duckdb_dialect_note_warns_against_timestamp_now_literal():
    """Prompt-accuracy fix: a diagnosed staging run showed a model emit the
    Postgres-ism `TIMESTAMP 'now'`, which DuckDB rejects outright.
    """
    prompt = assemble_prompt([_measurements_table()], [], "q", CAPS, "duckdb")
    assert "TIMESTAMP 'now'" in prompt
    assert "now()" in prompt


def test_assemble_prompt_no_dialect_note_for_non_duckdb_target():
    prompt = assemble_prompt([_measurements_table()], [], "q", CAPS, "postgres")
    assert "TIMESTAMP 'now'" not in prompt


# ── cardinality-guard remediation: warning message names the parent-join /
# selective-column bounding options for a table with no own time column ────


def _monitor_measurements_no_own_time_column_table() -> RenderedTable:
    return RenderedTable(
        table_id="staging.Shared.MonitorMeasurements",
        quoted_ref='"Shared"."MonitorMeasurements"',
        grain="one row per MonitorMeasurements reading, keyed by DeviceId",
        columns=[
            RenderedColumn(name="DeviceId", quoted_name='"DeviceId"', data_type="INTEGER", unit=None, is_time_column=False, is_indexed=True),
            RenderedColumn(name="MeasurementTypeId", quoted_name='"MeasurementTypeId"', data_type="INTEGER", unit=None, is_time_column=False, is_indexed=True),
            RenderedColumn(name="Id", quoted_name='"Id"', data_type="BIGINT", unit=None, is_time_column=False, is_indexed=True, is_foreign_key_or_primary_key=True),
        ],
        approx_row_count=344_225_600,
        is_large_time_series=True,
        required_time_column=None,
        time_via=TimeVia(table_id="staging.Shared.Monitors", column="MeasuredDate", from_columns=["DeviceId"], to_columns=["Id"]),
    )


def test_cardinality_warning_names_parent_join_time_bound_when_time_via_set():
    message = build_cardinality_warning_message(_monitor_measurements_no_own_time_column_table())
    assert "join to Monitors" in message
    assert "DeviceId=Id" in message
    assert "MeasuredDate" in message


def test_cardinality_warning_prefers_discriminator_shaped_column_over_entity_id_column():
    """MonitorMeasurements has both DeviceId (entity-identifying) and
    MeasurementTypeId (a coded discriminator) as indexed FK columns; the
    warning's example column should name the discriminator, since filtering
    "on a single DeviceId" is a materially different (and less obviously
    useful) example than filtering by measurement type.
    """
    message = build_cardinality_warning_message(_monitor_measurements_no_own_time_column_table())
    assert "MeasurementTypeId" in message
    assert "selective column such as MeasurementTypeId" in message


def test_cardinality_warning_own_time_column_case_unchanged():
    message = build_cardinality_warning_message(_measurements_table())
    assert 'you MUST include a time-bound predicate on "RecordedAt"' in message


def test_assemble_prompt_hr_query_cardinality_warning_end_to_end():
    """End-to-end: assembling the full prompt for a table with time_via set
    surfaces the parent-join guidance in the CARDINALITY WARNINGS section."""
    prompt = assemble_prompt(
        [_monitor_measurements_no_own_time_column_table()], [], "patients with HR above 120 in last 3 hours", CAPS, "duckdb"
    )
    assert "CARDINALITY WARNINGS" in prompt
    assert "join to Monitors" in prompt
    assert "MeasuredDate" in prompt
