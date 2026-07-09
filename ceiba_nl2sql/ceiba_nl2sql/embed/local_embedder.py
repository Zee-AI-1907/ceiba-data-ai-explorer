"""local_embedder.py (moved from prep/prep/embed/local_embedder.py into
ceiba_nl2sql — docs/PYTHON_NL2SQL_SERVICE_PLAN.md §3.1/§3.2) — local model
ONLY (fastembed BAAI/bge-small-en-v1.5, SPEC §1.2, §2.5).

No external embedding API, ever (locked decision #2, SPEC §0 #2, §2.5
invariant 4). This module is the ONE place the prep toolchain (and, later,
the NL->SQL service) calls an embedding model, and it is pluggable behind the
`Embedder` protocol so tests can swap in a deterministic, offline,
dependency-free fallback without ever touching a real model — while the REAL
default embedder used by `build` is always `FastEmbedEmbedder` wrapping
`BAAI/bge-small-en-v1.5`. Sharing this module (rather than a TS
reproduction) is what eliminates the `lib/rag/queryEmbedder.ts` parity-risk
gap the plan documents (§0 #1, §3.2): query and document vectors will be
produced by the exact same code path.

Manifest fingerprint (SPEC §1.2 `manifest.json.embeddingModel`):

    { "id": "bge-small-en-v1.5", "dimension": 384, "normalization": "l2",
      "revision": "sha256:<fastembed pin + model file content hash>" }

`revision` is computed from the LOCAL model artifact content (never a network
call at fingerprint time) so it is reproducible across machines that share the
same fastembed model cache, and changes if-and-only-if the underlying model
weights change — the exact "model weights fingerprint for reproducibility"
SPEC §1.2 asks for.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, Sequence

EXPECTED_MODEL_ID = "bge-small-en-v1.5"
EXPECTED_DIMENSION = 384
EXPECTED_NORMALIZATION = "l2"


class EmbedderConfigError(ValueError):
    """Raised when an embedder is misconfigured — e.g. a non-local provider,
    or a model id/dimension mismatch against the SPEC-locked default. Fails
    BEFORE any network call or model load (SPEC §2.5 invariant 4 discipline).
    """


@dataclass(frozen=True)
class EmbeddingModelFingerprint:
    """The SPEC §1.2 `manifest.json.embeddingModel` shape."""

    id: str
    dimension: int
    normalization: str
    revision: str
    lib: str = "fastembed"

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "dimension": self.dimension,
            "normalization": self.normalization,
            "revision": self.revision,
            "lib": self.lib,
        }

    def to_manifest_summary(self) -> dict:
        """The compact `{id, dim, lib, revision}` shape SPEC §0a decision #2
        specifically calls out for the manifest (distinct field name `dim`
        rather than `dimension` — kept as a SEPARATE accessor rather than
        renaming `to_json`'s `dimension` key, since `to_json` mirrors SPEC
        §1.2's `embeddingModel` object verbatim, which uses `dimension`).
        """
        return {"id": self.id, "dim": self.dimension, "lib": self.lib, "revision": self.revision}


class Embedder(Protocol):
    """Pluggable embedding backend. `embed_documents` takes a batch of
    non-PHI document texts and returns one L2-normalized float vector per
    input, in order. `fingerprint()` returns the manifest-recordable model
    identity (SPEC §1.2).
    """

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...
    def fingerprint(self) -> EmbeddingModelFingerprint: ...


def _l2_normalize(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0.0:
        return list(vector)
    return [v / norm for v in vector]


# ── the REAL default: fastembed + BAAI/bge-small-en-v1.5 ──────────────────


class FastEmbedEmbedder:
    """The real, default, LOCAL embedder (SPEC §0a decision #2): `fastembed`
    (ONNX, no torch, CPU, fully local) running `BAAI/bge-small-en-v1.5` (dim
    384). Model weights are fetched once into the local fastembed cache (a
    one-time local download, not a per-embed network call — no raw text or
    PHI is EVER sent anywhere; the model runs entirely on-box after the
    weights are cached) and then every `embed_documents` call is pure local
    inference.
    """

    def __init__(self, model_id: str = EXPECTED_MODEL_ID, cache_dir: str | None = None) -> None:
        if model_id != EXPECTED_MODEL_ID:
            raise EmbedderConfigError(
                f"FastEmbedEmbedder is pinned to {EXPECTED_MODEL_ID!r} (SPEC §0a decision #2); "
                f"got {model_id!r}. A mismatched embeddingModel.id must never silently proceed."
            )
        self._model_id = model_id
        self._hf_model_name = "BAAI/bge-small-en-v1.5"
        self._cache_dir = cache_dir
        self._model = None  # lazy: constructing loads/downloads weights

    def _ensure_model(self):
        if self._model is None:
            from fastembed import TextEmbedding

            kwargs: dict = {}
            if self._cache_dir:
                kwargs["cache_dir"] = self._cache_dir
            self._model = TextEmbedding(model_name=self._hf_model_name, **kwargs)
        return self._model

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        model = self._ensure_model()
        # fastembed's TextEmbedding.embed() already L2-normalizes bge output,
        # but we re-normalize defensively so the manifest's declared
        # normalization: "l2" is a guarantee this module enforces, not an
        # assumption about a third-party library's internals.
        vectors = list(model.embed(list(texts)))
        return [_l2_normalize([float(x) for x in vec]) for vec in vectors]

    def fingerprint(self) -> EmbeddingModelFingerprint:
        revision = compute_model_revision(self._hf_model_name, cache_dir=self._cache_dir)
        return EmbeddingModelFingerprint(
            id=self._model_id,
            dimension=EXPECTED_DIMENSION,
            normalization=EXPECTED_NORMALIZATION,
            revision=revision,
        )


def compute_model_revision(hf_model_name: str = "BAAI/bge-small-en-v1.5", cache_dir: str | None = None) -> str:
    """Compute a reproducible revision fingerprint for the LOCAL model
    artifact: `sha256:<fastembed version>:<hash of cached model file bytes>`.

    Reads from the already-populated fastembed/huggingface local cache (never
    a network call here) via `fastembed`'s own model listing, so this can be
    called independently of constructing a `FastEmbedEmbedder` (e.g. by the
    manifest builder after embedding already ran, or by a test asserting
    determinism). If the model has never been downloaded (cache empty), falls
    back to a version-only fingerprint — still deterministic and useful for
    drift detection, just without the weights-content component.
    """
    import tempfile

    import fastembed

    fastembed_version = fastembed.__version__

    try:
        # fastembed has no public "get default cache dir" accessor; it computes
        # the same default internally (fastembed/common/utils.py
        # `default_cache_dir`) as `<tempdir>/fastembed_cache`. Mirrored here
        # rather than imported since it's a private module constant, not a
        # public API — if fastembed changes this default, the fallback below
        # (version-only fingerprint) still keeps `build` working; only the
        # weights-content component of the revision would go stale, and
        # `assert_fingerprint_matches_expected` still guards the model `id`.
        cache_path = Path(cache_dir) if cache_dir else Path(tempfile.gettempdir()) / "fastembed_cache"

        # fastembed re-sources `BAAI/bge-small-en-v1.5` from a mirrored ONNX
        # repo (e.g. `qdrant/bge-small-en-v1.5-onnx-q`) — the on-disk HF cache
        # directory is named after the ACTUAL source repo, not the public
        # model id. Resolve the real source repo from fastembed's own model
        # registry (`list_supported_models()`) instead of guessing from
        # `hf_model_name`, so the cache-dir match is correct regardless of
        # which mirror a given fastembed version pins internally.
        source_repo = hf_model_name
        try:
            from fastembed import TextEmbedding as _TextEmbedding

            for entry in _TextEmbedding.list_supported_models():
                if entry.get("model") == hf_model_name:
                    hf_source = (entry.get("sources") or {}).get("hf")
                    if hf_source:
                        source_repo = hf_source
                    break
        except Exception:
            pass

        model_dir_hints = {hf_model_name.replace("/", "--").lower(), source_repo.replace("/", "--").lower()}
        candidate_dirs = [
            p
            for p in cache_path.glob("**/*")
            if p.is_dir() and any(hint in p.name.lower() for hint in model_dir_hints)
        ]
        onnx_files: list[Path] = []
        for d in candidate_dirs:
            onnx_files.extend(sorted(d.rglob("*.onnx")))
        if onnx_files:
            digest = hashlib.sha256()
            for f in sorted(onnx_files):
                # Resolve through possible HF-cache symlinks to the real blob.
                real = f.resolve()
                with real.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1 << 20), b""):
                        digest.update(chunk)
            return f"sha256:fastembed-{fastembed_version}:{digest.hexdigest()}"
    except Exception:
        pass

    return f"sha256:fastembed-{fastembed_version}:weights-not-yet-cached"


# ── deterministic hash-based fallback (TEST-ONLY) ───────────────────────────


class DeterministicHashEmbedder:
    """TEST-ONLY deterministic, offline, dependency-free embedder. NEVER the
    default for a real `build` — exists solely so `prep/tests/**` can assert
    embedding-pipeline behavior (dimension, normalization, wiring through
    vss_index.py/emit.py) without downloading or running a real model,
    keeping unit tests fast and hermetic (mirrors PLAN §0 ground rule #4: "CI
    green without" needing heavyweight external state).

    Deterministic: the same input text always produces the same vector (a
    seeded pseudo-random projection derived from a sha256 of the text), so
    tests can assert exact reproducibility without needing bit-identical
    real-model output.

    `fingerprint()` deliberately reports a DIFFERENT `id`
    ("test-deterministic-hash-v1") from the real
    `EXPECTED_MODEL_ID`/`bge-small-en-v1.5` so nothing ever mistakes a test
    build's vectors.duckdb for a real bundle — `assert_local_embedder_valid`
    below (and the runtime's manifest-id check, SPEC §1.2) would reject it if
    it silently claimed to be `bge-small-en-v1.5`.
    """

    MODEL_ID = "test-deterministic-hash-v1"

    def __init__(self, dimension: int = EXPECTED_DIMENSION) -> None:
        self._dimension = dimension

    def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._embed_one(t) for t in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector: list[float] = []
        seed = text.encode("utf-8")
        counter = 0
        while len(vector) < self._dimension:
            digest = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
            for i in range(0, len(digest), 4):
                if len(vector) >= self._dimension:
                    break
                chunk = digest[i : i + 4]
                # Map 4 bytes -> a signed float in roughly [-1, 1].
                as_int = int.from_bytes(chunk, "big", signed=False)
                vector.append((as_int / 0xFFFFFFFF) * 2.0 - 1.0)
            counter += 1
        return _l2_normalize(vector)

    def fingerprint(self) -> EmbeddingModelFingerprint:
        return EmbeddingModelFingerprint(
            id=self.MODEL_ID,
            dimension=self._dimension,
            normalization=EXPECTED_NORMALIZATION,
            revision="sha256:test-only-no-real-weights",
            lib="test-fallback",
        )


# ── provider gate (SPEC §2.5 invariant 4) ───────────────────────────────────


def assert_local_embedding_provider(provider: str) -> None:
    """Fail fast, before any network call or model load, if `provider` is not
    'local' (SPEC §2.5 invariant 4, mirrors config.py's
    `assert_local_embedding_provider` for the embedding sub-stage
    specifically). This is a defense-in-depth re-check at the point the
    embedder is actually constructed, independent of config.py's own
    load-time check.
    """
    if provider != "local":
        raise EmbedderConfigError(
            f"embedding.provider must be 'local' (no external embedding API — "
            f"locked decision #2), got {provider!r}"
        )


def build_embedder(provider: str, model_id: str, dimension: int, *, allow_test_fallback: bool = False) -> Embedder:
    """Construct the configured embedder. `allow_test_fallback=True` is the
    ONLY way to get `DeterministicHashEmbedder` — it must be explicit at every
    call site (tests only) so a real `build` invocation can never silently
    fall back to fake vectors just because, e.g., a model download failed.
    """
    assert_local_embedding_provider(provider)

    if model_id == DeterministicHashEmbedder.MODEL_ID:
        if not allow_test_fallback:
            raise EmbedderConfigError(
                f"{DeterministicHashEmbedder.MODEL_ID!r} is a TEST-ONLY model id; "
                "pass allow_test_fallback=True explicitly to use it."
            )
        return DeterministicHashEmbedder(dimension=dimension)

    if model_id != EXPECTED_MODEL_ID:
        raise EmbedderConfigError(
            f"unknown embedding modelId {model_id!r}; the only supported real model is "
            f"{EXPECTED_MODEL_ID!r} (SPEC §0a decision #2)"
        )
    if dimension != EXPECTED_DIMENSION:
        raise EmbedderConfigError(
            f"{EXPECTED_MODEL_ID} has dimension {EXPECTED_DIMENSION}, config declared {dimension}"
        )
    return FastEmbedEmbedder(model_id=model_id)


def assert_fingerprint_matches_expected(fingerprint: EmbeddingModelFingerprint, expected_model_id: str) -> None:
    """Runtime-side guard mirror (SPEC §1.2: "runtime refuses a mismatched
    embeddingModel.id"). The prep tool itself calls this right after
    embedding to fail the BUILD (not just at TS-runtime load time) if
    something produced vectors under an unexpected model id — e.g. a
    misconfigured test fallback accidentally reaching `build`.
    """
    if fingerprint.id != expected_model_id:
        raise EmbedderConfigError(
            f"embeddingModel.id mismatch: produced {fingerprint.id!r}, expected {expected_model_id!r}"
        )
