import 'server-only';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '@examguard/auth';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000';

export async function apiFetch<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { message?: string | string[] };
      if (Array.isArray(body.message)) message = body.message.join('; ');
      else if (body.message) message = body.message;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function getSessionUser() {
  try {
    return await apiFetch<{ id: string; email: string; firstName: string; lastName: string; role: string }>(
      '/api/v1/auth/me',
    );
  } catch {
    return null;
  }
}

export async function refreshSession(): Promise<boolean> {
  const store = await cookies();
  const refresh = store.get(REFRESH_COOKIE)?.value;
  if (!refresh) return false;
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: refresh }),
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    store.set(ACCESS_COOKIE, data.accessToken, { httpOnly: true, sameSite: 'lax', path: '/' });
    store.set(REFRESH_COOKIE, data.refreshToken, { httpOnly: true, sameSite: 'lax', path: '/' });
    return true;
  } catch {
    return false;
  }
}