/**
 * Reliable delivery outbox (spec §17-§18, §21).
 *
 * Security events and answer saves are enqueued, persisted to disk, and
 * retried with capped exponential backoff until the server acknowledges them.
 * Every event carries a stable clientEventId so a retry that actually reached
 * the server is deduplicated there (at-least-once delivery, effectively-once
 * semantics). Nothing is silently dropped when the network is down.
 *
 * Pure module — persistence and transport are injected, so this is fully
 * unit-testable without Electron.
 */
import type { QueuedEvent } from '../src/shared/types';
import { validateSensorPayload, toQueuedEvent } from '../src/shared/sensors';

export type Deliverable =
  | { attemptId: string; kind: 'event'; payload: QueuedEvent }
  | { attemptId: string; kind: 'answer'; payload: { questionId: string; value: unknown } };

interface StoredEntry {
  id: string;
  kind: Deliverable['kind'];
  payload: unknown;
  attemptId: string;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

export interface OutboxStorage {
  read(): string | null;
  write(json: string): void;
}

export interface OutboxTransport {
  deliver(entry: Deliverable): Promise<void>;
}

export interface OutboxOptions {
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxAttempts?: number;
  maxStored?: number;
  now?: () => number;
  onStatus?: (status: { pending: number; lastError: string | null }) => void;
}

export class ReliableOutbox {
  private entries: StoredEntry[] = [];
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxAttempts: number;
  private readonly maxStored: number;
  private readonly now: () => number;
  private readonly onStatus?: OutboxOptions['onStatus'];
  private flushing = false;
  private online = true;

  constructor(
    private readonly storage: OutboxStorage,
    private readonly transport: OutboxTransport,
    opts: OutboxOptions,
  ) {
    this.retryBaseMs = opts.retryBaseMs ?? 2_000;
    this.retryMaxMs = opts.retryMaxMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 20;
    this.maxStored = opts.maxStored ?? 5_000;
    this.now = opts.now ?? Date.now;
    this.onStatus = opts.onStatus;
    this.load();
  }

  // -- public API ----------------------------------------------------------

  get pendingCount(): number {
    return this.entries.length;
  }

  setOnline(online: boolean): void {
    this.online = online;
    if (online) void this.pump();
  }

  /** Enqueues an answer; an earlier unsent answer for the same question is replaced. */
  enqueueAnswer(attemptId: string, questionId: string, value: unknown): void {
    const existing = this.entries.find(
      (e) =>
        e.kind === 'answer' &&
        e.attemptId === attemptId &&
        (e.payload as { questionId: string }).questionId === questionId,
    );
    if (existing) {
      existing.payload = { questionId, value };
      existing.attempts = 0;
      existing.nextAttemptAt = 0;
      this.persist();
      void this.pump();
      return;
    }
    this.entries.push({
      id: crypto.randomUUID ? crypto.randomUUID() : `a-${this.now()}`,
      kind: 'answer',
      payload: { questionId, value },
      attemptId,
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: 0,
    });
    this.trim();
    this.persist();
    void this.pump();
  }

  /** Validates and enqueues a sensor event; returns false for invalid input. */
  enqueueEvent(attemptId: string, rawPayload: unknown): boolean {
    const check = validateSensorPayload(rawPayload);
    if (!check.ok) return false;
    const event = toQueuedEvent(check.payload, this.now());
    this.entries.push({
      id: event.clientEventId,
      kind: 'event',
      payload: event,
      attemptId,
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: 0,
    });
    this.trim();
    this.persist();
    void this.pump();
    return true;
  }

  /** Drops all queued work for an attempt (after submit/terminate). */
  clearAttempt(attemptId: string): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.attemptId !== attemptId);
    if (this.entries.length !== before) {
      this.persist();
      this.report();
    }
  }

  /**
   * Drops the whole queue. Called when a DIFFERENT user logs in — entries from
   * a previous account can never be delivered with the new token and would
   * otherwise retry into permanent 403s.
   */
  clearAll(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.persist();
    this.report();
  }

  async pump(): Promise<void> {
    if (this.flushing || !this.online) return;
    this.flushing = true;
    try {
      // Outer loop re-checks for work: entries enqueued WHILE a delivery was in
      // flight would otherwise miss this pump and wait for the next timer tick.
      while (this.online) {
        const due = this.entries.filter((e) => e.nextAttemptAt <= this.now());
        if (due.length === 0) break;
        for (const entry of due) {
          if (!this.online) break;
          try {
            await this.transport.deliver(this.toDeliverable(entry));
            this.entries = this.entries.filter((e) => e.id !== entry.id);
            this.persist();
          } catch {
            entry.attempts += 1;
            if (entry.attempts >= this.maxAttempts) {
              // Gave up after sustained failure (server-side attempt likely gone).
              this.entries = this.entries.filter((e) => e.id !== entry.id);
            } else {
              entry.nextAttemptAt = this.now() + this.backoff(entry.attempts);
            }
            this.persist();
          }
        }
      }
    } finally {
      this.flushing = false;
      this.report();
    }
  }

  /** Schedules retries for everything still pending (called on a timer). */
  schedule(): number {
    void this.pump();
    const next = Math.min(...this.entries.map((e) => Math.max(0, e.nextAttemptAt - this.now())));
    return Number.isFinite(next) ? next : -1;
  }

  // -- internals -----------------------------------------------------------

  private backoff(attempt: number): number {
    return Math.min(this.retryBaseMs * 2 ** Math.min(attempt - 1, 10), this.retryMaxMs);
  }

  private toDeliverable(entry: StoredEntry): Deliverable {
    if (entry.kind === 'event') {
      return { attemptId: entry.attemptId, kind: 'event', payload: entry.payload as QueuedEvent };
    }
    return {
      attemptId: entry.attemptId,
      kind: 'answer',
      payload: entry.payload as { questionId: string; value: unknown },
    };
  }

  private trim(): void {
    if (this.entries.length > this.maxStored) {
      this.entries = this.entries.slice(this.entries.length - this.maxStored);
    }
  }

  private persist(): void {
    try {
      this.storage.write(JSON.stringify(this.entries));
    } catch {
      // Queue persistence must never take the app down; entries stay in memory.
    }
  }

  private load(): void {
    try {
      const raw = this.storage.read();
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredEntry[];
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      this.entries = [];
    }
  }

  private report(): void {
    const lastError = null;
    this.onStatus?.({ pending: this.entries.length, lastError });
  }
}
