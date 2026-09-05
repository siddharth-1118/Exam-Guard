import { computeScore, gradeAnswer, type GradableQuestion } from '../src/scoring';

const q = (over: Partial<GradableQuestion>): GradableQuestion => ({
  id: over.id ?? 'q1',
  type: 'SINGLE_CHOICE',
  marks: 1,
  negativeMarks: 0.25,
  options: [],
  ...over,
});

const opts = (correct: string[], all: string[]) =>
  all.map((id, i) => ({ id, text: id, isCorrect: correct.includes(id), order: i }));

describe('gradeAnswer', () => {
  it('grades single choice', () => {
    const question = q({ options: opts(['b'], ['a', 'b', 'c', 'd']) });
    expect(gradeAnswer(question, 'b').correct).toBe(true);
    expect(gradeAnswer(question, 'b').earned).toBe(1);
    expect(gradeAnswer(question, 'a').correct).toBe(false);
    expect(gradeAnswer(question, 'a').earned).toBe(-0.25);
  });

  it('grades true/false as single choice', () => {
    const question = q({ type: 'TRUE_FALSE', options: opts(['true'], ['true', 'false']) });
    expect(gradeAnswer(question, 'true').correct).toBe(true);
    expect(gradeAnswer(question, 'false').correct).toBe(false);
  });

  it('grades multiple choice all-or-nothing', () => {
    const question = q({
      type: 'MULTIPLE_CHOICE',
      marks: 2,
      options: opts(['a', 'c'], ['a', 'b', 'c']),
    });
    expect(gradeAnswer(question, ['a', 'c']).earned).toBe(2);
    expect(gradeAnswer(question, ['a']).correct).toBe(false);
  });

  it('grades numeric with tolerance', () => {
    const question = q({
      type: 'NUMERIC',
      options: opts(['42'], ['42']),
      metadata: { tolerance: 0.5 },
    });
    expect(gradeAnswer(question, 42.3).correct).toBe(true);
    expect(gradeAnswer(question, 44).correct).toBe(false);
  });

  it('leaves manual types ungraded', () => {
    const question = q({ type: 'CODE', options: [] });
    const result = gradeAnswer(question, 'console.log(1)');
    expect(result.autoGraded).toBe(false);
    expect(result.earned).toBe(0);
  });

  it('treats empty answer as unanswered', () => {
    const question = q({ options: opts(['a'], ['a', 'b']) });
    expect(gradeAnswer(question, null).correct).toBe(false);
    expect(gradeAnswer(question, '').correct).toBe(false);
  });
});

describe('computeScore', () => {
  const questions: GradableQuestion[] = [
    q({ id: 'q1', options: opts(['a'], ['a', 'b']) }),
    q({ id: 'q2', marks: 2, type: 'MULTIPLE_CHOICE', options: opts(['x', 'y'], ['x', 'y', 'z']) }),
    q({ id: 'q3', type: 'NUMERIC', options: opts(['10'], ['10']) }),
    q({ id: 'q4', type: 'CODE', marks: 5, options: [] }), // manual
  ];

  it('computes score with negative marking', () => {
    const summary = computeScore(
      questions,
      [
        { questionId: 'q1', value: 'a' }, // +1
        { questionId: 'q2', value: ['x', 'y'] }, // +2
        { questionId: 'q3', value: null }, // unanswered
        { questionId: 'q4', value: 'code' }, // manual, pending
      ],
    );
    expect(summary.score).toBe(3);
    expect(summary.maxScore).toBe(9);
    expect(summary.correct).toBe(2);
    expect(summary.incorrect).toBe(0);
    expect(summary.unanswered).toBe(1);
    expect(summary.graded).toBe(false);
    expect(summary.percentage).toBeNull();
  });

  it('applies negative marks and floors at zero', () => {
    const summary = computeScore(
      [q({ id: 'q1', options: opts(['a'], ['a', 'b']) }), q({ id: 'q2', options: opts(['a'], ['a', 'b']) })],
      [
        { questionId: 'q1', value: 'b' }, // -0.25
        { questionId: 'q2', value: 'b' }, // -0.25
      ],
    );
    expect(summary.score).toBe(0); // floored
    expect(summary.incorrect).toBe(2);
  });

  it('can disable negative marking', () => {
    const summary = computeScore(
      [q({ id: 'q1', options: opts(['a'], ['a', 'b']) })],
      [{ questionId: 'q1', value: 'b' }],
      false,
    );
    expect(summary.score).toBe(0);
  });
});