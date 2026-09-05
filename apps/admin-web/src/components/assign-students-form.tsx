'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Select, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

export function AssignStudentsForm({
  examId,
  students,
}: {
  examId: string;
  students: Array<{ id: string; email: string; firstName: string; lastName: string; studentCode: string }>;
}) {
  const router = useRouter();
  const [ids, setIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) =>
    setIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const assign = async () => {
    setBusy(true);
    setError(null);
    try {
      await gate(`/exams/${examId}/students`, 'POST', { studentIds: ids });
      setIds([]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        {students.map((s) => {
          const checked = ids.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => toggle(s.id)}
              aria-pressed={checked}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                checked
                  ? 'border-indigo-600 bg-indigo-600 text-white'
                  : 'border-slate-300 bg-white text-slate-600 hover:border-indigo-300'
              }`}
            >
              {s.firstName} {s.lastName} · {s.studentCode}
            </button>
          );
        })}
        {students.length === 0 && <p className="text-sm text-slate-400">No students exist yet. Add students in the Students section first.</p>}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={assign} loading={busy} disabled={ids.length === 0}>
          Assign {ids.length > 0 ? `(${ids.length})` : ''}
        </Button>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}