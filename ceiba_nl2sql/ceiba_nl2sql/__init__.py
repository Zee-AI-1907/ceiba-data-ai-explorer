"""ceiba_nl2sql — shared Python library for the Ceiba NL->SQL toolchain.

This package holds the primitives that are genuinely shared between the
build-time `prep` toolchain and the future NL->SQL FastAPI runtime service
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3). Phase 1 (this package's initial
contents) covers only pieces that already existed as pure Python and are
reusable as-is:

  - `ceiba_nl2sql.embed`       — the local fastembed embedder (moved from
                                  prep/prep/embed/local_embedder.py).
  - `ceiba_nl2sql.compliance`  — PHI classification (`phi.py`, moved from
                                  prep/prep/classify_phi.py) and the PHI-aware
                                  aggregate profile reducer
                                  (`aggregate_profile.py`, moved from
                                  prep/prep/profile.py).
  - `ceiba_nl2sql.bundle`      — a read-only artifact bundle loader (NEW;
                                  the future service's read path; prep
                                  continues to WRITE bundles itself).
  - `ceiba_nl2sql.sqltools`    — a sqlglot-based, dialect-aware, read-only SQL
                                  guard (NEW; mirrors lib/sqlGuard.ts's
                                  semantics using a real parser).

Retrieval/generation/engine (currently TypeScript, `lib/rag/**` +
`lib/engine/**`) are NOT part of this phase — they are ported in later phases
per the plan's migration sequencing (§5).
"""

from __future__ import annotations

__all__: list[str] = []
