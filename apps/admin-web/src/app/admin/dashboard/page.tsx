import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Card, CardHeader, CardBody, StatCard, PageHeader, StatusBadge } from '@examguard/ui';
import { apiFetch, getSessionUser } from '@/lib/api';

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const stats = await apiFetch<{
    totalStudents: number;
    activeExams: number;
    liveExams: number;
    activeMonitors: number;
    suspiciousEvents: number;
    criticalAlerts: number;
    completedExams: number;
    averageScore: number | null;
    pendingReview: number;
  }>('/api/v1/reports/dashboard');

  const exams = await apiFetch<Array<{
    id: string;
    name: string;
    status: string;
    startAt: string | null;
    _count?: { questions: number; assignments: number };
  }>>('/api/v1/exams');

  const cards = [
    { label: 'Total Students', value: stats.totalStudents, tone: 'indigo' as const },
    { label: 'Active Exams', value: stats.activeExams, tone: 'slate' as const },
    { label: 'Live Exam Sessions', value: stats.liveExams, tone: 'green' as const },
    { label: 'Active Monitors', value: stats.activeMonitors, tone: 'indigo' as const },
    { label: 'Suspicious AI Events', value: stats.suspiciousEvents, tone: 'yellow' as const },
    { label: 'Critical Alerts', value: stats.criticalAlerts, tone: 'red' as const },
    { label: 'Completed Exams', value: stats.completedExams, tone: 'slate' as const },
    { label: 'Average Score', value: stats.averageScore == null ? '—' : `${stats.averageScore}%`, tone: 'green' as const },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome back, ${user.firstName}`}
        description="Platform overview for your organization."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((c) => (
          <StatCard key={c.label} {...c} />
        ))}
      </div>
      {stats.pendingReview > 0 && (
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          ⚠ {stats.pendingReview} attempt(s) are under review and will not publish results until resolved.
        </div>
      )}
      <div className="mt-8">
        <Card>
          <CardHeader
            title="Recent Exams"
            action={<Link className="text-sm font-medium text-indigo-600 hover:text-indigo-700" href="/admin/exams">View all →</Link>}
          />
          <CardBody className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-5 py-3">Exam</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Questions</th>
                  <th className="px-5 py-3">Students</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {exams.slice(0, 8).map((e) => (
                  <tr key={e.id} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{e.name}</td>
                    <td className="px-5 py-3"><StatusBadge status={e.status} /></td>
                    <td className="px-5 py-3 text-slate-600">{e._count?.questions ?? 0}</td>
                    <td className="px-5 py-3 text-slate-600">{e._count?.assignments ?? 0}</td>
                    <td className="px-5 py-3 text-right">
                      <Link className="text-indigo-600 hover:text-indigo-800" href={`/admin/exams/${e.id}`}>Manage</Link>
                    </td>
                  </tr>
                ))}
                {exams.length === 0 && (
                  <tr><td className="px-5 py-8 text-center text-slate-400" colSpan={5}>No exams yet — create your first exam.</td></tr>
                )}
              </tbody>
            </table>
          </CardBody>
        </Card>
      </div>
    </>
  );
}