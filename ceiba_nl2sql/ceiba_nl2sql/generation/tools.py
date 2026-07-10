"""tools.py — the tool registry for the tool-calling planning phase (P1).

A ToolSpec is `{name, schema, handler}`: `schema` is the OpenAI function-tool
definition sent as `tools=[...]`; `handler(parsed_args) -> str` runs the tool and
returns the string the loop appends as the `role=tool` result. `get_join_subgraph`
is tool #1; adding a future tool is one `make_*` factory returning a ToolSpec.

The get_join_subgraph handler is a per-request CLOSURE over the retriever's
adjacency + bundle (via `get_table_ref`), so the pure `build_join_subgraph` stays
free of any retriever instance. It captures the resolved JoinSubgraph through the
optional `on_subgraph` callback so the pipeline can render it into the generation
prompt after the plan phase.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from ceiba_nl2sql.generation.prompt import _render_join_graph
from ceiba_nl2sql.retrieval.retriever import (
    JoinAdjacency,
    JoinSubgraph,
    build_bridge_stub_tables,
    build_join_subgraph,
)

GET_JOIN_SUBGRAPH_TOOL_SCHEMA: dict = {
    "type": "function",
    "function": {
        "name": "get_join_subgraph",
        "description": (
            "Return the DECLARED foreign-key join edges and multi-hop bridge paths that connect the "
            "given tables. Call it with the tableIds you need to answer the question; any bridge "
            "tables required to connect them are added automatically. Use ONLY the join predicates it "
            "returns — do not invent joins."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "tables": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "The tableIds (or table names) you need to join to answer the question.",
                }
            },
            "required": ["tables"],
        },
    },
}


@dataclass
class ToolSpec:
    name: str
    schema: dict
    handler: Callable[[dict], str]


def _format_result(subgraph: JoinSubgraph, rendered_join_graph: str) -> str:
    """Formats the tool result the model sees: the rendered JOIN GRAPH plus
    explicit unknown/unreachable feedback so it can self-correct rather than
    silently receiving a disconnected or empty graph.
    """
    parts: list[str] = []
    if subgraph.join_hints or subgraph.join_paths:
        parts.append(rendered_join_graph)
    else:
        parts.append("(No declared FK join edges among the requested tables.)")
    if subgraph.unknown_tables:
        parts.append(
            "UNKNOWN TABLES (not in the schema — check the tableId and call again with a valid one): "
            + ", ".join(subgraph.unknown_tables)
        )
    if subgraph.unreachable_pairs:
        pairs = "; ".join(f"{a} <-> {b}" for a, b in subgraph.unreachable_pairs)
        parts.append(
            "NO FK PATH within the schema between: " + pairs + ". Reconsider which tables you actually need."
        )
    return "\n\n".join(parts)


def make_get_join_subgraph_tool(
    *,
    adjacency: JoinAdjacency,
    known_table_ids: set[str],
    get_table_ref: Callable[[str], str | None],
    max_hops: int = 6,
    on_subgraph: Callable[[JoinSubgraph], None] | None = None,
) -> ToolSpec:
    """Builds the get_join_subgraph ToolSpec for one request. `on_subgraph` (when
    given) receives each resolved JoinSubgraph so the pipeline can render it into
    the generation prompt.
    """

    def handler(arguments: dict) -> str:
        requested = arguments.get("tables") or []
        subgraph = build_join_subgraph(
            requested,
            adjacency=adjacency,
            known_table_ids=known_table_ids,
            get_table_ref=get_table_ref,
            max_hops=max_hops,
        )
        if on_subgraph is not None:
            on_subgraph(subgraph)
        stubs = build_bridge_stub_tables(
            subgraph.bridge_nodes, adjacency=adjacency, get_table_ref=get_table_ref
        )
        rendered = _render_join_graph(subgraph.join_hints, subgraph.join_paths, stubs)
        return _format_result(subgraph, rendered)

    return ToolSpec(name="get_join_subgraph", schema=GET_JOIN_SUBGRAPH_TOOL_SCHEMA, handler=handler)
