"""ceiba-nl2sql-prep — build-time DB-agnostic prep toolchain.

Emits a language-neutral, PHI-classified artifact bundle (JSON + one DuckDB-vss
vector file) consumed by the TypeScript runtime. NOT imported by the runtime.

P0 ships import-resolvable stubs for the SPEC §7 module layout; real logic lands
in P3a (introspect / profile / classify) and P3b (enrich / embed / emit).
"""

__version__ = "0.0.0"
