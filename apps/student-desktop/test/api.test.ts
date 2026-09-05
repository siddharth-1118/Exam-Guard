/**
 * ApiClient unit tests with a scripted in-memory fetch: login, token refresh on
 * 401, session-less me(), answer/event submission payloads.
 */
import { ApiClient, type TokenPair } from '../electron/api';

const USER = { id: 'u-1', email: 'student@exam.test', firstName: 'Ada', lastName: 'Lovelace', role: 'STUDENT' };
const ATTEMPT_VIEW = {
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
};

interface Handler {
  (url: string, init: RequestInit | undefined): Promise<unknown>;
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function makeFetch(handler: Handler): { fetch: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const isResponseLike = (v: unknown): v is Response =>
    typeof v === 'object' && v !== null && 'ok' in v && typeof (v as { text?: unknown }).text === 'function';
  const fetch: FetchFn = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const body = await handler(url, init);
    // Handlers may return a Response-shaped failure (e.g. 401) — pass it through.
    if (isResponseLike(body)) return body;
    const json = JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      text: async () => json,
      json: async () => body,
    } as Response;
  };
  return { fetch, calls };
}

function jsonRes(status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  } as Response;
}

describe('ApiClient', () => {
  it('logs in with the existing auth contract and stores tokens', async () => {
    let saved: string | null = null;
    const { fetch, calls } = makeFetch(async (url) => {
      expect(url).toContain('/api/v1/auth/login');
      return { accessToken: 'at-1', refreshToken: 'rt-1', user: USER };
    });
    const client = new ApiClient({
      baseUrl: 'http://localhost:4000',
      fetchImpl: fetch,
      saveRefreshToken: (t) => {
        saved = t;
      },
    });

    const user = await client.login('student@exam.test', 's3cret');
    expect(user.email).toBe('student@exam.test');
    expect(saved).toBe('rt-1');
    expect(client.hasToken).toBe(true);
    const loginCall = calls[0];
    expect(loginCall.init?.method).toBe('POST');
    expect(JSON.parse(String(loginCall.init?.body))).toEqual({
      email: 'student@exam.test',
      password: 's3cret',
    });
  });

  it('refreshes once on 401 and retries the original request with the new token', async () => {
    const { fetch } = makeFetch(async (url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (url.includes('/auth/refresh')) {
        return { accessToken: 'at-2', refreshToken: 'rt-2' } as TokenPair;
      }
      if (url.includes('/auth/me')) {
        if (headers.Authorization === 'Bearer at-1') return jsonRes(401, { message: 'expired' });
        if (headers.Authorization === 'Bearer at-2') return USER;
        return jsonRes(401, { message: 'no token' });
      }
      return jsonRes(404, { message: 'not found' });
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', fetchImpl: fetch });
    client.setTokens({ accessToken: 'at-1', refreshToken: 'rt-1' });

    const user = await client.me();
    expect(user?.id).toBe('u-1');
    expect(client.hasToken).toBe(true);
  });

  it('me() returns null without a session instead of calling the network', async () => {
    let calls = 0;
    const { fetch } = makeFetch(async () => {
      calls += 1;
      return USER;
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', fetchImpl: fetch });
    expect(await client.me()).toBeNull();
    expect(calls).toBe(0);
  });

  it('submits answers and proctoring events with the idempotency key', async () => {
    const bodies: Array<{ url: string; body: string }> = [];
    const { fetch } = makeFetch(async (url, init) => {
      bodies.push({ url, body: String(init?.body) });
      if (url.includes('/answers')) return { remainingMs: 3_500_000 };
      if (url.includes('/proctoring/events')) return { accepted: true };
      return ATTEMPT_VIEW;
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000/', fetchImpl: fetch });
    client.setTokens({ accessToken: 'at', refreshToken: 'rt' });

    await client.saveAnswer('att-1', 'q-1', '42');
    expect(bodies[0].url).toContain('/api/v1/attempts/att-1/answers');
    expect(JSON.parse(bodies[0].body)).toEqual({ questionId: 'q-1', value: '42' });

    await client.postProctoringEvent('att-1', {
      type: 'CAMERA_DISCONNECTED',
      severity: 'WARNING',
      detail: { deviceId: 'cam-0' },
      clientEventId: 'evt-abc',
      createdAt: '2026-01-01T10:00:00.000Z',
    });
    expect(bodies[1].url).toContain('/api/v1/proctoring/events');
    const eventBody = JSON.parse(bodies[1].body);
    expect(eventBody).toMatchObject({
      attemptId: 'att-1',
      type: 'CAMERA_DISCONNECTED',
      severity: 'WARNING',
      clientEventId: 'evt-abc',
    });

    const view = await client.submit('att-1');
    expect(view.id).toBe('att-1');
    expect(bodies[2].url).toContain('/api/v1/attempts/att-1/submit');
  });

  it('login retries on 429 (rate limit) with bounded backoff, then succeeds', async () => {
    let attempts = 0;
    const { fetch, calls } = makeFetch(async () => {
      attempts += 1;
      if (attempts < 3) return jsonRes(429, { message: 'ThrottlerException: Too Many Requests' });
      return { accessToken: 'at-ok', refreshToken: 'rt-ok', user: USER };
    });
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', fetchImpl: fetch });

    const user = await client.login('student@exam.test', 's3cret');
    expect(user.id).toBe('u-1');
    expect(calls.length).toBe(3);
    expect(client.hasToken).toBe(true);
  }, 20_000);

  it('login does not retry on a non-429 failure', async () => {
    const { fetch, calls } = makeFetch(async () => jsonRes(401, { message: 'Invalid credentials' }));
    const client = new ApiClient({ baseUrl: 'http://localhost:4000', fetchImpl: fetch });

    await expect(client.login('student@exam.test', 'wrong')).rejects.toThrow('Invalid credentials');
    expect(calls.length).toBe(1);
  });
});
