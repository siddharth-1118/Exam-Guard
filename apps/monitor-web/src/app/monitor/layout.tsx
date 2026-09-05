import Link from 'next/link';
import { getSessionUser } from '@/lib/api';
import { LogoutButton } from '@/components/logout-button';

export default async function MonitorLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
          <Link href="/monitor/exams" className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-red-600 text-xs font-bold text-white">EG</div>
            <span className="text-sm font-bold">ExamGuard Monitor</span>
            <span className="ml-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-400">live</span>
          </Link>
          <div className="flex items-center gap-3">
            {user && (
              <span className="text-sm text-slate-400">
                {user.firstName} {user.lastName}
              </span>
            )}
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}