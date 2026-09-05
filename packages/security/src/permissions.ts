import type { RoleName } from '@examguard/types';

/**
 * RBAC permission model. Canonical seed for packages/database (roles,
 * permissions, role_permissions tables). Keep this map and the seed in sync —
 * the DB is the runtime source of truth; this map is the compile-time contract.
 */

export type Permission =
  | 'system:manage'
  | 'org:manage'
  | 'org:read'
  | 'user:manage'
  | 'user:read'
  | 'student:manage'
  | 'student:read'
  | 'monitor:manage'
  | 'monitor:read'
  | 'exam:create'
  | 'exam:read'
  | 'exam:update'
  | 'exam:delete'
  | 'exam:assign'
  | 'question:manage'
  | 'question:read'
  | 'attempt:start'
  | 'attempt:submit'
  | 'attempt:read'
  | 'proctor:monitor'
  | 'proctor:intervene'
  | 'media:publish'
  | 'media:subscribe'
  | 'recording:manage'
  | 'recording:read'
  | 'audit:read'
  | 'report:read'
  | 'settings:manage';

export const ALL_PERMISSIONS: Permission[] = [
  'system:manage',
  'org:manage',
  'org:read',
  'user:manage',
  'user:read',
  'student:manage',
  'student:read',
  'monitor:manage',
  'monitor:read',
  'exam:create',
  'exam:read',
  'exam:update',
  'exam:delete',
  'exam:assign',
  'question:manage',
  'question:read',
  'attempt:start',
  'attempt:submit',
  'attempt:read',
  'proctor:monitor',
  'proctor:intervene',
  'media:publish',
  'media:subscribe',
  'recording:manage',
  'recording:read',
  'audit:read',
  'report:read',
  'settings:manage',
];

export const ROLE_PERMISSIONS: Record<RoleName, Permission[]> = {
  SUPER_ADMIN: [...ALL_PERMISSIONS],
  ORG_ADMIN: [
    'org:manage',
    'org:read',
    'user:manage',
    'user:read',
    'student:manage',
    'student:read',
    'monitor:manage',
    'monitor:read',
    'exam:create',
    'exam:read',
    'exam:update',
    'exam:delete',
    'exam:assign',
    'question:manage',
    'question:read',
    'attempt:read',
    'proctor:monitor',
    'proctor:intervene',
    'media:subscribe',
    'recording:manage',
    'recording:read',
    'audit:read',
    'report:read',
    'settings:manage',
  ],
  EXAM_MANAGER: [
    'exam:create',
    'exam:read',
    'exam:update',
    'exam:assign',
    'question:manage',
    'question:read',
    'student:read',
    'attempt:read',
    'report:read',
    'recording:read',
  ],
  MONITOR: [
    'exam:read',
    'attempt:read',
    'proctor:monitor',
    'proctor:intervene',
    'media:subscribe',
    'student:read',
    'recording:read',
  ],
  STUDENT: [
    'exam:read',
    'attempt:start',
    'attempt:submit',
    'attempt:read',
    'media:publish',
    'recording:read',
  ],
};

export function permissionsForRole(role: RoleName): Permission[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

export function hasPermission(role: RoleName, permission: Permission): boolean {
  return permissionsForRole(role).includes(permission);
}

/** True when `grantor` may assign `grantee` (no privilege escalation, spec §58). */
export function canGrantRole(grantor: RoleName, grantee: RoleName): boolean {
  const hierarchy: Record<RoleName, number> = {
    SUPER_ADMIN: 4,
    ORG_ADMIN: 3,
    EXAM_MANAGER: 2,
    MONITOR: 1,
    STUDENT: 0,
  };
  return (hierarchy[grantor] ?? 0) > (hierarchy[grantee] ?? 0);
}