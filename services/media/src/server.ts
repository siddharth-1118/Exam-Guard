/**
 * SFU process: HTTP (health + dev status) + WebSocket signaling.
 * The status endpoint exposes room/producer metadata (participant, attempt,
 * kinds, byte counters) — never tokens, credentials or media.
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import type { SfuConfig } from './config';
import { Logger } from './logger';
import type { SfuService } from './sfu';

export interface SfuServerHandle {
  close(): Promise<void>;
  url: string;
  statusUrl: string;
}

export function startServer(sfu: SfuService, config: SfuConfig): Promise<SfuServerHandle> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url ?? '/';
      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', workers: 1 }));
        return;
      }
      if (url === '/status' || url.startsWith('/status/rooms')) {
        let rooms;
        if (url.startsWith('/status/rooms/')) {
          const roomId = decodeURIComponent(url.slice('/status/rooms/'.length));
          const view = sfu.roomView(roomId);
          rooms = view ? [view] : [];
        } else {
          rooms = sfu.listRooms();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', metrics: sfu.status, rooms }));
        return;
      }
      // Recording admin endpoints — protected by admin key.
      if (url === '/admin/recording/start' && (req.method ?? 'GET') === 'POST') {
        if (req.headers['x-sfu-admin-key'] !== config.adminKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += String(chunk); if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          Logger.info(`[admin] Received POST /admin/recording/start: ${body}`);
          let parsed: Record<string, unknown>;
          try { parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}; }
          catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body' })); return; }
          const pid = typeof parsed.participantId === 'string' ? parsed.participantId : '';
          const rid = typeof parsed.recordingId === 'string' ? parsed.recordingId : '';
          const key = typeof parsed.storageKey === 'string' ? parsed.storageKey : '';
          if (!pid || !rid || !key) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'participantId, recordingId, storageKey required' }));
            return;
          }
          const result = await sfu.startRecording(pid, rid, key);
          Logger.info(`[admin] startRecording finished: started=${result.started}, error=${result.error ?? 'none'}`);
          res.writeHead(result.started ? 200 : 409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
        req.resume();
        return;
      }
      if (url === '/admin/recording/stop' && (req.method ?? 'GET') === 'POST') {
        if (req.headers['x-sfu-admin-key'] !== config.adminKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += String(chunk); if (body.length > 4096) req.destroy(); });
        req.on('end', async () => {
          let parsed: Record<string, unknown>;
          try { parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {}; }
          catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid body' })); return; }
          const pid = typeof parsed.participantId === 'string' ? parsed.participantId : '';
          if (!pid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'participantId required' }));
            return;
          }
          const result = await sfu.stopRecording(pid);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
        return;
      }
      if (url === '/admin/recording/status' && (req.method ?? 'GET') === 'GET') {
        if (req.headers['x-sfu-admin-key'] !== config.adminKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ recordings: sfu.recording.getStatus() }));
        return;
      }
      // Internal control plane (Phase 4D): the API evicts a participant's room
      // when its attempt ends server-side. Protected by the shared admin key —
      // never reachable by media clients (they only speak WS on /sfu).
      if (url === '/admin/evict' && (req.method ?? 'GET') === 'POST') {
        if (req.headers['x-sfu-admin-key'] !== config.adminKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += String(chunk);
          if (body.length > 4096) req.destroy();
        });
        req.on('end', () => {
          let participantId: unknown;
          let reason = 'admin-evict';
          try {
            const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
            participantId = parsed.participantId;
            if (typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid body' }));
            return;
          }
          if (typeof participantId !== 'string' || participantId.length < 8) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'participantId required' }));
            return;
          }
          const result = sfu.evictParticipant(participantId, reason);
          res.writeHead(result.evicted ? 200 : 404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const wss = new WebSocketServer({ server, path: '/sfu' });
    wss.on('connection', (ws, req) => {
      const remote = req.socket.remoteAddress ?? 'unknown';
      Logger.info(`ws connection from ${remote}`);
      (ws as unknown as { isAlive: boolean }).isAlive = true;
      ws.on('pong', () => {
        (ws as unknown as { isAlive: boolean }).isAlive = true;
      });
      sfu.handleConnection(ws);
    });

    // Stale-connection sweep (Phase 4D): a hard-crashed publisher never sends a
    // close frame, so its WebSocket (and therefore its room/transport/mediasoup
    // resources) would linger. Protocol-level pings detect the dead socket and
    // terminate it; the 'close' handler tears the room down. Browsers and the
    // Electron renderer answer protocol pings automatically.
    const pingSweep = setInterval(() => {
      for (const client of wss.clients) {
        const c = client as unknown as { isAlive: boolean };
        if (c.isAlive === false) {
          try {
            client.terminate();
          } catch {
            // already gone
          }
          continue;
        }
        c.isAlive = false;
        try {
          client.ping();
        } catch {
          // socket closing — close handler cleans up
        }
      }
    }, 15_000);
    wss.on('close', () => clearInterval(pingSweep));

    server.listen(config.port, config.host, () => {
      const url = `ws://${config.host}:${config.port}/sfu`;
      Logger.info(`SFU signaling on ${url}`);
      Logger.info(`SFU status on http://${config.host}:${config.port}/status`);
      resolve({
        url,
        statusUrl: `http://${config.host}:${config.port}/status`,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) {
              try {
                client.close(1001, 'shutdown');
              } catch {
                // ignore
              }
            }
            wss.close(() => {
              server.close(() => done());
            });
          }),
      });
    });
  });
}
