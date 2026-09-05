import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { setAuthCookies } from '@examguard/auth';
import { API_URL } from '@/lib/api';

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
  setAuthCookies(store, data.accessToken, data.refreshToken, false);
  const role = data.user?.role;
  return NextResponse.json({
    redirect: role === 'STUDENT' ? '/student/dashboard' : '/login',
    allowedPortal: role === 'STUDENT',
  });
}