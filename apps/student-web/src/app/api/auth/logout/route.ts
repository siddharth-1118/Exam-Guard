import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { clearAuthCookies, ACCESS_COOKIE } from '@examguard/auth';
import { API_URL } from '@/lib/api';

export async function POST() {
  const store = await cookies();
  const token = store.get(ACCESS_COOKIE)?.value;
  if (token) {
    await fetch(`${API_URL}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => undefined);
  }
  clearAuthCookies(store);
  return NextResponse.json({ ok: true });
}