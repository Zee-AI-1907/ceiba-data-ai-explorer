"""classify_phi.py — stage [4]; reuses phiScrubber PHI_COLUMNS (SPEC §2.5).

Loads the authoritative PHI set from config/phi_columns.json (generated from
lib/phiScrubber.ts via `npm run phi:sync`) so the prep toolchain and TS runtime
agree on one classification. P0 stub; real logic lands in P3a.
"""
