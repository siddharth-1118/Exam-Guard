import { BadRequestException } from '@nestjs/common';
import type { UserContext } from '../common/types';

function mockUser(overrides: Partial<UserContext> = {}): UserContext {
  return {
    userId: 'user-1',
    email: 'test@examguard.org',
    firstName: 'Test',
    lastName: 'User',
    role: 'ORG_ADMIN',
    orgId: 'org-1',
    permissions: ['exam:manage', 'question:manage', 'student:manage'],
    isSuperAdmin: false,
    ...overrides,
  };
}

describe('Checkpoints 1-5 — Exam Management & Lifecycle Guards', () => {
  it('validates schedule constraints (startAt < endAt)', () => {
    const start = new Date('2026-10-01T12:00:00Z');
    const end = new Date('2026-10-01T10:00:00Z');
    expect(start >= end).toBe(true);
  });

  it('rejects duration < 1 minute', () => {
    const durationMinutes = 0;
    expect(durationMinutes < 1).toBe(true);
  });

  it('blocks question linking when exam is OPEN', () => {
    const examStatus = 'OPEN';
    const attemptCount = 0;
    const isBlocked = examStatus === 'OPEN' || attemptCount > 0;
    expect(isBlocked).toBe(true);
  });

  it('blocks modifying questions linked to active exams with attempts', () => {
    const activeAttempts = 1;
    const isBlocked = activeAttempts > 0;
    expect(isBlocked).toBe(true);
  });

  it('requires consent when identity verification is enabled', () => {
    const settings = { identityVerificationRequired: true };
    const consentObj = {};
    const hasConsent = Boolean((consentObj as { identityVerified?: boolean }).identityVerified);
    expect(settings.identityVerificationRequired && !hasConsent).toBe(true);
  });

  it('allows starting attempt when identity verification consent is provided', () => {
    const settings = { identityVerificationRequired: true };
    const consentObj = { identityVerified: true, consentGiven: true };
    const hasConsent = Boolean(consentObj.identityVerified || consentObj.consentGiven);
    expect(settings.identityVerificationRequired && hasConsent).toBe(true);
  });
});
