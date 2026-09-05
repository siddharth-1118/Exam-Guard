import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
);

async function readClaims(req: NextRequest): Promise<{ role?: string } | null> {
  const token = req.cookies.get('eg_access')?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, SECRET, { algorithms: ['HS256'] });
    return { role: typeof payload.role === 'string' ? payload.role : undefined };
  } catch {
    return null;
  }
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login') {
    const claims = await readClaims(req);
    if (claims?.role === 'MONITOR') {
      return NextResponse.redirect(new URL('/monitor/exams', req.url));
    }
    return NextResponse.next();
  }
  if (pathname.startsWith('/monitor')) {
    const claims = await readClaims(req);
    if (!claims) {
      const url = new URL('/login', req.url);
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
    if (claims.role !== 'MONITOR') {
      return NextResponse.redirect(new URL('/login?portal=admin', req.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/login', '/monitor/:path*'],
};