import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Badge, Button, Card, CardBody, PageHeader, StatusBadge } from '@examguard/ui';
import { apiFetch, getSessionUser } from '@/lib/api';

interface AssignedExam {
  id: string;
  name: string;
  status: string;
  assignedStudents: number;
  active: number;
  suspicious: number;
  critical: number;
}

export const dynamic = 'force-dynamic';

export default async function MonitorExamsPage() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const exams = await apiFetch<AssignedExam[]>('/api/v1/monitoring/exams');

  return (
    <>
      <PageHeader
        title="Assigned exams"
        description={`Monitor ${user.firstName}, you can only view exams you are assigned to. Live push updates arrive in Phase 4 — this console polls every few seconds.`}
      />
      {exams.length === 0 ? (
        <Card className="border-slate-800 bg-slate-900">
          <CardBody>
            <p className="py-10 text-center text-sm text-slate-400">
              No exams assigned to you yet. An admin must assign you from the exam page.
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {exams.map((exam) => (
            <Card key={exam.id} className="border-slate-800 bg-slate-900">
              <CardBody>
                <div className="mb-3 flex items-center justify-between">
                  <StatusBadge status={exam.status} />
                  <span className="text-xs text-slate-500">{exam.assignedStudents} students</span>
                </div>
                <h3 className="text-base font-semibold text-white">{exam.name}</h3>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-slate-800/60 p-2">
                    <p className="text-lg font-bold text-emerald-400">{exam.active}</p>
                    <p className="text-[10px] uppercase text-slate-500">Active</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/60 p-2">
                    <p className="text-lg font-bold text-amber-400">{exam.suspicious}</p>
                    <p className="text-[10px] uppercase text-slate-500">Suspicious</p>
                  </div>
                  <div className="rounded-lg bg-slate-800/60 p-2">
                    <p className="text-lg font-bold text-red-400">{exam.critical}</p>
                    <p className="text-[10px] uppercase text-slate-500">Critical</p>
                  </div>
                </div>
                <Link href={`/monitor/exams/${exam.id}`} className="mt-4 block">
                  <Button className="w-full bg-red-600 hover:bg-red-700">Open monitoring board</Button>
                </Link>
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}