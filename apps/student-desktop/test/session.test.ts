/**
 * ExamSession unit tests: auth restore, attempt attach, answer routing through
 * the outbox, server-authoritative heartbeat state, submit/exit semantics.
 * The API client and outbox are replaced with spies.
 */
import { ExamSession } from '../electron/session';
import type { ApiClient } from '../electron/api';
import type { ReliableOutbox } from '../electron/outbox';
import type { AttemptView, UserProfile } from '../src/shared/types';

const USER: UserProfile = {
  id: 'u-1',
  email: 'student@exam.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'STUDENT',
  organizationId: 'org-1',
};

function activeView(over: Partial<AttemptView> = {}): AttemptView {
  return {
    id: 'att-1',
    examId: 'ex-1',
    examName: 'Java Midterm',
    status: 'ACTIVE',
    startedAt: '2026-01-01T10:00:00.000Z',
    submittedAt: null,
    deadline: '2026-01-01T11:00:00.000Z',
    remainingMs: 3_600_000,
    paused: false,
    questionCount: 2,
    answeredCount: 0,
    score: null,
    ...over,
  };
}

function makeHarness() {
  const api = {
    login: jest.fn(async () => USER),
    logout: jest.fn(async () => undefined),
    me: jest.fn(async () => USER),
    hasPersistedSession: false,
    listExams: jest.fn(async () => []),
    getExam: jest.fn(async () => ({ id: 'ex-1' })),
    startAttempt: jest.fn(async () => ({ attempt: activeView(), questions: [{ id: 'q-1' }] })),
    getAttempt: jest.fn(async () => ({ attempt: activeView(), questions: [], answers: [] })),
    heartbeat: jest.fn(async () => activeView()),
    submit: jest.fn(async () => activeView({ status: 'SUBMITTED', submittedAt: '2026-01-01T10:30:00.000Z' })),
    saveAnswer: jest.fn(async () => ({ remainingMs: 3_000_000 })),
    updateMediaSession: jest.fn(async () => undefined),
    postProctoringEvent: jest.fn(async () => undefined),
    setTokens: jest.fn(),
    clearTokens: jest.fn(),
  };
  const outbox = {
    enqueueAnswer: jest.fn(),
    enqueueEvent: jest.fn(() => true),
    clearAttempt: jest.fn(),
    clearAll: jest.fn(),
    setOnline: jest.fn(),
    pump: jest.fn(async () => undefined),
    pendingCount: 0,
  };
  const onExitSecureMode = jest.fn();

  const session = new ExamSession({
    api: api as unknown as ApiClient,
    outbox: outbox as unknown as ReliableOutbox,
    appVersion: '0.3.0',
    platform: 'win32',
    arch: 'x64',
    osRelease: '10.0.22631',
    heartbeatMs: 60_000,
    onExitSecureMode,
  });

  return { api, outbox, session, onExitSecureMode };
}

describe('ExamSession', () => {
  it('logs in and holds the student profile', async () => {
    const { session } = makeHarness();
    const user = await session.login('student@exam.test', 's3cret');
    expect(user.id).toBe('u-1');
    expect(session.user?.email).toBe('student@exam.test');
  });

  it('starts an attempt with server timing and exposes it to listeners', async () => {
    const { session, api } = makeHarness();
    const states: string[] = [];
    session.onAttempt((s) => states.push(s.status));

    const res = await session.start('ex-1', { camera: true });
    expect(api.startAttempt).toHaveBeenCalledWith(
      'ex-1',
      expect.objectContaining({ client: 'student-desktop', platform: 'win32' }),
      expect.objectContaining({ camera: true, version: '1' }),
    );
    expect(res.attempt.remainingMs).toBe(3_600_000);
    expect(session.currentAttemptId).toBe('att-1');
    expect(session.mapState()).toMatchObject({ status: 'active', blocked: false });
    expect(states).toContain('active');
    await session.release();
  });

  it('routes answer saves to the reliable outbox with the attempt id', async () => {
    const { session, outbox } = makeHarness();
    await session.start('ex-1', {});
    session.saveAnswer('q-1', 'the answer');
    expect(outbox.enqueueAnswer).toHaveBeenCalledWith('att-1', 'q-1', 'the answer');
    await session.release();
  });

  it('surfaces server-side pause and termination through heartbeats', async () => {
    const { session, api, outbox, onExitSecureMode } = makeHarness();
    await session.start('ex-1', {});
    const listener = jest.fn();
    session.onAttempt(listener);

    // Monitor pauses the student server-side.
    api.heartbeat.mockResolvedValueOnce(activeView({ status: 'PAUSED', paused: true, remainingMs: 3_400_000 }));
    await session.heartbeat('att-1');
    expect(session.mapState()).toMatchObject({ status: 'paused', blocked: true });

    // Monitor terminates the student server-side.
    api.heartbeat.mockResolvedValueOnce(activeView({ status: 'TERMINATED' }));
    await session.heartbeat('att-1');
    expect(session.mapState()).toMatchObject({ status: 'terminated', blocked: true });
    expect(outbox.clearAttempt).toHaveBeenCalledWith('att-1');
    expect(onExitSecureMode).toHaveBeenCalled();
    expect(listener).toHaveBeenCalled();
  });

  it('heartbeat rejects ids that are not the current attempt', async () => {
    const { session } = makeHarness();
    await session.start('ex-1', {});
    await expect(session.heartbeat('att-other')).rejects.toThrow(/No active attempt/);
    await session.release();
  });

  it('submits through the API, clears queued work and exits secure mode', async () => {
    const { session, api, outbox, onExitSecureMode } = makeHarness();
    await session.start('ex-1', {});
    session.saveAnswer('q-1', 'x');

    const view = await session.submit();
    expect(api.submit).toHaveBeenCalledWith('att-1');
    expect(view.status).toBe('SUBMITTED');
    expect(outbox.clearAttempt).toHaveBeenCalledWith('att-1');
    expect(onExitSecureMode).toHaveBeenCalled();
    expect(session.mapState()).toMatchObject({ status: 'submitted', blocked: true });
  });

  it('logout clears identity and stops the session', async () => {
    const { session, api } = makeHarness();
    await session.login('a@b.c', 'pw');
    await session.logout();
    expect(api.logout).toHaveBeenCalled();
    expect(session.user).toBeNull();
    expect(session.mapState()).toMatchObject({ status: 'idle', attempt: null });
  });
});
