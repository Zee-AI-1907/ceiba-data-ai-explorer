"""config.py — prep.config.yaml loader + validation (SPEC §2.2).

Loads the prep toolchain's source topology, embedding config, enrich config, and
PHI-gate config from a YAML file. Credentials are NEVER read from this file —
each source names an env var (`dsnEnv`); the DSN value itself must come from the
process environment (or a secrets manager that populates it), never be inlined in
committed YAML.

Hard rule (SPEC §2.5 invariant 4): `embedding.provider` MUST be `local`. This is
asserted at load time, before any network call or embedding work — a non-local
provider fails validation immediately (fail fast).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


class ConfigError(ValueError):
    """Raised for any structurally or semantically invalid prep.config.yaml."""


# ── dataclasses ────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EmbeddingConfig:
    provider: str
    model_id: str
    dimension: int


@dataclass(frozen=True)
class IntrospectConfig:
    include_schemas: list[str] = field(default_factory=list)
    exclude_schemas: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class ProfileConfig:
    sample_rows_per_table: int = 5000
    large_table_row_threshold: int = 10_000_000
    time_windowed_sample_for: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class SourceConfig:
    source_id: str
    engine: str
    dsn_env: str
    read_only: bool
    introspect: IntrospectConfig
    profile: ProfileConfig

    def resolve_dsn(self) -> str:
        """Resolve the DSN from the environment variable named by `dsn_env`.

        Never reads a DSN from the YAML file itself — only from the process
        environment. Raises ConfigError if the env var is unset or empty.
        """
        dsn = os.environ.get(self.dsn_env)
        if not dsn:
            raise ConfigError(
                f"source {self.source_id!r}: environment variable "
                f"{self.dsn_env!r} is not set (DSNs are never read from YAML)"
            )
        return dsn


@dataclass(frozen=True)
class InferJoinEdgesConfig:
    enabled: bool = True
    min_confidence: float = 0.8
    name_match_strategy: str = "col-eq-pk"


@dataclass(frozen=True)
class EnrichConfig:
    glossary: str
    infer_join_edges: InferJoinEdgesConfig


@dataclass(frozen=True)
class PhiGateConfig:
    phi_columnset: str
    fail_on_violation: bool = True


@dataclass(frozen=True)
class PrepConfig:
    bundle_format_version: str
    embedding: EmbeddingConfig
    sources: list[SourceConfig]
    enrich: EnrichConfig
    phi_gate: PhiGateConfig

    def source(self, source_id: str) -> SourceConfig:
        for src in self.sources:
            if src.source_id == source_id:
                return src
        available = ", ".join(s.source_id for s in self.sources)
        raise ConfigError(f"unknown sourceId {source_id!r}; available: {available}")


# ── loader ──────────────────────────────────────────────────────────────────


def _require(mapping: dict, key: str, ctx: str) -> object:
    if key not in mapping or mapping[key] is None:
        raise ConfigError(f"{ctx}: missing required key {key!r}")
    return mapping[key]


def _parse_embedding(raw: dict) -> EmbeddingConfig:
    provider = str(_require(raw, "provider", "embedding"))
    # Fail fast, before any work (introspection, profiling, embedding) — SPEC §2.5
    # invariant 4 and locked decision #2: local embeddings only, no external API.
    if provider != "local":
        raise ConfigError(
            f"embedding.provider must be 'local' (locked decision: no external "
            f"embedding API), got {provider!r}"
        )
    model_id = str(_require(raw, "modelId", "embedding"))
    dimension = int(_require(raw, "dimension", "embedding"))
    return EmbeddingConfig(provider=provider, model_id=model_id, dimension=dimension)


def _parse_introspect(raw: dict | None, ctx: str) -> IntrospectConfig:
    raw = raw or {}
    return IntrospectConfig(
        include_schemas=list(raw.get("includeSchemas", [])),
        exclude_schemas=list(raw.get("excludeSchemas", [])),
    )


def _parse_profile(raw: dict | None, ctx: str) -> ProfileConfig:
    raw = raw or {}
    return ProfileConfig(
        sample_rows_per_table=int(raw.get("sampleRowsPerTable", 5000)),
        large_table_row_threshold=int(raw.get("largeTableRowThreshold", 10_000_000)),
        time_windowed_sample_for=list(raw.get("timeWindowedSampleFor", [])),
    )


def _parse_source(raw: dict) -> SourceConfig:
    source_id = str(_require(raw, "sourceId", "sources[]"))
    ctx = f"sources[{source_id}]"
    engine = str(_require(raw, "engine", ctx))
    dsn_env = str(_require(raw, "dsnEnv", ctx))
    read_only = bool(raw.get("readOnly", True))
    if not read_only:
        raise ConfigError(
            f"{ctx}: readOnly must be true — a read-write source is a hard error"
        )
    return SourceConfig(
        source_id=source_id,
        engine=engine,
        dsn_env=dsn_env,
        read_only=read_only,
        introspect=_parse_introspect(raw.get("introspect"), ctx),
        profile=_parse_profile(raw.get("profile"), ctx),
    )


def _parse_enrich(raw: dict | None) -> EnrichConfig:
    raw = raw or {}
    glossary = str(raw.get("glossary", "config/glossary.seed.yaml"))
    infer_raw = raw.get("inferJoinEdges") or {}
    infer = InferJoinEdgesConfig(
        enabled=bool(infer_raw.get("enabled", True)),
        min_confidence=float(infer_raw.get("minConfidence", 0.8)),
        name_match_strategy=str(infer_raw.get("nameMatchStrategy", "col-eq-pk")),
    )
    return EnrichConfig(glossary=glossary, infer_join_edges=infer)


def _parse_phi_gate(raw: dict | None) -> PhiGateConfig:
    raw = raw or {}
    return PhiGateConfig(
        phi_columnset=str(raw.get("phiColumnset", "reuse-phiScrubber")),
        fail_on_violation=bool(raw.get("failOnViolation", True)),
    )


def load_config(path: str | Path) -> PrepConfig:
    """Load and validate prep.config.yaml.

    Raises ConfigError on any structural or semantic violation, including a
    non-local embedding provider (checked FIRST, before any other validation
    that might require network/DB access) and duplicate/missing sourceIds.
    """
    path = Path(path)
    if not path.is_file():
        raise ConfigError(f"config file not found: {path}")

    with path.open("r", encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top-level YAML must be a mapping")

    # Embedding provider guard FIRST — fail fast before touching sources (SPEC §2.5 #4).
    embedding = _parse_embedding(_require(raw, "embedding", "<root>"))

    bundle_format_version = str(_require(raw, "bundleFormatVersion", "<root>"))

    raw_sources = _require(raw, "sources", "<root>")
    if not isinstance(raw_sources, list) or not raw_sources:
        raise ConfigError("sources must be a non-empty list")
    sources = [_parse_source(s) for s in raw_sources]

    seen_ids = set()
    for src in sources:
        if src.source_id in seen_ids:
            raise ConfigError(f"duplicate sourceId: {src.source_id!r}")
        seen_ids.add(src.source_id)

    enrich = _parse_enrich(raw.get("enrich"))
    phi_gate = _parse_phi_gate(raw.get("phiGate"))

    return PrepConfig(
        bundle_format_version=bundle_format_version,
        embedding=embedding,
        sources=sources,
        enrich=enrich,
        phi_gate=phi_gate,
    )


def assert_local_embedding_provider(config: PrepConfig) -> None:
    """Standalone re-assertion of the local-only embedding rule (SPEC §2.5 #4).

    `load_config` already enforces this at parse time; this helper lets other
    stages (e.g. the PHI gate, §2.5) re-check the invariant defensively without
    re-parsing YAML.
    """
    if config.embedding.provider != "local":
        raise ConfigError(
            f"embedding.provider must be 'local', got {config.embedding.provider!r}"
        )
