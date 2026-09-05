/**
 * Student WebRTC publisher (Phase 4B).
 *
 * Lives in the RENDERER because Chromium's WebRTC stack is only available
 * there; the sandbox/contextIsolation model is untouched — network + token
 * acquisition still travel through the main-process bridge (window.examguard).
 *
 * It NEVER acquires media itself: it consumes the live streams owned by the
 * Phase 3B/3C device controller (camera/microphone/screen) and attaches their
 * existing tracks to a mediasoup send transport. If a device is off, that
 * producer simply isn't published (reported later when it comes up).
 *
 * Lifecycle: start() → short-lived media token (main) → SFU join → device →
 * send transport → produce per live track. Socket loss → bounded reconnect
 * with the SAME participant (token refreshed per attempt) and producers are
 * re-created only if the old ones are gone (server enforces one per kind).
 */
import { Device, types as msTypes } from 'mediasoup-client';

type Producer = msTypes.Producer;
type Transport = msTypes.Transport;
type RtpCapabilities = msTypes.RtpCapabilities;
type IceParameters = msTypes.IceParameters;
type IceCandidate = msTypes.IceCandidate;
type DtlsParameters = msTypes.DtlsParameters;
import type { MediaTokenInfo, SensorEventPayload } from '../shared/types';

export type PublisherState =
  | 'idle'
  | 'connecting'
  | 'publishing'
  | 'reconnecting'
  | 'failed'
  | 'stopped';

export type PubKind = 'camera' | 'microphone' | 'screen';

export interface PublishedProducer {
  producerId: string;
  kind: PubKind;
  mediaType: 'audio' | 'video';
  paused: boolean;
}

export interface PublisherOptions {
  attemptId: string;
  /** Fetched in the main process over the secure bridge — never stored. */
  getToken(): Promise<MediaTokenInfo>;
  /** The Phase 3 device controller's live stream for a kind (may be null). */
  stream(kind: PubKind): MediaStream | null;
  /** Into the existing ReliableOutbox pipeline via window.examguard. */
  report(payload: SensorEventPayload): void;
  onState?(state: PublisherState, producers: PublishedProducer[]): void;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000];
const MAX_RETRIES = 4;

type ServerMsg = { type?: string; data?: Record<string, unknown> };

export class SfuPublisher {
  readonly attemptId: string;
  private readonly opts: PublisherOptions;
  private state: PublisherState = 'idle';
  private ws: WebSocket | null = null;
  private device: Device | null = null;
  private sendTransport: Transport | null = null;
  private readonly produced = new Map<PubKind, PublishedProducer>();
  private stopping = false;
  private started = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disconnectGraceTimer: ReturnType<typeof setTimeout> | null = null;
  private transportState = 'new';
  private pending: Array<{
    resolve(data: Record<string, unknown>): void;
    reject(err: Error): void;
  }> = [];

  constructor(opts: PublisherOptions) {
    this.opts = opts;
    this.attemptId = opts.attemptId;
  }

  get stateValue(): PublisherState {
    return this.state;
  }

  snapshot(): { state: PublisherState; producers: PublishedProducer[] } {
    return { state: this.state, producers: Array.from(this.produced.values()) };
  }

  async start(): Promise<void> {
    if (this.started && this.state !== 'failed' && this.state !== 'stopped') return;
    this.started = true;
    this.stopping = false;
    this.setState('connecting');
    this.report({ type: 'MEDIA_PUBLISHER_CONNECTING', severity: 'INFO', detail: {} });
    await this.connectOnce();
  }

  /**
   * Produce any live track that is not yet published (idempotent). Called when
   * a device comes up mid-exam and after reconnects.
   */
  async publishLive(): Promise<void> {
    if (this.state !== 'publishing' || this.stopping) return;
    const kinds: PubKind[] = ['camera', 'microphone', 'screen'];
    for (const kind of kinds) {
      if (this.produced.has(kind)) continue;
      const stream = this.opts.stream(kind);
      if (!stream) continue;
      const track = kind === 'microphone' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
      if (!track) continue;
      await this.produceTrack(kind, track);
    }
  }

  /** Tear down everything (submit/terminate/logout/unmount). Idempotent. */
  stop(reason: 'submit' | 'terminated' | 'manual' = 'manual'): void {
    if (this.stopping) return;
    this.stopping = true;
    this.clearTimers();
    this.clearSocketHandlers();
    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // already closing
      }
      this.ws = null;
    }
    this.closeTransport();
    this.device = null;
    const wasActive = this.state === 'publishing' || this.state === 'reconnecting' || this.state === 'connecting';
    if (wasActive) {
      this.report({ type: 'MEDIA_PUBLISHER_DISCONNECTED', severity: 'INFO', detail: { reason } });
    }
    this.produced.clear();
    this.setState('stopped');
  }

  // -------------------------------------------------------------------------
  // Connect / reconnect
  // -------------------------------------------------------------------------

  private busy = false;

  private async connectOnce(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    try {
      await this.doConnect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.stopping) return;
      if (this.retries >= MAX_RETRIES) {
        this.report({ type: 'MEDIA_PUBLISHER_FAILED', severity: 'WARNING', detail: { message } });
        this.setState('failed');
        return;
      }
      this.setState('reconnecting');
      if (this.retries === 0) {
        this.report({ type: 'MEDIA_PUBLISHER_RECONNECTING', severity: 'WARNING', detail: { message } });
      }
      this.retries += 1;
      const delay = RETRY_DELAYS_MS[Math.min(this.retries - 1, RETRY_DELAYS_MS.length - 1)];
      this.retryTimer = setTimeout(() => void this.connectOnce(), delay);
    } finally {
      this.busy = false;
    }
  }

  private async doConnect(): Promise<void> {
    this.closeTransport();
    this.device = null;
    const token = await this.opts.getToken();
    const socket = new WebSocket(token.sfuUrl);
    this.ws = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SFU connection timed out')), 8_000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('SFU connection failed'));
      };
    });

    socket.onmessage = (event) => this.handleServerMessage(event.data);
    socket.onclose = (event) => {
      if (this.ws !== socket) return;
      this.ws = null;
      if (this.stopping) return;
      const code = typeof event?.code === 'number' ? event.code : 1006;
      // Server-side terminal closes (Phase 4D): 4001 = replaced by a newer
      // publisher connection, 4002 = attempt ended / evicted. Reconnecting
      // would fight the server — stop cleanly instead.
      if (code === 4001 || code === 4002) {
        this.stopping = true;
        this.clearTimers();
        this.closeTransport();
        this.device = null;
        this.produced.clear();
        this.setState('stopped');
        this.report({
          type: 'MEDIA_PUBLISHER_DISCONNECTED',
          severity: 'INFO',
          detail: { code, reason: 'closed by server' },
        });
        return;
      }
      this.teardownForReconnect('socket closed');
    };

    const join = await this.request<{ roomId: string; participantId: string; attemptId: string; routerRtpCapabilities: RtpCapabilities }>(
      'join',
      { token: token.token },
    );

    const device = new Device();
    await device.load({ routerRtpCapabilities: join.routerRtpCapabilities });
    this.device = device;

    const transportParams = await this.request<{
      transportId: string;
      iceParameters: IceParameters;
      iceCandidates: IceCandidate[];
      dtlsParameters: DtlsParameters;
    }>('create-transport', { direction: 'send' });

    const transport = device.createSendTransport({
      id: transportParams.transportId,
      iceParameters: transportParams.iceParameters,
      iceCandidates: transportParams.iceCandidates,
      dtlsParameters: transportParams.dtlsParameters,
    });

    transport.on('connect', ({ dtlsParameters }: { dtlsParameters: DtlsParameters }, callback: () => void, errback: (error: Error) => void) => {
      void this.request('connect-transport', { transportId: transport.id, dtlsParameters })
        .then(() => callback())
        .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
    });
    transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
      void this.request<{ id: string }>('produce', {
        transportId: transport.id,
        kind,
        rtpParameters,
        appData,
      })
        .then((data) => callback({ id: data.id }))
        .catch((err) => errback(err instanceof Error ? err : new Error(String(err))));
    });
    // A mediasoup transport 'disconnected' is frequently transient (ICE
    // recheck under load / brief capture stalls) and Chromium may return to
    // 'connected' on its own. Reconnecting on every blip evicts the SFU room
    // and cascades: monitors get kicked with 4002 and stale-close handling
    // can destroy the successor room. Give it a short grace window; only
    // 'failed' (or an actual socket loss) tears down immediately.
    transport.on('connectionstatechange', (state) => {
      this.transportState = state;
      if (this.stopping) return;
      if (state === 'failed') {
        this.clearDisconnectGrace();
        this.teardownForReconnect('transport failed');
      } else if (state === 'disconnected') {
        this.armDisconnectGrace();
      } else if (state === 'connected') {
        this.clearDisconnectGrace();
      }
    });

    this.sendTransport = transport;
    this.retries = 0;
    this.setState('publishing');
    this.report({
      type: this.reconnectCount > 0 ? 'MEDIA_PUBLISHER_RECONNECTED' : 'MEDIA_PUBLISHER_CONNECTED',
      severity: 'INFO',
      detail: { participantId: join.participantId },
    });
    this.reconnectCount = 0;
    await this.publishLive();
  }

  private reconnectCount = 0;

  private teardownForReconnect(reason: string): void {
    if (this.stopping) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.clearDisconnectGrace();
    this.closeTransport();
    this.device = null;
    this.produced.clear();
    if (this.state !== 'failed') {
      this.reconnectCount += 1;
      if (this.state !== 'connecting') {
        this.setState('reconnecting');
      }
      void this.connectOnce();
    }
  }

  // -------------------------------------------------------------------------
  // Producer management
  // -------------------------------------------------------------------------

  private async produceTrack(kind: PubKind, track: MediaStreamTrack): Promise<void> {
    const transport = this.sendTransport;
    const device = this.device;
    if (!transport || !device || this.stopping) return;
    try {
      const producer: Producer = await transport.produce({
        track,
        appData: { kind },
      });
      producer.on('trackended', () => {
        // Honest report: the underlying device track ended under us.
        this.report({ type: 'TRACK_UNPUBLISHED', severity: 'WARNING', detail: { kind } });
        this.produced.delete(kind);
        if (!this.stopping) this.onStateChanged();
      });
      producer.on('transportclose', () => {
        this.produced.delete(kind);
        if (!this.stopping) this.onStateChanged();
      });
      this.produced.set(kind, {
        producerId: producer.id,
        kind,
        mediaType: kind === 'microphone' ? 'audio' : 'video',
        paused: producer.paused,
      });
      this.report({
        type: 'TRACK_PUBLISHED',
        severity: 'INFO',
        detail: { kind, producerId: producer.id, mediaType: kind === 'microphone' ? 'audio' : 'video' },
      });
      this.onStateChanged();
    } catch (err) {
      // Transport-level error — handled by the reconnect path if fatal.
      const message = err instanceof Error ? err.message : String(err);
      if (this.state === 'publishing' && !this.stopping) {
        this.teardownForReconnect(`produce ${kind} failed: ${message}`);
      }
    }
  }

  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearDisconnectGrace();
  }

  /** If the transport is still disconnected when the grace expires, reconnect. */
  private armDisconnectGrace(): void {
    if (this.disconnectGraceTimer || this.stopping) return;
    const DISCONNECT_GRACE_MS = 5_000;
    this.disconnectGraceTimer = setTimeout(() => {
      this.disconnectGraceTimer = null;
      if (this.stopping) return;
      if (this.transportState === 'disconnected' && this.sendTransport) {
        this.teardownForReconnect('transport still disconnected after grace');
      }
    }, DISCONNECT_GRACE_MS);
  }

  private clearDisconnectGrace(): void {
    if (this.disconnectGraceTimer) {
      clearTimeout(this.disconnectGraceTimer);
      this.disconnectGraceTimer = null;
    }
  }

  private clearSocketHandlers(): void {
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
    }
  }

  private closeTransport(): void {
    this.clearDisconnectGrace();
    try {
      this.sendTransport?.close();
    } catch {
      // already closed
    }
    this.sendTransport = null;
    this.transportState = 'closed';
    this.produced.clear();
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
    const waiter = this.pending.shift();
    if (!waiter) return; // unsolicited push (pong etc.) — nothing pending
    if (msg.type === 'error') {
      const code = Number(msg.data?.code ?? 0);
      const message = String(msg.data?.message ?? 'SFU error');
      // Auth-level rejection is terminal; produce/transport errors are not.
      if (code === 401 || code === 403) {
        this.report({ type: 'MEDIA_PUBLISHER_FAILED', severity: 'WARNING', detail: { code, message } });
        this.stopping = true;
        this.setState('failed');
        try {
          this.ws?.close(1000, 'rejected');
        } catch {
          // ignore
        }
      }
      waiter.reject(new Error(`SFU ${code}: ${message}`));
      return;
    }
    waiter.resolve(msg.data ?? {});
  }

  /** Single in-flight request at a time — server answers every request in order. */
  private async request<T>(type: string, data: Record<string, unknown>): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('not connected to SFU');
    }
    const payload = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.push({ resolve, reject });
    });
    this.ws.send(JSON.stringify({ type, data }));
    return (await payload) as T;
  }

  // -------------------------------------------------------------------------
  // State / events
  // -------------------------------------------------------------------------

  private report(payload: SensorEventPayload): void {
    try {
      this.opts.report(payload);
    } catch {
      // Reporting must never break the media path.
    }
  }

  private setState(next: PublisherState): void {
    if (this.state === next) return;
    this.state = next;
    this.onStateChanged();
  }

  private onStateChanged(): void {
    this.opts.onState?.(this.state, Array.from(this.produced.values()));
  }
}

// ---------------------------------------------------------------------------
// E2E / development introspection (metadata only — never tokens/media)
// ---------------------------------------------------------------------------

let debugPublisher: SfuPublisher | null = null;

/**
 * The ExamScreen registers its live publisher here (or null on teardown).
 * `required` are the device kinds this attempt actually needs (from exam
 * settings ∩ consent) so E2E probes know which producers to expect.
 */
export function setDebugPublisher(publisher: SfuPublisher | null, required?: string[]): void {
  debugPublisher = publisher;
  if (typeof window === 'undefined') return;
  const next = publisher
    ? {
        getState: () => ({
          ...publisher.snapshot(),
          attemptId: publisher.attemptId,
          required: required?.length ? required : ['camera', 'microphone', 'screen'],
        }),
      }
    : { getState: () => null };
  (window as unknown as { __examguardPub: unknown }).__examguardPub = next;
}

/** Snapshot for main-process E2E probes (executeJavaScript). */
export function getPublisherDebug(): { state: PublisherState; producers: PublishedProducer[] } | null {
  return debugPublisher ? debugPublisher.snapshot() : null;
}
