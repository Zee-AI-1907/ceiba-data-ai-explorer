"""test_join_check.py — structural join validator (joins ⊆ declared FK edges).

Asserts:
  * A JOIN whose ON-condition equates a declared FK edge's columns
    (case-insensitively, on bare table names) is accepted.
  * A JOIN whose ON-condition equates columns that merely share a NAME
    (e.g. "ExternalId = ExternalId") but have no backing edge is rejected,
    with the offending predicate text returned.
  * In a multi-join query, only the join lacking a backing edge is reported
    as a violation — the declared one is not flagged.
"""

from __future__ import annotations

from prep.enrich.join_check import join_predicates_are_declared


def test_declared_fk_join_accepted():
    edges = [
        {
            "from": "s.Shared.Acceptances",
            "fromColumns": ["PatientId"],
            "to": "s.Shared.Patients",
            "toColumns": ["Id"],
        }
    ]
    sql = (
        'SELECT 1 FROM "Shared"."Acceptances" a '
        'JOIN "Shared"."Patients" p ON a."PatientId"=p."Id"'
    )
    ok, bad = join_predicates_are_declared(sql, edges)
    assert ok and bad == []


def test_invented_name_match_join_rejected():
    edges = [
        {
            "from": "s.Shared.Acceptances",
            "fromColumns": ["PatientId"],
            "to": "s.Shared.Patients",
            "toColumns": ["Id"],
        }
    ]
    sql = (
        'SELECT 1 FROM "Shared"."Acceptances" a '
        'JOIN "Shared"."Patients" p ON a."ExternalId"=p."ExternalId"'
    )
    ok, bad = join_predicates_are_declared(sql, edges)
    assert not ok and bad


def test_multi_join_flags_only_the_invented_one():
    edges = [
        {
            "from": "s.Shared.Acceptances",
            "fromColumns": ["PatientId"],
            "to": "s.Shared.Patients",
            "toColumns": ["Id"],
        },
        {
            "from": "s.Shared.Acceptances",
            "fromColumns": ["HospitalId"],
            "to": "s.public.HospitalRef",
            "toColumns": ["HospitalId"],
        },
    ]
    sql = (
        'SELECT 1 FROM "Shared"."Acceptances" a '
        'JOIN "Shared"."Patients" p ON a."PatientId"=p."Id" '
        'JOIN "Shared"."Measurements" m ON a."ExternalId"=m."ExternalId"'
    )
    ok, bad = join_predicates_are_declared(sql, edges)
    assert not ok
    assert len(bad) == 1
    assert "ExternalId" in bad[0]
