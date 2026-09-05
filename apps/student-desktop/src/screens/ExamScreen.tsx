import { useEffect, useMemo, useRef, useState } from 'react';
import { bridge, call } from '../lib/bridge';
import { createBrowserExamEnv, type BrowserExamEnv } from '../media/devices';
import { setDebugPublisher, SfuPublisher, type PublisherState } from '../media/publisher';
import {
  createExamDeviceController,
  type DeviceKind,
  type ExamDeviceController,
  type ExamDeviceSnapshot,
} from '../shared/deviceController';
import type {
  AppInfo,
  AssignedExam,
  AttemptView,
  RendererAttemptState,
} from '../shared/types';

// ---------------------------------------------------------------------------
// Types (mirror of the API DTOs; answer VALUES follow the student-web wire
// format: option id for single/true-false, option-id array for multi, string
// for numeric/short/long/code.)
// ---------------------------------------------------------------------------

interface Question {
  id: string;
  type: string;
  text: string;
  marks: number;
  difficulty: string;
  options: Array<{ id: string; text: string; order: number }>;
}

const formatMs = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
};

export function ExamScreen({
  exam,
  consent,
  attemptState,
  online,
  queuePending,
  appInfo,
  onFinish,
}: {
  exam: AssignedExam;
  consent: Record<string, unknown>;
  attemptState: RendererAttemptState;
  online: boolean;
  queuePending: number;
  appInfo: AppInfo | null;
  onFinish: () => void;
}) {
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<AttemptView | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [current, setCurrent] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ended, setEnded] = useState<AttemptView | null>(null);

  // Devices to run during the exam — required by policy AND consented.
  const deviceKinds = useMemo<DeviceKind[]>(() => {
    const s = exam.settings;
    const kinds: DeviceKind[] = [];
    if (s?.cameraRequired && consent.camera) kinds.push('camera');
    if (s?.microphoneRequired && consent.microphone) kinds.push('microphone');
    if (s?.screenMonitoringRequired && consent.screen) kinds.push('screen');
    return kinds;
  }, [exam.settings, consent.camera, consent.microphone, consent.screen]);

  const envRef = useRef<BrowserExamEnv | null>(null);
  const deviceControllerRef = useRef<ExamDeviceController | null>(null);
  const [deviceSnap, setDeviceSnap] = useState<ExamDeviceSnapshot | null>(null);
  const publisherRef = useRef<SfuPublisher | null>(null);
  const [pubState, setPubState] = useState<PublisherState>('idle');
  const [pubKinds, setPubKinds] = useState<string[]>([]);

  const startedRef = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const dirtyRef = useRef<Set<string>>(new Set());
  const attemptRef = useRef<AttemptView | null>(attempt);
  attemptRef.current = attempt;
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  /** Start required camera/microphone once the attempt is ACTIVE (real media). */
  function ensureDevicesStarted(attemptId: string) {
    if (deviceControllerRef.current || deviceKinds.length === 0) return;
    const env = createBrowserExamEnv({
      report: (payload) => {
        void bridge().reportSensor(payload);
      },
      updateSession: (kind, status) => {
        void bridge().updateMediaSession({ kind, status });
      },
    });
    const controller = createExamDeviceController({ env, enabled: deviceKinds });
    controller.onStatus((snap) => setDeviceSnap(snap));
    envRef.current = env;
    deviceControllerRef.current = controller;

    // Phase 4B: publisher consumes the SAME env streams (never acquires its
    // own). It starts when the first required device is live and publishes
    // more kinds as they come up (publishLive on every status change).
    if (!publisherRef.current) {
      const publisher = new SfuPublisher({
        attemptId,
        getToken: () => bridge().getMediaToken(attemptId),
        stream: (kind) => envRef.current?.stream(kind) ?? null,
        report: (payload) => {
          void bridge().reportSensor(payload);
        },
        onState: (state, producers) => {
          setPubState(state);
          setPubKinds(producers.map((p) => p.kind));
        },
      });
      publisherRef.current = publisher;
      setDebugPublisher(publisher, deviceKinds);
    }
    controller.start();
  }

  /** Stop camera/microphone on submit/terminate — never left running. */
  function stopDevices() {
    publisherRef.current?.stop('manual');
    publisherRef.current = null;
    setDebugPublisher(null);
    setPubState('idle');
    deviceControllerRef.current?.stop();
    envRef.current?.dispose();
    deviceControllerRef.current = null;
    envRef.current = null;
  }

  // Start publishing once devices are live; publish each kind as it appears.
  useEffect(() => {
    const id = attemptRef.current?.id;
    if (!id || deviceKinds.length === 0 || !deviceSnap) return;
    const live = deviceKinds.filter((k) => deviceSnap[k] === 'on');
    if (live.length === 0) return;
    const pub = publisherRef.current;
    if (!pub) return;
    if (pub.stateValue === 'idle') {
      setPubState('connecting');
      void pub
        .start()
        .then(() => setPubState(pub.stateValue))
        .catch(() => setPubState('failed'));
    }
    void pub.publishLive().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceSnap, attempt]);

  // Release devices if the component unmounts for any reason.
  useEffect(() => stopDevices, []);

  // -------------------------------------------------------------------------
  // Start the attempt exactly once (server-authoritative timing returned).
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void (async () => {
      try {
        const res = await call(() =>
          bridge().startAttempt(exam.id, {
            consent: {
              version: '2026-09-01',
              acceptedAt: new Date().toISOString(),
              camera: Boolean(consent.camera),
              microphone: Boolean(consent.microphone),
              screen: Boolean(consent.screen),
            },
            deviceInfo: {
              os: appInfo?.platform ?? 'unknown',
              appVersion: appInfo?.appVersion ?? '0.0.0',
              arch: appInfo?.arch,
              osRelease: appInfo?.osRelease,
              client: 'student-desktop',
            },
          }),
        );
        setAttempt(res.attempt);
        setQuestions(res.questions as Question[]);
        setRemaining(res.attempt.remainingMs);
        setStarting(false);
        if (res.attempt.status === 'ACTIVE') ensureDevicesStarted(res.attempt.id);
      } catch (err) {
        setStartError(err instanceof Error ? err.message : 'Unable to start the exam');
        setStarting(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exam.id]);

  // -------------------------------------------------------------------------
  // Server state pushes (pause/terminate/auto-submit from the heartbeat loop)
  // -------------------------------------------------------------------------

  useEffect(() => {
    const server = attemptState.attempt;
    if (!server || !attemptRef.current) return;
    if (attemptState.blocked && !attemptState.pausedReason) {
      // Paused — keep UI functional but overlay blocks input below.
    }
    if (server.status === 'ACTIVE' || server.status === 'PAUSED') {
      setAttempt(server);
      setRemaining(server.remainingMs);
    }
    if (server.status === 'SUBMITTED' || server.status === 'AUTO_SUBMITTED' || server.status === 'TERMINATED') {
      setEnded(server);
      void finishSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptState]);

  // Local countdown display — the server's deadline remains authoritative; this
  // only renders the time between heartbeats.
  useEffect(() => {
    if (starting || ended) return;
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
  }, [starting, ended]);

  // Periodic flush of dirty (text) answers — answers go through the main
  // process outbox, which retries until the server acknowledges.
  useEffect(() => {
    if (starting || ended) return;
    const flush = setInterval(flushDirty, 5_000);
    return () => clearInterval(flush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starting, ended]);

  useEffect(() => {
    if (online) flushDirty();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  // A required device dropping mid-exam is a security EVENT (not an
  // accusation): inform the student and show recovery automatically.
  useEffect(() => {
    if (!deviceSnap) return;
    const down = deviceKinds.filter((k) => {
      const st = deviceSnap[k];
      return st === 'off' || st === 'error';
    });
    if (down.length > 0) {
      const KIND_LABEL = { camera: 'Camera', microphone: 'Microphone', screen: 'Screen capture' } as const;
      const label = down.map((k) => KIND_LABEL[k]).join(' and ');
      setNotice(`${label} ${down.length > 1 ? 'are' : 'is'} not available — monitoring paused until it reconnects.`);
    } else if (deviceKinds.length > 0) {
      setNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceSnap]);

  // -------------------------------------------------------------------------
  // Answers (same wire format as student-web; saved via the reliable outbox)
  // -------------------------------------------------------------------------

  const persistAnswer = (questionId: string, value: unknown) => {
    if (!attemptRef.current) return;
    bridge().saveAnswer(attemptRef.current.id, questionId, value).catch(() => {
      // Outbox retries; nothing to do here.
    });
    dirtyRef.current.delete(questionId);
    setSaved((prev) => new Set(prev).add(questionId));
  };

  const setAnswer = (questionId: string, value: unknown, immediate = false) => {
    setAnswers((prev) => ({ ...prev, [questionId]: value }));
    dirtyRef.current.add(questionId);
    if (immediate) {
      if (debounceRef.current[questionId]) clearTimeout(debounceRef.current[questionId]);
      persistAnswer(questionId, value);
      return;
    }
    if (debounceRef.current[questionId]) clearTimeout(debounceRef.current[questionId]);
    debounceRef.current[questionId] = setTimeout(() => {
      persistAnswer(questionId, answersRef.current[questionId]);
    }, 800);
  };

  function flushDirty() {
    for (const qid of dirtyRef.current) {
      persistAnswer(qid, answersRef.current[qid]);
    }
  }

  const isChoice = (t: string) => ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE'].includes(t);
  const choose = (q: Question, v: unknown) => setAnswer(q.id, v, isChoice(q.type));

  // -------------------------------------------------------------------------
  // Submit
  // -------------------------------------------------------------------------

  async function doSubmit(auto: boolean) {
    const a = attemptRef.current;
    if (!a || submitting) return;
    setSubmitting(true);
    try {
      flushDirty();
      const res = await call(() => bridge().submit(a.id));
      setEnded(res);
      await finishSession();
    } catch (err) {
      setSubmitting(false);
      const message = err instanceof Error ? err.message : 'Submission failed';
      if (/paused/i.test(message)) {
        setNotice('The exam is paused by the monitor — submission is locked until it resumes.');
      } else {
        setNotice(message);
      }
    }
  }

  /** Clean up session state and hand back to the app shell. */
  async function finishSession() {
    stopDevices();
    await bridge().setExamMode(false);
    onFinish();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (starting) {
    return (
      <div className="center-card">
        <h1>ExamGuard</h1>
        <p className="muted">Starting exam session…</p>
        {startError && <p className="error">{startError}</p>}
      </div>
    );
  }

  if (startError) {
    return (
      <div className="center-card">
        <h1>ExamGuard</h1>
        <p className="error">{startError}</p>
        <button className="btn" onClick={() => void finishSession()}>
          Back to exams
        </button>
      </div>
    );
  }

  if (ended || !attempt) {
    return (
      <div className="center-card">
        <h1>ExamGuard</h1>
        <h2>{ended?.status === 'TERMINATED' ? 'Exam terminated' : 'Submission received'}</h2>
        <p className="muted">
          {ended?.status === 'TERMINATED'
            ? 'The monitor ended this session. If you believe this is an error, contact your institution.'
            : 'Your answers were synchronized. The session has ended and you may close the app.'}
        </p>
        {ended?.score != null && <p className="score">Score: {ended.score}</p>}
        <button className="btn" onClick={() => void finishSession()}>
          Finish
        </button>
      </div>
    );
  }

  const q = questions[current];
  const blockedByPause = attempt.status === 'PAUSED' || attemptState.blocked;
  const answeredCount = saved.size;
  const progress = Math.round((answeredCount / Math.max(1, questions.length)) * 100);

  return (
    <div className="exam-shell">
      <header className="exam-header">
        <div>
          <div className="exam-title">{attempt.examName}</div>
          <div className="exam-sub">
            Question {current + 1} of {questions.length} · {answeredCount} saved · {progress}%
          </div>
        </div>
        <div className="exam-status-right">
          {!online && <span className="chip chip-warn">offline — will sync</span>}
          {queuePending > 0 && <span className="chip chip-warn">{queuePending} syncing</span>}
          {deviceKinds.includes('camera') && deviceSnap && (
            <span className={`chip ${deviceSnap.camera === 'on' ? 'chip-ok' : deviceSnap.camera === 'starting' ? '' : 'chip-warn'}`}>
              {deviceSnap.camera === 'on' ? 'Camera ●' : deviceSnap.camera === 'starting' ? 'Camera …' : deviceSnap.camera === 'error' ? 'Camera error' : 'Camera off'}
            </span>
          )}
          {deviceKinds.includes('microphone') && deviceSnap && (
            <span className={`chip ${deviceSnap.microphone === 'on' ? 'chip-ok' : deviceSnap.microphone === 'starting' ? '' : 'chip-warn'}`}>
              {deviceSnap.microphone === 'on' ? 'Mic ●' : deviceSnap.microphone === 'starting' ? 'Mic …' : deviceSnap.microphone === 'error' ? 'Mic error' : 'Mic off'}
            </span>
          )}
          {deviceKinds.includes('screen') && deviceSnap && (
            <span
              className={`chip ${deviceSnap.screen === 'on' ? 'chip-ok' : deviceSnap.screen === 'starting' ? '' : 'chip-warn'}`}
              title={deviceSnap.screen === 'on' ? 'Your entire display is being monitored' : undefined}
            >
              {deviceSnap.screen === 'on' ? 'Screen ●' : deviceSnap.screen === 'starting' ? 'Screen …' : deviceSnap.screen === 'error' ? 'Screen error' : 'Screen off'}
            </span>
          )}
          {pubState === 'publishing' && (
            <span className="chip chip-ok" title={`Live media link to the proctoring service (${pubKinds.join(', ')})`}>
              Media ●
            </span>
          )}
          {(pubState === 'connecting' || pubState === 'reconnecting') && (
            <span className="chip" title="Establishing the secure media link">
              {pubState === 'reconnecting' ? 'Media reconnecting…' : 'Media connecting…'}
            </span>
          )}
          {pubState === 'failed' && (
            <span className="chip chip-warn" title="The live media link could not be established — the exam continues but live monitoring is unavailable.">
              Media unavailable
            </span>
          )}
          {blockedByPause ? (
            <span className="chip chip-warn">paused</span>
          ) : (
            <span className="chip chip-ok">secure session active</span>
          )}
          <span className={`timer ${remaining < 60_000 ? 'timer-critical' : ''}`} aria-live="polite">
            {formatMs(remaining)}
          </span>
        </div>
      </header>

      {blockedByPause && (
        <div className="overlay" role="alertdialog" aria-label="Exam paused">
          <div className="overlay-card">
            <h2>EXAM PAUSED</h2>
            <p>Your examination has been paused by the monitor. You cannot answer questions right now.</p>
          </div>
        </div>
      )}

      <main className="exam-body">
        {q && (
          <section className="question-card">
            <div className="question-meta">
              <span className="chip">{q.type.replaceAll('_', ' ')}</span>
              <span className="chip">{q.marks} pt</span>
              <span className="muted small">{saved.has(q.id) ? '✓ saved' : 'saving…'}</span>
            </div>
            <h3 className="question-text">{q.text}</h3>
            <QuestionInput question={q} value={answers[q.id]} onChange={(v) => choose(q, v)} disabled={blockedByPause} />
            {notice && <p className="notice">{notice}</p>}
          </section>
        )}

        <footer className="exam-nav">
          <button className="btn ghost" disabled={current === 0} onClick={() => setCurrent((c) => c - 1)}>
            ← Previous
          </button>
          <div className="palette">
            {questions.map((qq, i) => (
              <button
                key={qq.id}
                aria-label={`Go to question ${i + 1}`}
                className={`palette-dot ${i === current ? 'palette-current' : saved.has(qq.id) ? 'palette-saved' : ''}`}
                onClick={() => setCurrent(i)}
              />
            ))}
          </div>
          {current < questions.length - 1 ? (
            <button className="btn" onClick={() => setCurrent((c) => c + 1)}>
              Next →
            </button>
          ) : (
            <button className="btn" onClick={() => setConfirmSubmit(true)}>
              Submit exam
            </button>
          )}
        </footer>
      </main>

      {confirmSubmit && (
        <div className="overlay" role="alertdialog" aria-label="Confirm submission">
          <div className="overlay-card">
            <h2>Submit exam?</h2>
            <p>
              You have answered <strong>{answeredCount}</strong> of <strong>{questions.length}</strong> questions.
              Submission is final — answers are locked once received.
            </p>
            {notice && <p className="notice">{notice}</p>}
            <div className="row-gap right">
              <button className="btn ghost" onClick={() => setConfirmSubmit(false)}>
                Keep working
              </button>
              <button className="btn" disabled={submitting} onClick={() => { setConfirmSubmit(false); void doSubmit(false); }}>
                Submit now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Question input per type (identical answer semantics to student-web)
// ---------------------------------------------------------------------------

function QuestionInput({
  question,
  value,
  onChange,
  disabled,
}: {
  question: Question;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled: boolean;
}) {
  const selected = (Array.isArray(value) ? value : []) as string[];
  const toggleMulti = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const effectiveOptions =
    question.options.length > 0
      ? question.options
      : question.type === 'TRUE_FALSE'
        ? [
            { id: 'true', text: 'True', order: 1 },
            { id: 'false', text: 'False', order: 2 },
          ]
        : [];

  if (question.type === 'SINGLE_CHOICE' || question.type === 'TRUE_FALSE') {
    return (
      <div role="radiogroup" aria-label={question.text} className="option-list">
        {effectiveOptions.map((o) => (
          <label key={o.id} className={`option-row ${value === o.id ? 'option-selected' : ''}`}>
            <input
              type="radio"
              name={question.id}
              disabled={disabled}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
            />
            {o.text}
          </label>
        ))}
      </div>
    );
  }
  if (question.type === 'MULTIPLE_CHOICE') {
    return (
      <div className="option-list">
        {question.options.map((o) => (
          <label key={o.id} className={`option-row ${selected.includes(o.id) ? 'option-selected' : ''}`}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(o.id)}
              onChange={() => toggleMulti(o.id)}
            />
            {o.text}
          </label>
        ))}
      </div>
    );
  }
  const str = (typeof value === 'string' ? value : '') as string;
  if (question.type === 'NUMERIC') {
    return (
      <input
        className="input"
        type="text"
        inputMode="decimal"
        disabled={disabled}
        placeholder="Your numeric answer"
        value={str}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (question.type === 'SHORT_ANSWER') {
    return (
      <textarea className="input" rows={3} disabled={disabled} placeholder="Your answer" value={str} onChange={(e) => onChange(e.target.value)} />
    );
  }
  if (question.type === 'LONG_ANSWER') {
    return (
      <textarea className="input" rows={8} disabled={disabled} placeholder="Your answer" value={str} onChange={(e) => onChange(e.target.value)} />
    );
  }
  if (question.type === 'CODE') {
    return (
      <textarea className="input mono" rows={10} disabled={disabled} placeholder="Write your code here" value={str} onChange={(e) => onChange(e.target.value)} />
    );
  }
  return null;
}
