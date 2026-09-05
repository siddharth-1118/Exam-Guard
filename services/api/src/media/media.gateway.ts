/**
 * Authenticated media-control WebSocket gateway (Phase 4A).
 *
 * Control plane only: join/leave/state/reconnect/ping. No media bytes, no RTP,
 * no WebRTC negotiation (that arrives with the SFU in Phase 4B).
 *
 * Protocol (JSON text frames; `seq` echoes client sequencing):
 *   client → { type: 'media-session-join',  data: { token, attemptId } }   (student publisher)
 *   client → { type: 'exam-watch-join',     data: { token, examId } }      (monitor)
 *   client → { type: 'ping' } / { type: 'media-session-leave' }
 *   server → { type: 'joined', data: { mediaSessionId, participantId, attemptId, state } }
 *   server → { type: 'media-session-state', data: { participantId, state } }
 *   server → { type: 'pong' } / { type: 'media-error', data: { code, message } }
 *   server → { type: 'media-participant-connected' | 'media-participant-state', data: {...} }  (monitors)
 *
 * Security: token verified at join (first message), participant bound to the
 * verified identity, single live publisher connection per attempt enforced,
 * tenant isolation on every path. Malformed frames never crash the gateway.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { verifyAccessToken } from '@examguard/auth';
import type { AccessClaims } from '@examguard/auth';
import { IdentityService } from '../common/identity.service';
import { AppConfig } from '../common/config';
import type { UserContext } from '../common/types';
import { MediaService } from './media.service';
import { MediaPresenceService } from './media.presence';

const WS_PATH = '/api/v1/media/ws';
const RECONNECT_GRACE_MS = 45_000;
const PING_IDLE_MS = 45_000;
const MESSAGE_BUDGET = { windowMs: 10_000, max: 60 };
const MAX_CONNECTIONS = 500;

interface GatewayMetrics {
  connections: number;
  publisherConnections: number;
  monitorConnections: number;
  joins: number;
  reconnects: number;
  duplicateRejections: number;
  authFailures: number;
  leaves: number;
  pings: number;
  messages: number;
  /** Publisher sockets closed server-side (attempt ended / eviction). */
  serverCloses: number;
}

interface Conn {
  ws: WebSocket;
  claims: AccessClaims;
  user: UserContext;
  role: 'publisher' | 'subscriber';
  attemptId?: string;
  examId?: string;
  participantId?: string;
  lastSeenAt: number;
  msgWindowStart: number;
  msgWindowCount: number;
  joinedAt: number;
}

interface MediaStatePayload {
  attemptId: string;
  examId: string;
  mediaSessionId: string;
  participantId: string;
  state: string;
  reconnected?: boolean;
}

@Injectable()
export class MediaGateway {
  private readonly logger = new Logger(MediaGateway.name);
  private wss: WebSocketServer | null = null;
  private readonly conns = new Set<Conn>();
  /** attemptId → live publisher connection (single active connection enforced). */
  private readonly publisherByAttempt = new Map<string, Conn>();
  /** examId → monitor connections (targeted presence fan-out). */
  private readonly monitorsByExam = new Map<string, Set<Conn>>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** participantId → last authenticated activity (presence for the sweeper). */
  private readonly lastSeenByParticipant = new Map<string, number>();
  private readonly metrics: GatewayMetrics = {
    connections: 0,
    publisherConnections: 0,
    monitorConnections: 0,
    joins: 0,
    reconnects: 0,
    duplicateRejections: 0,
    authFailures: 0,
    leaves: 0,
    pings: 0,
    messages: 0,
    serverCloses: 0,
  };

  constructor(
    private readonly identity: IdentityService,
    private readonly config: AppConfig,
    private readonly media: MediaService,
    private readonly presence: MediaPresenceService,
  ) {}

  get path(): string {
    return WS_PATH;
  }

  get stats(): GatewayMetrics & { path: string; reconnectGraceMs: number } {
    return { ...this.metrics, path: WS_PATH, reconnectGraceMs: RECONNECT_GRACE_MS };
  }

  attach(httpServer: HttpServer): void {
    if (this.wss) return;
    this.wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
    this.wss.on('connection', (ws) => this.onConnection(ws));
    this.logger.log(`media gateway listening at ${WS_PATH}`);
  }

  close(): void {
    this.wss?.close();
    this.wss = null;
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
    this.conns.clear();
    this.publisherByAttempt.clear();
    this.monitorsByExam.clear();
    this.lastSeenByParticipant.clear();
  }

  /**
   * Presence readout for the stale-session sweeper (Phase 4D). Live means an
   * authenticated OPEN publisher socket is registered for the participant.
   * lastSeenAt is the last authenticated message time, or null if unknown.
   * No DB writes — pure in-process state (single node).
   */
  presenceOf(participantId: string): { live: boolean; lastSeenAt: number | null } {
    let live = false;
    for (const conn of this.conns) {
      if (conn.participantId === participantId && conn.role === 'publisher' && conn.ws.readyState === WebSocket.OPEN) {
        live = true;
        break;
      }
    }
    return { live, lastSeenAt: this.lastSeenByParticipant.get(participantId) ?? null };
  }

  /**
   * Server-initiated publisher close (Phase 4D): the attempt reached a
   * terminal state, so the live control socket is closed WITHOUT arming the
   * reconnect grace window — a crashed/absent client can never leave a live
   * publisher behind, and a live client learns immediately. Idempotent:
   * returns the number of sockets actually closed (0 when none were open).
   * The DB row is ended by the caller/attempt service; this only tears down
   * the in-process connection so onClose() treats it as a clean removal.
   */
  forceClosePublishersForAttempt(attemptId: string, code: number, message: string): number {
    const conn = this.publisherByAttempt.get(attemptId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) return 0;
    if (conn.participantId) {
      this.clearGrace(conn.participantId);
      this.lastSeenByParticipant.delete(conn.participantId);
      // Presence: the session is over — remove the ephemeral key + lease.
      void this.presence
        .removePresence(conn.participantId, conn.user?.orgId ?? '')
        .catch(() => undefined);
    }
    this.publisherByAttempt.delete(attemptId);
    conn.joinedAt = 0; // onClose() then early-returns (no RECONNECTING rearm)
    this.metrics.serverCloses += 1;
    try {
      conn.ws.close(code, message.slice(0, 120));
    } catch {
      // already closing
    }
    return 1;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  private onConnection(ws: WebSocket): void {
    if (this.conns.size >= MAX_CONNECTIONS) {
      this.send(ws, { type: 'media-error', data: { code: 429, message: 'too many connections' } });
      ws.close(1013, 'busy');
      return;
    }
    const conn: Conn = {
      ws,
      claims: null as never,
      user: null as never,
      role: 'publisher',
      lastSeenAt: Date.now(),
      msgWindowStart: Date.now(),
      msgWindowCount: 0,
      joinedAt: 0,
    };
    this.conns.add(conn);
    this.metrics.connections += 1;
    this.metrics.publisherConnections += 1;

    // Unauthenticated sockets that never join are dropped.
    const idle = setTimeout(() => {
      if (!conn.joinedAt) ws.close(4001, 'join-timeout');
    }, 10_000);

    ws.on('message', (data) => {
      void this.onMessage(conn, data);
    });
    ws.on('pong', () => {
      conn.lastSeenAt = Date.now();
    });
    ws.on('close', () => {
      clearTimeout(idle);
      this.onClose(conn);
    });
    ws.on('error', () => {
      ws.close();
    });
  }

  private async onMessage(conn: Conn, raw: RawData): Promise<void> {
    this.metrics.messages += 1;
    // Per-connection rate budget (malformed/spam protection).
    const now = Date.now();
    if (now - conn.msgWindowStart > MESSAGE_BUDGET.windowMs) {
      conn.msgWindowStart = now;
      conn.msgWindowCount = 0;
    }
    conn.msgWindowCount += 1;
    if (conn.msgWindowCount > MESSAGE_BUDGET.max) {
      this.send(conn.ws, { type: 'media-error', data: { code: 429, message: 'rate limit exceeded' } });
      conn.ws.close(1008, 'rate-limited');
      return;
    }

    let msg: { type?: unknown; data?: unknown; seq?: unknown } | null = null;
    try {
      msg = JSON.parse(String(raw)) as { type?: unknown; data?: unknown };
    } catch {
      this.send(conn.ws, { type: 'media-error', data: { code: 400, message: 'malformed frame' } });
      return;
    }
    if (!msg || typeof msg.type !== 'string') {
      this.send(conn.ws, { type: 'media-error', data: { code: 400, message: 'missing type' } });
      return;
    }
    const seq = typeof msg.seq === 'number' ? msg.seq : undefined;
    try {
      switch (msg.type) {
        case 'media-session-join':
          await this.handlePublisherJoin(conn, msg.data as Record<string, unknown>);
          break;
        case 'exam-watch-join':
          await this.handleMonitorJoin(conn, msg.data as Record<string, unknown>);
          break;
        case 'ping':
          this.metrics.pings += 1;
          conn.lastSeenAt = Date.now();
          if (conn.joinedAt && conn.role === 'publisher' && conn.participantId) {
            this.lastSeenByParticipant.set(conn.participantId, conn.lastSeenAt);
            // Redis presence TTL refresh (fire-and-forget, fail-safe).
            void this.presence
              .heartbeat(conn.participantId, conn.user?.orgId ?? '')
              .catch(() => undefined);
          }
          this.send(conn.ws, { type: 'pong', seq });
          break;
        case 'media-session-leave':
          this.metrics.leaves += 1;
          await this.handleLeave(conn, seq);
          break;
        default:
          this.send(conn.ws, {
            type: 'media-error',
            data: { code: 400, message: `unknown message type: ${msg.type}` },
            seq,
          });
      }
    } catch (err) {
      this.logger.warn(`media ws handler error: ${err instanceof Error ? err.message : String(err)}`);
      this.send(conn.ws, {
        type: 'media-error',
        data: { code: this.codeOf(err), message: err instanceof Error ? err.message : 'internal error' },
        seq,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Joins
  // -------------------------------------------------------------------------

  private async authenticate(token: string): Promise<{ claims: AccessClaims; user: UserContext } | null> {
    const claims = await verifyAccessToken(token, this.config.jwtSecret);
    if (!claims) {
      this.metrics.authFailures += 1;
      return null;
    }
    const user = await this.identity.resolve(claims.sub);
    if (!user) return null;
    return { claims, user };
  }

  private async handlePublisherJoin(conn: Conn, data: Record<string, unknown>): Promise<void> {
    const token = typeof data?.token === 'string' ? data.token : null;
    const attemptId = typeof data?.attemptId === 'string' ? data.attemptId : null;
    if (!token || !attemptId) throw new MediaGatewayError(400, 'token and attemptId required');
    const auth = await this.authenticate(token);
    if (!auth) throw new MediaGatewayError(401, 'invalid or expired token');
    if (auth.user.role !== 'STUDENT' || !auth.user.permissions.includes('media:publish')) {
      throw new MediaGatewayError(403, 'not a student publisher');
    }

    // Duplicate live connection prevention: one active publisher WS per attempt.
    const existing = this.publisherByAttempt.get(attemptId);
    if (existing && existing !== conn && existing.ws.readyState === WebSocket.OPEN) {
      this.metrics.duplicateRejections += 1;
      throw new MediaGatewayError(409, 'an active connection exists for this attempt');
    }
    if (conn.joinedAt && conn.attemptId && conn.attemptId !== attemptId) {
      this.publisherByAttempt.delete(conn.attemptId);
    }

    // Distributed ownership gate (Phase 4D.2): before touching the durable
    // row, verify no OTHER API instance currently owns this participant's
    // lease. Atomic acquire; 'owned-by-other' → 409 (prevents two instances
    // from both believing they own the same publisher connection). Our own
    // reconnect re-acquires idempotently ('already-owner'). When Redis is
    // unavailable this degrades to the single-node in-process check above.
    const ownedRows = await this.media.findParticipantsByAttempt(attemptId);
    const ownedRow = ownedRows.find((r) => r.organizationId === (auth.user.orgId ?? ''));
    if (ownedRow) {
      const owned = await this.presence.acquireOwnership(ownedRow.id, ownedRow.organizationId);
      if (owned === 'owned-by-other') {
        this.metrics.duplicateRejections += 1;
        throw new MediaGatewayError(409, 'active connection exists on another server instance');
      }
    }

    let session: { id: string; examId: string; organizationId: string; state: string; participantId: string };
    let reconnected: boolean;
    try {
      ({ session, reconnected } = await this.media.gatewayJoin(auth.user, attemptId));
    } catch (err) {
      // Roll the advisory lease back so a failed join never blocks a later one.
      if (ownedRow) {
        await this.presence.releaseOwnership(ownedRow.id, ownedRow.organizationId).catch(() => undefined);
      }
      throw err;
    }
    conn.claims = auth.claims;
    conn.user = auth.user;
    conn.role = 'publisher';
    conn.attemptId = attemptId;
    conn.participantId = session.id;
    conn.joinedAt = Date.now();
    conn.lastSeenAt = Date.now();
    this.publisherByAttempt.set(attemptId, conn);
    this.lastSeenByParticipant.set(session.id, Date.now());
    // Ephemeral presence mirror (fail-safe no-op when Redis is down).
    void this.presence
      .setPresence({
        participantId: session.id,
        mediaSessionId: session.id,
        attemptId,
        organizationId: session.organizationId,
        connectionState: 'ACTIVE',
        connectedAt: Date.now(),
        lastSeenAt: Date.now(),
      })
      .catch(() => undefined);
    if (reconnected) this.metrics.reconnects += 1;
    else this.metrics.joins += 1;

    this.send(conn.ws, {
      type: 'joined',
      data: {
        mediaSessionId: session.id,
        participantId: session.participantId,
        attemptId,
        state: session.state,
        reconnected,
      },
    });
    this.pushToMonitors(await this.media.monitorExamForParticipant(session.id), {
      type: reconnected ? 'media-participant-state' : 'media-participant-connected',
      data: {
        attemptId,
        examId: session.examId,
        mediaSessionId: session.id,
        participantId: session.participantId,
        state: session.state,
        reconnected,
      },
    });
  }

  private async handleMonitorJoin(conn: Conn, data: Record<string, unknown>): Promise<void> {
    const token = typeof data?.token === 'string' ? data.token : null;
    const examId = typeof data?.examId === 'string' ? data.examId : null;
    if (!token || !examId) throw new MediaGatewayError(400, 'token and examId required');
    const auth = await this.authenticate(token);
    if (!auth) throw new MediaGatewayError(401, 'invalid or expired token');
    if (!auth.user.permissions.includes('media:subscribe')) {
      throw new MediaGatewayError(403, 'not authorized to watch exams');
    }
    await this.media.assertExamWatchAccess(auth.user, examId);

    conn.claims = auth.claims;
    conn.user = auth.user;
    conn.role = 'subscriber';
    conn.examId = examId;
    conn.joinedAt = Date.now();
    conn.lastSeenAt = Date.now();
    this.metrics.monitorConnections += 1;
    this.metrics.joins += 1;
    let set = this.monitorsByExam.get(examId);
    if (!set) {
      set = new Set<Conn>();
      this.monitorsByExam.set(examId, set);
    }
    set.add(conn);
    this.send(conn.ws, { type: 'joined', data: { examId, role: 'subscriber' } });
  }

  // -------------------------------------------------------------------------
  // Leave / close / grace
  // -------------------------------------------------------------------------

  private async handleLeave(conn: Conn, seq?: number): Promise<void> {
    if (conn.joinedAt && conn.role === 'publisher' && conn.participantId) {
      const row = await this.media.monitorExamForParticipant(conn.participantId);
      await this.endPublisherConnection(conn, 'leave');
      this.send(conn.ws, { type: 'media-session-left', seq });
      this.pushToMonitors(row, {
        type: 'media-participant-state',
        data: {
          attemptId: conn.attemptId as string,
          examId: conn.examId ?? (row?.examId ?? ''),
          mediaSessionId: conn.participantId,
          participantId: conn.participantId,
          state: 'ENDED',
        },
      });
    } else if (conn.role === 'subscriber') {
      this.removeMonitor(conn);
      this.send(conn.ws, { type: 'media-session-left', seq });
    }
    conn.ws.close(1000, 'left');
  }

  private async endPublisherConnection(conn: Conn, reason: 'leave'): Promise<void> {
    this.clearGrace(conn.participantId as string);
    this.publisherByAttempt.delete(conn.attemptId as string);
    this.lastSeenByParticipant.delete(conn.participantId as string);
    if (conn.participantId) {
      // Ephemeral presence: clean removal (atomic, ownership-aware).
      await this.presence
        .removePresence(conn.participantId, conn.user?.orgId ?? '')
        .catch(() => undefined);
    }
    conn.joinedAt = 0;
    if (conn.user && conn.participantId) {
      // REST end (idempotent) so the row lands in ENDED with endedAt.
      await this.media
        .endById(conn.user, conn.participantId)
        .catch((err) => this.logger.warn(`media end on leave failed: ${err?.message ?? err}`));
    }
  }

  private onClose(conn: Conn): void {
    this.conns.delete(conn);
    if (conn.joinedAt === 0) {
      this.metrics.connections = Math.max(0, this.metrics.connections - 1);
      this.metrics.publisherConnections = Math.max(0, this.metrics.publisherConnections - 1);
      return;
    }
    if (conn.role === 'publisher') {
      const attemptId = conn.attemptId as string;
      const participantId = conn.participantId as string;
      // Only treat as a reconnectable drop if this connection still owns the slot.
      const current = this.publisherByAttempt.get(attemptId);
      if (current === conn) this.publisherByAttempt.delete(attemptId);
      this.clearGrace(participantId);
      this.metrics.publisherConnections = Math.max(0, this.metrics.publisherConnections - 1);
      void this.media.gatewaySocketLost(conn.user.userId, participantId).catch(() => undefined);
      // Redis mirror: the reconnect window is open (presence outlives the grace
      // so the sweeper sees an open grace on ANY instance; lease kept so the
      // owning instance can reclaim its own participant).
      void this.presence
        .markState(participantId, conn.user?.orgId ?? '', 'RECONNECTING')
        .catch(() => undefined);
      // Reconnect window; expire → DISCONNECTED if the student never returns.
      const timer = setTimeout(() => {
        this.graceTimers.delete(participantId);
        this.lastSeenByParticipant.delete(participantId);
        // Presence: reflect DISCONNECTED briefly, then the key auto-expires;
        // the ownership lease is released so another instance (or a later
        // publisher session for the same attempt) can take over.
        void this.presence
          .markState(participantId, conn.user?.orgId ?? '', 'DISCONNECTED')
          .catch(() => undefined);
        void this.media.gatewayExpire(conn.user.userId, participantId).catch(() => undefined);
      }, RECONNECT_GRACE_MS);
      this.graceTimers.set(participantId, timer);
    } else if (conn.role === 'subscriber') {
      this.removeMonitor(conn);
    }
    this.metrics.connections = Math.max(0, this.conns.size);
  }

  private removeMonitor(conn: Conn): void {
    if (!conn.examId) return;
    const set = this.monitorsByExam.get(conn.examId);
    if (set) {
      set.delete(conn);
      if (set.size === 0) this.monitorsByExam.delete(conn.examId);
    }
    this.metrics.monitorConnections = Math.max(0, this.metrics.monitorConnections - 1);
  }

  private clearGrace(participantId: string): void {
    const timer = this.graceTimers.get(participantId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(participantId);
    }
  }

  private pushToMonitors(
    meta: { examId: string; organizationId: string } | null,
    payload: { type: string; data: MediaStatePayload },
  ): void {
    if (!meta) return;
    const watchers = this.monitorsByExam.get(meta.examId);
    if (!watchers) return;
    for (const watcher of watchers) {
      // Tenant check even here: monitor org must equal the session org.
      if (watcher.user.orgId === meta.organizationId) {
        this.send(watcher.ws, payload);
      }
    }
  }

  private codeOf(err: unknown): number {
    return err instanceof MediaGatewayError ? err.code : 500;
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}

export class MediaGatewayError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
