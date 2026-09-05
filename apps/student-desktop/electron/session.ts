/**
 * Exam session coordinator (spec §4-§5, §15, §21-§22). Pure logic — Electron
 * wiring lives in main.ts. The server remains authoritative for timing and
 * status; this class only mirrors server state into the renderer and feeds the
 * outbox.
 */
import type {
  AttemptView,
  MediaSessionUpdate,
  RendererAttemptState,
  SensorEventPayload,
  UserProfile,
} from '../src/shared/types';
import type { ApiClient } from './api';
import type { ReliableOutbox } from './outbox';
import { MediaLink } from './mediaLink';

export type SessionListener = (state: RendererAttemptState) => void;

export interface SessionOptions {
  api: ApiClient;
  outbox: ReliableOutbox;
  appVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  heartbeatMs?: number;
  /** Called when the session wants the UI to exit secure mode. */
  onExitSecureMode?: () => void;
}

export class ExamSession {
  private readonly api: ApiClient;
  private readonly outbox: ReliableOutbox;
  private readonly appVersion: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly osRelease: string;
  private readonly heartbeatMs: number;
  private readonly onExitSecureMode?: () => void;

  user: UserProfile | null = null;
  attempt: AttemptView | null = null;
  questions: unknown[] = [];
  answers = new Map<string, unknown>();
  private attemptId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<SessionListener>();
  private lastSavedAnswerMs = 0;
  /** Phase 4A media-session control link (created once the attempt is ACTIVE). */
  private media: MediaLink | null = null;

  constructor(opts: SessionOptions) {
    this.api = opts.api;
    this.outbox = opts.outbox;
    this.appVersion = opts.appVersion;
    this.platform = opts.platform;
    this.arch = opts.arch;
    this.osRelease = opts.osRelease;
    this.heartbeatMs = opts.heartbeatMs ?? 15_000;
    this.onExitSecureMode = opts.onExitSecureMode;
  }

  // -- auth ----------------------------------------------------------------

  async login(email: string, password: string): Promise<UserProfile> {
    const user = await this.api.login(email, password);
    this.user = user;
    // A fresh login is a new account context: any events/answers still queued
    // from a previous user could never be delivered with the new token.
    this.outbox.clearAll();
    this.emitSession();
    return user;
  }

  async tryRestore(): Promise<UserProfile | null> {
    if (!this.api.hasPersistedSession) return null;
    const user = await this.api.me();
    if (user) {
      this.user = user;
      this.emitSession();
    }
    return user;
  }

  async logout(): Promise<void> {
    this.stopHeartbeat();
    this.stopMedia('logout');
    this.attempt = null;
    this.attemptId = null;
    this.questions = [];
    this.answers.clear();
    if (this.user) await this.api.logout();
    this.user = null;
    this.emitSession();
    this.emitAttempt({ status: 'idle', attempt: null, blocked: false });
    this.onExitSecureMode?.();
  }

  get deviceInfo(): Record<string, unknown> {
    return {
      os: this.platform,
      appVersion: this.appVersion,
      platform: this.platform,
      arch: this.arch,
      osRelease: this.osRelease,
      client: 'student-desktop',
    };
  }

  // -- exams ---------------------------------------------------------------

  listExams() {
    return this.api.listExams();
  }

  getExam(examId: string) {
    return this.api.getExam(examId);
  }

  // -- attempt lifecycle ---------------------------------------------------

  async start(examId: string, consent: Record<string, unknown>): Promise<{ attempt: AttemptView; questions: unknown[] }> {
    const res = await this.api.startAttempt(examId, this.deviceInfo, {
      version: '1',
      acceptedAt: new Date().toISOString(),
      ...consent,
    });
    this.attachAttempt(res.attempt, res.questions);
    return res;
  }

  async resumeExisting(attemptId: string): Promise<void> {
    const res = await this.api.getAttempt(attemptId);
    this.attachAttempt(res.attempt, res.questions);
    for (const a of res.answers) this.answers.set(a.questionId, a.value);
  }

  private attachAttempt(attempt: AttemptView, questions: unknown[]): void {
    this.attempt = attempt;
    this.attemptId = attempt.id;
    this.questions = questions;
    this.emitAttempt(this.mapState());
    this.startHeartbeat();
    // Ensure the outbox knows this attempt is live again.
    this.outbox.setOnline(true);
    void this.outbox.pump();
    if (attempt.status === 'ACTIVE') this.ensureMedia();
  }

  get currentAttemptId(): string | null {
    return this.attemptId;
  }

  mapState(): RendererAttemptState {
    const a = this.attempt;
    if (!a) return { status: 'idle', attempt: null, blocked: false };
    switch (a.status) {
      case 'ACTIVE':
        return { status: 'active', attempt: a, blocked: false };
      case 'PAUSED':
        return { status: 'paused', attempt: a, blocked: true };
      case 'SUBMITTED':
      case 'AUTO_SUBMITTED':
        return { status: 'submitted', attempt: a, blocked: true };
      case 'TERMINATED':
        return { status: 'terminated', attempt: a, blocked: true };
      default:
        return { status: 'active', attempt: a, blocked: false };
    }
  }

  // -- answers -------------------------------------------------------------

  /** Immediately persists via outbox; server is authoritative for writes. */
  saveAnswer(questionId: string, value: unknown): void {
    this.answers.set(questionId, value);
    if (!this.attemptId) return;
    this.lastSavedAnswerMs = Date.now();
    this.outbox.enqueueAnswer(this.attemptId, questionId, value);
  }

  getLastSaveMs(): number {
    return this.lastSavedAnswerMs;
  }

  async submit(): Promise<AttemptView> {
    if (!this.attemptId) throw new Error('No active attempt');
    const view = await this.api.submit(this.attemptId);
    await this.finishAttempt(view);
    return view;
  }

  // -- sensors -------------------------------------------------------------

  reportSensor(payload: SensorEventPayload): boolean {
    if (!this.attemptId) return false;
    return this.outbox.enqueueEvent(this.attemptId, payload);
  }

  updateMediaSession(update: MediaSessionUpdate): Promise<void> {
    if (!this.attemptId) return Promise.resolve();
    return this.api.updateMediaSession(this.attemptId, update).catch(() => undefined);
  }

  // -- heartbeat -----------------------------------------------------------

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.tick(), this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /** Server round-trip for an attempt (called by the heartbeat timer). */
  async tick(): Promise<void> {
    if (!this.attemptId || !this.user) return;
    try {
      await this.heartbeat(this.attemptId);
    } catch {
      // Offline: heartbeat failures are expected; event queue retries.
    }
  }

  /**
   * One server-authoritative heartbeat. The returned view replaces local state:
   * timer, pause state and termination all come from the server, never from the
   * client clock.
   */
  async heartbeat(attemptId: string): Promise<AttemptView> {
    if (this.attemptId !== attemptId) throw new Error('No active attempt for this id');
    const view = await this.api.heartbeat(attemptId);
    this.attempt = view;
    this.emitAttempt(this.mapState());
    if (view.status === 'SUBMITTED' || view.status === 'AUTO_SUBMITTED' || view.status === 'TERMINATED') {
      await this.finishAttempt(view);
    } else if (view.status === 'ACTIVE') {
      // Pause → resume restores the media control link if it had stopped.
      this.ensureMedia();
    }
    return view;
  }

  private async finishAttempt(view: AttemptView): Promise<void> {
    this.stopHeartbeat();
    this.stopMedia(view.status === 'TERMINATED' ? 'terminated' : 'submit');
    if (this.attemptId) this.outbox.clearAttempt(this.attemptId);
    this.attempt = view;
    this.attemptId = view.id;
    this.emitAttempt(this.mapState());
    this.onExitSecureMode?.();
  }

  // -- media-session control plane (Phase 4A) ------------------------------

  get mediaLink(): MediaLink | null {
    return this.media;
  }

  /** One authenticated control link per ACTIVE attempt (created lazily). */
  private ensureMedia(): void {
    const attemptId = this.attemptId;
    if (!attemptId || !this.user) return;
    if (this.media && this.media.attemptId === attemptId) return;
    if (this.media) this.media.stop('manual');
    this.media = new MediaLink({
      api: this.api,
      attemptId,
      status: () => this.attempt?.status ?? null,
      report: (payload) => {
        this.reportSensor(payload);
      },
    });
    void this.media.start().catch(() => undefined);
  }

  private stopMedia(reason: 'submit' | 'logout' | 'terminated' | 'manual'): void {
    if (!this.media) return;
    this.media.stop(reason);
    this.media = null;
  }

  /** Called by the renderer once it has torn down its media streams. */
  async release(): Promise<void> {
    this.stopHeartbeat();
    this.stopMedia('manual');
    if (this.attemptId && this.attempt && this.attempt.status !== 'ACTIVE' && this.attempt.status !== 'PAUSED') {
      this.outbox.clearAttempt(this.attemptId);
    }
  }

  // -- listeners -----------------------------------------------------------

  onAttempt(cb: SessionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emitAttempt(state: RendererAttemptState): void {
    for (const cb of this.listeners) cb(state);
  }

  private emitSession(): void {
    // Renderer subscribes through ipc 'ev:session'; main.ts forwards.
  }
}
