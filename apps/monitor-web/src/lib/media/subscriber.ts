/**
 * Monitor live-media subscriber (Phase 4C).
 *
 * Framework-agnostic module shared by the monitor portal's LiveMediaPanel and
 * the E2E harness. It is a CONSUMER only — it never calls getUserMedia. Media
 * comes from the SFU as authorized consumers of the student's existing
 * camera/microphone/screen producers (student publishes once; the SFU forwards
 * to every authorized subscriber — never student → monitor direct).
 *
 * Lifecycle: start() → connecting → subscribed (tracks attached) → stop().
 *
 * Resilience: the student publisher legitimately reconnects (its room is
 * replaced server-side), so a transient "room gone"/socket drop mid-feed is
 * NOT fatal — the subscriber re-subscribes with a FRESH short-lived token
 * (bounded). Only two conditions stop it permanently:
 *   - token issuance is refused (401/403/404 — the attempt ended or the
 *     monitor lost authorization), or
 *   - the bounded retry budget is exhausted.
 * The server remains authoritative: an ended attempt refuses new tokens, so
 * the subscriber can never resubscribe into the void.
 *
 * Audio stays muted unless the caller explicitly unmutes the focused student.
 */
import { Device, types as msTypes } from 'mediasoup-client';

type Consumer = msTypes.Consumer;
type Transport = msTypes.Transport;
type RtpCapabilities = msTypes.RtpCapabilities;
type IceParameters = msTypes.IceParameters;
type IceCandidate = msTypes.IceCandidate;
type DtlsParameters = msTypes.DtlsParameters;

export type TrackKind = 'camera' | 'microphone' | 'screen';

export type SubscriberState =
  | 'idle'
  | 'connecting'
  | 'reconnecting'
  | 'subscribed'
  | 'stopped'
  | 'failed';

export interface SubscriberTokenInfo {
  token: string;
  sfuUrl: string;
  mediaSessionId: string;
  participantId: string;
  attemptId: string;
  expiresInSeconds: number;
}

export interface FeedState {
  kind: TrackKind;
  /** live = an active consumer is attached; unavailable = feed ended/never was. */
  status: 'live' | 'connecting' | 'unavailable';
  consumerId: string | null;
}

export interface SubscriberOptions {
  attemptId: string;
  /** Fetched per (re)connect — tokens are short-lived and never cached. */
  getToken(): Promise<SubscriberTokenInfo>;
  onState?(state: SubscriberState, feeds: FeedState[]): void;
  onClose?(info: { code: number; reason: string }): void;
  /** Console-style sink so the E2E harness can observe without React. */
  log?(line: string): void;
}

type ServerMsg = { type?: string; data?: Record<string, unknown> };

const RETRY_DELAYS_MS = [400, 800, 1_500, 3_000, 5_000, 8_000];

class SubscriberError extends Error {
  constructor(
    message: string,
    /** True when retrying can never succeed (auth/token/attempt ended). */
    public readonly terminal: boolean,
  ) {
    super(message);
  }
}

export class MonitorSubscriber {
  readonly attemptId: string;
  private readonly opts: SubscriberOptions;
  private state: SubscriberState = 'idle';
  private ws: WebSocket | null = null;
  private device: Device | null = null;
  private transport: Transport | null = null;
  private readonly trackByKind = new Map<TrackKind, MediaStreamTrack>();
  private readonly consumerByKind = new Map<TrackKind, Consumer>();
  private readonly pending: Array<{
    resolve(data: Record<string, unknown>): void;
    reject(err: Error): void;
  }> = [];
  private stopping = false;
  private busy = false;
  private attempts = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once a feed was live — a later drop is a *re*connect, shown as such. */
  private hadLive = false;
  private sessionInfo: { participantId: string; mediaSessionId: string; roomId: string } | null = null;

  constructor(opts: SubscriberOptions) {
    this.opts = opts;
    this.attemptId = opts.attemptId;
  }

  get stateValue(): SubscriberState {
    return this.state;
  }

  get participantId(): string | null {
    return this.sessionInfo?.participantId ?? null;
  }

  snapshot(): { state: SubscriberState; feeds: FeedState[] } {
    const kinds: TrackKind[] = ['camera', 'microphone', 'screen'];
    return {
      state: this.state,
      feeds: kinds.map((kind) => {
        const consumer = this.consumerByKind.get(kind);
        const track = this.trackByKind.get(kind);
        return {
          kind,
          status:
            consumer && track && track.readyState === 'live'
              ? 'live'
              : this.state === 'subscribed'
                ? 'connecting'
                : 'unavailable',
          consumerId: consumer?.id ?? null,
        };
      }),
    };
  }

  /** Feed track for the UI (null while connecting / after the feed ended). */
  trackOf(kind: TrackKind): MediaStreamTrack | null {
    return this.trackByKind.get(kind) ?? null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Connect + subscribe. Never rejects for transient conditions — it loops
   * internally (bounded) until subscribed, stopped (token refused / attempt
   * ended), failed (budget exhausted) or stop() was called.
   */
  async start(): Promise<void> {
    if (this.stopping || this.state === 'subscribed' || this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        if (this.stopping) return;
        // Distinguish the first connect from bounded reconnects after a drop so
        // the UI can show an honest Reconnecting… state instead of a generic
        // connecting spinner.
        this.setState(this.hadLive ? 'reconnecting' : 'connecting');
        try {
          await this.connectOnce();
          if (this.stopping) return;
          this.hadLive = true;
          this.attempts = 0;
          this.setState('subscribed');
          return;
        } catch (err) {
          if (this.stopping) return;
          const error = err instanceof Error ? err : new Error(String(err));
          const message = error.message;
          const terminal = error instanceof SubscriberError && error.terminal;
          this.log(`subscribe attempt failed: ${message}`);
          if (terminal) {
            this.stopping = true;
            this.teardownConnection();
            this.opts.onClose?.({ code: 0, reason: message });
            this.setState('stopped');
            return;
          }
          this.attempts += 1;
          if (this.attempts > RETRY_DELAYS_MS.length) {
            this.log(`giving up after ${this.attempts - 1} retries: ${message}`);
            this.teardownConnection();
            this.setState('failed');
            return;
          }
          await sleep(RETRY_DELAYS_MS[this.attempts - 1]);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** Idempotent teardown — closes consumers, transport and the socket. */
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'leave' }));
      } catch {
        // ignore
      }
    }
    this.teardownConnection();
    this.setState('stopped');
  }

  /** Socket dropped (any code except clean local leave). Bounded retry. */
  private onSocketClosed(code: number, reason: string): void {
    if (this.stopping) return;
    this.sessionInfo = null;
    this.teardownConnection();
    this.opts.onClose?.({ code, reason });
    this.attempts = 0;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopping) void this.start().catch(() => undefined);
    }, 400);
  }

  // -------------------------------------------------------------------------
  // Connect internals
  // -------------------------------------------------------------------------

  private async connectOnce(): Promise<void> {
    let token: SubscriberTokenInfo;
    try {
      token = await this.opts.getToken();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Token refusal = the attempt ended or the monitor lost authorization:
      // permanent, server-authoritative.
      const terminal = /(401|403|404)/.test(message) || !/timed out|network|fetch/i.test(message);
      throw new SubscriberError(`token refused: ${message}`, terminal);
    }

    this.closeTransportAndConsumers();
    this.device = null;
    const socket = new WebSocket(token.sfuUrl);
    this.ws = socket;
    this.log('connecting to SFU');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SubscriberError('SFU connection timed out', false)),
        8_000,
      );
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new SubscriberError('SFU connection failed', false));
      };
    });

    socket.onmessage = (event) => this.handleServerMessage(event.data);
    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.onSocketClosed(typeof event?.code === 'number' ? event.code : 1006, String(event?.reason ?? ''));
    };

    let join: {
      roomId: string;
      participantId: string;
      mediaSessionId?: string;
      role: string;
      routerRtpCapabilities: RtpCapabilities;
      producers?: Array<{ producerId: string; kind: 'audio' | 'video'; appKind: TrackKind }>;
    };
    try {
      join = await this.request<typeof join>('join', { token: token.token });
    } catch (err) {
      // 409 = no publisher room right now (it may be reconnecting) — retryable.
      throw new SubscriberError(`join refused: ${err instanceof Error ? err.message : String(err)}`, false);
    }

    const device = new Device();
    await device.load({ routerRtpCapabilities: join.routerRtpCapabilities });
    this.device = device;

    const transportParams = await this.request<{
      transportId: string;
      iceParameters: IceParameters;
      iceCandidates: IceCandidate[];
      dtlsParameters: DtlsParameters;
    }>('create-transport', { direction: 'recv' });

    const transport = device.createRecvTransport({
      id: transportParams.transportId,
      iceParameters: transportParams.iceParameters,
      iceCandidates: transportParams.iceCandidates,
      dtlsParameters: transportParams.dtlsParameters,
    });
    transport.on(
      'connect',
      (
        { dtlsParameters }: { dtlsParameters: DtlsParameters },
        callback: () => void,
        errback: (error: Error) => void,
      ) => {
        void this.request('connect-transport', { transportId: transport.id, dtlsParameters })
          .then(() => callback())
          .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
      },
    );
    this.transport = transport;

    this.sessionInfo = {
      participantId: join.participantId,
      mediaSessionId: join.mediaSessionId ?? join.participantId,
      roomId: join.roomId,
    };
    this.log(
      `joined room ${join.roomId} (${JSON.stringify(join.producers ?? [])})`,
    );

    // Consume every producer the SFU currently advertises. Individual consume
    // failures are logged and retried by the outer loop only if no consumer
    // survives — a single missing feed must not kill the subscription.
    let consumedAny = false;
    for (const producer of join.producers ?? []) {
      if (this.stopping) return;
      const kind = normalizeKind(producer.appKind, producer.kind);
      if (!kind || this.consumerByKind.has(kind)) continue;
      try {
        await this.consume(kind, producer.producerId);
        consumedAny = true;
      } catch (err) {
        this.log(`consume ${kind} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!consumedAny && (join.producers?.length ?? 0) > 0) {
      throw new SubscriberError('no producers could be consumed', false);
    }
  }

  private async consume(kind: TrackKind, producerId: string): Promise<void> {
    const transport = this.transport;
    const device = this.device;
    if (!transport || !device || this.stopping) return;
    const consumed = await this.request<{
      consumerId: string;
      producerId: string;
      kind: 'audio' | 'video';
      appKind: TrackKind;
      rtpParameters: msTypes.RtpParameters;
    }>('consume', {
      transportId: transport.id,
      producerId,
      rtpCapabilities: device.rtpCapabilities,
    });
    if (this.stopping) return;
    const consumer: Consumer = await transport.consume({
      id: consumed.consumerId,
      producerId: consumed.producerId,
      kind: consumed.kind,
      rtpParameters: consumed.rtpParameters,
    });
    const track = consumer.track;
    this.consumerByKind.set(kind, consumer);
    this.trackByKind.set(kind, track);
    this.log(`consumer ${kind} created (${consumer.id.slice(0, 8)})`);
    const drop = (why: string): void => {
      if (this.consumerByKind.get(kind) !== consumer) return;
      this.consumerByKind.delete(kind);
      this.trackByKind.delete(kind);
      this.log(`consumer ${kind} ended (${why})`);
      this.setState(this.state); // nudge listeners with updated feeds
    };
    consumer.on('trackended', () => drop('track-ended'));
    consumer.on('transportclose', () => drop('transport-closed'));
    consumer.on('@close', () => drop('closed'));
    this.setState(this.state);
  }

  /** A new producer appeared while subscribed (device came up mid-exam). */
  private onProducerAdded(appKind: string, producerId: string): void {
    if (this.stopping) return;
    const kind = normalizeKind(appKind, undefined);
    if (!kind || this.consumerByKind.has(kind)) return;
    void this.consume(kind, producerId).catch(() => undefined);
  }

  // -------------------------------------------------------------------------
  // Socket plumbing
  // -------------------------------------------------------------------------

  private handleServerMessage(raw: unknown): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(String(raw)) as ServerMsg;
    } catch {
      return;
    }
    if (msg.type === 'producer-added') {
      const appKind = String(msg.data?.appKind ?? '');
      const producerId = String(msg.data?.producerId ?? '');
      if (appKind && producerId) this.onProducerAdded(appKind, producerId);
      return;
    }
    if (msg.type === 'consumer-closed') {
      const consumerId = String(msg.data?.consumerId ?? '');
      for (const [kind, consumer] of this.consumerByKind) {
        if (consumer.id === consumerId) {
          this.consumerByKind.delete(kind);
          this.trackByKind.delete(kind);
          this.log(`server closed consumer ${kind}`);
          this.setState(this.state);
        }
      }
      return;
    }
    const waiter = this.pending.shift();
    if (!waiter) {
      // Unsolicited error (e.g. room torn down mid-flow): re-subscribe, unless
      // the server refused authorization — then stop permanently.
      if (msg.type === 'error') {
        const code = Number(msg.data?.code ?? 0);
        const terminal = code === 401 || code === 403;
        if (terminal) {
          this.stopping = true;
          this.teardownConnection();
          this.opts.onClose?.({ code, reason: 'authorization refused' });
          this.setState('stopped');
        } else {
          this.onSocketClosed(code, 'transient error');
        }
      }
      return;
    }
    if (msg.type === 'error') {
      const code = Number(msg.data?.code ?? 0);
      const message = String(msg.data?.message ?? 'SFU error');
      const terminal = code === 401 || code === 403;
      if (terminal) this.stopping = true; // server-side refusal — stop retries
      waiter.reject(new SubscriberError(`SFU ${code}: ${message}`, terminal));
      return;
    }
    waiter.resolve(msg.data ?? {});
  }

  /** Single in-flight request at a time — the SFU answers requests in order. */
  private async request<T>(type: string, data: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new SubscriberError('not connected to SFU', false);
    }
    const payload = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
    this.ws.send(JSON.stringify({ type, data }));
    return (await payload) as T;
  }

  // -------------------------------------------------------------------------
  // Teardown helpers
  // -------------------------------------------------------------------------

  private teardownConnection(): void {
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      try {
        this.ws.close(1000, 'teardown');
      } catch {
        // already closed
      }
      this.ws = null;
    }
    this.closeTransportAndConsumers();
    this.sessionInfo = null;
  }

  private closeTransportAndConsumers(): void {
    for (const consumer of this.consumerByKind.values()) {
      try {
        consumer.close();
      } catch {
        // already closed
      }
    }
    this.consumerByKind.clear();
    this.trackByKind.clear();
    try {
      this.transport?.close();
    } catch {
      // already closed
    }
    this.transport = null;
    this.device = null;
  }

  private setState(next: SubscriberState): void {
    this.state = next;
    this.opts.onState?.(next, this.snapshot().feeds);
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeKind(appKind: string, mediaKind: 'audio' | 'video' | undefined): TrackKind | null {
  if (appKind === 'camera' || appKind === 'microphone' || appKind === 'screen') return appKind;
  if (mediaKind === 'audio') return 'microphone';
  if (mediaKind === 'video') return 'camera';
  return null;
}
