/**
 * ReliableOutbox unit tests: delivery, offline buffering, retry/backoff,
 * per-question answer coalescing, idempotency keys, persistence and cleanup.
 */
import {
  ReliableOutbox,
  type Deliverable,
  type OutboxStorage,
} from '../electron/outbox';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function memStorage(): OutboxStorage & { data: string | null } {
  const s = {
    data: null as string | null,
    read: () => s.data,
    write: (json: string) => {
      s.data = json;
    },
  };
  return s;
}

const EVENT = { type: 'EXAM_WINDOW_LOST_FOCUS', severity: 'WARNING', detail: { source: 'window' } };

describe('ReliableOutbox', () => {
  it('delivers an event with a stable clientEventId and removes it after success', async () => {
    const storage = memStorage();
    const delivered: Deliverable[] = [];
    const outbox = new ReliableOutbox(
      storage,
      {
        deliver: async (entry) => {
          delivered.push(entry);
        },
      },
      { maxStored: 100 },
    );

    const ok = outbox.enqueueEvent('attempt-1', EVENT);
    expect(ok).toBe(true);
    expect(outbox.pendingCount).toBe(1);

    await outbox.pump();
    await tick();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].attemptId).toBe('attempt-1');
    expect(delivered[0].kind).toBe('event');
    const payload = (delivered[0] as { payload: { clientEventId: string } }).payload;
    expect(payload.clientEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outbox.pendingCount).toBe(0);

  });

  it('rejects unknown event types instead of queueing garbage', () => {
    const outbox = new ReliableOutbox(memStorage(), { deliver: async () => undefined }, {});
    expect(outbox.enqueueEvent('a', { type: 'CHEATING_CONFIRMED', severity: 'CRITICAL' })).toBe(false);
    expect(outbox.enqueueEvent('a', { type: 'EXAM_WINDOW_LOST_FOCUS', severity: 'FATAL' })).toBe(false);
    expect(outbox.pendingCount).toBe(0);
  });

  it('buffers while offline and flushes once the network returns', async () => {
    const delivered: Deliverable[] = [];
    const outbox = new ReliableOutbox(
      memStorage(),
      {
        deliver: async (entry) => {
          delivered.push(entry);
        },
      },
      {},
    );
    outbox.setOnline(false);
    outbox.enqueueEvent('attempt-1', EVENT);
    outbox.enqueueAnswer('attempt-1', 'q-1', 'alpha');
    await tick();
    expect(delivered).toHaveLength(0);
    expect(outbox.pendingCount).toBe(2);

    outbox.setOnline(true);
    await outbox.pump();
    await tick();
    expect(delivered).toHaveLength(2);
    expect(outbox.pendingCount).toBe(0);
  });

  it('coalesces repeated answers for the same question and delivers the latest value', async () => {
    const delivered: Deliverable[] = [];
    const outbox = new ReliableOutbox(
      memStorage(),
      {
        deliver: async (entry) => {
          delivered.push(entry);
        },
      },
      {},
    );
    outbox.setOnline(false);
    outbox.enqueueAnswer('attempt-1', 'q-1', 'first draft');
    outbox.enqueueAnswer('attempt-1', 'q-1', 'final draft');
    outbox.enqueueAnswer('attempt-1', 'q-2', 'other');
    expect(outbox.pendingCount).toBe(2); // two questions, one coalesced entry each
    outbox.setOnline(true);
    await outbox.pump();
    await tick();

    const answerDeliveries = delivered.filter((d) => d.kind === 'answer');
    expect(answerDeliveries).toHaveLength(2);
    const q1 = answerDeliveries.find(
      (d) => (d as { payload: { questionId: string } }).payload.questionId === 'q-1',
    ) as { payload: { value: unknown } };
    expect(q1.payload.value).toBe('final draft');
  });

  it('retries with capped backoff and gives up after maxAttempts', async () => {
    let now = 0;
    let deliveries = 0;
    const outbox = new ReliableOutbox(
      memStorage(),
      {
        deliver: async () => {
          deliveries += 1;
          throw new Error('network down');
        },
      },
      { maxAttempts: 3, retryBaseMs: 2_000, now: () => now },
    );

    outbox.enqueueEvent('attempt-1', EVENT);
    await outbox.pump(); // attempt 1 fails
    expect(outbox.pendingCount).toBe(1);

    now = 1_999;
    await outbox.pump(); // not yet due — no new attempt
    expect(deliveries).toBe(1);

    now = 2_000;
    await outbox.pump(); // attempt 2 fails
    now = 6_000; // 2s -> 4s backoff
    await outbox.pump(); // attempt 3 fails -> dropped
    expect(deliveries).toBe(3);
    expect(outbox.pendingCount).toBe(0);
  });

  it('delivers a rapid burst enqueued while the first delivery is in flight', async () => {
    const delivered: Deliverable[] = [];
    const outbox = new ReliableOutbox(
      memStorage(),
      {
        deliver: async (entry) => {
          delivered.push(entry);
          await new Promise((resolve) => setTimeout(resolve, 2));
        },
      },
      {},
    );
    // Four events land within milliseconds of each other (media connect burst).
    outbox.enqueueEvent('attempt-1', EVENT);
    outbox.enqueueEvent('attempt-1', { type: 'CAMERA_CONNECTED', severity: 'INFO', detail: {} });
    outbox.enqueueEvent('attempt-1', { type: 'MIC_CONNECTED', severity: 'INFO', detail: {} });
    outbox.enqueueEvent('attempt-1', { type: 'NETWORK_RESTORED', severity: 'INFO', detail: {} });
    // The flush loop runs asynchronously across several delivery sleeps — poll.
    for (let i = 0; i < 50 && outbox.pendingCount > 0; i += 1) await tick();
    expect(delivered).toHaveLength(4);
    expect(outbox.pendingCount).toBe(0);
  });

  it('persists queued entries and replays them from a new instance', async () => {
    const storage = memStorage();
    const delivered: Deliverable[] = [];
    const first = new ReliableOutbox(
      storage,
      { deliver: async () => undefined },
      { maxStored: 100 },
    );
    first.setOnline(false);
    first.enqueueEvent('attempt-1', EVENT);
    await tick();

    const second = new ReliableOutbox(
      storage,
      {
        deliver: async (entry) => {
          delivered.push(entry);
        },
      },
      { maxStored: 100 },
    );
    expect(second.pendingCount).toBe(1);
    await second.pump();
    expect(delivered).toHaveLength(1);
  });

  it('clears all queued work for an attempt on submit/terminate', async () => {
    const outbox = new ReliableOutbox(memStorage(), { deliver: async () => undefined }, {});
    outbox.setOnline(false);
    outbox.enqueueEvent('attempt-1', EVENT);
    outbox.enqueueAnswer('attempt-1', 'q-1', 'x');
    outbox.enqueueEvent('attempt-2', EVENT);
    expect(outbox.pendingCount).toBe(3);

    outbox.clearAttempt('attempt-1');
    expect(outbox.pendingCount).toBe(1);
  });

  it('clearAll drops the entire queue (new user login)', async () => {
    const storage = memStorage();
    const outbox = new ReliableOutbox(storage, { deliver: async () => undefined }, {});
    outbox.setOnline(false);
    outbox.enqueueEvent('attempt-1', EVENT);
    outbox.enqueueAnswer('attempt-1', 'q-1', 'x');
    expect(outbox.pendingCount).toBe(2);

    outbox.clearAll();
    expect(outbox.pendingCount).toBe(0);

    // And the persisted file reflects the cleared queue.
    const reloaded = new ReliableOutbox(storage, { deliver: async () => undefined }, {});
    expect(reloaded.pendingCount).toBe(0);
  });
});
