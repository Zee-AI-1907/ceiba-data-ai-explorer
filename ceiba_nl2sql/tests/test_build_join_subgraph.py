"""Tests for build_join_subgraph (P1 T1) — the pure, deterministic helper the
get_join_subgraph tool calls with the model's declared table set. Exercised
against a HAND-BUILT staging-like adjacency (mock-v1's longest chain is only 3
hops, so a 4-5-hop reconnect cannot be written against that bundle).
"""
from ceiba_nl2sql.retrieval.retriever import build_join_adjacency, build_join_subgraph


def _edge(frm, fcol, to, tcol, card="many-to-one"):
    return {
        "from": frm, "fromColumns": [fcol], "to": to, "toColumns": [tcol],
        "joinCardinality": card, "crossSource": False, "confidence": 1.0,
    }


# staging-like FK chain, canonical tableIds <source>.<schema>.<Table>
P = "staging.Shared.Patients"
A = "staging.Shared.Acceptances"
U = "staging.Shared.Units"
D = "staging.Shared.Departments"
H = "staging.Shared.Hospitals"
O = "staging.Shared.Organizations"
M = "staging.Shared.Monitors"
MM = "staging.Shared.MonitorMeasurements"
ISLET = "staging.Shared.Islet"  # a KNOWN table with NO edges (isolated)

EDGES = [
    _edge(A, "PatientId", P, "Id"),
    _edge(A, "UnitId", U, "Id"),
    _edge(U, "DepartmentId", D, "Id"),
    _edge(D, "HospitalId", H, "Id"),
    _edge(H, "OrganizationId", O, "Id"),
    _edge(M, "AcceptanceId", A, "Id"),
    _edge(MM, "DeviceId", M, "Id"),
]
KNOWN = {t for e in EDGES for t in (e["from"], e["to"])} | {ISLET}
REFS = {t: '"Shared"."' + t.split(".")[-1] + '"' for t in KNOWN}


def _sub(requested, **kw):
    return build_join_subgraph(
        requested,
        adjacency=build_join_adjacency(EDGES),
        known_table_ids=KNOWN,
        get_table_ref=lambda t: REFS.get(t),
        **kw,
    )


def test_build_join_subgraph_reconnects_4_hop_endpoints():
    # MM -> Monitors -> Acceptances -> Units -> Departments = 4 edges. Only the
    # endpoints are named; the 3 intermediates must be pulled in as bridges.
    sub = _sub([MM, D])
    assert sub.unknown_tables == []
    assert sub.unreachable_pairs == []
    assert sub.bridge_nodes == {M, A, U}
    assert any(p.hop_count == 4 for p in sub.join_paths)


def test_build_join_subgraph_reconnects_5_hop_endpoints():
    # MM -> Monitors -> Acceptances -> Units -> Departments -> Hospitals = 5 edges.
    sub = _sub([MM, H])
    assert sub.bridge_nodes == {M, A, U, D}
    assert any(p.hop_count == 5 for p in sub.join_paths)


def test_build_join_subgraph_connected_over_three_named_tables():
    sub = _sub([MM, P, H])
    assert sub.unreachable_pairs == []
    assert {M, A, U, D} <= sub.bridge_nodes


def test_build_join_subgraph_unknown_table_reported():
    sub = _sub([P, "staging.Shared.Nope"])
    assert "staging.Shared.Nope" in sub.unknown_tables
    assert P in sub.resolved_ids  # the valid one is still processed


def test_build_join_subgraph_unreachable_pair_reported():
    # ISLET is a KNOWN table with no FK edges — reachable from nothing.
    sub = _sub([P, ISLET])
    assert sub.unknown_tables == []  # known, just isolated (not "unknown")
    assert any({P, ISLET} == set(pair) for pair in sub.unreachable_pairs)


def test_build_join_subgraph_resolves_bare_name_and_quotedref():
    sub = _sub(["Patients", '"Shared"."Units"'])
    assert set(sub.resolved_ids) == {P, U}
    assert sub.unknown_tables == []


def test_build_join_subgraph_deterministic_ordering():
    a = _sub([H, MM, P])
    b = _sub([P, MM, H])
    assert [p.nodes for p in a.join_paths] == [p.nodes for p in b.join_paths]
    assert a.bridge_nodes == b.bridge_nodes


def test_build_join_subgraph_hints_cover_bridge_edges():
    # join_hints must span edges among (named UNION bridges), so every hop of
    # the rendered chain is also present as an edge.
    sub = _sub([MM, D])
    hint_pairs = {(h.from_ref, h.to_ref) for h in sub.join_hints}
    assert (REFS[MM], REFS[M]) in hint_pairs
    assert (REFS[M], REFS[A]) in hint_pairs
    assert (REFS[U], REFS[D]) in hint_pairs
