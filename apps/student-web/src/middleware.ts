import { NextRequest, NextResponse } from 'next/server';
import { jwtVerify } from 'jose';

const SECRETS = [
  process.env.JWT_SECRET,
  'change-me-to-a-long-random-string',
  'dev-only-insecure-secret-change-me',
]
  .filter(Boolean)
  .map((s) => new TextEncoder().encode(s!));

async function readClaims(req: NextRequest): Promise<{ role?: string } | null> {
  const token = req.cookies.get('eg_access')?.value;
  if (!token) return null;
  for (const secret of SECRETS) {
    try {
      const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
      return { role: typeof payload.role === 'string' ? payload.role : undefined };
    } catch {
      // try next secret
    }
  }
  return null;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === '/login') {
    const claims = await readClaims(req);
    if (claims?.role === 'STUDENT') {
      return NextResponse.redirect(new URL('/student/dashboard', req.url));
    }
    return NextResponse.next();
  }
  if (pathname.startsWith('/student')) {
    const claims = await readClaims(req);
    if (!claims) {
      const url = new URL('/login', req.url);
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
    if (claims.role !== 'STUDENT') {
      return NextResponse.redirect(new URL('/login?portal=admin', req.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/login', '/student/:path*'],
};