import { useEffect, useState } from 'react';
import { bridge, call } from '../lib/bridge';
import type { AssignedExam, UserProfile } from '../shared/types';

export function ExamListScreen({
  user,
  online,
  onPick,
  onLogout,
}: {
  user: UserProfile | null;
  online: boolean;
  onPick: (exam: AssignedExam) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const [exams, setExams] = useState<AssignedExam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const list = await call(() => bridge().listExams());
        if (mounted) setExams(list);
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : 'Could not load exams');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <strong>ExamGuard</strong>
          <span className="muted">
            {' '}
            — {user?.firstName} {user?.lastName}
          </span>
        </div>
        <div className="topbar-right">
          <span className={`dot ${online ? 'dot-green' : 'dot-red'}`} />
          <span className="muted">{online ? 'Online' : 'Offline'}</span>
          <button className="btn ghost" onClick={() => void onLogout()}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <h2>Your exams</h2>
        {error && <p className="error">{error}</p>}
        {loading && <p className="muted">Loading…</p>}
        {!loading && exams.length === 0 && (
          <p className="muted">You have no assigned exams right now.</p>
        )}
        <div className="card-grid">
          {exams.map((exam) => (
            <button key={exam.id} className="card exam-card" onClick={() => void onPick(exam)}>
              <div className="card-title">{exam.name}</div>
              {exam.description && <p className="muted">{exam.description}</p>}
              <div className="meta-row">
                <span className="chip">{exam.durationMinutes} min</span>
                <span className="chip chip-status">{exam.status}</span>
              </div>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
