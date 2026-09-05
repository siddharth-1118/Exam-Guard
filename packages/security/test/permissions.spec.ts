import { canGrantRole, hasPermission, permissionsForRole } from '../src/permissions';

describe('RBAC permissions', () => {
  it('grants super admin everything', () => {
    expect(hasPermission('SUPER_ADMIN', 'system:manage')).toBe(true);
    expect(hasPermission('SUPER_ADMIN', 'audit:read')).toBe(true);
  });

  it('keeps students out of admin resources', () => {
    expect(hasPermission('STUDENT', 'system:manage')).toBe(false);
    expect(hasPermission('STUDENT', 'audit:read')).toBe(false);
    expect(hasPermission('STUDENT', 'proctor:intervene')).toBe(false);
    expect(hasPermission('STUDENT', 'attempt:submit')).toBe(true);
  });

  it('gives monitors only proctoring scopes', () => {
    expect(hasPermission('MONITOR', 'proctor:monitor')).toBe(true);
    expect(hasPermission('MONITOR', 'proctor:intervene')).toBe(true);
    expect(hasPermission('MONITOR', 'exam:delete')).toBe(false);
    expect(hasPermission('MONITOR', 'question:manage')).toBe(false);
  });

  it('prevents privilege escalation in role grants', () => {
    expect(canGrantRole('ORG_ADMIN', 'EXAM_MANAGER')).toBe(true);
    expect(canGrantRole('ORG_ADMIN', 'SUPER_ADMIN')).toBe(false);
    expect(canGrantRole('MONITOR', 'MONITOR')).toBe(false);
    expect(canGrantRole('SUPER_ADMIN', 'STUDENT')).toBe(true);
  });

  it('always returns a stable permission list per role', () => {
    for (const role of ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER', 'MONITOR', 'STUDENT'] as const) {
      const perms = permissionsForRole(role);
      expect(perms.length).toBeGreaterThan(0);
      expect(new Set(perms).size).toBe(perms.length);
    }
  });
});