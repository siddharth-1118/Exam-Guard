/**
 * ExamGuard backend client (main process). Pure — no Electron imports, so it is
 * unit-testable with a fake fetch. All network traffic flows through the main
 * process; the renderer never talks to the network.
 */
import type {
  AttemptView,
  AssignedExam,
  MediaSessionInfo,
  MediaSessionUpdate,
  MediaTokenInfo,
  QueuedEvent,
  UserProfile,
} from '../src/shared/types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Persisted encrypted refresh token; set by the secure store adapter. */
  loadRefreshToken?: () => string | null;
  saveRefreshToken?: (token: string | null) => void;
}

interface ApiResult<T> {
  accessToken?: string;
  refreshToken?: string;
  user?: unknown;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private readonly loadRefreshToken?: () => string | null;
  private readonly saveRefreshToken?: (token: string | null) => void;

  constructor(private readonly opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.loadRefreshToken = opts.loadRefreshToken;
    this.saveRefreshToken = opts.saveRefreshToken;
  }

  get hasToken(): boolean {
    return this.accessToken !== null;
  }

  get hasPersistedSession(): boolean {
    return Boolean(this.loadRefreshToken?.());
  }

  /** Main-process only — never exposed to the renderer. */
  getAccessToken(): string | null {
    return this.accessToken;
  }

  /** Signaling endpoint of the API's media gateway (Phase 4A control plane). */
  get mediaWsUrl(): string {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    return `${wsBase}/api/v1/media/ws`;
  }

  private async raw<T>(path: string, init: RequestInit = {}, retryAuth = true): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    };
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (res.status === 401 && retryAuth && this.refreshToken) {
      const ok = await this.refresh();
      if (ok) return this.raw<T>(path, init, false);
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const message =
        typeof body === 'object' && body !== null && 'message' in body
          ? String((body as { message: unknown }).message)
          : `Request failed (${res.status})`;
      throw new ApiError(res.status, message);
    }
    return body as T;
  }

  async refresh(): Promise<boolean> {
    const token = this.refreshToken ?? this.loadRefreshToken?.() ?? null;
    if (!token) return false;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: token }),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as TokenPair;
      this.setTokens(data);
      return true;
    } catch {
      return false;
    }
  }

  setTokens(tokens: TokenPair | null): void {
    this.accessToken = tokens?.accessToken ?? null;
    this.refreshToken = tokens?.refreshToken ?? null;
    if (this.saveRefreshToken) this.saveRefreshToken(tokens?.refreshToken ?? null);
  }

  clearTokens(): void {
    this.accessToken = null;
    this.refreshToken = null;
    if (this.saveRefreshToken) this.saveRefreshToken(null);
  }

  // -- auth ----------------------------------------------------------------

  /**
   * Bounded retry on 429 only: the API rate-limits auth per IP (10/min in the
   * dev default), and a burst of students behind one NAT legitimately trips
   * it. Retrying login with backoff is safe (idempotent credentials) and keeps
   * an exam session starting during a campus-wide login rush instead of
   * failing the student on the first 429. Never retries other statuses.
   */
  async login(email: string, password: string): Promise<UserProfile> {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const backoff = [1_500, 3_500, 6_000];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const res = await this.raw<{ accessToken: string; refreshToken: string; user: UserProfile }>(
          '/api/v1/auth/login',
          { method: 'POST', body: JSON.stringify({ email, password }) },
          false,
        );
        this.setTokens({ accessToken: res.accessToken, refreshToken: res.refreshToken });
        return res.user;
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 429 || attempt >= backoff.length) throw err;
        await sleep(backoff[attempt]);
      }
    }
  }

  async me(): Promise<UserProfile | null> {
    if (!this.accessToken && !this.loadRefreshToken?.()) return null;
    if (!this.accessToken) {
      const ok = await this.refresh();
      if (!ok) return null;
    }
    try {
      return await this.raw<UserProfile>('/api/v1/auth/me');
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) await this.raw('/api/v1/auth/logout', { method: 'POST' }, false);
    } finally {
      this.clearTokens();
    }
  }

  // -- exams ---------------------------------------------------------------

  async listExams(): Promise<AssignedExam[]> {
    return this.raw<AssignedExam[]>('/api/v1/exams');
  }

  async getExam(examId: string): Promise<AssignedExam> {
    return this.raw<AssignedExam>(`/api/v1/exams/${examId}`);
  }

  // -- attempts ------------------------------------------------------------

  async startAttempt(
    examId: string,
    deviceInfo: Record<string, unknown>,
    consent: Record<string, unknown>,
  ): Promise<{ attempt: AttemptView; questions: unknown[] }> {
    return this.raw('/api/v1/attempts', {
      method: 'POST',
      body: JSON.stringify({ examId, deviceInfo, consent }),
    });
  }

  async getAttempt(
    attemptId: string,
  ): Promise<{ attempt: AttemptView; questions: unknown[]; answers: Array<{ questionId: string; value: unknown }> }> {
    return this.raw(`/api/v1/attempts/${attemptId}`);
  }

  async saveAnswer(attemptId: string, questionId: string, value: unknown): Promise<{ remainingMs: number }> {
    return this.raw(`/api/v1/attempts/${attemptId}/answers`, {
      method: 'POST',
      body: JSON.stringify({ questionId, value }),
    });
  }

  async heartbeat(attemptId: string): Promise<AttemptView> {
    return this.raw(`/api/v1/attempts/${attemptId}/heartbeat`, { method: 'POST' });
  }

  async submit(attemptId: string): Promise<AttemptView> {
    return this.raw(`/api/v1/attempts/${attemptId}/submit`, { method: 'POST' });
  }

  // -- proctoring ----------------------------------------------------------

  async postProctoringEvent(attemptId: string, event: QueuedEvent): Promise<void> {
    await this.raw('/api/v1/proctoring/events', {
      method: 'POST',
      body: JSON.stringify({
        attemptId,
        type: event.type,
        severity: event.severity,
        detail: event.detail,
        clientEventId: event.clientEventId,
      }),
    });
  }

  async updateMediaSession(attemptId: string, update: MediaSessionUpdate): Promise<void> {
    await this.raw('/api/v1/proctoring/sessions', {
      method: 'POST',
      body: JSON.stringify({ attemptId, ...update }),
    });
  }

  // -- media-session control plane (Phase 4A/4B) ---------------------------

  async createMediaSession(attemptId: string): Promise<MediaSessionInfo> {
    return this.raw('/api/v1/media/sessions', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    });
  }

  /** Short-lived SFU publisher credential (Phase 4B). */
  async getMediaToken(attemptId: string): Promise<MediaTokenInfo> {
    return this.raw('/api/v1/media/token', {
      method: 'POST',
      body: JSON.stringify({ attemptId }),
    });
  }

  async getMediaSession(id: string): Promise<MediaSessionInfo> {
    return this.raw(`/api/v1/media/sessions/${id}`);
  }

  async endMediaSession(id: string): Promise<MediaSessionInfo> {
    return this.raw(`/api/v1/media/sessions/${id}/end`, { method: 'POST' });
  }
}
