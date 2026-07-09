"""test_sqlguard_parity.py — the Python half of the cross-runtime guard parity
check (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §1.3).

Runs the SHARED adversarial + benign corpus (tests/fixtures/
sqlGuardParityCorpus.json, the SAME file the TS test tests/unit/
sqlGuardParity.test.ts reads) through ceiba_nl2sql.sqltools.guard and asserts
the intended relationship: the Python guard is AT LEAST as strict as the TS
guard. Concretely:

  * every case the TS guard REJECTS (`tsRejected: true`) MUST also be rejected
    by the Python guard (Python is never MORE permissive), and
  * every case the TS guard ALLOWS (`tsRejected: false`) is also allowed by the
    Python guard (the intersection is intentional — see the plan doc wording:
    "kept in sync by hand-maintained verb lists + lexical fallback").

The corpus is discovered relative to the repo root so the test runs from either
`ceiba_nl2sql/` (its own pytest working dir) or the repo root.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ceiba_nl2sql.sqltools.guard import guard_sql


def _find_corpus() -> Path:
    # This file: <repo>/ceiba_nl2sql/tests/test_sqlguard_parity.py
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "tests" / "fixtures" / "sqlGuardParityCorpus.json"
        if candidate.exists():
            return candidate
    raise FileNotFoundError("sqlGuardParityCorpus.json not found in any parent's tests/fixtures/")


_CORPUS = json.loads(_find_corpus().read_text())["cases"]


@pytest.mark.parametrize("case", _CORPUS, ids=[c["name"] for c in _CORPUS])
def test_python_guard_at_least_as_strict_as_ts(case):
    verdict = guard_sql(case["sql"], dialect="duckdb")
    python_rejected = not verdict.allowed
    if case["tsRejected"]:
        assert python_rejected, (
            f"TS guard REJECTS {case['name']!r} but the Python guard ALLOWED it — "
            "the Python guard must be at least as strict as the TS guard."
        )
    else:
        # Cases both are expected to allow: the Python guard must not newly
        # reject a benign read-only query (that would be a false positive that
        # breaks the shared contract, not extra strictness).
        assert not python_rejected, (
            f"TS guard ALLOWS {case['name']!r} but the Python guard rejected it "
            f"({verdict.reason!r}) — unexpected divergence on a benign query."
        )
