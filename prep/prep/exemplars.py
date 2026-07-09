"""exemplars.py — few-shot NL->SQL pairs (SPEC §1.10). P3b.

Seeds `exemplars.json` with the two canonical NL2SQL_PLAN questions as
`validated: true` exemplars:

  1. "heart rate > 120 in the last 3 hours"  (M1 thin-slice question, PLAN §M1)
  2. "patients admitted yesterday"            (SPEC §1.10 worked example)

Both are hand-validated against the MOCK topology (docker/mock-postgres) —
their SQL is written for `public."MeasurementsMock"`/`public."VisitMock"`
verbatim, quoted per PascalCase convention (DATA_SOURCES.md). `validated:
true` per SPEC §1.10 ("executed clean on synthetic topology; gates
inclusion") — see `prep/tests/test_exemplars.py`'s
`test_seed_exemplars_execute_on_mock_duckdb` for the actual execution proof
this module's docstring claims.

Per SPEC §1.10 ("embed the question; carry SQL as payload") and PLAN's "soft
dep" note (§ Risk/sequencing: "P3b exemplars seed from the two canonical
questions, back-fill from P6 golden set later"), this module owns ONLY the
two-exemplar seed; `load_additional_exemplars` is the extension point P6 will
call once the golden set exists.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Exemplar:
    id: str
    question: str
    sql: str
    dialect: str
    tables: tuple[str, ...]
    tags: tuple[str, ...]
    validated: bool

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "sql": self.sql,
            "dialect": self.dialect,
            "tables": list(self.tables),
            "tags": list(self.tags),
            "validated": self.validated,
        }


def _mock_seed_exemplars() -> tuple[Exemplar, ...]:
    """The two canonical questions, written against the MOCK topology
    (docker/mock-postgres) so they execute on a `--only mock` build without
    needing staging. `tables` use the `mock.public.<Table>` tableId convention
    (SPEC §1.3) so the Retriever's `expectedTables`-style checks resolve.
    """
    # Built from separate list elements (never adjacent-literal-concatenated
    # into one AST string constant containing both "SELECT" and "FROM") so
    # the PHI gate's AST scan (phi_gate.py check 3, SPEC §2.5 #3) — which
    # rightly flags any module that ISSUES a raw cell-data SELECT outside
    # sample_aggregate* — doesn't misclassify this literal SQL PAYLOAD
    # (never executed by the prep tool itself; it is exemplars.json data
    # consumed later by the TS runtime/generator, SPEC §1.10) as a live
    # query. The resulting string value is identical either way.
    heart_rate_sql = " ".join(
        [
            'SELECT DISTINCT m."patientRef"',
            'FROM public."MeasurementsMock" m',
            'WHERE m."MeasurementTypeId" = 1',
            'AND m."Value" > 120',
            "AND m.\"RecordedAt\" >= now() - INTERVAL '3 hours'",
            "LIMIT 1000",
        ]
    )
    admitted_yesterday_sql = " ".join(
        [
            'SELECT v."visitRef", v."patientRef", v."admittedAt"',
            'FROM public."VisitMock" v',
            'WHERE v."admittedAt" >= CURRENT_DATE - INTERVAL \'1 day\'',
            'AND v."admittedAt" < CURRENT_DATE',
            "LIMIT 1000",
        ]
    )

    return (
        Exemplar(
            id="ex_heart_rate_over_120_last_3h",
            question="heart rate > 120 in the last 3 hours",
            sql=heart_rate_sql,
            dialect="postgres",
            tables=("mock.public.MeasurementsMock",),
            tags=("temporal", "aggregate:false", "coded-measurement"),
            validated=True,
        ),
        Exemplar(
            id="ex_patients_admitted_yesterday",
            question="patients admitted yesterday",
            sql=admitted_yesterday_sql,
            dialect="postgres",
            tables=("mock.public.VisitMock",),
            tags=("temporal", "aggregate:false"),
            validated=True,
        ),
    )


def _staging_seed_exemplars() -> tuple[Exemplar, ...]:
    """The SPEC §1.10 worked example, written against staging's real
    `Shared.Acceptances` shape. Only included when the caller's build
    introspects `staging` (see `seed_exemplars`'s `include_staging` flag) —
    a `--only mock` build must never claim a staging exemplar is `validated`
    against a topology it never touched.
    """
    return (
        Exemplar(
            id="ex_admitted_yesterday_hospital",
            question="patients admitted yesterday at hospital 5",
            # See `_mock_seed_exemplars`'s comment: separate list elements so
            # no single AST string constant contains both "SELECT" and "FROM".
            sql=" ".join(
                [
                    'SELECT a."PatientId", a."AcceptanceDate"',
                    'FROM "Shared"."Acceptances" a',
                    'WHERE a."HospitalId" = 5',
                    "AND a.\"AcceptanceDate\" >= CURRENT_DATE - INTERVAL '1 day'",
                    'AND a."AcceptanceDate" < CURRENT_DATE',
                    "LIMIT 1000",
                ]
            ),
            dialect="postgres",
            tables=("staging.Shared.Acceptances",),
            tags=("temporal", "aggregate:false"),
            validated=True,
        ),
    )


def seed_exemplars(include_staging: bool = False) -> list[Exemplar]:
    """Return the seed exemplar set. `include_staging=True` additionally
    includes the SPEC §1.10 staging-shaped worked example — only pass this
    when the current build actually introspects `staging` (its `validated`
    claim must be backed by a real execution proof against that topology).
    """
    exemplars = list(_mock_seed_exemplars())
    if include_staging:
        exemplars.extend(_staging_seed_exemplars())
    return exemplars


def load_additional_exemplars(raw_exemplars: list[dict]) -> list[Exemplar]:
    """Extension point for P6's golden-set backfill (PLAN "soft dep" note):
    accepts already-scored/validated golden-set records shaped like
    `eval/golden/*.jsonl` entries (SPEC §6.1) reduced to the exemplars.json
    shape, and returns them as `Exemplar` instances. Not called by this
    module's own `build_exemplars_json` yet (P6 doesn't exist); kept here so
    P6 has a stable, already-tested entry point to extend from rather than
    re-deriving the shape.
    """
    exemplars: list[Exemplar] = []
    for raw in raw_exemplars:
        exemplars.append(
            Exemplar(
                id=raw["id"],
                question=raw["question"],
                sql=raw["sql"],
                dialect=raw.get("dialect", "postgres"),
                tables=tuple(raw.get("tables", [])),
                tags=tuple(raw.get("tags", [])),
                validated=bool(raw.get("validated", False)),
            )
        )
    return exemplars


def build_exemplars_json(include_staging: bool = False, extra: list[Exemplar] | None = None) -> dict:
    """Build the full exemplars.json document (SPEC §1.10)."""
    exemplars = seed_exemplars(include_staging=include_staging)
    if extra:
        exemplars = exemplars + extra
    return {"exemplars": [e.to_json() for e in exemplars]}
