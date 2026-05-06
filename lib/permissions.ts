/**
 * permissions.ts — RBAC permissions matrix (H-010).
 *
 * Defines which permissions each role holds.
 * Import `hasPermission` / `requirePermission` in API routes and components.
 */

export type Role = 'admin' | 'analyst' | 'clinician'

export type Permission =
  | 'query:run'            // run SQL queries
  | 'query:export'         // export CSV / Excel
  | 'narrative:generate'   // AI narrative generation
  | 'dashboard:write'      // create / edit dashboards
  | 'dashboard:read'       // view dashboards
  | 'chart:write'          // create / edit charts
  | 'alert:write'          // create / edit alerts
  | 'report:write'         // create / edit reports
  | 'audit:read'           // view audit log
  | 'admin:manage'         // user management

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
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
  ],
  analyst: [
    'query:run',
    'query:export',
    'narrative:generate',
    'dashboard:write',
    'dashboard:read',
    'chart:write',
    'alert:write',
    'report:write',
  ],
  clinician: [
    'query:run',
    'narrative:generate',
    'dashboard:read',
  ],
}

/**
 * Returns true if the given role has the requested permission.
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role]
  return perms ? perms.includes(permission) : false
}

/**
 * Throws an error if the given role does NOT have the requested permission.
 * Useful for server-side guards that want to throw rather than return.
 */
export function requirePermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Forbidden: role '${role}' does not have permission '${permission}'`)
  }
}
