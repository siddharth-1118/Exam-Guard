import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me',
);

const ALLOWED_ROLES = ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER'];

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
    if (claims?.role && ALLOWED_ROLES.includes(claims.role)) {
      return NextResponse.redirect(new URL('/admin/dashboard', req.url));
    }
    return NextResponse.next();
  }

  if (pathname.startsWith('/admin')) {
    const claims = await readClaims(req);
    if (!claims) {
      const url = new URL('/login', req.url);
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
    if (!ALLOWED_ROLES.includes(claims.role ?? '')) {
      return NextResponse.redirect(new URL('/login?portal=student-or-monitor', req.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/login', '/admin/:path*'],
};