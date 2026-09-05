import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge, call } from './lib/bridge';
import { LoginScreen } from './screens/LoginScreen';
import { ExamListScreen } from './screens/ExamListScreen';
import { PreflightScreen } from './screens/PreflightScreen';
import { ExamScreen } from './screens/ExamScreen';
import type {
  AppInfo,
  AssignedExam,
  RendererAttemptState,
  UserProfile,
} from './shared/types';

type Phase = 'boot' | 'login' | 'exams' | 'preflight' | 'exam' | 'done';

export default function App() {
  const [phase, setPhase] = useState<Phase>('boot');
  const [user, setUser] = useState<UserProfile | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [selectedExam, setSelectedExam] = useState<AssignedExam | null>(null);
  const [attemptState, setAttemptState] = useState<RendererAttemptState>({
    status: 'idle',
    attempt: null,
    blocked: false,
  });
  const [consent, setConsent] = useState<Record<string, unknown> | null>(null);
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState({ pending: 0, online: true });
  const [secureMode, setSecureMode] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);
  const exitCleanupRef = useRef<(() => void) | null>(null);
  // Phase ref so event handlers never navigate the shell out of an active exam
  // when a late/duplicate session push arrives (e.g. tryRestore resolving).
  const phaseNavRef = useRef<Phase>('boot');
  phaseNavRef.current = phase;

  useEffect(() => {
    const b = bridge();
    const unsubs = [
      b.onSession((u) => {
        setUser(u);
        // A session/identity push only moves a *fresh* shell to the exam list.
        // Never yank the student out of preflight/exam (mid-attempt) — the
        // ExamScreen reacts to attempt pushes itself.
        const cur = phaseNavRef.current;
        if (u && (cur === 'boot' || cur === 'login' || cur === 'done')) setPhase('exams');
      }),
      b.onAttempt((state) => {
        setAttemptState(state);
        if (state.status === 'submitted' || state.status === 'terminated') {
          // let the exam screen tear down streams, then move to done
          setPhase('exam');
        }
      }),
      b.onNetwork((o) => setOnline(o)),
      b.onQueue((q) => setQueue(q)),
      b.onSecureMode((active) => setSecureMode(active)),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  // boot: load app info + session
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const b = bridge();
        const info = await b.getAppInfo();
        if (!mounted) return;
        setAppInfo(info);
        const status = await b.authStatus();
        if (!mounted) return;
        if (status.loggedIn && status.user) {
          setUser(status.user);
          setPhase('exams');
        } else {
          setPhase('login');
        }
      } catch (err) {
        if (mounted) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleLogin = useCallback(async (email: string, password: string) => {
    const u = await call(() => bridge().login(email, password).then((r) => r.user));
    setUser(u);
    setPhase('exams');
  }, []);

  const handleLogout = useCallback(async () => {
    exitCleanupRef.current?.();
    exitCleanupRef.current = null;
    await call(() => bridge().logout());
    setUser(null);
    setSelectedExam(null);
    setPhase('login');
  }, []);

  const handleChooseExam = useCallback(async (exam: AssignedExam) => {
    const full = await call(() => bridge().getExam(exam.id));
    setSelectedExam(full);
    setPhase('preflight');
  }, []);

  const handleStart = useCallback(async (c: Record<string, unknown>) => {
    if (!selectedExam) return;
    await bridge().setExamMode(true);
    setConsent(c);
    setPhase('exam');
    // The exam screen calls startAttempt itself so it can show progress.
  }, [selectedExam]);

  const handleFinish = useCallback((cleanup?: () => void) => {
    exitCleanupRef.current = cleanup ?? null;
    setPhase('done');
  }, []);

  const backToExams = useCallback(async () => {
    await bridge().setExamMode(false);
    setSelectedExam(null);
    setPhase('exams');
  }, []);

  // -------------------------------------------------------------------------
  // E2E auto-drive (Phase 4B proof). The main process sets a sessionStorage
  // flag and reloads; this drives the REAL shell → exam flow so the real
  // ExamScreen / device controller / publisher path runs without manual UI.
  // Consent is granted for everything the exam requires (hardware is real).
  // -------------------------------------------------------------------------
  const e2eAutoStartedRef = useRef(false);
  // Live refs so the auto-drive loop never reads stale closure state.
  const userRef = useRef(user);
  userRef.current = user;
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const e2e = window.sessionStorage.getItem('__examguardE2E') === '1';
    if (!e2e || e2eAutoStartedRef.current) return;
    e2eAutoStartedRef.current = true;
    void (async () => {
      const waitFor = async (pred: () => boolean, what: string, timeoutMs = 45_000): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (!pred()) {
          if (Date.now() > deadline) {
            console.error(`[e2e-auto] timed out waiting for ${what}`);
            return false;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        return true;
      };
      const b = bridge();
      try {
        if (!(await waitFor(() => userRef.current !== null && phaseRef.current === 'exams', 'login/exams'))) return;
        let chosen: AssignedExam | null = null;
        for (let i = 0; i < 5 && !chosen; i += 1) {
          const exams = await b.listExams();
          chosen = exams.find((e) => e.status === 'OPEN') ?? null;
          if (!chosen) await new Promise((r) => setTimeout(r, 1_000));
        }
        if (!chosen) {
          console.error('[e2e-auto] no OPEN exam assigned');
          return;
        }
        console.log(`[e2e-auto] chosen exam ${chosen.id} status=${chosen.status}`);
        const full = await b.getExam(chosen.id);
        console.log(`[e2e-auto] got exam settings ${JSON.stringify(full.settings)}`);
        const settings = full.settings;
        const cameraReq = settings?.cameraRequired === true;
        const micReq = settings?.microphoneRequired === true;
        const screenReq = settings?.screenMonitoringRequired === true;
        await b.setExamMode(true);
        setSelectedExam(full);
        setConsent({
          camera: cameraReq,
          microphone: micReq,
          screen: screenReq,
          screenAccepted: screenReq,
          acceptedAt: new Date().toISOString(),
        });
        setPhase('exam');
        console.log('[e2e-auto] phase=exam consent granted');
      } catch (err) {
        console.error(`[e2e-auto] ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phase]);

  if (fatal) {
    return (
      <div className="center-card">
        <h1>ExamGuard</h1>
        <p className="error">Something went wrong: {fatal}</p>
        <p className="muted">Please restart the application. Your session is recoverable.</p>
      </div>
    );
  }

  if (phase === 'boot') {
    return (
      <div className="center-card">
        <h1>ExamGuard</h1>
        <p className="muted">Starting secure session…</p>
      </div>
    );
  }

  if (phase === 'login') {
    return <LoginScreen onLogin={handleLogin} />;
  }

  if (phase === 'exams') {
    return (
      <ExamListScreen
        user={user}
        online={online}
        onPick={handleChooseExam}
        onLogout={handleLogout}
      />
    );
  }

  if (phase === 'preflight' && selectedExam) {
    return (
      <PreflightScreen
        exam={selectedExam}
        online={online}
        onStart={handleStart}
        onBack={backToExams}
      />
    );
  }

  if (phase === 'exam' && selectedExam) {
    return (
      <ExamScreen
        exam={selectedExam}
        consent={consent ?? {}}
        attemptState={attemptState}
        online={online}
        queuePending={queue.pending}
        appInfo={appInfo}
        onFinish={handleFinish}
      />
    );
  }

  // done
  return (
    <div className="center-card">
      <h1>ExamGuard</h1>
      <h2>Session complete</h2>
      <p className="muted">
        All camera, microphone and screen capture have been stopped. You may close this window.
      </p>
      <button className="btn" onClick={() => void handleLogout()}>
        Sign out
      </button>
    </div>
  );
}
