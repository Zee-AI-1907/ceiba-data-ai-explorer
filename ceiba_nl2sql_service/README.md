# ceiba_nl2sql_service — NL→SQL FastAPI runtime

The Python NL→SQL runtime service (`docs/PYTHON_NL2SQL_SERVICE_PLAN.md`).
Endpoints: `POST /nl2sql/generate`, `POST /nl2sql/execute`, `POST /nl2sql/explain`,
`GET /healthz`, `GET /readyz`. Protected routes require the internal
`Authorization: Bearer ${NL2SQL_SERVICE_TOKEN}`.

As of **Phase 3** the service is AVAILABLE + metered behind a flag: the TS
`/api/sql-generate` route calls it only when `NL2SQL_GENERATE_RUNTIME=python`
(default `ts`). Rollback is a single env flip back to `ts` — no redeploy.

## Per-query cost + token metering

`POST /nl2sql/generate` returns an additive `usage` block:

```jsonc
"usage": {
  "model": "gpt-4o-mini",   // model that ran (the real client echoes the resolved snapshot)
  "promptTokens": 320,       // summed across EVERY LLM call in the request…
  "completionTokens": 48,    // …including each self-repair round
  "totalTokens": 368,
  "llmCalls": 2,             // 1 initial + repair rounds
  "estimatedCostUsd": 0.0000768,  // tokens × price table (generation/pricing.py)
  "latencyMs": 512
}
```

- **Where cost comes from:** `ceiba_nl2sql/generation/pricing.py` holds a per-model
  USD-per-1M-token table (`DEFAULT_MODEL_PRICES`). Override without a deploy via
  env `NL2SQL_MODEL_PRICES` (JSON, merged over defaults). An unknown model reports
  `estimatedCostUsd: 0.0` (never a fabricated price) and is logged verbatim.
- **Self-repair summing:** the pipeline (`generation/pipeline.py`) accumulates each
  `LlmCompletion.usage` from `call_llm` across the initial call and every repair
  round, then prices the sum once. `llmCalls` = total LLM calls made.
- **Server-side log:** every generate logs one structured line
  `nl2sql.generate.usage correlationId=… tenantId=… outcome=… model=… totalTokens=… estimatedCostUsd=… latencyMs=…`
  keyed by the `X-Correlation-Id` the TS route forwards, so cost is measurable
  server-side independent of the response body.

## Running a LIVE per-query cost measurement

CI is hermetic — the stub LLM reports SYNTHETIC token counts and **no real OpenAI
call is ever made in tests**. To measure real per-query cost you must supply a
real key and the real model, then hit the service:

```bash
# 1. Configure the service process (a real OpenAI key + BAA + a real bundle).
export OPENAI_API_KEY=sk-...            # a real key
export OPENAI_BAA_SIGNED=true           # egress gate (schema-metadata is always allowed;
                                        #   this only matters for future patient-derived calls)
export NL2SQL_LLM_MODEL=gpt-4o-mini     # the model to price
export NL2SQL_BUNDLE_DIR=/path/to/a/real/bundle
export MOCK_DSN=postgresql://ceiba_ro:...@localhost:55433/mockdb
export NL2SQL_SERVICE_TOKEN=$(openssl rand -hex 32)
# optional: override prices for your negotiated rate
# export NL2SQL_MODEL_PRICES='{"gpt-4o-mini":{"input":0.15,"output":0.60}}'

# 2. Boot the service and wait for /readyz to be green.
uvicorn ceiba_nl2sql_service.app:app --port 8088

# 3. Issue a real generate request and read the `usage` block.
curl -s http://127.0.0.1:8088/nl2sql/generate \
  -H "Authorization: Bearer $NL2SQL_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Correlation-Id: cost-probe-1" \
  -d '{"question":"patients whose heart rate was over 120 in the last 3 hours","tenantId":"org_probe"}' \
  | python -m json.tool
# → the response `usage.estimatedCostUsd` is the real per-query cost; the same
#   figure is in the server log line keyed by correlationId=cost-probe-1.
```

Through the full stack, set `NL2SQL_GENERATE_RUNTIME=python` +
`NL2SQL_SERVICE_URL` + `NL2SQL_SERVICE_TOKEN` in the Next app and call
`POST /api/sql-generate`; the `usage` block is surfaced in that route's JSON
response too.

## Tests (hermetic)

```bash
python -m pytest ceiba_nl2sql_service/tests ceiba_nl2sql/tests -q
```

The stub `StubLlmClient` reports synthetic token counts so the metering path
(summing + USD estimate) is exercised without a real tokenizer or network.
