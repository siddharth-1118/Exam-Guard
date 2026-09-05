'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card, CardBody, CardHeader, Input, PageHeader, Select, Spinner, Textarea, Alert, Checkbox } from '@examguard/ui';
import { gate } from '@/lib/gate';

interface Question {
  id: string;
  type: string;
  text: string;
  marks: number;
  difficulty: string;
  options?: Array<{ id: string; text: string; isCorrect: boolean }>;
}

const QUESTION_TYPES = [
  { value: 'SINGLE_CHOICE', label: 'Single choice' },
  { value: 'MULTIPLE_CHOICE', label: 'Multiple choice' },
  { value: 'TRUE_FALSE', label: 'True / False' },
  { value: 'SHORT_ANSWER', label: 'Short answer' },
  { value: 'LONG_ANSWER', label: 'Long answer' },
  { value: 'NUMERIC', label: 'Numeric' },
  { value: 'CODE', label: 'Code' },
];

const NEEDS_OPTIONS = ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'TRUE_FALSE', 'NUMERIC'];

export default function QuestionBankPage() {
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try {
      const data = await gate<Question[]>('/questions', 'GET');
      setQuestions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load questions');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <PageHeader
        title="Question Bank"
        description="Reusable questions for your exams (all seven supported types)."
        actions={<Button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Hide form' : '+ Add Question'}</Button>}
      />
      {error && <div className="mb-4"><Alert tone="danger">{error}</Alert></div>}
      {showForm && <QuestionForm onCreated={() => { setShowForm(false); void load(); }} />}
      <Card className="mt-6">
        <CardHeader title={`Questions (${questions?.length ?? 0})`} />
        <CardBody className="p-0">
          {questions === null ? (
            <div className="flex justify-center py-10"><Spinner /></div>
          ) : (
            <div className="divide-y divide-slate-100">
              {questions.map((q) => (
                <div key={q.id} className="flex items-start justify-between gap-4 px-5 py-4">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Badge tone="indigo">{q.type.replaceAll('_', ' ')}</Badge>
                      <Badge tone="slate">{q.marks} pt</Badge>
                      <span className="text-xs text-slate-400">{q.difficulty}</span>
                    </div>
                    <p className="text-sm text-slate-800">{q.text}</p>
                    {q.options && q.options.length > 0 && (
                      <p className="mt-1 text-xs text-slate-400">
                        {q.options.filter((o) => o.isCorrect).length} correct · {q.options.length} options
                      </p>
                    )}
                  </div>
                </div>
              ))}
              {questions.length === 0 && <p className="px-5 py-10 text-center text-sm text-slate-400">No questions yet.</p>}
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}

function QuestionForm({ onCreated }: { onCreated: () => void }) {
  const [type, setType] = useState('SINGLE_CHOICE');
  const [text, setText] = useState('');
  const [marks, setMarks] = useState('1');
  const [negativeMarks, setNegativeMarks] = useState('0');
  const [difficulty, setDifficulty] = useState('MEDIUM');
  const [options, setOptions] = useState<Array<{ text: string; isCorrect: boolean }>>([
    { text: '', isCorrect: true },
    { text: '', isCorrect: false },
    { text: '', isCorrect: false },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsOptions = NEEDS_OPTIONS.includes(type);
  const correctCount = options.filter((o) => o.isCorrect).length;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsOptions) {
        const filled = options.filter((o) => o.text.trim());
        if (type === 'SINGLE_CHOICE' && correctCount !== 1) {
          throw new Error('Exactly one option must be marked correct for single choice');
        }
        if (type === 'MULTIPLE_CHOICE' && correctCount < 1) {
          throw new Error('Mark at least one correct option');
        }
        if (filled.length < 2) throw new Error('Provide at least two options');
        await gate('/questions', 'POST', {
          type,
          text,
          marks: Number(marks),
          negativeMarks: Number(negativeMarks),
          difficulty,
          options: filled.map((o, i) => ({ ...o, order: i + 1 })),
        });
      } else {
        await gate('/questions', 'POST', {
          type,
          text,
          marks: Number(marks),
          negativeMarks: Number(negativeMarks),
          difficulty,
        });
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create question');
    } finally {
      setBusy(false);
    }
  };

  const setOption = (i: number, patch: Partial<{ text: string; isCorrect: boolean }>) =>
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));

  return (
    <Card>
      <CardHeader title="New question" />
      <CardBody className="space-y-4">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Select label="Type" value={type} onChange={(e) => setType(e.target.value)} options={QUESTION_TYPES} />
          <Input label="Marks" type="number" min={0} step="0.5" value={marks} onChange={(e) => setMarks(e.target.value)} />
          <Input label="Negative marks" type="number" min={0} step="0.25" value={negativeMarks} onChange={(e) => setNegativeMarks(e.target.value)} />
          <Select label="Difficulty" value={difficulty} onChange={(e) => setDifficulty(e.target.value)} options={[
            { value: 'EASY', label: 'Easy' },
            { value: 'MEDIUM', label: 'Medium' },
            { value: 'HARD', label: 'Hard' },
          ]} />
        </div>
        <Textarea label="Question text" rows={2} value={text} onChange={(e) => setText(e.target.value)} />

        {needsOptions && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Options — mark correct answer(s)</p>
            {options.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type={type === 'SINGLE_CHOICE' ? 'radio' : 'checkbox'}
                  name="correct-option"
                  checked={o.isCorrect}
                  onChange={() =>
                    type === 'SINGLE_CHOICE'
                      ? setOptions((prev) => prev.map((x, idx) => ({ ...x, isCorrect: idx === i })))
                      : setOption(i, { isCorrect: !o.isCorrect })
                  }
                  aria-label={`Option ${i + 1} correct`}
                  className="h-4 w-4 accent-indigo-600"
                />
                <Input value={o.text} placeholder={`Option ${i + 1}`} onChange={(e) => setOption(i, { text: e.target.value })} />
                {options.length > 2 && (
                  <Button variant="ghost" size="sm" onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}>✕</Button>
                )}
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setOptions((prev) => [...prev, { text: '', isCorrect: false }])}>
              + Add option
            </Button>
          </div>
        )}
        {type === 'CODE' && (
          <Input label="Language" value="" placeholder="e.g. java (metadata — manual grading)" disabled hint="Code questions are manually graded." />
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end">
          <Button onClick={submit} loading={busy} disabled={!text.trim()}>Save question</Button>
        </div>
      </CardBody>
    </Card>
  );
}