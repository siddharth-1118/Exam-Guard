import { computeScore, gradeAnswer, type GradableQuestion } from '@examguard/security';

describe('Checkpoint 12 — Grading & Results', () => {
  const singleChoiceQ: GradableQuestion = {
    id: 'q-single',
    type: 'SINGLE_CHOICE',
    marks: 4,
    negativeMarks: 1,
    options: [
      { id: 'opt-1', isCorrect: true, text: 'Option A' },
      { id: 'opt-2', isCorrect: false, text: 'Option B' },
    ],
  };

  const multiChoiceQ: GradableQuestion = {
    id: 'q-multi',
    type: 'MULTIPLE_CHOICE',
    marks: 5,
    negativeMarks: 2,
    options: [
      { id: 'opt-a', isCorrect: true, text: 'A' },
      { id: 'opt-b', isCorrect: true, text: 'B' },
      { id: 'opt-c', isCorrect: false, text: 'C' },
    ],
  };

  const trueFalseQ: GradableQuestion = {
    id: 'q-tf',
    type: 'TRUE_FALSE',
    marks: 2,
    negativeMarks: 0.5,
    options: [
      { id: 'opt-true', isCorrect: true, text: 'true' },
      { id: 'opt-false', isCorrect: false, text: 'false' },
    ],
  };

  const numericQ: GradableQuestion = {
    id: 'q-num',
    type: 'NUMERIC',
    marks: 3,
    negativeMarks: 1,
    options: [{ id: 'opt-num', isCorrect: true, text: '42.5' }],
    metadata: { tolerance: 0.1 },
  };

  const shortAnsQ: GradableQuestion = {
    id: 'q-short',
    type: 'SHORT_ANSWER',
    marks: 3,
    negativeMarks: 1,
    options: [{ id: 'opt-s1', isCorrect: true, text: 'Paris' }],
  };

  const essayQ: GradableQuestion = {
    id: 'q-essay',
    type: 'LONG_ANSWER',
    marks: 10,
    negativeMarks: 0,
  };

  it('grades SINGLE_CHOICE correctly with positive and negative marks', () => {
    const correctRes = gradeAnswer(singleChoiceQ, 'opt-1');
    expect(correctRes.correct).toBe(true);
    expect(correctRes.earned).toBe(4);

    const wrongRes = gradeAnswer(singleChoiceQ, 'opt-2');
    expect(wrongRes.correct).toBe(false);
    expect(wrongRes.earned).toBe(-1);
  });

  it('grades MULTIPLE_CHOICE correctly requiring all correct options', () => {
    const correctRes = gradeAnswer(multiChoiceQ, ['opt-a', 'opt-b']);
    expect(correctRes.correct).toBe(true);
    expect(correctRes.earned).toBe(5);

    const partialRes = gradeAnswer(multiChoiceQ, ['opt-a']);
    expect(partialRes.correct).toBe(false);
    expect(partialRes.earned).toBe(-2);
  });

  it('grades TRUE_FALSE correctly', () => {
    const res = gradeAnswer(trueFalseQ, 'opt-true');
    expect(res.correct).toBe(true);
    expect(res.earned).toBe(2);
  });

  it('grades NUMERIC with tolerance', () => {
    const exact = gradeAnswer(numericQ, 42.5);
    expect(exact.correct).toBe(true);

    const withinTol = gradeAnswer(numericQ, 42.55);
    expect(withinTol.correct).toBe(true);

    const outsideTol = gradeAnswer(numericQ, 43.0);
    expect(outsideTol.correct).toBe(false);
  });

  it('grades SHORT_ANSWER using text option keys case-insensitively', () => {
    const correct = gradeAnswer(shortAnsQ, 'paris');
    expect(correct.correct).toBe(true);
    expect(correct.earned).toBe(3);

    const wrong = gradeAnswer(shortAnsQ, 'London');
    expect(wrong.correct).toBe(false);
    expect(wrong.earned).toBe(-1);
  });

  it('leaves LONG_ANSWER as manual (autoGraded = false)', () => {
    const res = gradeAnswer(essayQ, 'This is an essay response');
    expect(res.autoGraded).toBe(false);
    expect(res.earned).toBe(0);
  });

  it('computes total score and bounds score between 0 and maxScore', () => {
    const questions = [singleChoiceQ, multiChoiceQ, trueFalseQ, numericQ];
    const answers = [
      { questionId: 'q-single', value: 'opt-1' }, // +4
      { questionId: 'q-multi', value: 'opt-c' },   // -2
      { questionId: 'q-tf', value: 'opt-true' },  // +2
      { questionId: 'q-num', value: 42.5 },       // +3
    ];

    const summary = computeScore(questions, answers, true);
    expect(summary.maxScore).toBe(14);
    expect(summary.score).toBe(7); // 4 - 2 + 2 + 3 = 7
    expect(summary.correct).toBe(3);
    expect(summary.incorrect).toBe(1);
    expect(summary.unanswered).toBe(0);
    expect(summary.score).toBeGreaterThanOrEqual(0);
    expect(summary.score).toBeLessThanOrEqual(summary.maxScore);
  });

  it('handles negative marking disabled', () => {
    const questions = [singleChoiceQ, multiChoiceQ];
    const answers = [
      { questionId: 'q-single', value: 'opt-2' }, // wrong -> 0 when negative marking disabled
      { questionId: 'q-multi', value: ['opt-a', 'opt-b'] }, // +5
    ];

    const summary = computeScore(questions, answers, false);
    expect(summary.score).toBe(5);
  });
});
