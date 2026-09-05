import { SignJWT, jwtVerify } from 'jose';

/**
 * JWT-based authentication helpers (access + refresh tokens).
 * Access: short-lived (15 min default). Refresh: long-lived, bound to the
 * user's `tokenVersion` — logout bumps the version, invalidating all
 * outstanding refresh tokens (revocation without server-side storage).
 */

export interface AccessClaims {
  sub: string; // user id
  email: string;
  type: 'access';
  orgId?: string | null;
  role?: string | null;
}

export interface RefreshClaims {
  sub: string;
  type: 'refresh';
  tokenVersion: number;
}

export type MediaTokenRole = 'publisher' | 'subscriber';

/**
 * Short-lived, narrowly-scoped SFU credential (Phase 4B publisher / Phase 4C
 * subscriber). Binds one participant to exactly one media participant;
 * expires in seconds. Never derived from the long-lived access token and
 * never stored.
 */
export interface MediaTokenClaims {
  sub: string; // media participant id
  type: 'media';
  orgId: string;
  examId: string;
  attemptId: string;
  participantId: string;
  role: MediaTokenRole;
}

const encoder = new TextEncoder();

function key(secret: string): Uint8Array {
  return encoder.encode(secret);
}

export async function signAccessToken(
  claims: Omit<AccessClaims, 'type'>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function signRefreshToken(
  claims: Omit<RefreshClaims, 'type'>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function signMediaToken(
  claims: Omit<MediaTokenClaims, 'type'>,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ ...claims, type: 'media' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key(secret));
}

export async function verifyMediaToken(
  token: string,
  secret: string,
): Promise<MediaTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (
      payload.type !== 'media' ||
      typeof payload.sub !== 'string' ||
      typeof payload.orgId !== 'string' ||
      typeof payload.examId !== 'string' ||
      typeof payload.attemptId !== 'string' ||
      typeof payload.participantId !== 'string' ||
      (payload.role !== 'publisher' && payload.role !== 'subscriber')
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      type: 'media',
      orgId: payload.orgId,
      examId: payload.examId,
      attemptId: payload.attemptId,
      participantId: payload.participantId,
      role: payload.role,
    };
  } catch {
    return null;
  }
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.type !== 'access' || typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      type: 'access',
      orgId: payload.orgId ? String(payload.orgId) : null,
      role: payload.role ? String(payload.role) : null,
    };
  } catch {
    return null;
  }
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    if (payload.type !== 'refresh' || typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      type: 'refresh',
      tokenVersion: Number(payload.tokenVersion ?? 0),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cookie helpers for web apps (framework-agnostic — apps pass their cookie store)
// ---------------------------------------------------------------------------

export const ACCESS_COOKIE = 'eg_access';
export const REFRESH_COOKIE = 'eg_refresh';

export interface CookieSetter {
  set(name: string, value: string, options: Record<string, unknown>): void;
}

export function setAuthCookies(
  setter: CookieSetter,
  accessToken: string,
  refreshToken: string,
  secure: boolean,
): void {
  const base = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    path: '/',
  };
  setter.set(ACCESS_COOKIE, accessToken, { ...base, maxAge: 15 * 60 });
  setter.set(REFRESH_COOKIE, refreshToken, { ...base, maxAge: 7 * 24 * 3600 });
}

export function clearAuthCookies(setter: CookieSetter): void {
  const base = { httpOnly: true, sameSite: 'lax' as const, path: '/', maxAge: 0 };
  setter.set(ACCESS_COOKIE, '', base);
  setter.set(REFRESH_COOKIE, '', base);
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}