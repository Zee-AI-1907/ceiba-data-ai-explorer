"""cli.py — standalone CLI entry point for the Python eval harness (ports
eval/cli.ts; docs/PYTHON_NL2SQL_SERVICE_PLAN.md §4.1, §5 Phase 5).

Usage:
    python -m ceiba_nl2sql_eval.cli          # synthetic mode, recorded LLM
    ceiba-nl2sql-eval                        # equivalent, via console script

Runs the full golden set in synthetic mode and prints the EvalReport (plus
per-item detail, each item's `sql` truncated to 200 chars) as JSON to
stdout. `main()` is importable with zero top-level side effects — only
invoking it (directly, via `python -m`, or via the console script) triggers
a run.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import sys
from typing import Any

from ceiba_nl2sql_eval.run_eval import load_golden_set, run_eval


def _to_jsonable(value: Any) -> Any:
    """Recursively converts dataclasses (incl. nested) into plain dicts so
    the EvalReport/ScoredItem tree round-trips through `json.dumps` cleanly.
    """
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {k: _to_jsonable(v) for k, v in dataclasses.asdict(value).items()}
    if isinstance(value, dict):
        return {k: _to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_jsonable(v) for v in value]
    return value


async def _run() -> dict:
    golden = load_golden_set()
    result = await run_eval(golden)

    items_payload = []
    for item in result.items:
        item_dict = _to_jsonable(item)
        item_dict["sql"] = (item_dict.get("sql") or "")[:200]
        items_payload.append(item_dict)

    return {
        "report": _to_jsonable(result.report),
        "items": items_payload,
        "mode": result.mode,
    }


def main() -> None:
    try:
        payload = asyncio.run(_run())
    except Exception as exc:  # noqa: BLE001 - mirrors eval/cli.ts's `.catch` -> stderr + exit 1
        print(exc, file=sys.stderr)
        sys.exit(1)
        return
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
