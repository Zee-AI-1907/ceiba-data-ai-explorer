"""settings.py — service configuration from env
(docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1 `settings.py`, §6 "Config / env
deltas").

Env vars this service formalizes (per plan §6):
  NL2SQL_BUNDLE_DIR          — path to the artifact bundle directory (§1.1).
  NL2SQL_ENGINE              — 'duckdb' (default) | 'trino' (stub, deferred).
  MOCK_DSN / STAGING_DSN     — read-only Postgres DSNs the engine ATTACHes.
  OPENAI_API_KEY             — the real OpenAI client's credential.
  OPENAI_BAA_SIGNED          — the egress gate (default false / closed).
  NL2SQL_SERVICE_TOKEN       — the internal service bearer token (§2.1).
  NL2SQL_SERVICE_PORT        — the port uvicorn binds (default 8088).
  NL2SQL_EMBEDDING_MODEL_ID  — override for tests (test-deterministic-hash-v1).
"""

from __future__ import annotations

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    # ── bundle + engine ──────────────────────────────────────────────────────
    nl2sql_bundle_dir: str | None = None
    nl2sql_engine: str = "duckdb"
    mock_dsn: str | None = None
    staging_dsn: str | None = None

    # ── LLM + egress gate ────────────────────────────────────────────────────
    openai_api_key: str | None = None
    openai_baa_signed: bool = False
    # The driving model. Primary env is NL2SQL_LLM_MODEL (plan §6); OPENAI_MODEL
    # is kept as a legacy alias so an existing config keeps working. Default is
    # the current default driving model (kept in sync with llm.DEFAULT_LLM_MODEL).
    openai_model: str = Field(
        default="gpt-4o-mini",
        validation_alias=AliasChoices("NL2SQL_LLM_MODEL", "OPENAI_MODEL", "openai_model"),
    )

    # ── internal service auth (§2.1) ─────────────────────────────────────────
    nl2sql_service_token: str | None = None

    # ── networking ────────────────────────────────────────────────────────────
    nl2sql_service_port: int = 8088

    # ── test-only override: lets the hermetic test suite point the service
    # at the test-fallback embedding model id instead of the real
    # bge-small-en-v1.5, matching the committed fixture bundle's manifest. ──
    nl2sql_embedding_model_id: str | None = None


def get_settings() -> Settings:
    """Fresh Settings() per call (cheap; env-backed) rather than a
    module-global singleton, so tests can monkeypatch os.environ and get a
    consistent view without needing an explicit cache-reset seam.
    """
    return Settings()
