import Link from 'next/link';
import { Card, CardBody, PageHeader, StatusBadge, Button } from '@examguard/ui';
import { apiFetch } from '@/lib/api';
import { DeleteExamButton } from '@/components/delete-exam-button';

export const dynamic = 'force-dynamic';

export default async function ExamsPage() {
  const exams = await apiFetch<Array<{
    id: string;
    name: string;
    description: string | null;
    status: string;
    durationMinutes: number;
    startAt: string | null;
    endAt: string | null;
    _count?: { questions: number; assignments: number };
  }>>('/api/v1/exams');

  return (
    <>
      <PageHeader
        title="Exams"
        description="Create, schedule and manage secure examinations."
        actions={<Link href="/admin/exams/create"><Button>+ New Exam</Button></Link>}
      />
      <Card>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-5 py-3">Exam</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Duration</th>
                <th className="px-5 py-3">Questions</th>
                <th className="px-5 py-3">Students</th>
                <th className="px-5 py-3">Window</th>
                <th className="px-5 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {exams.map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <td className="px-5 py-3">
                    <Link className="font-medium text-indigo-600 hover:text-indigo-800" href={`/admin/exams/${e.id}`}>
                      {e.name}
                    </Link>
                    {e.description && <p className="max-w-md truncate text-xs text-slate-400">{e.description}</p>}
                  </td>
                  <td className="px-5 py-3"><StatusBadge status={e.status} /></td>
                  <td className="px-5 py-3 text-slate-600">{e.durationMinutes} min</td>
                  <td className="px-5 py-3 text-slate-600">{e._count?.questions ?? 0}</td>
                  <td className="px-5 py-3 text-slate-600">{e._count?.assignments ?? 0}</td>
                  <td className="px-5 py-3 text-xs text-slate-500">
                    {e.startAt ? new Date(e.startAt).toLocaleString() : '—'}
                    {e.endAt ? <><br />→ {new Date(e.endAt).toLocaleString()}</> : null}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <Link className="mr-3 text-sm text-indigo-600 hover:text-indigo-800" href={`/admin/exams/${e.id}`}>Manage</Link>
                    <DeleteExamButton examId={e.id} examName={e.name} />
                  </td>
                </tr>
              ))}
              {exams.length === 0 && (
                <tr><td className="px-5 py-8 text-center text-slate-400" colSpan={7}>No exams yet.</td></tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </>
  );
}