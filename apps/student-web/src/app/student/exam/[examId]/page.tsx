'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardBody, Checkbox, Input, Textarea, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

// ---------------------------------------------------------------------------
// Types (mirror of API DTOs)
// ---------------------------------------------------------------------------

interface Attempt {
  id: string;
  examId: string;
  examName: string;
  status: string;
  remainingMs: number;
  paused: boolean;
  questionCount: number;
  answeredCount: number;
  score: number | null;
}

interface Question {
  id: string;
  type: string;
  text: string;
  marks: number;
  difficulty: string;
  options: Array<{ id: string; text: string; order: number }>;
}

interface StartResponse {
  attempt: Attempt;
  questions: Question[];
}

interface ExamWithSettings {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  _count?: { questions: number };
  settings: {
    cameraRequired: boolean;
    microphoneRequired: boolean;
    screenMonitoringRequired: boolean;
    identityVerificationRequired: boolean;
    aiProctoringEnabled: boolean;
    clipboardPolicy: string;
    fullScreenPolicy: string;
    evidencePolicy: string;
    retentionDays: number;
  } | null;
}

type Phase = 'loading' | 'intro' | 'running' | 'submitted' | 'error';

const formatMs = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export default function ExamPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = use(params);
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [exam, setExam] = useState<ExamWithSettings | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [consent, setConsent] = useState(false);
  const [offline, setOffline] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);

  // ---- Runner state ----
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pauseReason, setPauseReason] = useState<string>('Your exam has been paused by the monitor.');
  const [notice, setNotice] = useState<string | null>(null);
  const [submittedInfo, setSubmittedInfo] = useState<Attempt | null>(null);

  const answersRef = useRef(answers);
  answersRef.current = answers;
  const remainingRef = useRef(remaining);
  const autoSubmittedRef = useRef(false);
  const dirtyRef = useRef<Set<string>>(new Set());

  // -------------------------------------------------------------------------
  // Load exam
  // -------------------------------------------------------------------------

  useEffect(() => {
    void (async () => {
      try {
        const examData = await gate<ExamWithSettings>(`/exams/${examId}`, 'GET');
        setExam(examData);
        setPhase('intro');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load exam');
        setPhase('error');
      }
    })();
  }, [examId]);

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  const startExam = async () => {
    setError(null);
    try {
      const res = await gate<StartResponse>('/attempts', 'POST', {
        examId,
        consent: {
          version: '2026-09-01',
          camera: true,
          microphone: true,
          screen: true,
          acceptedAt: new Date().toISOString(),
        },
      });
      setAttempt(res.attempt);
      setQuestions(res.questions);
      setRemaining(res.attempt.remainingMs);
      setPaused(false);
      setPhase('running');
      window.scrollTo(0, 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to start exam');
    }
  };

  // -------------------------------------------------------------------------
  // Timer + heartbeat (server-authoritative — local clock only drives the UI)
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== 'running') return;
    const tick = setInterval(() => {
      setRemaining((r) => {
        const next = r - 1000;
        if (next <= 0) {
          clearInterval(tick);
          void doSubmit(true);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (phase !== 'running') return;
    const beat = setInterval(() => {
      void (async () => {
        if (!attempt) return;
        try {
          const res = await gate<Attempt>(`/attempts/${attempt.id}/heartbeat`, 'POST');
          syncFromServer(res);
          if (res.status === 'AUTO_SUBMITTED' || res.status === 'SUBMITTED') {
            setSubmittedInfo(res);
            setPhase('submitted');
          }
        } catch {
          // transient failure — retry on next beat
        }
      })();
    }, 15_000);
    return () => clearInterval(beat);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, attempt?.id]);

  const syncFromServer = (a: Attempt) => {
    setRemaining(a.remainingMs);
    setPaused(a.paused);
  };

  // Network awareness
  useEffect(() => {
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Answer save (autosave — server remains authoritative)
  // -------------------------------------------------------------------------

  const persistAnswer = useCallback(
    async (questionId: string, value: unknown) => {
      if (!attempt) return;
      try {
        const res = await gate<{ savedAt: string; remainingMs: number }>(
          `/attempts/${attempt.id}/answers`,
          'POST',
          { questionId, value },
        );
        setRemaining(res.remainingMs);
        dirtyRef.current.delete(questionId);
        setSaved((prev) => {
          const next = new Set(prev);
          next.add(questionId);
          return next;
        });
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Save failed';
        if (/paused/i.test(message)) {
          setPauseReason(message);
          setPaused(true);
        } else if (/expired|locked/i.test(message)) {
          setNotice('Exam time has expired — submitting your answers.');
          void doSubmit(true);
        }
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [attempt?.id],
  );

  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const setAnswer = (questionId: string, value: unknown, immediate = false) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    dirtyRef.current.add(questionId);
    if (immediate) {
      if (debounceRef.current[questionId]) clearTimeout(debounceRef.current[questionId]);
      void persistAnswer(questionId, value);
      return;
    }
    // Debounce keystrokes for text answers; the periodic flush is the backstop.
    if (debounceRef.current[questionId]) clearTimeout(debounceRef.current[questionId]);
    debounceRef.current[questionId] = setTimeout(() => {
      void persistAnswer(questionId, answersRef.current[questionId]);
    }, 800);
  };

  const flushDirty = () => {
    const dirty = [...dirtyRef.current];
    for (const qid of dirty) {
      void persistAnswer(qid, answersRef.current[qid]);
    }
  };

  const isChoiceType = (t: string) => ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE'].includes(t);
  const choose = (question: Question, v: unknown) =>
    setAnswer(question.id, v, isChoiceType(question.type));

  // Periodic flush for text answers + flush when back online
  useEffect(() => {
    if (phase !== 'running') return;
    const flush = setInterval(flushDirty, 5_000);
    return () => clearInterval(flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    if (!offline) flushDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline]);

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  const doSubmit = async (auto: boolean) => {
    if (!attempt || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    setSubmitting(true);
    try {
      flushDirty();
      const res = await gate<Attempt>(`/attempts/${attempt.id}/submit`, 'POST');
      setSubmittedInfo(res);
      setPhase('submitted');
    } catch (err) {
      autoSubmittedRef.current = false;
      const message = err instanceof Error ? err.message : 'Submission failed';
      setNotice(message);
      if (!auto) setSubmitting(false);
    } finally {
      if (!auto) setSubmitting(false);
    }
  };

  const confirmAndSubmit = () => {
    setConfirmSubmit(false);
    void doSubmit(false);
  };

  // -------------------------------------------------------------------------
  // Render phases
  // -------------------------------------------------------------------------

  if (phase === 'loading') {
    return <div className="py-24 text-center text-slate-400">Loading exam…</div>;
  }

  if (phase === 'error') {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <Alert tone="danger">
          {error ?? 'Something went wrong. Your exam session is being recovered. Please wait.'}
        </Alert>
        <div className="mt-4"><Button variant="secondary" onClick={() => router.push('/student/dashboard')}>Back to dashboard</Button></div>
      </main>
    );
  }

  if (phase === 'intro' && exam) {
    const s = exam.settings;
    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <h1 className="text-2xl font-bold text-slate-900">{exam.name}</h1>
        {exam.description && <p className="mt-2 text-slate-600">{exam.description}</p>}
        <Card className="mt-6">
          <CardBody className="space-y-4">
            <div className="flex gap-6 text-sm">
              <div><p className="text-xs text-slate-400">Duration</p><p className="font-semibold">{exam.durationMinutes} minutes</p></div>
              <div><p className="text-xs text-slate-400">Questions</p><p className="font-semibold">{exam._count?.questions ?? '—'}</p></div>
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold">Instructions</h2>
              <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm text-slate-700">
                {exam.instructions ?? 'Read each question carefully. Submit before the timer expires; the server auto-submits at the deadline.'}
              </p>
            </div>
            <div>
              <h2 className="mb-2 text-sm font-semibold">This exam monitors</h2>
              <ul className="space-y-1 text-sm text-slate-700">
                {s?.cameraRequired && <li>• Your camera (live, for proctoring)</li>}
                {s?.microphoneRequired && <li>• Your microphone (audio level monitoring)</li>}
                {s?.screenMonitoringRequired && <li>• Your screen (screen monitoring)</li>}
                {s?.aiProctoringEnabled && <li>• AI-assisted suspicious-behavior detection (assistive only — human monitors decide)</li>}
                <li>• Clipboard: {s?.clipboardPolicy ?? 'BLOCK'} · Fullscreen: {s?.fullScreenPolicy ?? 'REQUIRED'}</li>
                <li>• Evidence recording: {s?.evidencePolicy ?? 'EVENT_ONLY'} · Retention {s?.retentionDays ?? 90} days</li>
              </ul>
              <p className="mt-2 text-xs text-slate-500">
                You will never be monitored without this disclosure. Recording only captures evidence around suspicious events by default.
              </p>
            </div>
            <Checkbox
              label="I understand what is monitored, I consent to the exam policy and privacy notice, and I will not attempt to cheat."
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            {error && <Alert tone="danger">{error}</Alert>}
            <Button className="w-full" disabled={!consent} onClick={startExam}>
              I consent — begin exam
            </Button>
            <p className="text-center text-xs text-slate-400">
              Web delivery is a fallback with weaker lockdown than the ExamGuard desktop app (see the policy this exam was created with).
            </p>
          </CardBody>
        </Card>
      </main>
    );
  }

  if (phase === 'running' && attempt) {
    const q = questions[current];
    const answered = (saved.size / Math.max(1, questions.length)) * 100;
    return (
      <main className="flex min-h-screen flex-col bg-slate-100">
        {/* Status bar */}
        <header className="sticky top-0 z-40 border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div>
              <p className="text-sm font-bold text-slate-900">{attempt.examName}</p>
              <p className="text-xs text-slate-400">
                Question {current + 1} of {questions.length} · {Math.round(answered)}% saved
              </p>
            </div>
            <div className="flex items-center gap-4">
              {offline && <Badge tone="red">offline — will sync</Badge>}
              {paused ? <Badge tone="yellow">paused</Badge> : <Badge tone="green">secure session active</Badge>}
              <span
                className={`rounded-lg px-3 py-1 font-mono text-lg font-bold tabular-nums ${
                  remaining < 60_000 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-800'
                }`}
                aria-live="polite"
              >
                {formatMs(remaining)}
              </span>
            </div>
          </div>
        </header>

        {/* Paused overlay (server-enforced: saves/heartbeats report paused state) */}
        {paused && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4" role="alertdialog" aria-label="Exam paused">
            <Card className="w-full max-w-md">
              <CardBody className="space-y-3 text-center">
                <div className="text-4xl">⏸</div>
                <h2 className="text-lg font-bold text-slate-900">EXAM PAUSED</h2>
                <p className="text-sm text-slate-600">Your examination has been temporarily paused by the examination monitor.</p>
                <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">Reason: {pauseReason}</p>
                <p className="text-xs text-slate-400">You cannot answer questions while paused. It will resume automatically when the monitor reopens it.</p>
              </CardBody>
            </Card>
          </div>
        )}

        <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-6">
          {q && (
            <Card>
              <CardBody>
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Badge tone="indigo">{q.type.replaceAll('_', ' ')}</Badge>
                    <span className="text-xs text-slate-400">{q.marks} pt</span>
                  </div>
                  <span className="text-xs text-slate-400">{saved.has(q.id) ? '✓ saved' : 'saving…'}</span>
                </div>
                <p className="mb-4 whitespace-pre-wrap text-base font-medium text-slate-900">{q.text}</p>
                <QuestionInput
                  question={q}
                  value={answers[q.id] ?? (q.type === 'MULTIPLE_CHOICE' ? [] : undefined)}
                  onChange={(v) => choose(q, v)}
                />
                {notice && <div className="mt-4"><Alert tone="warning">{notice}</Alert></div>}
              </CardBody>
            </Card>
          )}

          <div className="mt-6 flex items-center justify-between">
            <Button variant="secondary" disabled={current === 0} onClick={() => setCurrent((c) => Math.max(0, c - 1))}>
              ← Previous
            </Button>
            <div className="flex items-center gap-2">
              {questions.map((qq, i) => (
                <button
                  key={qq.id}
                  type="button"
                  aria-label={`Go to question ${i + 1}`}
                  onClick={() => setCurrent(i)}
                  className={`h-2.5 w-2.5 rounded-full ${
                    i === current ? 'bg-indigo-600' : saved.has(qq.id) ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                />
              ))}
            </div>
            {current < questions.length - 1 ? (
              <Button onClick={() => setCurrent((c) => Math.min(questions.length - 1, c + 1))}>Next →</Button>
            ) : (
              <Button onClick={() => setConfirmSubmit(true)}>Submit exam</Button>
            )}
          </div>
        </div>

        {confirmSubmit && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/70 p-4" role="alertdialog" aria-label="Confirm submission">
            <Card className="w-full max-w-md">
              <CardBody className="space-y-3">
                <h2 className="text-lg font-bold text-slate-900">Submit exam?</h2>
                <p className="text-sm text-slate-600">
                  You have answered <strong>{saved.size}</strong> of <strong>{questions.length}</strong> questions.
                  Submission is final — answers are locked once received.
                </p>
                {notice && <Alert tone="warning">{notice}</Alert>}
                <div className="flex justify-end gap-2 pt-2">
                  <Button variant="secondary" onClick={() => setConfirmSubmit(false)}>Keep working</Button>
                  <Button onClick={confirmAndSubmit} loading={submitting}>Submit now</Button>
                </div>
              </CardBody>
            </Card>
          </div>
        )}
      </main>
    );
  }

  // submitted
  return (
    <main className="mx-auto max-w-xl px-4 py-16 text-center">
      <div className="mb-4 text-5xl">✅</div>
      <h1 className="text-2xl font-bold text-slate-900">Submission received</h1>
      <p className="mt-2 text-slate-600">
        Your answers were synchronized and the secure session has ended. You may now close this page.
      </p>
      {submittedInfo && (
        <div className="mt-4 space-y-1 text-sm text-slate-500">
          <p>Status: {submittedInfo.status.replace('_', ' ')}</p>
          {submittedInfo.score != null && <p className="font-semibold text-slate-800">Score: {submittedInfo.score}</p>}
        </div>
      )}
      <div className="mt-6"><Button onClick={() => router.push('/student/dashboard')}>Back to dashboard</Button></div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Question input per type
// ---------------------------------------------------------------------------

function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const isMulti = question.type === 'MULTIPLE_CHOICE';
  const selected = (Array.isArray(value) ? value : []) as string[];

  const toggleMulti = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  // TRUE_FALSE without stored options
  const effectiveOptions =
    question.options.length > 0
      ? question.options
      : question.type === 'TRUE_FALSE'
        ? [
            { id: 'true', text: 'True', order: 1 },
            { id: 'false', text: 'False', order: 2 },
          ]
        : [];

  switch (question.type) {
    case 'SINGLE_CHOICE':
    case 'TRUE_FALSE':
      return (
        <div role="radiogroup" aria-label={question.text} className="space-y-2">
          {effectiveOptions.map((o) => (
            <label
              key={o.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors ${
                value === o.id ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
              }`}
            >
              <input
                type="radio"
                name={question.id}
                checked={value === o.id}
                onChange={() => onChange(o.id)}
                className="h-4 w-4 accent-indigo-600"
              />
              {o.text}
            </label>
          ))}
        </div>
      );
    case 'MULTIPLE_CHOICE':
      return (
        <div className="space-y-2">
          {question.options.map((o) => (
            <label
              key={o.id}
              className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors ${
                selected.includes(o.id) ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 hover:border-indigo-300'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggleMulti(o.id)}
                className="h-4 w-4 accent-indigo-600"
              />
              {o.text}
            </label>
          ))}
        </div>
      );
    case 'NUMERIC':
      return (
        <Input
          type="text"
          inputMode="decimal"
          placeholder="Your numeric answer"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'SHORT_ANSWER':
      return (
        <Textarea rows={3} placeholder="Your answer" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      );
    case 'LONG_ANSWER':
      return (
        <Textarea rows={8} placeholder="Your answer" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      );
    case 'CODE':
      return (
        <Textarea
          rows={10}
          className="font-mono"
          placeholder="Write your code here"
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    default:
      return null;
  }
}