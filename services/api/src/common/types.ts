import type { RoleName } from '@examguard/types';

export interface UserContext {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: RoleName;
  orgId: string | null; // null for super admins
  permissions: string[];
  isSuperAdmin: boolean;
}

export interface RequestWithUser {
  user: UserContext;
}

export interface Pagination {
  page: number;
  pageSize: number;
}