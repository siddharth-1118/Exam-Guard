import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from '@examguard/auth';
import { API_URL, refreshSession } from '@/lib/api';

/**
 * Server-side proxy for mutations. The browser never holds the API token:
 * this route attaches the httpOnly cookie as a bearer token and forwards.
 * Authorization is still enforced end-to-end by the API (RBAC + tenancy).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    path?: string;
    method?: string;
    body?: unknown;
  };
  if (!body.path || !body.path.startsWith('/')) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  const path = `/api/v1${body.path}`;
  const method = (body.method ?? 'POST').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'DELETE', 'PUT'].includes(method)) {
    return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const store = await cookies();
  const send = async (token: string | undefined) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body.body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${API_URL}${path}`, {
      method,
      headers,
      body: body.body !== undefined ? JSON.stringify(body.body) : undefined,
      cache: 'no-store',
    });
  };

  let res = await send(store.get(ACCESS_COOKIE)?.value);
  if (res.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      res = await send(store.get(ACCESS_COOKIE)?.value);
    }
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string | string[] };
  if (!res.ok) {
    const message = Array.isArray(data.message) ? data.message.join('; ') : data.message ?? 'Request failed';
    return NextResponse.json({ error: message }, { status: res.status });
  }
  return NextResponse.json(data);
}