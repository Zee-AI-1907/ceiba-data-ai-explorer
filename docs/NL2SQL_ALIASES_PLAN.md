# NL2SQL Prep — User-Defined Table & Column Aliases

Status: PLAN (no code changed). Task #51. Author-facing feature spec + phased implementation plan.

## Goal

Let a human curator declare **aliases** that map a natural-language term to a
specific **table** or **column** in the introspected catalog, so a question
phrased in the user's vocabulary pins the right relation. The motivating case:

> A user asks "admissions in the last 24 hours". In the real staging schema
> the admission event lives on `Shared.Acceptances`. The curator wants to
> alias **"admission" / "admissions" → the `Acceptances` table** so the term
> pins that table during retrieval, even though the word "admission" never
> appears in the table/column names.

Requirements distilled from the request:

1. A **config surface** where the curator declares aliases for tables AND
   columns. Case-insensitive, many-aliases-per-target, validated against the
   real catalog (an alias pointing at a non-existent table/column is reported,
   not silently emitted).
2. Aliases **participate in the enrich phase**, "before or together with"
   relation (join-graph) creation — not bolted on after the bundle is built.
3. **Clean merge** with the auto-mined synonyms from `code_tables.py` — a
   curator alias and a machine-mined synonym must coexist with a defined
   precedence.
4. **Runtime reach**: the aliased term must pin its target table in
   `HybridRetriever`, and surface in the generation prompt.

This is a genuinely small feature that rides on machinery that already exists.
The whole `synonyms` → `maps[]` → `GlossaryHit` → retrieval-pin → SEMANTIC
HINTS pipeline was built for Fix D. Aliases are, structurally, a curator-authored
`synonym` entry with `kind: table` / `kind: column` maps. The work is (a) a
dedicated, ergonomic config file so curators don't hand-edit the large
`glossary.seed.yaml`, (b) validation, and (c) closing the one real runtime gap:
`kind: table` glossary hits currently do NOT pin a table.

## Current State (grounded in the code)

### The enrich phase, in order (`prep/prep/cli.py` `_run_build_pipeline_p3b`, lines ~565-658)

```
[5] ENRICH
  1. apply_importance_and_large_flag(catalog, foreign_keys, row_counts, …)   # importance.py
  2. apply_time_via_hints(catalog, foreign_keys)                              # importance.py
  3. joingraph = build_join_graph(tables, primary_keys, foreign_keys, …)     # joingraph.py   ← RELATIONS CREATED HERE
  4. code_table_hints = build_code_table_hints(catalog, joingraph, …)        # code_tables.py (needs joingraph)
  5. alias_seed = load_synonym_alias_seed("config/synonym_aliases.seed.yaml") # code_tables.py
  6. auto_synonyms = build_auto_synonyms(…, code_table_hints, alias_seed)     # code_tables.py
  7. auto_synonyms = resolve_auto_synonym_columns(auto_synonyms, catalog)     # code_tables.py
  8. glossary = build_glossary_from_seed_file(catalog, glossary_seed, auto_synonyms=…)  # glossary.py  ← ARTIFACT ASSEMBLED HERE
```

Two important facts about ordering:

- The join graph (step 3) is built from `catalog["tables"]` + `keys`. It does
  **not** consult the glossary. So table aliases do not need to *precede* the
  join graph to influence relations — the join graph is derived purely from
  keys + name-matching. The user's instinct ("before or together with
  relations") is satisfied by landing aliases in the same ENRICH phase and, as
  a bonus, we can feed alias-named tables into the join-graph **name-match
  allowlist** (see Pipeline Integration below) so an alias can *strengthen*
  relation inference. That is the "together with" interpretation and it is
  worth doing.
- `glossary.json` is the natural artifact for aliases: it already carries
  `synonyms[]` (hand-seeded) and `autoSynonyms[]` (machine-mined), both of
  which the retriever reads.

### The glossary artifact shape (`prep/prep/enrich/glossary.py`)

`build_glossary_json` emits:

```json
{
  "synonyms":   [ { "term", "aliases":[], "maps":[ {kind: table|column|coded-measurement|…} ] } ],
  "abbreviations": { "hr": "heart rate", … },
  "codeSystems": [...], "units": [...], "temporal": [...],
  "autoSynonyms": [ { "term", "aliases":[], "provenance", "confidence", "maps":[ {kind: coded-measurement} ] } ]
}
```

`resolve_synonyms` already supports `kind: table` (→ `{"tableId", "kind":"table"}`)
and `kind: column` (→ `{"columnId","kind":"column","timeColumnId?","unit?"}`),
resolving BARE refs (`schema.table`, `schema.table.column`) against every
sourceId in the catalog and dropping refs with no match. **This is exactly the
resolution + validation behavior aliases need — we reuse it verbatim.**

### The auto-mined synonym merge (`code_tables.py`)

`build_auto_synonyms` reads `config/synonym_aliases.seed.yaml` — a flat
`CanonicalMinedName: [alias, …]` map keyed by a code-table label value (e.g.
`HR: [heart rate, pulse]`) — and emits `autoSynonyms[]` `coded-measurement`
maps. These are kept in a SEPARATE array from hand-seeded `synonyms[]` for
"auditable provenance" (retriever.py line 510-512). Aliases will land in
`synonyms[]` (curator-authored, provenance is implicit), keeping the existing
`autoSynonyms[]` array untouched.

### Runtime consumption (`ceiba_nl2sql/…/retrieval/retriever.py`)

`_expand_question` (line 504) iterates `glossary["synonyms"]`: for each synonym
whose `term` or any `alias` is a substring of the lowercased question, it
appends the terms to the expanded query AND builds a `GlossaryHit` per `maps[]`
entry via `_glossary_hit_from_map`. Hits with a `hosting_table_id` and
confidence ≥ `HINT_PIN_THRESHOLD` (0.62) are injected at **rank 0** in
`retrieve()` (line 879-892) — the "retrieval pin".

**The one real gap for table aliases** (`_glossary_hit_from_map`, line 603-604):

```python
if kind == "table":
    return GlossaryHit(term=term, confidence=confidence)   # ← no hosting_table_id!
```

A `kind: table` hit records the term but sets NO `hosting_table_id`, so it does
**not** pin. Today "vitals"/"patient"/"hospital" (all `kind: table` synonyms)
influence retrieval only through query-text expansion + BM25/dense recall, not
the guaranteed pin. For "admission → Acceptances" to reliably pin, this branch
must set `hosting_table_id` from the map's `tableId`. This is the load-bearing
runtime change.

For `kind: column` aliases, `_glossary_hit_from_map` already returns
`resolved_column_id` (line 593-600) but ALSO sets no `hosting_table_id` — so a
column alias surfaces in SEMANTIC HINTS (`prompt.py` `_render_semantic_hint`
renders `value:` off `resolved_column_id`) but does not pin its table either.
We'll derive `hosting_table_id` from the column's table in both branches.

## Config Design

### Decision: a NEW dedicated file, `config/aliases.seed.yaml`, structured target-first.

Rejected alternatives:

- **Extend `glossary.seed.yaml`'s `synonyms:`** — works mechanically (aliases
  ARE synonyms) but the glossary seed is a large, semantically-loaded file
  mixing coded-measurements, temporal phrases, code systems, units. Curators
  adding a simple "call this table X" alias should not have to understand
  `coded-measurement` map shapes. Separation of concerns + a smaller blast
  radius for hand edits.
- **Reuse `synonym_aliases.seed.yaml`** (the code_tables Layer-A seed) — that
  file is keyed by *mined code-table label value* and only ever produces
  `coded-measurement` maps against auto-detected code tables. It cannot express
  "this term → this arbitrary table/column". Different semantic domain.
- **Per-table annotation file** (aliases nested under each table) — more
  verbose, and forces a table-centric layout that reads awkwardly for column
  aliases and many-terms-per-target. Target-first in one flat file is denser
  and easier to review.

The new file is **target-first** (the target table/column is the key idea,
aliases hang off it) because that matches how a curator thinks ("for the
Acceptances table, accept these words") and makes duplicate-target review
trivial.

### Example `config/aliases.seed.yaml`

```yaml
# aliases.seed.yaml — curator-authored NL term → catalog table/column aliases.
#
# Each entry names a BARE catalog ref (schema.table or schema.table.column, NO
# sourceId prefix — same convention as glossary.seed.yaml) and the NL aliases
# that should resolve to it. Aliases are matched CASE-INSENSITIVELY as
# whole-word substrings of the question (same match rule as glossary synonyms).
#
# Resolution + validation happen at build time against the ACTUAL introspected
# catalog: an alias whose target table/column does not exist in THIS build is
# reported by `prep build` (and fails the build under strict mode) rather than
# silently emitted. A build that doesn't introspect the target's source simply
# omits that entry (per-source resolution, same as glossary.seed.yaml).

tables:
  - table: Shared.Acceptances
    aliases: [admission, admissions, admit, admitted, arrived]
  - table: Shared.Patients
    aliases: [patient roster, census]

columns:
  - column: Shared.Acceptances.AcceptanceDate
    aliases: [admission date, admission time, time of admission]
    # optional: mark this as the temporal anchor so a "within N of admission"
    # phrase can resolve its event column to this alias's column.
    isTimeColumn: true
  - column: Shared.MonitorMeasurements.HeartRate
    aliases: [ventricular rate, cardiac frequency]
    unit: bpm
```

Notes on the shape:

- **Case-insensitivity**: matching is already lowercased in
  `_expand_question`. The seed values are stored as-authored; the retriever
  lowercases at match time. We additionally lowercase-normalize on load so the
  emitted `glossary.json` aliases are consistent.
- **Many aliases per target**: `aliases` is a list. Multiple entries may also
  target the same table (merged).
- **Table alias** → compiled to a `synonyms[]` entry with a `kind: table` map.
- **Column alias** → compiled to a `synonyms[]` entry with a `kind: column`
  map (optionally `timeColumnRef`/`unit`, reusing the existing column-map
  fields). `isTimeColumn: true` is sugar that additionally emits a
  `temporal-column` map so the column can serve as a temporal event anchor.
- **`term` vs `aliases`**: the compiled synonym's `term` is the FIRST alias
  (the canonical display term shown in SEMANTIC HINTS as `- "admission"`);
  remaining aliases fill `aliases[]`. Curators don't author a separate
  canonical term — the first alias is it. (If a curator wants a specific
  canonical, they list it first.)

### Config wiring in `prep.config.yaml`

Add an optional key under `enrich:` (default path, so an absent file is a
no-op, mirroring `glossary.seed.yaml`'s missing-file tolerance):

```yaml
enrich:
  glossary: config/glossary.seed.yaml
  aliases: config/aliases.seed.yaml        # NEW — optional; missing file = no aliases
  inferJoinEdges: { enabled: true, minConfidence: 0.8, nameMatchStrategy: "col-eq-pk" }
```

Parsed in `config.py` `_parse_enrich` → `EnrichConfig.aliases: str =
"config/aliases.seed.yaml"`. No new dataclass; one field.

## Pipeline Integration (phase ordering)

Aliases land in the **ENRICH phase**, and we exploit ordering to satisfy the
"before or together with relations" requirement:

```
[5] ENRICH (revised)
  0. alias_seed = load_aliases_seed(config.enrich.aliases)          # NEW — pure load, no catalog needed
  1. apply_importance_and_large_flag(...)
  2. apply_time_via_hints(...)
  3. joingraph = build_join_graph(
         tables, primary_keys, foreign_keys,
         min_confidence=…,
         alias_named_tables=alias_target_table_bare_refs(alias_seed),  # NEW (optional boost) — see below
     )
  4. code_table_hints = build_code_table_hints(...)
  5. synonym_alias_seed = load_synonym_alias_seed(...)               # unchanged (code_tables Layer A)
  6. auto_synonyms = build_auto_synonyms(...)
  7. auto_synonyms = resolve_auto_synonym_columns(...)
  8. alias_synonyms = compile_aliases_to_synonyms(alias_seed)        # NEW — turn seed into synonyms[]-shaped seed entries
  9. glossary = build_glossary_from_seed_file(
         catalog, glossary_seed,
         auto_synonyms=auto_synonyms_json,
         extra_synonyms=alias_synonyms,                              # NEW param, merged + resolved with hand seed
     )
```

Two integration points:

1. **Glossary merge (required, load-bearing).** Alias entries are compiled to
   the same `synonyms[]` seed shape the glossary already understands
   (`{term, aliases, maps:[{kind:table|column|temporal-column,…}]}`), then
   passed to `build_glossary_json` as an `extra_synonyms` list. `resolve_synonyms`
   resolves + validates them against the catalog for free (drops refs with no
   catalog match, per-source — identical discipline to hand-seeded synonyms).
   The emitted `glossary.json.synonyms[]` therefore contains hand-seeded AND
   alias synonyms, uniformly. No new artifact, no reader change on the bundle
   loader (it passes `glossary.json` through as an opaque dict).

2. **Join-graph name-match boost (optional, the "together with relations"
   bonus).** `build_inferred_name_match_edges` already infers FK-shaped edges
   by column-name equality, gated by `_confidence_for_match` which uses a
   `_SHARED_ID_SPACE_HINTS` allowlist to boost specific column names. We can
   pass the set of alias-named tables so that, e.g., aliasing a bridge table by
   name nudges its name-match edges above `minConfidence`. **This is genuinely
   optional** — the join graph does not need aliases to function, and the
   primary feature (table pinning) works without it. Recommend deferring the
   join-graph boost to a follow-up phase unless a concrete relation-miss shows
   up; the docstring hook is documented so it's a small additive change later.

### Why not a new `aliases.json` artifact?

Because `glossary.json` is *already* the artifact the retriever reads for
term→target mappings, and aliases are semantically synonyms. A parallel
`aliases.json` would require: a new emit path, a new loader field, a new
retriever read loop, and a new merge point with `synonyms`/`autoSynonyms` — all
duplicating machinery that already exists. Landing aliases in
`glossary.json.synonyms[]` is strictly less code and reuses the validated
resolution path. The provenance concern (which the `autoSynonyms` split solved
for machine-mined hints) does not apply: aliases are hand-authored like the
rest of `synonyms[]`.

## Merge Semantics (alias vs auto-mined synonym)

The two live in **different arrays** of `glossary.json`, so they never
literally collide in storage:

- Curator aliases → `synonyms[]` (alongside `glossary.seed.yaml` entries).
- Machine-mined → `autoSynonyms[]` (from `code_tables.py`).

At **runtime** (`_expand_question`) both arrays are scanned; a question term
can match an entry in each. Precedence rules:

1. **`synonyms[]` is scanned before `autoSynonyms[]`** (retriever.py line 525
   loop precedes line 535 loop). So a curator alias's `GlossaryHit` is emitted
   first. When both a curator alias and an auto-mined synonym resolve to a
   hosting table, the curator's pin is inserted at rank 0 first — curator wins
   the ordering. **This is the desired precedence: an explicit human alias
   overrides a machine guess.** No code change needed to get this ordering;
   it's inherent in the scan order. Document it as a guarantee.

2. **Confidence.** Curator alias synonyms carry the hand-seed default
   confidence (1.0 via `_glossary_hit_from_map`'s `confidence=1.0` for the
   `synonyms[]` loop). Auto-mined carry their mined `confidence`. Both clear
   the 0.62 pin threshold, so both pin; ordering (rule 1) decides precedence
   under a tight `max_tables`.

3. **Same term, different targets — both surface.** If a curator aliases
   "pressure" → a table and the auto-miner mined "pressure" → a coded value,
   BOTH hits render in SEMANTIC HINTS (capped at `MAX_SEMANTIC_HINTS=6`), with
   the curator's first. We do NOT dedupe across arrays; surfacing both is
   safer than silently dropping one, and the prompt cap bounds verbosity.

4. **Build-time conflict detection (validation).** If two ALIAS entries in
   `aliases.seed.yaml` map the *same alias string* to *different* targets, that
   is a curator error — the build reports it (warning by default; error under
   `--strict`). Within-seed only; we do not attempt to detect alias/auto-mined
   term overlaps at build time because they legitimately coexist (rule 3).

## Runtime Flow (SchemaContext → prompt)

Trace for "admissions in the last 24 hours" with `admission/admissions →
Shared.Acceptances`:

1. **Bundle load** (`loader.py`): `glossary.json` loaded as `LoadedBundle.glossary`.
   Its `synonyms[]` now contains the compiled alias entry:
   ```json
   { "term": "admission", "aliases": ["admissions","admit","admitted","arrived"],
     "maps": [ { "tableId": "staging.Shared.Acceptances", "kind": "table" } ] }
   ```

2. **`_expand_question`** (retriever.py line 525): "admissions" matches
   (substring of the lowercased question). Terms appended to the expanded query
   (helps BM25/dense recall too). For the `kind: table` map,
   `_glossary_hit_from_map` builds a `GlossaryHit`.
   **← REQUIRED CHANGE:** the `kind == "table"` branch must set
   `hosting_table_id = m["tableId"]` so the hit pins. (Currently it returns a
   bare `GlossaryHit(term=term)`.)

3. **`retrieve()`** (line 879): the hit's `hosting_table_id`
   (`staging.Shared.Acceptances`), confidence 1.0 ≥ 0.62, is collected into
   `pinned_table_ids` and injected at **rank 0** ahead of dense/BM25 recall.
   The bridge/pin-protect logic (line 940-956) reserves a slot so a tight
   `max_tables` cap cannot drop it.

4. **Render + prompt** (prompt.py `_render_semantic_hint`, line 314): a
   `kind: table` hit has no `resolved_column_id` and (after the change) a
   `hosting_table_id`, so it renders the "hosted on" line:
   ```
   - "admission"
       hosted on staging.Shared.Acceptances — read "admission" ONLY from Acceptances; …
   ```
   `_render_semantic_hints`' `meaningful_hits` filter (line 389) already admits
   a hit with a `hosting_table_id`, so the table alias now shows up in SEMANTIC
   HINTS. The temporal phrase "last 24 hours" resolves independently through
   the existing `temporal[]` path and is applied to Acceptances'
   `AcceptanceDate` (via the column being the pinned table's time column, or a
   `temporal-column` map if the curator marked one).

5. **Generation**: the model sees Acceptances pinned in SCHEMA CONTEXT + the
   SEMANTIC HINTS "read admission from Acceptances" steer + the JOIN GRAPH.

For a **column alias**, step 2 goes through the `kind == "column"` branch
(already returns `resolved_column_id`), plus the same new
`hosting_table_id`-from-column derivation so the column's table also pins;
step 4 renders the `value:` line.

## Phased Plan (concrete file touch-points)

### Phase 1 — Config + compile + validate (prep side; no runtime change yet)

- `config/aliases.seed.yaml` — NEW file (start with the admission→Acceptances
  example so it's exercised by the staging build).
- `prep/prep/config.py`:
  - `EnrichConfig`: add `aliases: str = "config/aliases.seed.yaml"`.
  - `_parse_enrich`: read `raw.get("aliases", "config/aliases.seed.yaml")`.
- `prep/prep/enrich/aliases.py` — NEW module:
  - `load_aliases_seed(path) -> AliasSeed` (tolerant missing-file → empty,
    mirroring `load_glossary_seed`). Lowercase-normalizes alias strings.
  - `compile_aliases_to_synonyms(seed) -> list[dict]`: turns each table/column
    entry into a `synonyms[]`-shaped seed dict (`term`=first alias, `aliases`=rest,
    `maps`=`[{kind:table, tableRef:…}]` or `[{kind:column, columnRef:…, timeColumnRef?, unit?}]`,
    plus a `{kind:temporal-column, columnRef}` map when `isTimeColumn: true`).
  - `validate_aliases(seed, catalog) -> list[AliasValidationIssue]`: reports
    (a) target table/column not present in catalog (per-source aware — only an
    issue if NO source has it), (b) duplicate alias→different target within the
    seed, (c) an alias colliding with an existing `glossary.seed.yaml` term
    (warning). Reuses `build_catalog_index` from `glossary.py` for lookups.
- `prep/prep/enrich/glossary.py`:
  - `build_glossary_json(..., extra_synonyms: list[dict] | None = None)` — new
    optional param; `resolve_synonyms(seed_synonyms + extra_synonyms, index)`.
  - `build_glossary_from_seed_file(..., extra_synonyms=None)` — thread through.

### Phase 2 — Pipeline wiring (prep `cmd_build`)

- `prep/prep/cli.py` `_run_build_pipeline_p3b`:
  - Load alias seed early in ENRICH (step 0).
  - `alias_synonyms = compile_aliases_to_synonyms(alias_seed)`.
  - Run `validate_aliases(alias_seed, catalog)`; log issues; under a strict
    flag (reuse `phiGate.failOnViolation`-style pattern or a new
    `enrich.failOnAliasError`) fail the build on hard issues.
  - Pass `extra_synonyms=alias_synonyms` to `build_glossary_from_seed_file`.
  - Add `aliasCount` to the ENRICH `BuildStage.extra` telemetry.

### Phase 3 — Runtime pin fix (nl2sql side; the load-bearing change)

- `ceiba_nl2sql/ceiba_nl2sql/retrieval/retriever.py` `_glossary_hit_from_map`:
  - `kind == "table"`: set `hosting_table_id = m.get("tableId")`.
  - `kind == "column"`: additionally set `hosting_table_id` = the column's
    table id (`".".join(columnId.split(".")[:-1])`) so a column alias also
    pins its table.
  - This changes behavior for the EXISTING hand-seeded `kind: table` synonyms
    (patient/hospital/ward/vitals) too — they will now pin. That is arguably a
    latent-bug fix (they were meant to be found), but call it out in the PR and
    verify against the benchmark that pinning these common tables doesn't
    crowd out better recall under tight `max_tables`. If it regresses, gate the
    table-pin behind a per-map opt-in flag (`"pin": true`) that
    `compile_aliases_to_synonyms` sets but the legacy hand seed does not.

### Phase 4 — (optional) join-graph name-match boost

- `prep/prep/enrich/joingraph.py` `build_join_graph` /
  `build_inferred_name_match_edges` / `_confidence_for_match`: accept an
  `alias_named_tables: set[str]` and treat an alias-named table's shared column
  as a shared-id-space hint. Defer unless a relation-miss motivates it.

## Test Strategy (follow existing ~150-test patterns)

Prep tests live in `prep/tests/` (e.g. `test_code_tables.py`,
`test_table_filter.py`, `test_glossary*.py`). NL2SQL tests in
`ceiba_nl2sql/…/tests/` (`test_retriever.py`).

- `prep/tests/test_aliases.py` (NEW):
  - `load_aliases_seed`: missing file → empty; case normalization; both
    `tables`/`columns` sections parse.
  - `compile_aliases_to_synonyms`: table entry → `kind:table` map; column
    entry → `kind:column` map; `isTimeColumn` → extra `temporal-column` map;
    first-alias-becomes-term.
  - `validate_aliases`: unknown table → issue; unknown column → issue;
    present-in-one-source-only → NOT an issue; duplicate alias→different
    target → issue.
- `prep/tests/test_glossary*.py` (extend): `build_glossary_json` with
  `extra_synonyms` merges + resolves them; alias to a table absent from the
  catalog is dropped (empty `maps[]`), present in one source resolves per-source
  — reuse the existing mock/staging catalog fixtures.
- `ceiba_nl2sql/…/tests/test_retriever.py` (extend):
  - `_glossary_hit_from_map` `kind:table` now carries `hosting_table_id`.
  - `kind:column` carries a derived `hosting_table_id`.
  - End-to-end `retrieve()` on a hand-built bundle: a table-alias term pins its
    target at rank 0 and survives a `max_tables=1` cap (pin-protect).
- Prompt: extend a `prompt.py` render test to assert the "hosted on …" line
  appears for a table-alias hit.
- Build smoke: extend the existing `cmd_build` integration test (if present) to
  assert `glossary.json.synonyms[]` contains the compiled admission alias when
  `aliases.seed.yaml` is present.

## Open Questions

1. **Should Phase 3's table-pin apply to the legacy hand-seeded `kind: table`
   synonyms, or only to alias-compiled ones?** Applying it universally is
   cleaner and likely a bug fix, but changes retrieval for patient/hospital/ward.
   Recommend: apply universally, verify on the benchmark, and keep the
   `"pin": true` opt-in flag in reserve if it regresses recall.
2. **Strict-mode surface for alias validation errors** — reuse
   `phiGate.failOnViolation` semantics with a new `enrich.failOnAliasError`
   (default false → warn), or a `--strict-aliases` CLI flag? Recommend a config
   key for parity with the rest of ENRICH.
3. **Alias → coded-measurement.** The current design supports table + column
   aliases. Should a curator also be able to alias a term directly to a coded
   measurement (e.g. "cardiac output" → a specific `MeasurementTypeId`)? That
   is already expressible in `glossary.seed.yaml`'s `coded-measurement` maps;
   keep it there rather than duplicating that complexity in the simpler
   aliases file. Confirm with the user that aliases are table/column only.
4. **Do the join-graph boost (Phase 4) now or defer?** Recommend defer — the
   pinning feature is self-contained and the join graph works without it.
```
