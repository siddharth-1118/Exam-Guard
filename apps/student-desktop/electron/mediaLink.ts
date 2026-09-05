/**
 * Student media-session link (Phase 4A control plane).
 *
 * Owns ONE authenticated WebSocket to the API's media gateway and mirrors the
 * server-side session state machine locally. The participant id is stable: a
 * reconnect restores the SAME server row. Media transport (WebRTC/SFU) does
 * not exist yet — this is purely control signaling.
 *
 * Lifecycle: start() → POST create (idempotent) → WS join → joined(ACTIVE);
 * unexpected socket loss → bounded reconnect (RECONNECTING → ACTIVE) while the
 * attempt is open; stop(reason) → leave + idempotent REST end → ENDED.
 */
import WebSocket from 'ws';
import type { ApiClient } from './api';
import type { MediaSessionInfo, SensorEventPayload } from '../src/shared/types';

export type MediaLinkState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'ended';

export interface MediaLinkOptions {
  api: ApiClient;
  attemptId: string;
  /** Attempt status as of now — the server remains authoritative. */
  status(): string | null;
  /** Emit into the existing proctoring pipeline (ReliableOutbox). */
  report(payload: SensorEventPayload): void;
  onState?(state: MediaLinkState, info: MediaSessionInfo | null): void;
}

const PING_INTERVAL_MS = 15_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_RECONNECT_ATTEMPTS = 15;

export class MediaLink {
  readonly attemptId: string;
  private readonly api: ApiClient;
  private readonly status: () => string | null;
  private readonly report: (p: SensorEventPayload) => void;
  private readonly onState?: (s: MediaLinkState, info: MediaSessionInfo | null) => void;

  private session: MediaSessionInfo | null = null;
  private state: MediaLinkState = 'idle';
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectDelayIdx = 0;
  private stopping = false;
  private joinedOnce = false;
  private started = false;

  constructor(opts: MediaLinkOptions) {
    this.api = opts.api;
    this.attemptId = opts.attemptId;
    this.status = opts.status;
    this.report = opts.report;
    this.onState = opts.onState;
  }

  get stateValue(): MediaLinkState {
    return this.state;
  }

  get sessionInfo(): MediaSessionInfo | null {
    return this.session;
  }

  private setState(next: MediaLinkState): void {
    this.state = next;
    this.onState?.(next, this.session);
  }

  /** Create (idempotent) + join the gateway. No-op if already running. */
  async start(): Promise<MediaSessionInfo> {
    if (this.started && this.state !== 'ended' && this.state !== 'failed') {
      return this.session as MediaSessionInfo;
    }
    this.started = true;
    this.stopping = false;
    this.setState('connecting');
    if (!this.session || this.session.state === 'ENDED' || this.session.state === 'FAILED') {
      try {
        this.session = await this.api.createMediaSession(this.attemptId);
        this.report({ type: 'MEDIA_SESSION_CREATED', severity: 'INFO', detail: { mediaSessionId: this.session.id } });
      } catch (err) {
        this.fail(`create media session failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    }
    this.connect();
    return this.session;
  }

  /**
   * Tear the link down. REST end is idempotent server-side, so repeated stops
   * (submit, logout, heartbeat-termination) are safe.
   */
  stop(reason: 'submit' | 'logout' | 'terminated' | 'manual' = 'manual'): void {
    if (this.stopping || this.state === 'ended') return;
    this.stopping = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, reason);
      } catch {
        // already closing
      }
      this.ws = null;
    }
    if (this.session) {
      this.report({ type: 'MEDIA_DISCONNECTED', severity: 'INFO', detail: { reason } });
      this.setState('ended');
      if (reason === 'submit' || reason === 'logout' || reason === 'terminated') {
        void this.api.endMediaSession(this.session.id).catch(() => undefined);
      }
    }
  }

  /** Test hook (E2E): drop the socket so the bounded reconnect path runs. */
  dropConnectionForTest(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(4000, 'test-drop');
    }
  }

  // -------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------

  private connect(): void {
    if (this.stopping || this.state === 'ended') return;
    this.setState(this.joinedOnce && this.state !== 'failed' ? 'reconnecting' : this.state === 'failed' ? 'reconnecting' : 'connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.api.mediaWsUrl);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'socket creation failed');
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      const token = this.api.getAccessToken();
      if (!token) {
        // Token expired/cleared: refresh once, then retry the join on the next attempt.
        ws.close(4001, 'no-token');
        return;
      }
      ws.send(JSON.stringify({ type: 'media-session-join', data: { token, attemptId: this.attemptId } }));
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          type?: string;
          data?: { code?: number; message?: string; mediaSessionId?: string; participantId?: string; state?: string };
        };
        if (msg.type === 'joined' && msg.data) {
          this.handleJoined(msg.data);
        } else if (msg.type === 'media-error' && msg.data?.code === 401) {
          // Access token expired mid-flight — refresh and reconnect once.
          void this.api.refresh().then((ok) => {
            if (ok && !this.stopping) this.scheduleReconnect('refreshed');
          });
        } else if (msg.type === 'media-error') {
          this.fail(`media gateway error ${msg.data?.code}: ${msg.data?.message ?? 'unknown'}`);
        }
      } catch {
        // Ignore malformed frames from the server.
      }
    });
    ws.on('close', () => {
      this.ws = null;
      if (this.stopping || this.state === 'ended') return;
      this.clearPing();
      if (this.session) {
        this.report({ type: 'MEDIA_RECONNECTING', severity: 'WARNING', detail: { reason: 'socket-closed' } });
      }
      this.setState('reconnecting');
      this.scheduleReconnect('socket closed');
    });
    ws.on('error', () => {
      // 'close' always follows; reconnect logic lives there.
    });
  }

  private handleJoined(data: { mediaSessionId?: string; participantId?: string; state?: string }): void {
    if (!data.mediaSessionId || !data.participantId || !data.state) {
      this.fail('joined without session identity');
      return;
    }
    if (!this.session || this.session.id !== data.mediaSessionId) {
      // Server may have re-opened the row; adopt its identity (same participant
      // slot for this attempt).
      this.session = {
        ...(this.session as MediaSessionInfo),
        id: data.mediaSessionId,
        participantId: data.participantId,
        attemptId: this.attemptId,
        state: data.state as MediaSessionInfo['state'],
        connectedAt: this.session?.connectedAt ?? null,
        lastSeenAt: this.session?.lastSeenAt ?? new Date().toISOString(),
        endedAt: null,
        createdAt: this.session?.createdAt ?? new Date().toISOString(),
        examId: this.session?.examId ?? '',
      };
    } else {
      this.session.state = data.state as MediaSessionInfo['state'];
    }
    this.reconnectAttempts = 0;
    this.reconnectDelayIdx = 0;
    this.startPing();
    if (this.joinedOnce) {
      this.report({ type: 'MEDIA_RECONNECTED', severity: 'INFO', detail: { participantId: data.participantId } });
    } else {
      this.joinedOnce = true;
      this.report({ type: 'MEDIA_CONNECTED', severity: 'INFO', detail: { participantId: data.participantId } });
    }
    this.setState('connected');
  }

  private scheduleReconnect(_reason: string): void {
    if (this.stopping || this.state === 'ended') return;
    const status = this.status();
    if (status !== 'ACTIVE' && status !== 'PAUSED') {
      this.fail(`media reconnect aborted (attempt status: ${status ?? 'none'})`);
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.fail(`media reconnect gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      return;
    }
    this.reconnectAttempts += 1;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectDelayIdx, RECONNECT_DELAYS_MS.length - 1)];
    if (this.reconnectDelayIdx < RECONNECT_DELAYS_MS.length - 1) this.reconnectDelayIdx += 1;
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private fail(message: string): void {
    if (this.stopping || this.state === 'ended') return;
    this.clearTimers();
    this.ws = null;
    this.report({ type: 'MEDIA_FAILED', severity: 'WARNING', detail: { message } });
    this.setState('failed');
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearPing();
    this.clearReconnect();
  }
}
