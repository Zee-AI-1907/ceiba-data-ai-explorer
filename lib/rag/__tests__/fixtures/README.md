# lib/rag test fixtures

`bundles/mock-v1/` is a tiny, committed NL2SQL artifact bundle (NL2SQL_SPEC.md
§1) used by `bundleLoader.test.ts` and `retriever.test.ts` so those tests are
hermetic/CI-safe (NL2SQL_PLAN.md §0 ground rule #4) — no mock Postgres, no
Python venv, no model download required at test time.

## Provenance

Built once via the prep toolchain against the OrbStack mock Postgres
(`docs/mock-topology.md`) with the deterministic test-only embedder (never the
real `bge-small-en-v1.5` — see `prep/prep/embed/local_embedder.py`'s
`DeterministicHashEmbedder`, `MODEL_ID = "test-deterministic-hash-v1"`):

```bash
bash scripts/mock-db-up.sh
cd prep && source .venv/bin/activate
MOCK_DSN="postgresql+psycopg://ceiba_ro:ceiba_ro_pw@localhost:55433/mockdb" \
  python -m prep.cli build \
  --config ../config/prep.config.yaml \
  --only mock \
  --test-fallback-embedder \
  --out ../lib/rag/__tests__/fixtures/bundles
```

The tool writes a timestamped `v<ts>_<hash>/` directory plus a `latest`
symlink; rename the timestamped directory to `mock-v1` (and remove the
`latest` symlink) to match what the tests import by a stable path:

```bash
cd lib/rag/__tests__/fixtures/bundles
rm -f latest
mv v*_*/ mock-v1/
```

## Regenerating

Only regenerate this fixture if the bundle FORMAT changes (SPEC §1) or the
mock schema/seed changes in a way that would make the fixture's expected rows
(`retriever.test.ts`'s canonical-question assertions) stale. Regenerating with
a fresh timestamp changes `manifest.bundleVersion` but not
`manifest.embeddingModel.id` (`test-deterministic-hash-v1`) or the file
hashes' semantic content — tests key off table/column/glossary/exemplar IDs,
never off `bundleVersion` itself.

## Why the DuckDB file is committed as binary

`vectors.duckdb` (SPEC §1.11) cannot be represented as JSON — it is DuckDB's
native on-disk format with an HNSW index over 384-d float vectors. Regenerating
it from the JSON siblings alone is not possible (the embeddings are not
otherwise persisted), so it is committed alongside the JSON files rather than
regenerated at test time.
