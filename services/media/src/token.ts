/**
 * Minimal HS256 JWT verification for API-issued media tokens (Phase 4B).
 * Implemented with node:crypto so the SFU carries no auth framework. The API
 * signs with jose + the shared JWT_SECRET; the token must be type 'media' and
 * role 'publisher' and must not be expired.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type MediaTokenRole = 'publisher' | 'subscriber';

export interface MediaTokenClaims {
  sub: string;
  type: 'media';
  orgId: string;
  examId: string;
  attemptId: string;
  participantId: string;
  role: MediaTokenRole;
  iat?: number;
  exp?: number;
}

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

function decodeSegment<T>(segment: string): T | null {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns claims on success, null on invalid signature/format/expiry/scope. */
export function verifyMediaToken(token: string, secret: string): MediaTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;
  const header = decodeSegment<{ alg?: string }>(headerSeg);
  if (!header || header.alg !== 'HS256') return null;

  const expected = createHmac('sha256', secret).update(`${headerSeg}.${payloadSeg}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sigSeg, 'base64url');
  } catch {
    return null;
  }
  if (!safeEqual(expected, provided)) return null;

  const claims = decodeSegment<Partial<MediaTokenClaims> & { type?: string; role?: string }>(payloadSeg);
  if (!claims || typeof claims !== 'object') return null;
  if (
    claims.type !== 'media' ||
    typeof claims.sub !== 'string' ||
    typeof claims.orgId !== 'string' ||
    typeof claims.examId !== 'string' ||
    typeof claims.attemptId !== 'string' ||
    typeof claims.participantId !== 'string' ||
    (claims.role !== 'publisher' && claims.role !== 'subscriber')
  ) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && claims.exp <= now) return null;
  return {
    sub: claims.sub,
    type: 'media',
    orgId: claims.orgId,
    examId: claims.examId,
    attemptId: claims.attemptId,
    participantId: claims.participantId,
    // Preserve the verified role — the union was validated above. (A previous
    // version hardcoded 'publisher', silently turning every subscriber token
    // into a publisher join at the SFU.)
    role: claims.role as MediaTokenRole,
    iat: claims.iat,
    exp: claims.exp,
  };
}

/** For dev fixtures only — mirrors the API's jose signing (used by tests). */
export function signMediaTokenForTest(
  claims: Omit<MediaTokenClaims, 'type'>,
  secret: string,
  ttlSeconds: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      ...claims,
      type: 'media',
      iat: nowSeconds,
      exp: nowSeconds + ttlSeconds,
    }),
  );
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}
