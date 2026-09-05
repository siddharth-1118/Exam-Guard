'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Input, Modal, Select, Textarea, RiskBadge, PageHeader } from '@examguard/ui';
import { LiveMediaPanel } from '@/components/live-media-panel';
import { gate } from '@/lib/gate';

const PAUSE_PRESETS = [
  { label: '30 seconds', value: '30' },
  { label: '1 minute', value: '60' },
  { label: '5 minutes', value: '300' },
  { label: '10 minutes', value: '600' },
  { label: 'Custom (seconds)', value: 'custom' },
];

const QUICK_MESSAGES = [
  'Please remain facing the camera.',
  'Please ensure your face is visible.',
  'Your examination has been temporarily paused.',
  'Please remove the detected unauthorized object.',
];

interface Detail {
  identity: { studentId: string; studentCode: string; name: string; email: string };
  exam: { id: string | null; name: string; status: string | null };
  attempt: { id: string; status: string; startedAt: string | null; submittedAt: string | null; score: number | null } | null;
  connection: { device: Record<string, unknown> | null; os: string | null; appVersion: string | null; lastSignalAt: string | null };
  media: {
    camera: { status: string; muted: boolean } | null;
    microphone: { status: string; muted: boolean; audioLevel: number } | null;
    screen: { status: string } | null;
  };
  risk: { score: number; level: string; computedAt: string } | null;
  events: Array<{ id: string; type: string; severity: string; capturedAt: string; detail: Record<string, unknown> | null }>;
  aiEvents: Array<{ id: string; eventType: string; confidence: number; status: string; capturedAt: string }>;
  actions: Array<{ id: string; action: string; reason: string | null; monitor: { email: string } | null; createdAt: string }>;
}

const statusTone = (s: string): 'red' | 'yellow' | 'green' | 'slate' | 'indigo' | 'blue' => {
  if (['ACTIVE', 'SUBMITTED', 'AUTO_SUBMITTED'].includes(s)) return 'green';
  if (['PAUSED', 'DISCONNECTED'].includes(s)) return 'yellow';
  if (s === 'TERMINATED') return 'red';
  if (s === 'UNDER_REVIEW') return 'indigo';
  return 'slate';
};

export default function MonitorStudentDetail() {
  const params = useParams<{ studentId: string }>();
  const router = useRouter();
  const studentId = params.studentId;
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Pause modal
  const [pauseOpen, setPauseOpen] = useState(false);
  const [pauseDuration, setPauseDuration] = useState('300');
  const [pauseCustom, setPauseCustom] = useState('600');
  const [pauseReason, setPauseReason] = useState('');
  // Resume
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeReason, setResumeReason] = useState('');
  // Terminate
  const [terminateOpen, setTerminateOpen] = useState(false);
  const [terminateReason, setTerminateReason] = useState('');
  // Message / flag
  const [messageOpen, setMessageOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [flagOpen, setFlagOpen] = useState(false);
  const [flagNote, setFlagNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await gate<Detail>(`/monitoring/students/${studentId}`, 'GET');
      setData(d);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load student');
    }
  }, [studentId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await gate(`/monitoring/students/${studentId}/${path}`, 'POST', body);
      setPauseOpen(false);
      setResumeOpen(false);
      setTerminateOpen(false);
      setMessageOpen(false);
      setFlagOpen(false);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const effectiveDuration = pauseDuration === 'custom' ? Number(pauseCustom) : Number(pauseDuration);
  const status = data?.attempt?.status ?? 'NO_ATTEMPT';
  const isPaused = status === 'PAUSED';
  const canPause = ['ACTIVE', 'DISCONNECTED'].includes(status);
  const canResume = isPaused;
  const canTerminate = !['SUBMITTED', 'AUTO_SUBMITTED', 'TERMINATED'].includes(status);

  return (
    <>
      <Link href={`/monitor/exams/${data?.exam.id ?? ''}`} className="text-sm text-slate-400 hover:text-white">← Back to board</Link>
      <PageHeader
        title={data ? `Student ${data.identity.studentCode}` : 'Student detail'}
        description={data ? `${data.identity.name} · ${data.identity.email} · ${data.exam.name}` : 'Loading…'}
      />

      {notice && <div className="mb-4"><Alert tone={notice.startsWith('Failed') || notice.includes('permission') ? 'danger' : 'warning'}>{notice}</Alert></div>}
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}

      {data && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(status)}>{status.replace('_', ' ')}</Badge>
            {data.risk && <RiskBadge score={data.risk.score} level={data.risk.level} />}
            <Button variant="secondary" size="sm" disabled={!canPause} onClick={() => setPauseOpen(true)}>⏸ Pause</Button>
            <Button variant="success" size="sm" disabled={!canResume} onClick={() => setResumeOpen(true)}>▶ Resume</Button>
            <Button variant="danger" size="sm" disabled={!canTerminate} onClick={() => setTerminateOpen(true)}>⛔ Terminate</Button>
            <Button variant="secondary" size="sm" onClick={() => setMessageOpen(true)}>✉ Message</Button>
            <Button variant="secondary" size="sm" onClick={() => setFlagOpen(true)}>🚩 Flag</Button>
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              {/* Live media — real SFU consumers attach here (Phase 4C). Audio
                  muted by default; enabling applies only to this focused student. */}
              <LiveMediaPanel attemptId={data.attempt?.id ?? null} attemptStatus={status} />

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <Card className="border-slate-800 bg-slate-900">
                  <CardHeader title="AI EVENTS" subtitle="Assistive detection — human review required" />
                  <CardBody className="max-h-72 overflow-y-auto p-0">
                    {data.aiEvents.length === 0 ? (
                      <p className="px-4 py-6 text-center text-xs text-slate-600">No AI events.</p>
                    ) : (
                      <ul className="divide-y divide-slate-800">
                        {data.aiEvents.map((e) => (
                          <li key={e.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                            <span className="text-slate-200">{e.eventType.replaceAll('_', ' ')}</span>
                            <span className="flex items-center gap-2">
                              <span className="text-slate-500">{Math.round(e.confidence * 100)}%</span>
                              <Badge tone={e.status === 'PENDING' ? 'yellow' : e.status === 'CONFIRMED' ? 'red' : 'slate'}>{e.status}</Badge>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
                <Card className="border-slate-800 bg-slate-900">
                  <CardHeader title="SECURITY EVENTS" />
                  <CardBody className="max-h-72 overflow-y-auto p-0">
                    {data.events.length === 0 ? (
                      <p className="px-4 py-6 text-center text-xs text-slate-600">No security events.</p>
                    ) : (
                      <ul className="divide-y divide-slate-800">
                        {data.events.map((e) => (
                          <li key={e.id} className="flex items-center justify-between px-4 py-2.5 text-xs">
                            <span className="text-slate-200">{e.type.replaceAll('_', ' ')}</span>
                            <span className="text-slate-500">{new Date(e.capturedAt).toLocaleTimeString()}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              </div>
            </div>

            <div className="space-y-4">
              <Card className="border-slate-800 bg-slate-900">
                <CardHeader title="Identity & Session" />
                <CardBody className="space-y-2 text-xs">
                  <p><span className="text-slate-500">Student:</span> <span className="text-slate-200">{data.identity.name}</span></p>
                  <p><span className="text-slate-500">Code:</span> <span className="font-mono text-slate-200">{data.identity.studentCode}</span></p>
                  <p><span className="text-slate-500">OS:</span> <span className="text-slate-200">{data.connection.os ?? '—'}</span></p>
                  <p><span className="text-slate-500">App version:</span> <span className="text-slate-200">{data.connection.appVersion ?? 'web'}</span></p>
                  <p><span className="text-slate-500">Last signal:</span> <span className="text-slate-200">{data.connection.lastSignalAt ? new Date(data.connection.lastSignalAt).toLocaleTimeString() : '—'}</span></p>
                  <p><span className="text-slate-500">Started:</span> <span className="text-slate-200">{data.attempt?.startedAt ? new Date(data.attempt.startedAt).toLocaleString() : '—'}</span></p>
                  {data.attempt?.score != null && <p><span className="text-slate-500">Score:</span> <span className="font-semibold text-slate-100">{data.attempt.score}</span></p>}
                </CardBody>
              </Card>
              <Card className="border-slate-800 bg-slate-900">
                <CardHeader title="Monitor Actions" subtitle="Audit trail for this student" />
                <CardBody className="max-h-60 overflow-y-auto p-0">
                  {data.actions.length === 0 ? (
                    <p className="px-4 py-4 text-center text-xs text-slate-600">No actions yet.</p>
                  ) : (
                    <ul className="divide-y divide-slate-800">
                      {data.actions.map((a) => (
                        <li key={a.id} className="px-4 py-2.5 text-xs">
                          <p className="font-medium text-slate-200">{a.action} <span className="text-slate-500">· {new Date(a.createdAt).toLocaleTimeString()}</span></p>
                          {a.reason && <p className="mt-0.5 text-slate-400">{a.reason}</p>}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>
        </>
      )}

      {/* Pause */}
      <Modal open={pauseOpen} onClose={() => setPauseOpen(false)} title={`Pause ${data?.identity.studentCode ?? ''}`}>
        <div className="space-y-4">
          <Select label="Duration" value={pauseDuration} onChange={(e) => setPauseDuration(e.target.value)} options={PAUSE_PRESETS} />
          {pauseDuration === 'custom' && (
            <Input label="Custom duration (seconds)" type="number" min={5} value={pauseCustom} onChange={(e) => setPauseCustom(e.target.value)} />
          )}
          <Textarea label="Reason (required, logged)" required rows={2} placeholder="e.g. Phone-like object detected — verification required" value={pauseReason} onChange={(e) => setPauseReason(e.target.value)} />
          <p className="text-xs text-slate-500">The server enforces the pause — the student client cannot override it. Pause time does not count against the exam clock.</p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPauseOpen(false)}>Cancel</Button>
            <Button onClick={() => act('pause', { durationSeconds: effectiveDuration, reason: pauseReason })} loading={busy} disabled={pauseReason.length < 3}>
              Pause for {effectiveDuration >= 60 ? `${Math.round(effectiveDuration / 60)} min` : `${effectiveDuration}s`}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Resume */}
      <Modal open={resumeOpen} onClose={() => setResumeOpen(false)} title="Resume exam">
        <div className="space-y-4">
          <Textarea label="Reason (required, logged)" required rows={2} value={resumeReason} onChange={(e) => setResumeReason(e.target.value)} placeholder="e.g. Verification complete" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setResumeOpen(false)}>Cancel</Button>
            <Button variant="success" onClick={() => act('resume', { reason: resumeReason })} loading={busy} disabled={resumeReason.length < 3}>Resume exam</Button>
          </div>
        </div>
      </Modal>

      {/* Terminate */}
      <Modal open={terminateOpen} onClose={() => setTerminateOpen(false)} title="Terminate exam" wide>
        <div className="space-y-4">
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            This will <strong>permanently end</strong> {data?.identity.name}'s attempt. Answers will be locked and submission blocked.
            This action cannot be casually undone and is recorded in the audit log.
          </div>
          <Textarea label="Reason (required, logged)" required rows={2} value={terminateReason} onChange={(e) => setTerminateReason(e.target.value)} placeholder="e.g. Confirmed unauthorized materials" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setTerminateOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => act('terminate', { reason: terminateReason })} loading={busy} disabled={terminateReason.length < 3}>Terminate exam</Button>
          </div>
        </div>
      </Modal>

      {/* Message */}
      <Modal open={messageOpen} onClose={() => setMessageOpen(false)} title="Send message">
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {QUICK_MESSAGES.map((m) => (
              <button key={m} type="button" onClick={() => setMessage(m)} className="rounded-full border border-slate-300 px-3 py-1 text-xs hover:border-indigo-400 hover:bg-indigo-50">
                {m.length > 42 ? `${m.slice(0, 42)}…` : m}
              </button>
            ))}
          </div>
          <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Type a custom message…" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setMessageOpen(false)}>Cancel</Button>
            <Button onClick={() => act('message', { content: message })} loading={busy} disabled={!message.trim()}>Send</Button>
          </div>
        </div>
      </Modal>

      {/* Flag */}
      <Modal open={flagOpen} onClose={() => setFlagOpen(false)} title="Flag incident">
        <div className="space-y-3">
          <Textarea rows={3} value={flagNote} onChange={(e) => setFlagNote(e.target.value)} placeholder="Describe the incident…" />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setFlagOpen(false)}>Cancel</Button>
            <Button onClick={() => act('flag', { note: flagNote })} loading={busy} disabled={!flagNote.trim()}>Flag student</Button>
          </div>
        </div>
      </Modal>
    </>
  );
}