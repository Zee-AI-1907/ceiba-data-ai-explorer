-- =============================================================================
-- Ceiba NL->SQL mock Postgres — READ-ONLY ROLE (Phase P1)
-- =============================================================================
-- Creates `ceiba_ro`: a GENUINELY read-only login role. This is the PRIMARY
-- read-only control (infra layer) — the engines connect as this role, matching
-- the staging safety rule (docs/DATA_SOURCES.md): "the runtime connection role
-- should be a genuinely read-only principal".
--
-- ceiba_ro gets:
--   * LOGIN + CONNECT on mockdb
--   * USAGE on schema public
--   * SELECT on all EXISTING tables
--   * default privileges so FUTURE tables (created by the admin) are also
--     SELECT-only to ceiba_ro
-- and gets NO INSERT/UPDATE/DELETE/TRUNCATE, NO CREATE (revoked on schema),
-- NO sequence write. Defense-in-depth alongside the app-level read-only
-- transaction settings.
--
-- Portable: runs identically in a CI Postgres service container. Uses
-- DO-block guards so re-application (or CI re-seed) does not error.
-- =============================================================================

SET client_min_messages = warning;

-- Create the role only if it does not already exist (idempotent).
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ceiba_ro') THEN
        CREATE ROLE ceiba_ro LOGIN PASSWORD 'ceiba_ro_pw';
    END IF;
END
$$;

-- Ensure no accidental DB-level create rights; allow connect only.
REVOKE ALL ON DATABASE mockdb FROM ceiba_ro;
GRANT CONNECT ON DATABASE mockdb TO ceiba_ro;

-- Schema: allow lookup/usage, explicitly DENY object creation.
GRANT USAGE ON SCHEMA public TO ceiba_ro;
REVOKE CREATE ON SCHEMA public FROM ceiba_ro;

-- Existing tables: SELECT only. (No INSERT/UPDATE/DELETE/TRUNCATE granted.)
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ceiba_ro;

-- Sequences: read-only USAGE/SELECT is fine (needed if a SELECT touches a
-- serial's currval); explicitly no UPDATE (which would allow nextval/setval
-- side effects). We grant only SELECT here — no USAGE/UPDATE — since the schema
-- uses no serial defaults that ceiba_ro must advance.
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ceiba_ro;

-- Default privileges: FUTURE tables created by mock_admin in public are
-- automatically SELECT-only to ceiba_ro (belt-and-suspenders for later phases
-- that may add mock tables).
ALTER DEFAULT PRIVILEGES FOR ROLE mock_admin IN SCHEMA public
    GRANT SELECT ON TABLES TO ceiba_ro;

-- Make sure the default-privileges block does NOT hand out write on future
-- tables/sequences (Postgres default is none, but be explicit for auditability).
ALTER DEFAULT PRIVILEGES FOR ROLE mock_admin IN SCHEMA public
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLES FROM ceiba_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE mock_admin IN SCHEMA public
    REVOKE ALL ON SEQUENCES FROM ceiba_ro;
