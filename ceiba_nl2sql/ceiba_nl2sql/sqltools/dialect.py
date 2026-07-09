"""dialect.py — sqlglot dialect name map (SPEC-relevant dialects: duckdb,
postgres, trino). Shared by `ceiba_nl2sql.sqltools.guard` and any future
retrieval/generation/cardinality-guard module that needs to parse SQL in the
engine's target dialect (docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1
`sqltools/dialect.py`).
"""

from __future__ import annotations

# The engine dialects this codebase's NL->SQL runtime targets today
# (lib/engine/DuckDbEngine.ts, lib/engine/TrinoEngine.ts — postgres is used by
# prep's own introspection/exemplar-validation path against staging/mock).
SUPPORTED_DIALECTS = frozenset({"duckdb", "postgres", "trino"})

# Default dialect when a caller does not specify one — mirrors the runtime's
# default engine (DuckDbEngine).
DEFAULT_DIALECT = "duckdb"


class UnsupportedDialectError(ValueError):
    """Raised when a caller asks to parse/guard SQL in a dialect this module
    does not recognize. Fails fast rather than silently falling back to a
    default dialect that could misclassify a statement.
    """


def normalize_dialect(dialect: str | None) -> str:
    """Validate + normalize a dialect name to one of `SUPPORTED_DIALECTS`.
    `None` resolves to `DEFAULT_DIALECT`.
    """
    if dialect is None:
        return DEFAULT_DIALECT
    normalized = dialect.strip().lower()
    if normalized not in SUPPORTED_DIALECTS:
        raise UnsupportedDialectError(
            f"unsupported SQL dialect {dialect!r}; supported: {sorted(SUPPORTED_DIALECTS)}"
        )
    return normalized
