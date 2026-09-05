import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Badge, Button, Card, CardBody, PageHeader, StatusBadge } from '@examguard/ui';
import { apiFetch, getSessionUser } from '@/lib/api';

interface StudentExam {
  id: string;
  name: string;
  description: string | null;
  status: string;
  durationMinutes: number;
  startAt: string | null;
  endAt: string | null;
  assignmentId: string | null;
}

export const dynamic = 'force-dynamic';

export default async function StudentDashboard() {
  const user = await getSessionUser();
  if (!user) redirect('/login');
  const exams = await apiFetch<StudentExam[]>('/api/v1/exams').catch(() => []);

  return (
    <>
      <PageHeader title={`My exams, ${user.firstName}`} description="Exams assigned to you by your institution." />
      {exams.length === 0 ? (
        <Card><CardBody><p className="py-8 text-center text-sm text-slate-400">You have not been assigned any exams yet.</p></CardBody></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {exams.map((exam) => {
            const now = Date.now();
            const notYetOpen = exam.startAt && now < new Date(exam.startAt).getTime();
            const closed = exam.endAt && now > new Date(exam.endAt).getTime();
            const canStart = exam.status === 'OPEN' && !notYetOpen && !closed;
            return (
              <Card key={exam.id} className="flex flex-col">
                <CardBody className="flex flex-1 flex-col">
                  <div className="mb-2 flex items-center justify-between">
                    <StatusBadge status={exam.status} />
                    <span className="text-xs text-slate-400">{exam.durationMinutes} minutes</span>
                  </div>
                  <h3 className="text-base font-semibold text-slate-900">{exam.name}</h3>
                  {exam.description && <p className="mt-1 line-clamp-2 text-sm text-slate-500">{exam.description}</p>}
                  <div className="mt-3 space-y-1 text-xs text-slate-400">
                    <p>Opens: {exam.startAt ? new Date(exam.startAt).toLocaleString() : 'immediately'}</p>
                    <p>Closes: {exam.endAt ? new Date(exam.endAt).toLocaleString() : '—'}</p>
                  </div>
                  <div className="mt-4 flex-1" />
                  {canStart ? (
                    <Link href={`/student/exam/${exam.id}`}><Button className="w-full">Open exam</Button></Link>
                  ) : (
                    <div className="text-center">
                      <Badge tone={notYetOpen ? 'yellow' : 'slate'}>
                        {notYetOpen ? 'Not open yet' : closed ? 'Closed' : exam.status === 'DRAFT' ? 'Not scheduled' : '—'}
                      </Badge>
                    </div>
                  )}
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}
      <Card className="mt-8">
        <CardBody>
          <p className="text-xs leading-relaxed text-slate-400">
            <strong>Monitoring notice:</strong> Exams on this platform may require camera, microphone and screen monitoring,
            with AI-assisted proctoring and human monitors. You will always be shown exactly what is monitored and asked for
            consent before starting. The secure desktop app provides the strongest lockdown; this web view is only offered
            when the exam policy permits it.
          </p>
        </CardBody>
      </Card>
    </>
  );
}