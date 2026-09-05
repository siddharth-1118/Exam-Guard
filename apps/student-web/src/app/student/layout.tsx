import Link from 'next/link';
import { getSessionUser } from '@/lib/api';
import { LogoutButton } from '@/components/logout-button';

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <Link href="/student/dashboard" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-xs font-bold text-white">EG</div>
            <span className="text-sm font-bold text-slate-900">ExamGuard Student</span>
          </Link>
          <div className="flex items-center gap-3">
            {user && <span className="text-sm text-slate-500">Hi, {user.firstName}</span>}
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
    </div>
  );
}