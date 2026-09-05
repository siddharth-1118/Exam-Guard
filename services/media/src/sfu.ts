/**
 * ExamGuard SFU (Phase 4B publishing + Phase 4C subscribed consumers).
 *
 * One room per MediaParticipant (roomId == participantId). A publisher joins
 * with a short-lived media token (role 'publisher') and produces
 * camera/microphone/screen tracks over a send transport. Authorized monitors
 * join the SAME room with a role 'subscriber' token, open a recv transport and
 * consume those producers — media traverses the SFU once (publisher → router →
 * N consumers), never student → monitor direct.
 *
 * Signaling (JSON text frames):
 *   → { type:'join', data:{ token } }
 *   ← { type:'joined', data:{ roomId, participantId, attemptId, role,
 *                             routerRtpCapabilities,
 *                             producers:[{producerId,kind,appKind}] } }
 *   → { type:'create-transport', data:{ direction:'send'|'recv' } }
 *   ← { type:'transport-created', data:{ transportId, iceParameters,
 *                                        iceCandidates, dtlsParameters } }
 *   → { type:'connect-transport', data:{ transportId, dtlsParameters } }
 *   ← { type:'transport-connected', data:{ transportId } }
 *   → { type:'produce', data:{ transportId, kind, rtpParameters,
 *                              appData:{ kind:'camera'|'microphone'|'screen' } } }
 *   ← { type:'produced', data:{ producerId, kind, appKind } }
 *   → { type:'consume', data:{ transportId, producerId, rtpCapabilities } }
 *   ← { type:'consumed', data:{ consumerId, producerId, kind, appKind,
 *                               rtpParameters } }
 *   → { type:'close-consumer'|'close-transport'|'leave' } ; { type:'ping' } → pong
 *   ← { type:'producer-added', data:{ producerId, kind, appKind } }        (push)
 *   ← { type:'consumer-closed', data:{ consumerId, reason } }              (push)
 *   ← { type:'error', data:{ code, message } } (401/403/409/400/404/429)
 *
 * One live publisher per participant: a publisher join while another is live
 * evicts the old one server-side (no uncontrolled duplicates). Subscribers do
 * not own the room — when the publisher leaves / the attempt ends, every
 * subscriber socket receives close 4002 and the whole room is torn down.
 * A subscriber disconnect only tears down its own transports/consumers.
 */
import { Logger } from './logger';
import { RecordingEgress } from './recording';
import * as mediasoup from 'mediasoup';
import type {
  Consumer,
  Producer,
  Router,
  RtpCapabilities,
  RtpCodecCapability,
  WebRtcTransport,
  Worker,
} from 'mediasoup/node/lib/types';
import type { WebSocket } from 'ws';
import type { SfuConfig } from './config';
import { verifyMediaToken, type MediaTokenClaims } from './token';

export type AppTrackKind = 'camera' | 'microphone' | 'screen';

export interface ProducerView {
  producerId: string;
  kind: 'audio' | 'video';
  appKind: AppTrackKind;
  paused: boolean;
  bytesSent: number;
  bitrate: number;
}

export interface ConsumerView {
  consumerId: string;
  producerId: string;
  kind: 'audio' | 'video';
  appKind: AppTrackKind;
  paused: boolean;
  bytesSent: number;
  bitrate: number;
}

export interface RoomView {
  roomId: string;
  attemptId: string;
  participantId: string;
  createdAt: number;
  transports: { id: string; direction: 'send' | 'recv'; state: string }[];
  producers: ProducerView[];
  consumers: ConsumerView[];
  subscribers: number;
}

const MEDIA_CODECS: RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: { 'x-google-start-bitrate': 1000 },
  },
];

const MSG_BUDGET = { windowMs: 10_000, max: 120 };
const WS_MAX_PAYLOAD = 64 * 1024;

interface SubscriberConn {
  ws: WebSocket;
  /** recv transports owned by this monitor connection. */
  transports: Map<string, WebRtcTransport>;
  /** live connection state per recv transport (dtlsstatechange). */
  transportStates: Map<string, string>;
  consumers: Map<string, Consumer>;
}

interface Room {
  router: Router;
  participantId: string;
  attemptId: string;
  orgId: string;
  examId: string;
  ws: WebSocket | null;
  claims: MediaTokenClaims;
  sendTransport: WebRtcTransport | null;
  transportState: string;
  producers: Map<string, Producer>;
  /** Authorized monitor connections attached to this publisher's room. */
  subscribers: SubscriberConn[];
  createdAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

interface Metrics {
  rooms: number;
  producers: number;
  consumers: number;
  joins: number;
  evictions: number;
  authFailures: number;
  malformed: number;
  joinRejected: number;
}

export class SfuService {
  private worker: Worker | null = null;
  private readonly rooms = new Map<string, Room>();
  private readonly metrics: Metrics = {
    rooms: 0,
    producers: 0,
    consumers: 0,
    joins: 0,
    evictions: 0,
    authFailures: 0,
    malformed: 0,
    joinRejected: 0,
  };
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  readonly recording: RecordingEgress;

  constructor(private readonly config: SfuConfig) {
    this.recording = new RecordingEgress({
      storageDir: config.recordingStorageDir,
      apiUrl: config.apiUrl,
      sfuAdminKey: config.adminKey,
    });
  }

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = await mediasoup.createWorker({
      rtcMinPort: this.config.rtcMinPort,
      rtcMaxPort: this.config.rtcMaxPort,
      logLevel: 'warn',
    });
    this.worker.on('died', () => {
      Logger.error('mediasoup worker died — shutting down');
      process.exit(1);
    });
    // Track byte deltas for live bitrate views.
    this.statsTimer = setInterval(() => void this.sampleStats(), 1_000);
    this.statsTimer.unref();
    Logger.info(`mediasoup worker ${this.worker.pid} ready`);
  }

  get status(): Metrics {
    return {
      ...this.metrics,
      rooms: this.rooms.size,
      producers: this.countProducers(),
      consumers: this.countConsumers(),
    };
  }

  listRooms(): RoomView[] {
    const views: RoomView[] = [];
    for (const room of this.rooms.values()) {
      views.push(this.viewOf(room));
    }
    return views;
  }

  roomView(roomId: string): RoomView | null {
    const room = this.rooms.get(roomId);
    return room ? this.viewOf(room) : null;
  }

  // -------------------------------------------------------------------------
  // Signaling entrypoint
  // -------------------------------------------------------------------------

  handleConnection(ws: WebSocket): void {
    let claims: MediaTokenClaims | null = null;
    let role: 'publisher' | 'subscriber' | null = null;
    let joined = false;
    let sub: SubscriberConn | null = null;
    let msgWindowStart = Date.now();
    let msgWindowCount = 0;

    const send = (payload: unknown): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };
    const error = (code: number, message: string): void => send({ type: 'error', data: { code, message } });

    const roomFor = (participantId: string): Room | null => this.rooms.get(participantId) ?? null;
    const disconnectRoom = (room: Room, reason: string): void => {
      this.teardownRoom(room.participantId, reason);
    };

    const handleMessage = async (raw: string): Promise<void> => {
      const now = Date.now();
      if (now - msgWindowStart > MSG_BUDGET.windowMs) {
        msgWindowStart = now;
        msgWindowCount = 0;
      }
      msgWindowCount += 1;
      if (msgWindowCount > MSG_BUDGET.max) {
        error(429, 'rate limit exceeded');
        return;
      }

      let msg: { type?: string; data?: Record<string, unknown> };
      try {
        msg = JSON.parse(raw) as typeof msg;
      } catch {
        this.metrics.malformed += 1;
        error(400, 'malformed frame');
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        this.metrics.malformed += 1;
        error(400, 'missing type');
        return;
      }

      switch (msg.type) {
        case 'join': {
          if (joined) {
            error(409, 'already joined');
            return;
          }
          const token = typeof msg.data?.token === 'string' ? msg.data.token : null;
          if (!token) {
            error(401, 'missing token');
            return;
          }
          const verified = verifyMediaToken(token, this.config.jwtSecret);
          if (!verified) {
            this.metrics.authFailures += 1;
            error(401, 'invalid or expired media token');
            return;
          }
          claims = verified;
          role = verified.role;

          if (role === 'subscriber') {
            // Monitors attach to an EXISTING publisher room — never create one,
            // never subscribe into the void.
            const room = roomFor(verified.participantId);
            if (!room) {
              this.metrics.joinRejected += 1;
              error(409, 'no active publisher session for this participant');
              return;
            }
            sub = { ws, transports: new Map(), transportStates: new Map(), consumers: new Map() };
            room.subscribers.push(sub);
            joined = true;
            this.metrics.joins += 1;
            send({
              type: 'joined',
              data: {
                roomId: room.participantId,
                participantId: room.participantId,
                attemptId: room.attemptId,
                role: 'subscriber',
                routerRtpCapabilities: room.router.rtpCapabilities,
                producers: Array.from(room.producers.values()).map((p) => ({
                  producerId: p.id,
                  kind: p.kind,
                  appKind: p.appData.kind ?? (p.kind === 'audio' ? 'microphone' : 'camera'),
                })),
              },
            });
            return;
          }

          const existing = roomFor(verified.participantId);
          if (existing) {
            // One publisher per participant: evict the stale connection.
            this.metrics.evictions += 1;
            const oldWs = existing.ws;
            this.teardownRoom(existing.participantId, 'replaced-by-new-join');
            try {
              oldWs?.close(4001, 'replaced by a newer publisher connection');
            } catch {
              // already closed
            }
          }
          const room = await this.createRoom(verified);
          room.ws = ws;
          this.rooms.set(verified.participantId, room);
          joined = true;
          this.metrics.joins += 1;
          send({
            type: 'joined',
            data: {
              roomId: verified.participantId,
              participantId: verified.participantId,
              attemptId: verified.attemptId,
              role: 'publisher',
              routerRtpCapabilities: room.router.rtpCapabilities,
            },
          });
          return;
        }

        case 'create-transport': {
          if (!joined || !claims || !role) {
            error(401, 'join first');
            return;
          }
          const room = roomFor(claims.participantId);
          if (!room) {
            error(409, 'room gone');
            return;
          }
          const direction = msg.data?.direction;
          if (role === 'publisher') {
            if (direction !== 'send') {
              error(400, 'publishers use direction send');
              return;
            }
            if (room.sendTransport) {
              error(409, 'a send transport already exists for this participant');
              return;
            }
            const transport = await room.router.createWebRtcTransport({
              listenIps: [{ ip: this.config.host, announcedIp: this.config.announcedIp ?? undefined }],
              enableUdp: true,
              enableTcp: true,
              preferUdp: true,
            });
            room.sendTransport = transport;
            room.transportState = 'connecting';
            transport.on('dtlsstatechange', (state: string) => {
              room.transportState = state;
              if (state === 'closed' || state === 'failed') {
                this.closeTransport(room, transport);
              }
            });
            transport.on('@close', () => {
              if (room.sendTransport === transport) room.sendTransport = null;
            });
            send({
              type: 'transport-created',
              data: {
                transportId: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
              },
            });
            return;
          }
          // subscriber → recv transport owned by this connection
          if (direction !== 'recv') {
            error(400, 'subscribers use direction recv');
            return;
          }
          if (!sub) {
            error(401, 'join first');
            return;
          }
          const transport = await room.router.createWebRtcTransport({
            listenIps: [{ ip: this.config.host, announcedIp: this.config.announcedIp ?? undefined }],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
          });
          sub.transports.set(transport.id, transport);
          sub.transportStates.set(transport.id, 'connecting');
          transport.on('dtlsstatechange', (state: string) => {
            if (!sub) return;
            sub.transportStates.set(transport.id, state);
            if (state === 'closed' || state === 'failed') {
              transport.close();
            }
          });
          transport.on('@close', () => {
            sub?.transports.delete(transport.id);
            sub?.transportStates.delete(transport.id);
          });
          send({
            type: 'transport-created',
            data: {
              transportId: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters,
            },
          });
          return;
        }

        case 'connect-transport': {
          if (!joined || !claims || !role) {
            error(401, 'join first');
            return;
          }
          const room = roomFor(claims.participantId);
          if (!room) {
            error(400, 'unknown room');
            return;
          }
          const transportId = String(msg.data?.transportId ?? '');
          const transport =
            role === 'subscriber'
              ? (sub?.transports.get(transportId) ?? null)
              : room.sendTransport;
          if (!transport || transport.id !== transportId) {
            error(400, 'unknown transport');
            return;
          }
          try {
            await transport.connect({ dtlsParameters: msg.data?.dtlsParameters as never });
            send({ type: 'transport-connected', data: { transportId: transport.id } });
          } catch (err) {
            error(400, `connect failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        case 'produce': {
          if (!joined || !claims || !role || role !== 'publisher') {
            error(403, 'only publishers can produce');
            return;
          }
          const room = roomFor(claims.participantId);
          const transport = room?.sendTransport;
          if (!room || !transport || transport.id !== msg.data?.transportId) {
            error(400, 'unknown send transport');
            return;
          }
          const kind = msg.data?.kind;
          if (kind !== 'audio' && kind !== 'video') {
            error(400, 'kind must be audio or video');
            return;
          }
          const appData = ((msg.data?.appData as Record<string, unknown> | undefined) ?? {}) as {
            kind?: unknown;
          };
          const appKind = appData.kind;
          if (appKind !== 'camera' && appKind !== 'microphone' && appKind !== 'screen') {
            error(400, 'appData.kind must be camera | microphone | screen');
            return;
          }
          // One producer per track kind per publisher.
          for (const existing of room.producers.values()) {
            const existingApp = existing.appData as { kind?: string };
            if (existingApp.kind === appKind) {
              error(409, `a ${appKind} producer already exists`);
              return;
            }
          }
          try {
            const producer = await transport.produce({
              kind,
              rtpParameters: msg.data?.rtpParameters as never,
              appData: { kind: appKind, participantId: room.participantId, attemptId: room.attemptId },
            });
            room.producers.set(producer.id, producer);
            producer.on('transportclose', () => room.producers.delete(producer.id));
            producer.on('@close', () => room.producers.delete(producer.id));
            send({
              type: 'produced',
              data: { id: producer.id, producerId: producer.id, kind, appKind },
            });
            // Tell attached subscribers a live track appeared (device came up).
            const meta = { producerId: producer.id, kind, appKind };
            for (const watcher of room.subscribers) {
              if (watcher.ws.readyState === watcher.ws.OPEN) {
                watcher.ws.send(JSON.stringify({ type: 'producer-added', data: meta }));
              }
            }
          } catch (err) {
            error(400, `produce failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        case 'consume': {
          if (!joined || !claims || !role || role !== 'subscriber') {
            error(403, 'only subscribers can consume');
            return;
          }
          const room = roomFor(claims.participantId);
          const conn = sub;
          if (!room || !conn) {
            error(409, 'room gone');
            return;
          }
          const transport = conn.transports.get(String(msg.data?.transportId ?? ''));
          const producer = room.producers.get(String(msg.data?.producerId ?? ''));
          if (!transport || !producer) {
            error(404, 'transport or producer not found');
            return;
          }
          try {
            const consumer: Consumer = await transport.consume({
              producerId: producer.id,
              rtpCapabilities: msg.data?.rtpCapabilities as RtpCapabilities,
            });
            conn.consumers.set(consumer.id, consumer);
            const notifyClosed = (reason: string): void => {
              if (conn.consumers.delete(consumer.id)) {
                if (conn.ws.readyState === conn.ws.OPEN) {
                  conn.ws.send(
                    JSON.stringify({ type: 'consumer-closed', data: { consumerId: consumer.id, reason } }),
                  );
                }
              }
            };
            consumer.on('producerclose', () => notifyClosed('producer-closed'));
            consumer.on('transportclose', () => notifyClosed('transport-closed'));
            consumer.on('@close', () => notifyClosed('closed'));
            send({
              type: 'consumed',
              data: {
                consumerId: consumer.id,
                producerId: producer.id,
                kind: consumer.kind,
                appKind: (producer.appData as { kind?: string }).kind ?? producer.kind,
                rtpParameters: consumer.rtpParameters,
              },
            });
          } catch (err) {
            error(400, `consume failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          return;
        }

        case 'resume-consumer': {
          if (!joined || !claims || !role || role !== 'subscriber' || !sub) {
            error(401, 'join first');
            return;
          }
          const consumer = sub.consumers.get(String(msg.data?.consumerId ?? ''));
          if (!consumer) {
            error(404, 'consumer not found');
            return;
          }
          consumer.resume();
          send({ type: 'consumer-resumed', data: { consumerId: consumer.id } });
          return;
        }

        case 'close-consumer': {
          if (!joined || !claims || !role) return;
          const room = roomFor(claims.participantId);
          const map = role === 'subscriber' ? sub?.consumers : null;
          if (!room || !map) return;
          const consumer = map.get(String(msg.data?.consumerId ?? ''));
          if (consumer) {
            consumer.close();
            map.delete(consumer.id);
            send({ type: 'consumer-closed', data: { consumerId: consumer.id, reason: 'client-closed' } });
          }
          return;
        }

        case 'close-transport': {
          if (!joined || !claims || !role) return;
          const room = roomFor(claims.participantId);
          if (!room) return;
          const transportId = String(msg.data?.transportId ?? '');
          if (role === 'subscriber' && sub) {
            const transport = sub.transports.get(transportId);
            if (transport) {
              transport.close(); // consumers die with it and notify via events
              sub.transports.delete(transportId);
              send({ type: 'transport-closed', data: { transportId } });
            }
            return;
          }
          if (role === 'publisher' && room.sendTransport?.id === transportId) {
            const id = room.sendTransport.id;
            this.closeTransport(room, room.sendTransport);
            send({ type: 'transport-closed', data: { transportId: id } });
          }
          return;
        }

        case 'leave': {
          if (joined && claims && role === 'publisher') {
            // Only the current publisher socket may end its own room — a stale
            // publisher connection must never kill its successor's room.
            const room = roomFor(claims.participantId);
            if (room && room.ws === ws) this.teardownRoom(claims.participantId, 'leave');
          } else if (joined && role === 'subscriber' && claims) {
            const room = roomFor(claims.participantId);
            if (room && sub) this.detachSubscriber(room, sub);
          }
          try {
            ws.close(1000, 'leave');
          } catch {
            // ignore
          }
          return;
        }

        case 'ping': {
          send({ type: 'pong' });
          return;
        }

        default: {
          this.metrics.malformed += 1;
          error(400, `unknown message type: ${msg.type}`);
        }
      }
    };

    ws.on('message', (raw) => {
      const text = String(raw);
      if (text.length > WS_MAX_PAYLOAD) {
        this.metrics.malformed += 1;
        error(400, 'frame too large');
        return;
      }
      void handleMessage(text).catch(() => error(500, 'internal handler error'));
    });
    ws.on('close', () => {
      if (joined && claims && role === 'publisher') {
        // Stale-close protection: when a publisher reconnects, the NEW join
        // evicts the old room and the old socket is closed with 4001. That
        // old socket's close event arrives asynchronously — it must only tear
        // down the room if it is STILL the room's owner. Keying teardown by
        // participantId alone would destroy the newer room and leave its
        // socket orphaned (produce -> 409 room gone -> reconnect churn).
        const room = roomFor(claims.participantId);
        if (room && room.ws === ws) this.teardownRoom(claims.participantId, 'socket-closed');
      } else if (joined && claims && role === 'subscriber') {
        const room = roomFor(claims.participantId);
        if (room && sub) this.detachSubscriber(room, sub);
      }
    });
    ws.on('error', () => {
      // 'close' always follows.
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async createRoom(claims: MediaTokenClaims): Promise<Room> {
    const worker = this.worker;
    if (!worker) throw new Error('SFU not started');
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
    const room: Room = {
      router,
      participantId: claims.participantId,
      attemptId: claims.attemptId,
      orgId: claims.orgId,
      examId: claims.examId,
      ws: null,
      claims,
      sendTransport: null,
      transportState: 'new',
      producers: new Map(),
      subscribers: [],
      createdAt: Date.now(),
      idleTimer: null,
    };
    this.rooms.set(claims.participantId, room);
    Logger.info(`room ${claims.participantId.slice(0, 8)} created (attempt ${claims.attemptId.slice(0, 8)})`);
    return room;
  }

  private closeTransport(room: Room, transport: WebRtcTransport): void {
    if (room.sendTransport === transport) room.sendTransport = null;
    transport.close(); // producers die with their transport
  }

  /** Removes ONE subscriber's resources; the publisher/room keep running. */
  private detachSubscriber(room: Room, sub: SubscriberConn): void {
    const idx = room.subscribers.indexOf(sub);
    if (idx >= 0) room.subscribers.splice(idx, 1);
    for (const consumer of sub.consumers.values()) {
      try {
        consumer.close();
      } catch {
        // already closed
      }
    }
    for (const transport of sub.transports.values()) {
      try {
        transport.close();
      } catch {
        // already closed
      }
    }
    sub.consumers.clear();
    sub.transports.clear();
    sub.transportStates.clear();
    Logger.info(
      `subscriber detached from room ${room.participantId.slice(0, 8)} (remaining subscribers ${room.subscribers.length})`,
    );
  }

  /** Tears down the whole room — always on publisher socket close so no stale state. */
  private teardownRoom(participantId: string, reason: string): void {
    const room = this.rooms.get(participantId);
    if (!room) return;
    // Stop any active recording for this participant before tearing down the room.
    if (this.recording.isRecording(participantId)) {
      void this.recording.stopRecording(participantId).catch((err) => {
        Logger.error(`recording stop on teardown failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.rooms.delete(participantId);
    if (room.idleTimer) clearTimeout(room.idleTimer);
    // Every attached subscriber must lose the feed when the publisher goes.
    for (const sub of room.subscribers) {
      try {
        if (sub.ws.readyState === sub.ws.OPEN) {
          sub.ws.close(4002, 'publisher session ended');
        }
      } catch {
        // already closing
      }
      for (const consumer of sub.consumers.values()) {
        try {
          consumer.close();
        } catch {
          // already closed
        }
      }
      for (const transport of sub.transports.values()) {
        try {
          transport.close();
        } catch {
          // already closed
        }
      }
    }
    room.subscribers = [];
    try {
      room.sendTransport?.close();
    } catch {
      // already closed
    }
    try {
      room.router.close();
    } catch {
      // already closed
    }
    room.ws = null;
    Logger.info(`room ${participantId.slice(0, 8)} torn down (${reason})`);
  }

  /**
   * Start recording all producers for a participant's room.
   * The room must already have producers (publisher connected and producing).
   */
  async startRecording(
    participantId: string,
    recordingId: string,
    storageKey: string,
  ): Promise<{ started: boolean; error?: string }> {
    const room = this.rooms.get(participantId);
    if (!room) return { started: false, error: 'room not found' };
    if (room.producers.size === 0) return { started: false, error: 'no producers' };
    try {
      await this.recording.startRecording(
        room.router,
        participantId,
        recordingId,
        storageKey,
        room.producers,
      );
      return { started: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Logger.error(`startRecording failed: ${msg}`);
      return { started: false, error: msg };
    }
  }

  /**
   * Stop recording for a participant. Returns the recording result.
   */
  async stopRecording(participantId: string) {
    return this.recording.stopRecording(participantId);
  }

  /**
   * Server-initiated eviction (Phase 4D hardening): the API ends an attempt and
   * asks the SFU to drop the publisher's room WITHOUT waiting for the client.
   * Idempotent — a missing room is a no-op (returns false). The publisher's
   * socket receives close 4002 so a live client learns the attempt ended and
   * does not fight the eviction with reconnect attempts.
   */
  evictParticipant(participantId: string, reason: string): { evicted: boolean } {
    const room = this.rooms.get(participantId);
    if (!room) return { evicted: false };
    const publisherWs = room.ws;
    this.teardownRoom(participantId, reason);
    if (publisherWs && publisherWs.readyState === publisherWs.OPEN) {
      try {
        publisherWs.close(4002, 'attempt ended — publisher evicted');
      } catch {
        // already closing
      }
    }
    return { evicted: true };
  }

  private readonly bitrates = new Map<
    string,
    { bytes: number; at: number; bitrate: number }
  >();

  private statsBusy = false;

  private async sampleStats(): Promise<void> {
    if (this.statsBusy) return;
    this.statsBusy = true;
    try {
      // Cumulative bytes from mediasoup; per-second deltas computed here so
      // roomView() can report a live bitrate. Metadata only — never media.
      for (const room of this.rooms.values()) {
        for (const producer of room.producers.values()) {
          let bytes = 0;
          try {
            // Producer stats are inbound to the worker (RtpStreamRecvStats) and
            // expose byteCount (never bytesSent — that is consumer/outbound).
            const stats = (await producer.getStats()) as unknown as Array<{
              type: string;
              byteCount?: number;
              bytesSent?: number;
            }>;
            for (const stat of stats) {
              if (stat.type === 'inbound-rtp') bytes += stat.byteCount ?? 0;
              else bytes += stat.bytesSent ?? stat.byteCount ?? 0;
            }
          } catch {
            continue;
          }
          this.recordDelta(producer.id, bytes);
        }
        for (const sub of room.subscribers) {
          for (const consumer of sub.consumers.values()) {
            let bytes = 0;
            try {
              // Consumer stats are outbound from the worker to the subscriber.
              const stats = (await consumer.getStats()) as unknown as Array<{
                type: string;
                bytesSent?: number;
                byteCount?: number;
              }>;
              for (const stat of stats) {
                if (stat.type === 'outbound-rtp') bytes += stat.bytesSent ?? 0;
                else bytes += stat.bytesSent ?? stat.byteCount ?? 0;
              }
            } catch {
              continue;
            }
            this.recordDelta(consumer.id, bytes);
          }
        }
      }
      // Drop entries whose producers/consumers are gone.
      const live = new Set<string>();
      for (const room of this.rooms.values()) {
        for (const p of room.producers.keys()) live.add(p);
        for (const sub of room.subscribers) for (const c of sub.consumers.keys()) live.add(c);
      }
      for (const key of Array.from(this.bitrates.keys())) {
        if (!live.has(key)) this.bitrates.delete(key);
      }
    } finally {
      this.statsBusy = false;
    }
  }

  private recordDelta(id: string, bytes: number): void {
    const prev = this.bitrates.get(id);
    const now = Date.now();
    const bitrate =
      prev && now > prev.at ? Math.round(((bytes - prev.bytes) * 8 * 1000) / (now - prev.at)) : 0;
    this.bitrates.set(id, { bytes, at: now, bitrate });
  }

  private viewOf(room: Room): RoomView {
    const producers: ProducerView[] = [];
    for (const producer of room.producers.values()) {
      const app = producer.appData as { kind?: string };
      const tracked = this.bitrates.get(producer.id);
      producers.push({
        producerId: producer.id,
        kind: producer.kind,
        appKind: (app.kind as AppTrackKind) ?? (producer.kind === 'audio' ? 'microphone' : 'camera'),
        paused: producer.paused,
        bytesSent: tracked?.bytes ?? 0,
        bitrate: tracked?.bitrate ?? 0,
      });
    }
    const consumers: ConsumerView[] = [];
    for (const sub of room.subscribers) {
      for (const consumer of sub.consumers.values()) {
        const producer = room.producers.get(consumer.producerId);
        const tracked = this.bitrates.get(consumer.id);
        consumers.push({
          consumerId: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          appKind: ((producer?.appData as { kind?: string } | undefined)?.kind as AppTrackKind) ?? 'camera',
          paused: consumer.paused,
          bytesSent: tracked?.bytes ?? 0,
          bitrate: tracked?.bitrate ?? 0,
        });
      }
    }
    const transports: RoomView['transports'] = [];
    if (room.sendTransport) {
      transports.push({ id: room.sendTransport.id, direction: 'send', state: room.transportState });
    }
    for (const sub of room.subscribers) {
      for (const transport of sub.transports.values()) {
        transports.push({
          id: transport.id,
          direction: 'recv',
          state: sub.transportStates.get(transport.id) ?? 'new',
        });
      }
    }
    return {
      roomId: room.participantId,
      attemptId: room.attemptId,
      participantId: room.participantId,
      createdAt: room.createdAt,
      transports,
      producers,
      consumers,
      subscribers: room.subscribers.length,
    };
  }

  private countProducers(): number {
    let n = 0;
    for (const room of this.rooms.values()) n += room.producers.size;
    return n;
  }

  private countConsumers(): number {
    let n = 0;
    for (const room of this.rooms.values()) {
      for (const sub of room.subscribers) n += sub.consumers.size;
    }
    return n;
  }
}
