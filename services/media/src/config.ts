/**
 * SFU environment configuration. Reads process.env with dev defaults matching
 * the API's defaults so `node services/media/src/index.ts` works out of the
 * box against a default local API. No secrets are logged or exposed.
 */

export interface SfuConfig {
  /** HTTP + WebSocket listen port (signaling/control + dev status). */
  port: number;
  host: string;
  /** Shared HMAC secret used to verify API-issued media tokens. */
  jwtSecret: string;
  /** Local media workers RTC port range (ICE/UDP/TCP). */
  rtcMinPort: number;
  rtcMaxPort: number;
  /** Announcement IP for ICE candidates (empty = private IP as-is). */
  announcedIp: string | null;
  /** ms until an idle router is torn down after its publisher leaves. */
  roomIdleMs: number;
  /**
   * Shared secret the API presents on the internal admin control endpoint
   * (server-side room eviction). Dev default mirrors @examguard/config — set
   * SFU_ADMIN_KEY in real deployments. Never exposed over the wire to clients.
   */
  adminKey: string;
  /** Directory where recording egress writes .webm files (shared with API). */
  recordingStorageDir: string;
  /** API base URL for recording finalize calls. */
  apiUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SfuConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (jwtSecret.length < 16 && env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set and at least 16 chars in production');
  }
  return {
    port: Number(env.SFU_PORT ?? 4010),
    host: env.SFU_HOST ?? '127.0.0.1',
    jwtSecret: jwtSecret || 'dev-only-insecure-secret-change-me',
    rtcMinPort: Number(env.SFU_RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(env.SFU_RTC_MAX_PORT ?? 49999),
    announcedIp: env.SFU_ANNOUNCED_IP ? env.SFU_ANNOUNCED_IP : null,
    roomIdleMs: Number(env.SFU_ROOM_IDLE_MS ?? 30_000),
    adminKey: env.SFU_ADMIN_KEY || 'examguard-dev-sfu-admin-key',
    recordingStorageDir: env.RECORDING_STORAGE_DIR || `${process.cwd()}/storage/recordings`,
    apiUrl: env.API_URL || 'http://localhost:4000',
  };
}
