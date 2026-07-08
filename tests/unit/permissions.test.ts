/**
 * Unit tests for lib/permissions.ts — the RBAC role→permission matrix.
 *
 * This module is a pure, dependency-free lookup table, so it is fully testable today with
 * no mocking and no external services. See docs/TEST_STRATEGY.md §7.1 for how this fits
 * into the broader local-RBAC test plan (session/auth-guard tests are BLOCKED until the
 * Clerk→local-auth rewrite lands; this file only covers the permission matrix itself, which
 * is not being rewritten).
 */
import { describe, expect, it } from 'vitest'
import { hasPermission, requirePermission, type Permission, type Role } from '@/lib/permissions'

const ALL_PERMISSIONS: Permission[] = [
  'query:run',
  'query:export',
  'narrative:generate',
  'dashboard:write',
  'dashboard:read',
  'chart:write',
  'alert:write',
  'report:write',
  'audit:read',
  'admin:manage',
]

describe('hasPermission', () => {
  it('grants admin every defined permission', () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(hasPermission('admin', permission)).toBe(true)
    }
  })

  it('grants analyst all permissions except audit:read and admin:manage', () => {
    const deniedForAnalyst: Permission[] = ['audit:read', 'admin:manage']
    for (const permission of ALL_PERMISSIONS) {
      const expected = !deniedForAnalyst.includes(permission)
      expect(hasPermission('analyst', permission)).toBe(expected)
    }
  })

  it('grants clinician only query:run, narrative:generate, dashboard:read', () => {
    const grantedForClinician: Permission[] = ['query:run', 'narrative:generate', 'dashboard:read']
    for (const permission of ALL_PERMISSIONS) {
      const expected = grantedForClinician.includes(permission)
      expect(hasPermission('clinician', permission)).toBe(expected)
    }
  })

  it('denies write/admin permissions to clinician (negative-space RBAC check)', () => {
    expect(hasPermission('clinician', 'dashboard:write')).toBe(false)
    expect(hasPermission('clinician', 'chart:write')).toBe(false)
    expect(hasPermission('clinician', 'alert:write')).toBe(false)
    expect(hasPermission('clinician', 'report:write')).toBe(false)
    expect(hasPermission('clinician', 'query:export')).toBe(false)
    expect(hasPermission('clinician', 'audit:read')).toBe(false)
    expect(hasPermission('clinician', 'admin:manage')).toBe(false)
  })

  it('denies audit:read and admin:manage to analyst (H1-style privilege check)', () => {
    expect(hasPermission('analyst', 'audit:read')).toBe(false)
    expect(hasPermission('analyst', 'admin:manage')).toBe(false)
  })

  it('returns false for an unknown/undefined role instead of throwing', () => {
    expect(hasPermission('superuser' as Role, 'query:run')).toBe(false)
  })
})

describe('requirePermission', () => {
  it('does not throw when the role holds the permission', () => {
    expect(() => requirePermission('admin', 'admin:manage')).not.toThrow()
    expect(() => requirePermission('clinician', 'query:run')).not.toThrow()
  })

  it('throws a descriptive Forbidden error when the role lacks the permission', () => {
    expect(() => requirePermission('clinician', 'admin:manage')).toThrow(
      /Forbidden.*clinician.*admin:manage/
    )
    expect(() => requirePermission('analyst', 'audit:read')).toThrow(
      /Forbidden.*analyst.*audit:read/
    )
  })

  it('throws for an unrecognized role rather than silently allowing access', () => {
    expect(() => requirePermission('superuser' as Role, 'query:run')).toThrow(/Forbidden/)
  })
})
