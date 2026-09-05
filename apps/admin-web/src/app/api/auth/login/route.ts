import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { setAuthCookies } from '@examguard/auth';
import { API_URL, homeForRole } from '@/lib/api';

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!body.email || !body.password) {
    return NextResponse.json({ error: 'Email and password are required' }, { status: 400 });
  }
  const res = await fetch(`${API_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email, password: body.password }),
    cache: 'no-store',
  });
  const data = (await res.json().catch(() => ({}))) as {
    accessToken?: string;
    refreshToken?: string;
    user?: { role?: string };
    message?: string;
  };
  if (!res.ok || !data.accessToken || !data.refreshToken) {
    return NextResponse.json(
      { error: typeof data.message === 'string' ? data.message : 'Login failed' },
      { status: res.status === 429 ? 429 : 401 },
    );
  }
  const store = await cookies();
  const secure = process.env.NODE_ENV === 'production';
  setAuthCookies(store, data.accessToken, data.refreshToken, secure);
  const role = data.user?.role;
  const allowed = role === 'SUPER_ADMIN' || role === 'ORG_ADMIN' || role === 'EXAM_MANAGER';
  return NextResponse.json({
    redirect: allowed ? '/admin/dashboard' : homeForRole(role),
    allowedPortal: allowed,
    role,
  });
}