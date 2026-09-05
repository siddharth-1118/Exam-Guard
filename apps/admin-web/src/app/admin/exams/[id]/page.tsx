import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, Button, Card, CardBody, CardHeader, PageHeader, RiskBadge, StatusBadge } from '@examguard/ui';
import { apiFetch } from '@/lib/api';
import { ExamStatusActions } from '@/components/exam-status-actions';
import { AssignStudentsForm } from '@/components/assign-students-form';
import { LinkQuestionsForm } from '@/components/link-questions-form';

export const dynamic = 'force-dynamic';

interface ExamDetail {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  status: string;
  durationMinutes: number;
  maxAttempts: number;
  negativeMarkingEnabled: boolean;
  negativeMarkingValue: number;
  passingScore: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  autoSubmit: boolean;
  startAt: string | null;
  endAt: string | null;
  _count?: { questions: number; assignments: number };
  settings: {
    cameraRequired: boolean;
    microphoneRequired: boolean;
    screenMonitoringRequired: boolean;
    identityVerificationRequired: boolean;
    aiProctoringEnabled: boolean;
    clipboardPolicy: string;
    fullScreenPolicy: string;
    appSwitchPolicy: string;
    multipleFacePolicy: string;
    phoneObjectDetection: boolean;
    allowOfflineMode: boolean;
    evidencePolicy: string;
    retentionDays: number;
  } | null;
}

interface AttemptResult {
  attemptId: string;
  studentName: string;
  studentCode: string;
  status: string;
  score: number | null;
  scoreGraded: boolean;
  submittedAt: string | null;
  riskScore: number | null;
  riskLevel: string | null;
}

export default async function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let exam: ExamDetail;
  try {
    exam = await apiFetch<ExamDetail>(`/api/v1/exams/${id}`);
  } catch {
    notFound();
  }

  const [students, results] = await Promise.all([
    apiFetch<Array<{ id: string; email: string; firstName: string; lastName: string; studentCode: string }>>('/api/v1/students').catch(() => []),
    apiFetch<AttemptResult[]>(`/api/v1/exams/${id}/results`).catch(() => []),
  ]);

  const s = exam.settings;
  const policyRows: Array<[string, string]> = s
    ? [
        ['Camera required', String(s.cameraRequired)],
        ['Microphone required', String(s.microphoneRequired)],
        ['Screen monitoring', String(s.screenMonitoringRequired)],
        ['Identity verification', String(s.identityVerificationRequired)],
        ['AI proctoring', String(s.aiProctoringEnabled)],
        ['Clipboard', s.clipboardPolicy],
        ['Fullscreen', s.fullScreenPolicy],
        ['App switching', s.appSwitchPolicy],
        ['Multiple faces', s.multipleFacePolicy],
        ['Phone/object detection', String(s.phoneObjectDetection)],
        ['Offline mode', String(s.allowOfflineMode)],
        ['Evidence', s.evidencePolicy],
        ['Retention', `${s.retentionDays} days`],
      ]
    : [];

  return (
    <>
      <PageHeader
        title={exam.name}
        description={exam.description ?? undefined}
        actions={<ExamStatusActions examId={exam.id} status={exam.status} />}
      />
      <Link href="/admin/exams" className="text-sm text-indigo-600 hover:text-indigo-800">← All exams</Link>

      <div className="mt-4 grid grid-cols-1 gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHeader title="Overview" />
            <CardBody className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
              <div><p className="text-xs text-slate-400">Status</p><StatusBadge status={exam.status} /></div>
              <div><p className="text-xs text-slate-400">Duration</p><p className="font-medium">{exam.durationMinutes} min</p></div>
              <div><p className="text-xs text-slate-400">Questions</p><p className="font-medium">{exam._count?.questions ?? 0}</p></div>
              <div><p className="text-xs text-slate-400">Assigned students</p><p className="font-medium">{exam._count?.assignments ?? 0}</p></div>
              <div><p className="text-xs text-slate-400">Attempts allowed</p><p className="font-medium">{exam.maxAttempts}</p></div>
              <div><p className="text-xs text-slate-400">Passing score</p><p className="font-medium">{exam.passingScore}%</p></div>
              <div><p className="text-xs text-slate-400">Negative marking</p><p className="font-medium">{exam.negativeMarkingEnabled ? `${exam.negativeMarkingValue}` : 'Off'}</p></div>
              <div><p className="text-xs text-slate-400">Auto-submit</p><p className="font-medium">{exam.autoSubmit ? 'On' : 'Off'}</p></div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Questions" subtitle="Link questions from your question bank to this exam." />
            <CardBody>
              <LinkQuestionsForm examId={exam.id} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Assigned Students" subtitle="Students who can start this exam." />
            <CardBody>
              <AssignStudentsForm examId={exam.id} students={students} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Results" subtitle="Attempts and server-computed scores." />
            <CardBody className="p-0">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-5 py-3">Student</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Score</th>
                    <th className="px-5 py-3">Risk</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {results.map((r) => (
                    <tr key={r.attemptId} className="hover:bg-slate-50">
                      <td className="px-5 py-3">
                        <p className="font-medium text-slate-900">{r.studentName}</p>
                        <p className="text-xs text-slate-400">{r.studentCode}</p>
                      </td>
                      <td className="px-5 py-3"><StatusBadge status={r.status} /></td>
                      <td className="px-5 py-3">
                        {r.score == null
                          ? <Badge tone="slate">pending manual grade</Badge>
                          : <span className="font-semibold">{r.score}</span>}
                      </td>
                      <td className="px-5 py-3">
                        {r.riskScore != null ? <RiskBadge score={r.riskScore} level={r.riskLevel ?? 'NORMAL'} /> : '—'}
                      </td>
                    </tr>
                  ))}
                  {results.length === 0 && (
                    <tr><td className="px-5 py-6 text-center text-slate-400" colSpan={4}>No attempts yet.</td></tr>
                  )}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Security Policy" />
            <CardBody>
              <dl className="space-y-2">
                {policyRows.map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between text-sm">
                    <dt className="text-slate-500">{k}</dt>
                    <dd className="font-medium capitalize">{v.replaceAll('_', ' ').toLowerCase()}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
          {exam.instructions && (
            <Card>
              <CardHeader title="Student Instructions" />
              <CardBody><p className="whitespace-pre-wrap text-sm text-slate-600">{exam.instructions}</p></CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}