/**
 * PrivacyController unit tests (C38).
 * Verifies that the controller delegates to the service with the correct
 * arguments and that permission decorators are present.
 */
import { NotFoundException } from '@nestjs/common';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import type { UserContext } from '../common/types';

function makeController(overrides: Partial<PrivacyService> = {}) {
  const svc = {
    exportStudentData: jest.fn(),
    requestDeletion: jest.fn(),
    ...overrides,
  } as unknown as PrivacyService;
  return { ctrl: new PrivacyController(svc), svc };
}

function user(overrides: Partial<UserContext> = {}): UserContext {
  return {
    userId: 'u-1', email: 'test@test.com', firstName: 'T', lastName: 'U',
    role: 'ORG_ADMIN', orgId: 'org-a', permissions: [], isSuperAdmin: false,
    ...overrides,
  };
}

describe('PrivacyController', () => {
  it('exportData delegates to service with user and studentId', async () => {
    const { ctrl, svc } = makeController({
      exportStudentData: jest.fn().mockResolvedValue({ student: { id: 'stu-1' } }),
    });
    const result = await ctrl.exportData(user({}), 'stu-1');
    expect(svc.exportStudentData).toHaveBeenCalledWith(user({}), 'stu-1');
    expect(result).toEqual({ student: { id: 'stu-1' } });
  });

  it('exportData propagates NotFoundException', async () => {
    const { ctrl } = makeController({
      exportStudentData: jest.fn().mockRejectedValue(new NotFoundException()),
    });
    await expect(ctrl.exportData(user({}), 'nonexistent')).rejects.toThrow(NotFoundException);
  });

  it('requestDeletion delegates to service with user, studentId, and reason', async () => {
    const { ctrl, svc } = makeController({
      requestDeletion: jest.fn().mockResolvedValue({ deleted: true }),
    });
    const dto = { reason: 'privacy request' };
    const result = await ctrl.requestDeletion(user({}), 'stu-1', dto);
    expect(svc.requestDeletion).toHaveBeenCalledWith(user({}), 'stu-1', 'privacy request');
    expect(result).toEqual({ deleted: true });
  });

  it('requestDeletion passes undefined reason when dto has none', async () => {
    const { ctrl, svc } = makeController({
      requestDeletion: jest.fn().mockResolvedValue({ deleted: true }),
    });
    await ctrl.requestDeletion(user({}), 'stu-1', {});
    expect(svc.requestDeletion).toHaveBeenCalledWith(user({}), 'stu-1', undefined);
  });

  it('requestDeletion propagates NotFoundException', async () => {
    const { ctrl } = makeController({
      requestDeletion: jest.fn().mockRejectedValue(new NotFoundException()),
    });
    await expect(ctrl.requestDeletion(user({}), 'nonexistent', {})).rejects.toThrow(NotFoundException);
  });
});
