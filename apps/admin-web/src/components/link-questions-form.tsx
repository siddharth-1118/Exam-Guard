'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Alert } from '@examguard/ui';
import { gate } from '@/lib/gate';

interface Question {
  id: string;
  type: string;
  text: string;
  marks: number;
  difficulty: string;
}

export function LinkQuestionsForm({ examId }: { examId: string }) {
  const router = useRouter();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/gate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/questions', method: 'GET' }),
    })
      .then((r) => r.json())
      .then((data) => setQuestions(Array.isArray(data) ? data : []))
      .catch(() => undefined);
  }, []);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const link = async () => {
    setBusy(true);
    setError(null);
    try {
      await gate(`/exams/${examId}/questions`, 'POST', { questionIds: selected });
      setSelected([]);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Linking failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-3 grid max-h-72 grid-cols-1 gap-2 overflow-y-auto md:grid-cols-2">
        {questions.map((q: Question) => {
          const checked = selected.includes(q.id);
          return (
            <button
              key={q.id}
              type="button"
              onClick={() => toggle(q.id)}
              aria-pressed={checked}
              className={`rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                checked ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white hover:border-indigo-300'
              }`}
            >
              <span className="mb-1 flex items-center gap-2">
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] uppercase text-slate-500">{q.type.replaceAll('_', ' ')}</span>
                <span className="text-slate-400">{q.marks} pt</span>
              </span>
              <span className="line-clamp-2 text-slate-700">{q.text}</span>
            </button>
          );
        })}
        {questions.length === 0 && <p className="text-sm text-slate-400">No questions in the bank yet — add them in the Question Bank page.</p>}
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={link} loading={busy} disabled={selected.length === 0}>
          Add {selected.length > 0 ? `${selected.length} ` : ''}to exam
        </Button>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </div>
  );
}