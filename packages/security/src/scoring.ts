import { AUTO_GRADABLE_QUESTION_TYPES } from '@examguard/types';
import type { QuestionType } from '@examguard/types';

/**
 * Scoring engine (server-authoritative, spec §32/§38).
 * Grading happens on the server from stored answers + question keys;
 * client-supplied scores are never trusted.
 */

export interface GradableQuestion {
  id: string;
  type: QuestionType;
  marks: number;
  negativeMarks: number;
  options?: Array<{ id: string; isCorrect: boolean; text?: string }>;
  metadata?: { tolerance?: number } | null; // NUMERIC tolerance
}

export type AnswerValue = string | string[] | number | boolean | null;

export interface AnswerInput {
  questionId: string;
  value: AnswerValue;
}

export interface GradedResult {
  questionId: string;
  correct: boolean;
  partial: boolean;
  earned: number;
  autoGraded: boolean;
}

function normalizeOptions(options?: Array<{ id: string; isCorrect: boolean; text?: string }>) {
  return options ?? [];
}

function isCorrectMulti(selected: string[], question: GradableQuestion): boolean {
  const opts = normalizeOptions(question.options);
  const correctIds = opts.filter((o) => o.isCorrect).map((o) => o.id).sort();
  const selectedIds = [...selected].sort();
  if (correctIds.length !== selectedIds.length) return false;
  return correctIds.every((id, i) => id === selectedIds[i]);
}

export function gradeAnswer(question: GradableQuestion, value: AnswerValue): GradedResult {
  const base: GradedResult = {
    questionId: question.id,
    correct: false,
    partial: false,
    earned: 0,
    autoGraded: AUTO_GRADABLE_QUESTION_TYPES.includes(question.type),
  };

  if (value === null || value === undefined || value === '') {
    return { ...base, correct: false, earned: 0 };
  }

  switch (question.type) {
    case 'SINGLE_CHOICE': {
      const correct = normalizeOptions(question.options).find((o) => o.isCorrect)?.id;
      const earned = value === correct ? question.marks : -question.negativeMarks;
      return { ...base, correct: value === correct, earned };
    }
    case 'TRUE_FALSE': {
      const options = normalizeOptions(question.options);
      if (options.length === 0) {
        // No answer-key options stored: grade on the literal 'true'/'false' value.
        const correct = String(value).toLowerCase() === 'true';
        return { ...base, correct, earned: correct ? question.marks : -question.negativeMarks };
      }
      const correct = options.find((o) => o.isCorrect)?.id;
      const earned = value === correct ? question.marks : -question.negativeMarks;
      return { ...base, correct: value === correct, earned };
    }
    case 'MULTIPLE_CHOICE': {
      const selected = Array.isArray(value) ? value : [];
      const correct = isCorrectMulti(selected, question);
      return { ...base, correct, earned: correct ? question.marks : -question.negativeMarks };
    }
    case 'NUMERIC': {
      const tolerance = question.metadata?.tolerance ?? 0.001;
      const correctIds = normalizeOptions(question.options)
        .filter((o) => o.isCorrect && o.text !== undefined)
        .map((o) => parseFloat(o.text as string));
      const parsed = typeof value === 'number' ? value : parseFloat(String(value));
      if (Number.isNaN(parsed) || correctIds.length === 0) {
        return { ...base, correct: false, earned: 0 };
      }
      const correct = correctIds.some((c) => Math.abs(c - parsed) <= tolerance);
      return { ...base, correct, earned: correct ? question.marks : -question.negativeMarks };
    }
    case 'SHORT_ANSWER': {
      const options = normalizeOptions(question.options);
      const correctTexts = options
        .filter((o) => o.isCorrect && o.text !== undefined)
        .map((o) => String(o.text).trim().toLowerCase());
      if (correctTexts.length === 0) {
        return base;
      }
      const studentText = String(value).trim().toLowerCase();
      const correct = correctTexts.includes(studentText);
      const earned = correct ? question.marks : -question.negativeMarks;
      return { ...base, autoGraded: true, correct, earned };
    }
    case 'LONG_ANSWER':
    case 'CODE':
      // Manual grading. Earned stays 0 until a grader records marks.
      return base;
    default:
      return base;
  }
}

export interface ScoreSummary {
  score: number;
  maxScore: number;
  correct: number;
  incorrect: number;
  unanswered: number;
  percentage: number | null; // null until all questions are graded
  graded: boolean;
  negativeMarkingEnabled: boolean;
}

export function computeScore(
  questions: GradableQuestion[],
  answers: AnswerInput[],
  negativeMarkingEnabled = true,
): ScoreSummary {
  const answerMap = new Map(answers.map((a) => [a.questionId, a.value]));
  let score = 0;
  let maxScore = 0;
  let correct = 0;
  let incorrect = 0;
  let unanswered = 0;
  let allGraded = true;

  for (const question of questions) {
    const value = answerMap.get(question.id) ?? null;
    const result = gradeAnswer(question, value);
    maxScore += question.marks;
    if (!result.autoGraded) {
      allGraded = false;
      continue;
    }
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      unanswered += 1;
      continue;
    }
    if (result.correct) {
      correct += 1;
      score += question.marks;
    } else {
      incorrect += 1;
      if (negativeMarkingEnabled) {
        score += result.earned; // negative for wrong auto-graded answers
      }
    }
  }

  score = Math.min(maxScore, Math.max(0, Math.round(score * 1000) / 1000));

  return {
    score,
    maxScore,
    correct,
    incorrect,
    unanswered,
    percentage: allGraded && maxScore > 0 ? Math.round((score / maxScore) * 100) : null,
    graded: allGraded,
    negativeMarkingEnabled,
  };
}