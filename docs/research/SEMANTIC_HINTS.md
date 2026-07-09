# Auto-Generating a Semantic Hint Layer: NL Term → Lookup VALUE → Hosting TABLE + Join Path

**Status:** research + decision-grade recommendation (feeds implementation immediately).
**Scope:** how to AUTO-MINE, from the database itself, a semantic hint layer that maps clinical NL terms to (a) lookup-table code VALUES (`"heart rate"` → `MonitorMeasurementTypes.Id = 2`) and (b) the hosting/measurement TABLE + join path to patients (`MonitorMeasurements.Value`, joined `Monitors→Acceptances→Patients`); how to surface it into retrieval (boosting the hosting table into the survivor set) and into the generation prompt (a `SEMANTIC HINTS` value-mapping block).
**Read-only research.** No code was changed; this is the only file created.
**Composes with:** `docs/research/JOINGRAPH_SURFACING.md` — that doc supplies the join-graph surfacing + bridge-path mechanism; this doc supplies the term→value→hosting-table hint that seeds the survivor pair those bridge paths connect.

---

## 0. TL;DR — the recommendation

1. **Auto-mine "code tables" from the schema** (§1). A generic detector flags a table as a lookup/enum vocabulary when it is (a) low row count, (b) has the `(id, name)` two-to-few-column shape, (c) is *referenced by an FK* from a fact table, and (d) its name/label column is low-cardinality non-PHI text. For each such table emit `{canonical_name → code_id}` rows (e.g. `MonitorMeasurementTypes → {'HR':2,'SPO2':12,…}`). Names only, never patient values — PHI-safe by construction.
2. **Layer synonym expansion** (§2): a small **hand-curated clinical alias seed** (`HR ↔ heart rate ↔ pulse`, `SPO2 ↔ oxygen saturation`) as the high-precision core, plus a **local-embedding fallback** (fastembed / bge-small, already in the bundle pipeline) that matches an unmatched NL phrase to the mined canonical names by cosine similarity above a threshold. No external ontology API required; LOINC/SNOMED/UMLS are documented as an *optional* offline enrichment, not a dependency (§2.4). This curated-seed + embedding-fallback pair **is** the "similarity matrix" the user asked for.
3. **The routing hint is a `coded-measurement`-style record** that already exists in `glossary.json` — extend it, do not invent a new artifact (§3). Each hint binds: the matched `codeValue` (2), the `codeRefTableId`/`codeRefColumnId` (the lookup row's home), the **hosting** `valueColumnId` (`MonitorMeasurements.Value`) + `codeColumnId` (`MeasurementTypeId`), the `timeColumnId`, and (new) a `hostingTableId` used purely as a retrieval-boost anchor. Add a machine-mined block `glossary.autoSynonyms` distinct from the hand-seeded `synonyms`, tagged with `confidence` and `provenance`.
4. **Retrieval boost fixes the recall gap** (§4): when a hint's term/alias matches the question, **inject its `hostingTableId` directly into the table-recall survivor set** (a "glossary pin"), bypassing the dense/BM25 stage that failed on `MonitorMeasurements` (no "heart" in the name, empty grain). The join-graph work (`JOINGRAPH_SURFACING.md` §2–3) then pulls in the bridge tables `Monitors`/`Acceptances` toward `Patients`. This is the mechanism that fixes "HR above 120" returning 0.
5. **Prompt rendering** (§5): a dedicated `SEMANTIC HINTS` block rendered in the exact M-Schema value-example spirit — `"HR" / "heart rate" → filter "MonitorMeasurements"."MeasurementTypeId" = 2; value "MonitorMeasurements"."Value" (unit=bpm); time "MonitorMeasurements"."MeasuredDate"`. Full rendered HR example in §5.2.
6. **Bounded at 1,200 tables** (§6): only low-card lookup vocabularies are mined and only *matched* hints are rendered per query, so the token cost scales with the question, not the schema. Never embed every value of every table.
7. **Precision/safety** (§7): every emitted hint must be backed by a *real lookup row* + a *real FK* (no hallucinated mappings); ambiguous short tokens (`MAP` the pressure vs. "map") are gated by word-boundary + confidence thresholds + a stop-token deny-list; only lookup *names* are embedded, never patient VALUES.

Expected impact: converts the HR failure from "0 rows / wrong table" into a correct query, and generalizes to every `*Types`/`*Statuses`/`*Categories` vocabulary in the schema for free.

---

## 1. Auto-mining the synonym/value matrix from the DB

### 1.1 The problem

The schema has ~1,200 tables, many of them low-cardinality lookup/enum tables (`…Types`, `…Statuses`, `…Categories`) — "synonym mines". `MonitorMeasurementTypes(Id, Name)` with 12 rows is the canonical case: its `Name` values (`HR`, `SPO2`, `TEMP`, …) are a *controlled clinical vocabulary* that already exists in the database, and the FK `MonitorMeasurements.MeasurementTypeId → MonitorMeasurementTypes.Id` tells us both *which code* a term maps to and *where the measured value lives*. The task is to extract this generically, without hand-listing every lookup table.

This is exactly BIRD's "external knowledge evidence — domain hints, value mappings, and synonym definitions" ([BIRD](https://bird-bench.github.io/)), except **auto-derived from the DB** rather than hand-authored per question.

### 1.2 The code-table detector (generic heuristic)

A table `T` is classified as a **lookup/code vocabulary** when ALL of:

| Signal | Rule | Rationale |
|---|---|---|
| **Low row count** | `approxRowCount ≤ CODE_TABLE_MAX_ROWS` (recommend **200**) | Enum/reference tables are tiny; fact tables are not. `reltuples`, never `COUNT(*)` (§ mirrors `aggregate_profile.py`). |
| **Code-table shape** | has a single-column PK of integer/short-string type, AND ≤ `CODE_TABLE_MAX_COLS` columns (recommend **6**), AND at least one non-PK **text label column** | The `(Id, Name[, Description, …])` shape. |
| **Referenced by an FK** | appears as the `to` (PK) side of ≥1 join-graph edge whose `from` side is a larger fact table | A vocabulary is *used*; an orphan tiny table is not a code table for our purposes. This is the discriminator that separates real vocabularies from incidental small tables. |
| **Low-card non-PHI label** | the label column profiles as `kind="categorical"`, `distinctCount ≤ HIGH_CARDINALITY_ABSOLUTE` (20), `phiClass == "non-phi"` | Reuses the existing `aggregate_profile.py` classification verbatim — the label must be safe to embed. |

The **label column** (the human-readable name) is picked by, in order: a column literally named `Name`/`Label`/`Code`/`ShortName`/`Description`; else the single non-PK, non-FK text column; else skip the table (ambiguous). The **id column** is the single-column PK.

> Naming (`…Types`/`…Statuses`/`…Categories`) is a *weak positive prior only* — used to boost ranking/confidence, **never** as a hard filter, because plenty of vocabularies (like `MonitorMeasurementTypes` — matches, but also `Units`, `Wards`, `Genders`) don't follow the suffix convention and plenty of `…Type` columns are not tables. The structural signals (row count + shape + FK-referenced) are authoritative.

This mirrors the classic literature definition: "if a text column contains only a few distinct values (low cardinality) it may … be transformed into a lookup value" and "cardinalities may be detected … by analyzing the primary and foreign keys of the tables, or by row count" ([enum/code-table detection](https://medium.com/@sathishdba/clickhouse-understanding-lowcardinality-vs-enum-columns-9c09b26467d9); [USPTO 11892973, code-description → enum](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11892973)).

### 1.3 Extracting the (id, canonical_name) rows — PHI-safe

The prep toolchain **already samples low-cardinality columns into `profiles.json.topCategories`** (`aggregate_profile.py`: categorical + non-PHI + `distinct ≤ 20` → up to 8 labels with counts). For a ≤200-row code table we can read the full `(id, label)` pairs directly (this is *not* PHI — lookup names are vocabulary, per the PHI note), through the same single data-touching path (`sample_aggregate_from_rows`), fetching `SELECT id_col, label_col FROM T` bounded by the row-count guard.

Output per code table:

```jsonc
{
  "codeTableId": "staging.Shared.MonitorMeasurementTypes",
  "idColumnId":  "staging.Shared.MonitorMeasurementTypes.Id",
  "labelColumnId":"staging.Shared.MonitorMeasurementTypes.Name",
  "referencedBy": [                       // from join-graph: the fact tables that USE this code
    { "factTableId": "staging.Shared.MonitorMeasurements",
      "fkColumnId":  "staging.Shared.MonitorMeasurements.MeasurementTypeId" }
  ],
  "codes": [ {"id": 2, "name": "HR"}, {"id": 12, "name": "SPO2"}, {"id": 9, "name": "TEMP"}, … ]
}
```

**PHI discipline:** we emit `name` (the *vocabulary label*, e.g. `HR`) — never any value from the *fact* table (`MonitorMeasurements.Value` is a patient reading and is never listed). This is exactly the existing gate invariant (SPEC §2.5: "no `topCategories` for a `phiClass != non-phi` column"); the mined codes are subject to the same PHI gate scan.

### 1.4 Why this generalizes across 1,200 tables

The detector is O(tables) over metadata already in `catalog.json` + `joingraph.json` + `profiles.json`; it touches data only for the handful of tables passing the ≤200-row structural filter. Every `*Types`/`*Statuses`/`*Categories`/units/wards vocabulary in `CeibaHospitalDB` becomes a synonym source automatically. This is CodeS's "build an index of *all values*… then match" idea ([CodeS §value retriever](https://arxiv.org/pdf/2402.16347)) but restricted to the *low-cardinality vocabulary subset*, which is the only part that is both PHI-safe and cheap.

---

## 2. Expanding synonyms — the layered "similarity matrix"

The mined codes give us `HR`, `SPO2`, `TEMP` — the *canonical* names. Users type `heart rate`, `pulse`, `oxygen saturation`, `o2 sat`, `temperature`. We need `NL phrase → canonical mined name`. Three sources, layered by precision:

### 2.1 Layer A — hand-curated clinical alias seed (high precision, small)

A tiny YAML block, `config/synonym_aliases.seed.yaml`, keyed by canonical mined name:

```yaml
HR:    [heart rate, pulse, hr, ventricular rate]
SPO2:  [oxygen saturation, o2 sat, spo2, sats, pulse ox]
TEMP:  [temperature, temp, body temperature]
MAP:   [mean arterial pressure, mean art pressure]   # NOT "map"; see §7
NIMAP: [non-invasive mean arterial pressure, nibp mean]
CVP:   [central venous pressure]
```

~30–60 lines covers the vitals vocabulary. This is the authoritative, hand-verified core. The seed is **matched against the mined names**, so an alias only survives if a real code row exists for its key — you cannot author an alias for a code that isn't in the DB (no hallucination; same discipline as `glossary.py`'s reference resolution). Clinical NL2SQL work confirms this is necessary: **"over 33% of abbreviations in the UMLS have multiple meanings, rising to 54% in clinical reports"** — a curated, DB-scoped seed sidesteps that ambiguity where a generic ontology would inject noise ([UMLS abbreviation ambiguity](https://www.nlm.nih.gov/research/umls/Snomed/nursing_terminology_resources.html); [Robust Clinical Querying with Local LLMs — lexical challenges in NL2SQL](https://www.mdpi.com/2504-2289/9/10/256)).

### 2.2 Layer B — local-embedding fallback (recall, zero-config)

For any NL phrase in the question that Layer A doesn't cover, embed the phrase and the mined canonical names (+ their descriptions if the code table has a `Description` column) with the **same local fastembed / bge-small-en-v1.5 model already used for the bundle vectors** (SPEC §2.2: "LOCAL ONLY — no external API"), and match by cosine ≥ `SYNONYM_SIM_THRESHOLD` (recommend **0.62** for bge-small; tune on the golden set). This catches `"heart beat"`, `"pulse rate"`, misspellings, phrasings the seed missed — the "embedding-similarity expansion" the user described.

Because bge-small is trained on general English, `heart rate`↔`HR` similarity is moderate (abbreviations are hard for embedders); embedding a **short gloss** with each code (`"HR — heart rate, beats per minute"`, itself derived from the seed alias + unit) rather than the bare token `HR` sharply improves this. So Layer A doubles as the *gloss source* that makes Layer B work. This is the standard pattern (embed a descriptive document, not a bare code).

### 2.3 Layer C — this IS the similarity matrix

Materialize, at build time, the cross product **{mined canonical names} × {seed aliases ∪ their glosses}** with cosine scores as an auditable `autoSynonyms` table. Each row: `{term, canonicalName, codeTableId, codeId, score, provenance ∈ {curated, embedding}}`. Curated rows get `score = 1.0`. Rows below threshold are dropped. This is the persisted "similarity/synonym matrix"; the retriever just does exact/substring lookup against it at query time (no live embedding of code names per query — precomputed).

### 2.4 Ontologies (LOINC/SNOMED/UMLS) — optional, not a dependency

Feasible but **not recommended as a core dependency**:

- **LOINC** is free (with registration) and *does* cover vital signs (HR, SpO2, temperature, hemodynamics) ([LOINC vital signs](https://www.cdc.gov/laboratory-systems/php/livd-test-codemapping/index.html)). SNOMED CT requires a UMLS/member-country license; UMLS requires a (free) license + agreement.
- The value they add — synonyms for our ~12 vitals — is almost entirely covered by the ~50-line seed. The licensing, size (UMLS is 4M+ concepts / 12M+ names), and ambiguity (54% multi-meaning abbreviations) cost more than they return at this scope.
- **Recommendation:** ship the curated-seed + embedding layers now. Leave a documented *offline* hook: a build step that, if a locally-licensed LOINC/SNOMED subset file is present, merges additional aliases into the seed (SSSOM-style mapping file, [SSSOM](https://arxiv.org/pdf/2112.07051)). Never call a network terminology API at build or query time.

**Pragmatic verdict:** curated seed (precision) + local-embedding fallback (recall) + optional offline ontology merge. Matches the systematic-review finding that automated terminology mapping is an unsolved, precision-sensitive problem ([systematic review of clinical terminology mapping, 2018–2025](https://www.sciencedirect.com/science/article/pii/S2590005626000585)) — so keep the authoritative layer hand-curated and DB-scoped.

---

## 3. The routing hint: term → table + value + join

### 3.1 Reuse the existing `coded-measurement` map — do not invent a new top-level artifact

`glossary.py` **already** resolves a `coded-measurement` seed entry into exactly the shape we need (`valueColumnId`, `codeColumnId`, `codeRefTableId`, `codeRefColumnId`, `codeValue`, `timeColumnId`, `unit`) and `retriever.py._glossary_hit_from_map` already consumes it. The gap is that today these are **hand-seeded**; the recommendation is to **auto-generate `coded-measurement` maps from the mined code tables + FK graph**, and to add the fields needed for retrieval boost + prompt rendering.

Keep everything inside `glossary.json` (SPEC §1.9). Add two things:

1. **`glossary.autoSynonyms`** — the machine-mined matrix from §2.3 (kept *separate* from hand-authored `synonyms` so provenance is auditable and the two can be gated independently). Each entry resolves to a `coded-measurement` map exactly like a hand-seeded synonym.
2. **Two fields on the `coded-measurement` map**: `hostingTableId` (the fact table the value lives on — the retrieval-boost anchor) and `confidence` (from §2.3).

### 3.2 Extended `coded-measurement` map (auto-generated)

```jsonc
{
  "autoSynonyms": [
    {
      "term": "HR",
      "aliases": ["heart rate", "pulse"],
      "provenance": "curated",          // or "embedding"
      "confidence": 1.0,
      "maps": [
        {
          "kind": "coded-measurement",
          "codeValue": 2,                                                   // MeasurementTypeId
          "codeRefTableId":  "staging.Shared.MonitorMeasurementTypes",       // the lookup ROW's home
          "codeRefColumnId": "staging.Shared.MonitorMeasurementTypes.Id",
          "codeColumnId":    "staging.Shared.MonitorMeasurements.MeasurementTypeId", // the FK on the fact
          "valueColumnId":   "staging.Shared.MonitorMeasurements.Value",     // WHERE the reading lives
          "hostingTableId":  "staging.Shared.MonitorMeasurements",           // NEW: retrieval-boost anchor
          "timeColumnId":    "staging.Shared.MonitorMeasurements.MeasuredDate",
          "unit": "bpm"
        }
      ]
    }
  ]
}
```

Everything here is *derived, not authored*: `codeValue`/`codeRefTableId`/`codeRefColumnId` come from the mined code table (§1.3); `codeColumnId`/`hostingTableId`/`valueColumnId` come from the FK edge (`MonitorMeasurements.MeasurementTypeId → …Types.Id`); `valueColumnId` is the fact table's measurement column (heuristic: a numeric non-PK non-FK column named `Value`/`Reading`/`Result`/`Amount`, or the single dominant numeric column); `timeColumnId` is the fact's `isTimeColumn`; `unit` from `catalog.unit` or the seed. `aliases`/`confidence`/`provenance` come from §2.

### 3.3 Why `hostingTableId` is the load-bearing new field

The existing `GlossaryHit` carries `resolved_column_id` (the value column) but the retriever never uses it to *change which tables are recalled* — it only decorates the prompt. `hostingTableId` is the explicit hook the retriever pins into the survivor set (§4). Without it, the hint is descriptive; with it, the hint is *causal* for recall.

---

## 4. Retrieval integration — the recall fix

### 4.1 The failure, precisely

"HR above 120" fails because table recall (`retriever.py._recall_tables`, hybrid dense+BM25+importance) never surfaces `MonitorMeasurements`:
- **BM25:** the table's doc text (`_build_index`) is `tableId quotedRef: grain. columns: …`; there is **no token "heart"** and the grain is empty, so lexical match is ~0.
- **Dense:** bge-small embeds the (empty-grain) table doc; "heart rate above 120" is not close to "MonitorMeasurements … columns: DeviceId, MeasurementTypeId, Value".
- The FK graph-expand (stage 5) only expands *from survivors*, so if `MonitorMeasurements` never survives, its neighbors never get pulled either.

The code value `2` and the fact table are *knowable from the schema*, but nothing connects the phrase "heart rate" to the table `MonitorMeasurements`. That connection is exactly the mined hint.

### 4.2 The boost mechanism — a "glossary pin" before recall fusion

Add a stage between `_expand_question` (stage 1, which already produces `glossary_hits`) and the survivor cutoff:

```
matched_hints = hints whose term/alias matched the question   (already computed in _expand_question)
pinned_tables = { m.hostingTableId for h in matched_hints for m in h.maps
                  if m.confidence >= HINT_PIN_THRESHOLD }        # recommend 0.62 (embedding) / always (curated)
recall_survivors = pinned_tables ∪ recalled_table_ids           # UNION — pin bypasses dense/BM25 ranking
```

`pinned_tables` are inserted at the **front** of the survivor list (rank 0) so the token-budget/prune stage keeps them. Then the existing `_graph_expand` — and, per `JOINGRAPH_SURFACING.md` §2–3, the **BFS bridge-path expansion** — pulls `Monitors`/`Acceptances` onto the path to `Patients`. So the two docs compose exactly:

```
this doc:  "heart rate" → pin hosting table MonitorMeasurements into survivors
joingraph: MonitorMeasurements ↔ Patients has no direct edge → BFS finds
           MonitorMeasurements →(N:1) Monitors →(N:1) Acceptances →(N:1) Patients
           → bridge-protect Monitors, Acceptances into the render
```

The pin is the *seed*; the bridge expansion is the *closure*. Neither alone fixes HR: without the pin, `MonitorMeasurements` is never in the pair; without the bridge paths, the pin reaches a table with no visible route to `Patients`.

This directly implements the "value hints … explicitly guide the model to recognize database values mentioned in queries" finding, and the observation that **"imperfect recall from [value/schema-linking] stages propagates and becomes a performance bottleneck"** — the pin is a *guaranteed-recall* path for known coded vocabulary, immune to embedding/BM25 miss ([Enhanced Schema Linking via Self-Verification and Value Hints](https://www.mdpi.com/2504-2289/10/4/104); [Rethinking Schema Linking: bidirectional retrieval](https://arxiv.org/pdf/2510.14296)).

### 4.3 Bidirectional confirmation (optional precision guard)

The bidirectional-retrieval literature suggests a cheap confirmation: after pinning `MonitorMeasurements` via the term, verify the pin by checking that at least one *column* the question needs (`Value`, or the `codeColumn`) is present — which it always is for a coded-measurement hint. Effectively free here; worth keeping as an assertion so a malformed hint can't pin an unrelated table ([2510.14296](https://arxiv.org/pdf/2510.14296)).

---

## 5. Prompt rendering — the `SEMANTIC HINTS` value-mapping block

### 5.1 Format, grounded in M-Schema value-example convention

M-Schema (the serialization behind XiYan-SQL, a top BIRD/Spider system) renders each column as a tuple `(name:TYPE, comment, Primary Key, Examples: [v1, v2, v3])` and foreign keys as `table.col=reftable.refcol` ([M-Schema `m_schema.py`](https://github.com/XGenerationLab/M-Schema); [XiYan-SQL](https://arxiv.org/pdf/2411.08599v1) — "each column includes the column name, data type, column description, primary key identifier, and example values"). Our semantic hint is the *value-linking* analogue: instead of generic example values, we give the model the **exact code value to filter on** plus **where it lives**. We follow M-Schema's conventions: the `A.col = B.col` FK notation and the "here are the concrete values" framing.

The block sits between `SCHEMA CONTEXT` and the `JOIN GRAPH` block (so the model reads term→code→hosting-table, then the join graph tells it how the hosting table reaches patients). It composes with `JOINGRAPH_SURFACING.md` §8.1 verbatim.

### 5.2 Rendered example — "HR above 120 in the last 3 hours"

```
SEMANTIC HINTS (resolve NL terms to exact coded values; prefer a literal code filter over an extra lookup join):

- "HR" / "heart rate" / "pulse"
    filter:  "MonitorMeasurements"."MeasurementTypeId" = 2      -- code 2 = 'HR' in "MonitorMeasurements Types"
    value:   "MonitorMeasurements"."Value"    (unit = bpm)      -- "above 120" → "Value" > 120
    time:    "MonitorMeasurements"."MeasuredDate"               -- use for "last 3 hours"
    hosted on "MonitorMeasurements"; to reach patients, follow the JOIN GRAPH path below.

---

JOIN GRAPH (use these exact join predicates; direction FK-side → PK-side, [card] is row multiplicity):

Edges among selected tables:
  "MonitorMeasurements"."DeviceId"  = "Monitors"."Id"      [N:1]
  "Monitors"."AcceptanceId"         = "Acceptances"."Id"   [N:1]
  "Acceptances"."PatientId"         = "Patients"."Id"      [N:1]

Multi-hop path (measurement → patient), all N:1 — one patient per measurement, so COUNT(DISTINCT "Patients"."Id"):
  "MonitorMeasurements" →(DeviceId=Id) "Monitors" →(AcceptanceId=Id) "Acceptances" →(PatientId=Id) "Patients"

BRIDGE tables (present only to connect the above — do not SELECT business columns):
  - "staging"."Shared"."Monitors"     join cols: "Id", "AcceptanceId"
  - "staging"."Shared"."Acceptances"  join cols: "Id", "PatientId"
```

A model given this writes: `… FROM "Shared"."MonitorMeasurements" mm JOIN "Shared"."Monitors" mo ON mm."DeviceId"=mo."Id" JOIN "Shared"."Acceptances" a ON mo."AcceptanceId"=a."Id" WHERE mm."MeasurementTypeId"=2 AND mm."Value">120 AND mm."MeasuredDate" >= now() - INTERVAL '3 hours'` — copying every fact instead of guessing.

### 5.3 Rendering rules

- Render a hint **only if its term/alias matched the question** (never dump all mined vocabulary — §6).
- If the code value is stable and the query only filters (not displays) the type, **prefer the literal `MeasurementTypeId = 2`** over joining the lookup table (saves a join; the code is baked in). Render the lookup join form only if the query needs the *name* in output.
- One hint = ~40–70 tokens. Cap at `MAX_SEMANTIC_HINTS` (recommend 6) matched hints per query.
- Show the `-- code N = 'NAME'` inline comment so the model (and a human auditor) can see the provenance of the literal.

---

## 6. Generality + scale

- **Only low-card vocabularies are mined** (§1.2): the ≤200-row + FK-referenced filter admits the ~dozens of lookup tables in a 1,200-table schema, not the fact tables. Never embed every value of every table — that is the anti-pattern CodeS avoids with a BM25 pre-filter, and which we avoid entirely by scoping to vocabularies ([CodeS](https://arxiv.org/pdf/2402.16347)).
- **Build-time cost:** O(tables) metadata scan + a bounded `SELECT id,label` per code table. Trivial next to profiling.
- **Query-time cost:** a hash lookup of question tokens/phrases against the precomputed `autoSynonyms` matrix; no live embedding of code names (precomputed at build). Prompt cost scales with *matched* hints, not schema size.
- **Bundle-size cost:** the matrix is names+ids+scores — kilobytes even for hundreds of vocabularies.
- **DB-agnostic:** the detector uses only `catalog`/`joingraph`/`profiles` (already DB-neutral); the same code mines a non-clinical schema's `OrderStatuses`/`Countries`/`Currencies` vocabularies with no clinical assumptions.

---

## 7. Precision / safety

| Risk | Guard |
|---|---|
| **Homograph / short-token ambiguity** — `MAP` (mean arterial pressure) vs. "map"; `PA` (pulmonary artery) vs. "PA" the state; `TEMP` vs. "temp(orary)" | (a) Match aliases with **word boundaries** and prefer the **multi-word alias** (`mean arterial pressure`) over the bare abbreviation; (b) a **stop-token deny-list** for bare abbreviations that are common English words (`map`, `temp`, `pa`, `sap`) — the bare form only fires when accompanied by a clinical context token or when the multi-word alias matched; (c) confidence-gate embedding matches at `SYNONYM_SIM_THRESHOLD`. Clinical NL2SQL explicitly names this ("54% of clinical abbreviations are multi-meaning") — the deny-list is the mitigation ([Robust Clinical Querying / lexical challenges](https://www.mdpi.com/2504-2289/9/10/256)). |
| **Hallucinated mapping** — a hint for a code/table that doesn't exist | Every hint is *resolved against the catalog + join-graph at build time* (the `glossary.py` reference-resolution discipline): no code row → no hint; no FK edge → no `hostingTableId`. A hint is emitted **iff** a real lookup row AND a real FK back it. |
| **Wrong hosting table** — a code table referenced by several facts | Emit one `coded-measurement` map **per referencing fact table**; at query time the join-graph proximity to other survivors disambiguates which fact is relevant (usually there is one dominant fact per vocabulary, e.g. `MonitorMeasurements` for `MonitorMeasurementTypes`). |
| **Low-confidence embedding synonym pins the wrong table** | Two thresholds: `SYNONYM_SIM_THRESHOLD` (admit into matrix) < `HINT_PIN_THRESHOLD` (allowed to *pin* a table into recall). Curated (`confidence=1.0`) always pins; embedding synonyms only pin above the higher bar, else they just expand the query text (soft signal) without a hard pin. |
| **PHI leakage** | Only lookup *label* columns are read/embedded, and only when they profile `phiClass == "non-phi"` + low-card (§1.2). Patient VALUES (`MonitorMeasurements.Value`) are never listed, never embedded — same invariant the PHI gate (SPEC §2.5) already enforces on `glossary.json`. The mined `autoSynonyms` block is added to the gate's scanned files. |

---

## 8. Concrete build spec (implementer-ready)

### 8.1 Prep-toolchain algorithm — mine code tables + build the hint set

New module `prep/prep/enrich/code_tables.py`, run in stage [3.5] (after profile, before glossary emit), consuming `catalog.json` + `joingraph.json` + `profiles.json`:

```
INPUT: catalog, joingraph, profiles, alias_seed (config/synonym_aliases.seed.yaml), embedder (local bge-small)
CONFIG: CODE_TABLE_MAX_ROWS=200, CODE_TABLE_MAX_COLS=6, SYNONYM_SIM_THRESHOLD=0.62, HINT_PIN_THRESHOLD=0.62

1. DETECT code tables:
   for each table T:
     if approxRowCount(T) <= CODE_TABLE_MAX_ROWS
        and single-column integer/short-string PK
        and len(columns) <= CODE_TABLE_MAX_COLS
        and T is the PK-side of >=1 join-graph edge from a larger fact table
        and label_col := pick_label_column(T) is categorical, distinct<=20, non-PHI:
            mark T as code_table with (id_col=PK, label_col)

2. EXTRACT codes (PHI-safe, single data touch via sample_aggregate path):
   for each code_table T: codes[T] = SELECT id_col, label_col FROM T  (bounded by row guard)

3. RESOLVE hosting facts from join-graph:
   for each code_table T, for each edge (fact.fk -> T.id):
       hosting[T].append({ factTableId, fkColumnId=fact.fk,
                           valueColumnId = pick_value_column(fact),      # numeric Value/Reading/Result
                           timeColumnId  = fact.isTimeColumn })

4. BUILD synonym matrix (§2.3):
   canonical_names = {code.name for all code tables}
   for each canonical name c:
       aliases = alias_seed.get(c, [])                 # curated, confidence 1.0
       gloss   = build_gloss(c, aliases, unit)         # "HR — heart rate, bpm"
   # embedding fallback done at QUERY expand-time OR precomputed here for common phrases:
   #   optional: embed gloss(c); store vector for query-time cosine, OR
   #   precompute matrix rows for a phrase-bank if desired.

5. EMIT glossary.autoSynonyms[]: one entry per (canonical name), maps[] = one coded-measurement
   map per hosting fact, carrying codeValue, codeRefTableId/Column, codeColumnId,
   valueColumnId, hostingTableId, timeColumnId, unit, confidence, provenance.

6. PHI GATE: autoSynonyms is added to SPEC §2.5 scanned files (names only asserted).
```

`pick_value_column(fact)`: numeric, non-PK, non-FK, name ∈ {`Value`,`Reading`,`Result`,`Amount`,`Measurement`} else the single dominant numeric column; skip (emit map without `valueColumnId`) if ambiguous.

### 8.2 Bundle artifact schema — extend `glossary.json` (no new file)

Add to `glossary.json` (SPEC §1.9): a top-level `"autoSynonyms": [...]` array with the §3.2 shape, and two new optional fields (`hostingTableId`, `confidence`) on the existing `coded-measurement` map. Rationale: the loader, PHI gate, and `retriever._glossary_hit_from_map` already know `glossary.json` and `coded-measurement`; adding a sibling array + two fields is strictly additive and backward-compatible. Keeping `synonyms` (hand) and `autoSynonyms` (mined) separate preserves provenance and lets the two be thresholded independently.

`GlossaryHit` (retriever) gains `hosting_table_id: str | None` and `confidence: float = 1.0`; `_glossary_hit_from_map` sets them for the `coded-measurement` branch.

### 8.3 Retrieval-boost mechanism

In `HybridRetriever.retrieve`, after `_expand_question` yields `glossary_hits`:
```
pinned = { h.hosting_table_id for h in glossary_hits
           if h.hosting_table_id and h.confidence >= HINT_PIN_THRESHOLD }
recalled_table_ids = list(pinned) + [t for t in recalled_table_ids if t not in pinned]
```
Everything downstream (`_graph_expand`, the `JOINGRAPH_SURFACING.md` `_bridge_expand`, prune, render) is unchanged — the pin just guarantees the hosting table is in the survivor set at rank 0. Add `HINT_PIN_THRESHOLD` as a `RetrieveOptions`/constant.

### 8.4 Prompt block

Add `_render_semantic_hints(glossary_hits, rendered_tables)` to `prompt.py` (`ceiba_nl2sql/generation/prompt.py`), inserted between SCHEMA CONTEXT and the JOIN GRAPH block (`JOINGRAPH_SURFACING.md` §8.3 adds `_render_join_graph` in the same spot; order: SCHEMA → SEMANTIC HINTS → JOIN GRAPH → CARDINALITY). Render only hits whose term matched; format per §5.2; cap at `MAX_SEMANTIC_HINTS`. Prefer the literal-code-filter form; show the `-- code N = 'NAME'` provenance comment.

### 8.5 Composition with join-graph surfacing

| Concern | This doc | `JOINGRAPH_SURFACING.md` |
|---|---|---|
| Get `MonitorMeasurements` into survivors | **pin via hint** (§4.2) | (assumes it's a survivor) |
| Connect it to `Patients` | (hands off) | **BFS bridge path + bridge-protect** (§2–3) |
| Prompt: term → code → value | **SEMANTIC HINTS block** (§5) | references it (§5) |
| Prompt: hosting-table → patients | (hands off) | **JOIN GRAPH block** (§8.1) |

They are two halves of one fix. Ship the join-graph rendering (its item 1, trivial) and this doc's pin + hint block together for the HR query to go green end-to-end.

---

## 9. Ranked recommendations — accuracy impact vs effort

| # | Recommendation | Accuracy impact | Effort | Notes |
|---|---|---|---|---|
| 1 | **Auto-mine code tables → `autoSynonyms` (curated-seed layer only)** + `hostingTableId` field | **Very high** | **Medium** — `code_tables.py` detector + extract + emit | The foundation; makes every vitals term a hint. Curated seed alone covers the ~12 vitals. |
| 2 | **Retrieval pin (hosting table into survivors)** | **Very high** (directly fixes HR recall) | **Low** — ~10 lines in `retrieve()` + `GlossaryHit` fields | The causal recall fix. Depends on #1 + join-graph bridge expand. |
| 3 | **SEMANTIC HINTS prompt block** (render matched hints, literal-code-filter) | **High** | **Low** — `_render_semantic_hints` | Value-linking gain; M-Schema-style. Depends on #1. |
| 4 | **Precision guards** (stop-token deny-list, word-boundary, dual thresholds) | **Medium–High** (prevents `MAP`/`temp` false fires) | **Low** — deny-list + threshold consts | Cheap; do with #1 or the first false-positive shows up. |
| 5 | **Local-embedding synonym fallback (Layer B)** | **Medium** (recall on unseeded phrasings) | **Medium** — gloss embedding + cosine at expand-time | Reuses bundle embedder. Defer until eval shows seed-miss cases. |
| 6 | **Offline LOINC/SNOMED alias merge** | **Low** (seed already covers vitals) | **Medium–High** (licensing, parsing) | Optional; only if the vocabulary grows well beyond vitals. |

**Build order:** 1 → 2 → 3 → 4 (all needed for the HR query, all near-term) → 5 → 6. Sequenced *after / alongside* `JOINGRAPH_SURFACING.md` items 1–2 (join rendering + bridge expand), since #2 here depends on the bridge expansion to reach `Patients`.

---

## Sources

- **Enhanced Schema Linking with LLMs via Self-Verification and Value Hints** — value hints "explicitly guide the model to recognize database values mentioned in queries"; imperfect value/schema-linking recall "propagates and becomes a performance bottleneck". [MDPI Big Data Cogn. Comput. 10(4):104](https://www.mdpi.com/2504-2289/10/4/104)
- **Rethinking Schema Linking: A Context-Aware Bidirectional Retrieval Approach for Text-to-SQL** — table-first↔column-first bidirectional retrieval; "narrows the gap between full and perfect schema settings by 50%". [arXiv 2510.14296](https://arxiv.org/pdf/2510.14296)
- **CodeS: Towards Building Open-source Language Models for Text-to-SQL** — coarse-to-fine value retriever: BM25 index over *all DB values*, then LCS fine match, injected into the prompt to "guide the model in producing accurate predicates". [arXiv 2402.16347](https://arxiv.org/pdf/2402.16347)
- **M-Schema / XiYan-SQL** — schema serialization with per-column `Examples: [...]` value lists and `table.col=reftable.refcol` FK lines; example-value + FK conventions we follow. [M-Schema repo](https://github.com/XGenerationLab/M-Schema); [XiYan-SQL, arXiv 2411.08599](https://arxiv.org/html/2411.08599v1)
- **Robust Clinical Querying with Local LLMs: Lexical Challenges in NL2SQL and RAG on EHRs** — lexical/synonym/abbreviation ambiguity in clinical NL2SQL; local-LLM constraint. [MDPI Big Data Cogn. Comput. 9(10):256](https://www.mdpi.com/2504-2289/9/10/256)
- **UMLS / clinical terminology** — 4M+ concepts, 12M+ names, 223 vocabularies (SNOMED CT, LOINC, ICD); "over 33% of UMLS abbreviations multi-meaning, 54% in clinical reports". [NLM UMLS](https://www.nlm.nih.gov/research/umls/Snomed/nursing_terminology_resources.html); LOINC vital-signs coverage [CDC LIVD](https://www.cdc.gov/laboratory-systems/php/livd-test-codemapping/index.html)
- **A systematic review of automatic mapping of clinical terminologies (2018–2025)** — automated LOINC/SNOMED/ICD mapping is precision-sensitive and unsolved (warrant for curated + DB-scoped over generic ontology). [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2590005626000585)
- **SSSOM: A Simple Standard for Sharing Ontological Mappings** — format for an optional offline ontology-alias merge. [arXiv 2112.07051](https://arxiv.org/pdf/2112.07051)
- **Code/enum table detection** — low-cardinality → lookup value; cardinality detected via FK analysis or row count; code-description → enum. [enum vs low-cardinality](https://medium.com/@sathishdba/clickhouse-understanding-lowcardinality-vs-enum-columns-9c09b26467d9); [USPTO 11892973](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11892973)
- Internal: `docs/NL2SQL_SPEC.md` §1.9 (glossary.json / `coded-measurement` schema), §2.5 (PHI gate); `docs/research/JOINGRAPH_SURFACING.md` (join-graph surfacing + bridge expand this composes with); `prep/prep/enrich/glossary.py` (reference-resolution discipline + existing `coded-measurement` handling); `ceiba_nl2sql/…/compliance/aggregate_profile.py` (low-card sampling + PHI classification reused by the detector); `ceiba_nl2sql/…/retrieval/retriever.py` (`_expand_question`, `_recall_tables`, `_glossary_hit_from_map` — the pin/hit integration points).
