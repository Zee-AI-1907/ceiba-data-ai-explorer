"""Regression test for the Postgres ±infinity date/timestamp handling.

Real clinical staging data holds Postgres `infinity` / `-infinity` date and
timestamp sentinels (open-ended ranges). psycopg3's default DateLoader raises
`DataError: date too small (before year 1)` on `-infinity`, which crashed a
staging bundle build during profiling (`sample_aggregate`). The introspector
registers per-connection loaders that map ±infinity to None so aggregation
treats them as absent (we only compute counts/min/max/mean, never emit the raw
value). This test locks that behavior in.
"""

from __future__ import annotations

import pytest

psycopg = pytest.importorskip("psycopg")

from prep.introspect.sqlalchemy_introspector import _register_infinity_safe_loaders


class _FakeAdapters:
    """Captures register_loader calls without a live connection."""

    def __init__(self) -> None:
        self.registered: dict[str, type] = {}

    def register_loader(self, typename: str, loader: type) -> None:
        self.registered[typename] = loader


class _FakeConn:
    def __init__(self) -> None:
        self.adapters = _FakeAdapters()


def _load(loader_cls, raw: bytes):
    """Instantiate a psycopg loader for its pg oid and load a raw byte value.

    psycopg loaders take (oid, transformer); for the sentinel-only branch we
    exercise, the transformer is never consulted, so a minimal stub suffices.
    """
    # The loader only reaches super().load() for non-sentinel input; for the
    # ±infinity bytes it short-circuits to None before touching the transformer.
    loader = loader_cls.__new__(loader_cls)
    return loader.load(raw)


def test_registers_date_and_timestamp_loaders() -> None:
    conn = _FakeConn()
    _register_infinity_safe_loaders(conn)
    assert set(conn.adapters.registered) == {"date", "timestamp", "timestamptz"}


@pytest.mark.parametrize("sentinel", [b"infinity", b"-infinity"])
def test_infinity_sentinels_map_to_none(sentinel: bytes) -> None:
    conn = _FakeConn()
    _register_infinity_safe_loaders(conn)
    for typename in ("date", "timestamp", "timestamptz"):
        loader_cls = conn.adapters.registered[typename]
        assert _load(loader_cls, sentinel) is None, (
            f"{typename} loader must map {sentinel!r} to None"
        )


def test_normal_date_still_parses() -> None:
    """A real date must still round-trip through the default loader path."""
    import datetime

    conn = _FakeConn()
    _register_infinity_safe_loaders(conn)
    date_loader_cls = conn.adapters.registered["date"]
    # A real psycopg loader needs the date oid + a transformer to parse a real
    # value; construct one via the connection's adapters the normal way.
    real_conn = None
    dsn = None
    import os

    dsn = os.environ.get("MOCK_DSN")
    if not dsn:
        pytest.skip("MOCK_DSN not set — normal-date parse checked against live DB only")
    try:
        real_conn = psycopg.connect(dsn.replace("postgresql+psycopg://", "postgresql://"))
    except Exception as exc:  # pragma: no cover - env dependent
        pytest.skip(f"mock DB unreachable: {exc}")
    try:
        _register_infinity_safe_loaders(real_conn)
        with real_conn.cursor() as cur:
            cur.execute("SELECT DATE '2026-07-09'")
            (value,) = cur.fetchone()
        assert value == datetime.date(2026, 7, 9)
    finally:
        real_conn.close()
