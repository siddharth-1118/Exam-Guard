import type { AiEventType, RiskLevel } from '@examguard/types';

/**
 * Configurable risk scoring engine (spec §23).
 * - Weights are configurable per exam (riskWeights snapshot stored on the attempt).
 * - Events decay over time so transient noise does not compound into a false CRITICAL.
 * - The score is context for humans — never proof of misconduct.
 */

export interface RiskWeights {
  FACE_MISSING: number;
  MULTIPLE_FACES: number;
  PHONE_DETECTED: number;
  BOOK_DETECTED: number;
  PAPER_DETECTED: number;
  SECOND_PERSON: number;
  CAMERA_BLOCKED: number;
  LOOKING_AWAY: number;
  UNAUTHORIZED_OBJECT: number;
  ENVIRONMENT_CHANGE: number;
  FACE_PARTIALLY_VISIBLE: number;
  FOCUS_LOSS: number;
}

export const DEFAULT_RISK_WEIGHTS: RiskWeights = {
  FACE_MISSING: 20,
  MULTIPLE_FACES: 50,
  PHONE_DETECTED: 70,
  BOOK_DETECTED: 50,
  PAPER_DETECTED: 40,
  SECOND_PERSON: 70,
  CAMERA_BLOCKED: 60,
  LOOKING_AWAY: 10,
  UNAUTHORIZED_OBJECT: 55,
  ENVIRONMENT_CHANGE: 25,
  FACE_PARTIALLY_VISIBLE: 15,
  FOCUS_LOSS: 15,
};

export const RISK_LEVEL_BANDS: Array<{ max: number; level: RiskLevel }> = [
  { max: 29, level: 'NORMAL' },
  { max: 59, level: 'LOW_CONCERN' },
  { max: 79, level: 'SUSPICIOUS' },
  { max: 100, level: 'CRITICAL' },
];

export function riskLevelForScore(score: number): RiskLevel {
  const clamped = Math.max(0, Math.min(100, score));
  for (const band of RISK_LEVEL_BANDS) {
    if (clamped <= band.max) return band.level;
  }
  return 'CRITICAL';
}

export interface RiskEventInput {
  eventType: AiEventType | 'FOCUS_LOSS';
  confidence: number; // 0..1
  timestamp: number; // epoch ms
  weight?: number; // override
}

export interface RiskEvaluation {
  score: number; // 0..100
  level: RiskLevel;
  events: Array<{ eventType: string; weight: number; at: number }>;
}

/**
 * Accumulates risk for a single attempt.
 * Decay: score halves over `halfLifeMs` (default 10 min) of inactivity.
 * Repeat suppression: same event type within `repeatWindowMs` (default 60s)
 * contributes at reduced weight (25%) to avoid stacking.
 */
export class RiskTracker {
  private current = 0;
  private lastAt = 0;
  private readonly events: Array<{ eventType: string; weight: number; at: number }> = [];
  private readonly lastEventByType = new Map<string, number>();

  constructor(
    private readonly weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
    private readonly halfLifeMs = 600_000,
    private readonly repeatWindowMs = 60_000,
  ) {}

  add(input: RiskEventInput): RiskEvaluation {
    const now = input.timestamp;
    if (this.lastAt > 0 && now > this.lastAt) {
      const elapsed = now - this.lastAt;
      this.current *= Math.pow(0.5, elapsed / this.halfLifeMs);
    }
    this.lastAt = now;

    const baseWeight =
      input.weight ?? (this.weights[input.eventType as keyof RiskWeights] ?? 10);
    const lastSame = this.lastEventByType.get(input.eventType) ?? -Infinity;
    const repeat = now - lastSame < this.repeatWindowMs;
    this.lastEventByType.set(input.eventType, now);

    // Confidence-gated: low-confidence events contribute less than full weight.
    const confidenceFactor = 0.5 + 0.5 * Math.min(1, Math.max(0, input.confidence));
    const weight = Math.round(baseWeight * confidenceFactor * (repeat ? 0.25 : 1));

    this.current = Math.max(0, Math.min(100, this.current + weight));
    this.events.push({ eventType: input.eventType, weight, at: now });

    return { score: Math.round(this.current), level: riskLevelForScore(this.current), events: [...this.events] };
  }

  score(): number {
    return Math.round(this.current);
  }
}

export function evaluateRisk(
  inputs: RiskEventInput[],
  weights: RiskWeights = DEFAULT_RISK_WEIGHTS,
): RiskEvaluation {
  const tracker = new RiskTracker(weights);
  let last: RiskEvaluation = { score: 0, level: 'NORMAL', events: [] };
  for (const input of inputs) {
    last = tracker.add(input);
  }
  return last;
}