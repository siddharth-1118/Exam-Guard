/**
 * Shared configuration. BRAND_NAME is the single place to rebrand the product
 * (spec §1) — every app and service reads it from here.
 */

export const BRAND_NAME = 'ExamGuard';

export const APP_DESCRIPTION =
  'Secure online examination, lockdown and live proctoring platform';

/** Monitor pause presets (spec §14). */
export const PAUSE_OPTIONS_SECONDS = [30, 60, 300, 600];

/** Heartbeat interval (ms) the client should use. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Grace period before an unreachable student attempt is marked DISCONNECTED. */
export const DISCONNECT_GRACE_MS = 60_000;

/** Preset monitor messages (spec §17). */
export const PREDEFINED_MESSAGES = [
  'Please remain facing the camera.',
  'Please ensure your face is visible.',
  'Your examination has been temporarily paused.',
  'Please remove the detected unauthorized object.',
] as const;

export interface Env {
  NODE_ENV: string;
  APP_ENV: string;
  API_PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  JWT_SECRET: string;
  JWT_ACCESS_TTL: number;
  JWT_REFRESH_TTL: number;
  CORS_ORIGINS: string[];
  /** SFU signaling/HTTP origin handed to clients (Phase 4B). */
  SFU_URL: string;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const isProduction = env.NODE_ENV === 'production';
  const jwtSecret = env.JWT_SECRET ?? '';

  if (isProduction && env.APP_ENV !== 'test') {
    if (
      !jwtSecret ||
      jwtSecret.length < 16 ||
      jwtSecret === 'change-me-to-a-long-random-string' ||
      jwtSecret === 'dev-only-insecure-secret-change-me'
    ) {
      throw new Error(
        'JWT_SECRET must be set to a secure string (≥ 16 chars) in production and cannot use development default placeholders.',
      );
    }
    if (!env.DATABASE_URL || env.DATABASE_URL.includes('examguard:examguard@localhost')) {
      throw new Error('DATABASE_URL must be configured with explicit production credentials in production.');
    }
    if (!env.REDIS_URL) {
      throw new Error('REDIS_URL must be configured in production.');
    }
    const corsOrigins = (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim());
    if (corsOrigins.includes('*') && env.ALLOW_UNRESTRICTED_CORS !== 'true') {
      throw new Error('CORS_ORIGINS cannot use wildcard "*" in production without explicit ALLOW_UNRESTRICTED_CORS=true.');
    }
  }

  return {
    NODE_ENV: env.NODE_ENV ?? 'development',
    APP_ENV: env.APP_ENV ?? 'development',
    API_PORT: Number(env.API_PORT ?? 4000),
    DATABASE_URL:
      env.DATABASE_URL ?? 'postgresql://examguard:examguard@localhost:5432/examguard?schema=public',
    REDIS_URL: env.REDIS_URL ?? 'redis://localhost:6379',
    JWT_SECRET: jwtSecret || 'dev-only-insecure-secret-change-me',
    JWT_ACCESS_TTL: Number(env.JWT_ACCESS_TTL ?? 900),
    JWT_REFRESH_TTL: Number(env.JWT_REFRESH_TTL ?? 604800),
    CORS_ORIGINS: (env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:3001,http://localhost:3002')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    SFU_URL: (env.WEBRTC_SERVER_URL || env.SFU_URL || 'ws://localhost:4010/sfu').replace(/\/+$/, ''),
  };
}