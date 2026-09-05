import Link from 'next/link';
import { getSessionUser } from '@/lib/api';
import { LogoutButton } from '@/components/logout-button';

const NAV: Array<{ href: string; label: string; roles: string[] }> = [
  { href: '/admin/dashboard', label: 'Dashboard', roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER'] },
  { href: '/admin/exams', label: 'Exams', roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER'] },
  { href: '/admin/question-bank', label: 'Question Bank', roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER'] },
  { href: '/admin/students', label: 'Students', roles: ['SUPER_ADMIN', 'ORG_ADMIN', 'EXAM_MANAGER'] },
  { href: '/admin/users', label: 'Users & Roles', roles: ['SUPER_ADMIN', 'ORG_ADMIN'] },
  { href: '/admin/monitors', label: 'Monitors', roles: ['SUPER_ADMIN', 'ORG_ADMIN'] },
  { href: '/admin/audit-logs', label: 'Audit Logs', roles: ['SUPER_ADMIN', 'ORG_ADMIN'] },
  { href: '/admin/organizations', label: 'Organizations', roles: ['SUPER_ADMIN'] },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  const role = user?.role ?? '';
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-slate-200 bg-white">
        <div className="flex h-16 items-center gap-2 border-b border-slate-100 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">EG</div>
          <div>
            <p className="text-sm font-bold text-slate-900">ExamGuard</p>
            <p className="text-[10px] uppercase tracking-wide text-slate-400">Admin Portal</p>
          </div>
        </div>
        <nav className="p-3" aria-label="Admin navigation">
          {NAV.filter((n) => n.roles.includes(role)).map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="mb-1 block rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-6">
          <p className="text-sm text-slate-500">Organization administration</p>
          <div className="flex items-center gap-3">
            {user && (
              <div className="text-right">
                <p className="text-sm font-medium text-slate-900">
                  {user.firstName} {user.lastName}
                </p>
                <p className="text-xs text-slate-400">{role.replaceAll('_', ' ')}</p>
              </div>
            )}
            <LogoutButton />
          </div>
        </header>
        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}