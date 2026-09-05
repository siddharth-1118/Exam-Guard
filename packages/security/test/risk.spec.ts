import { DEFAULT_RISK_WEIGHTS, RiskTracker, evaluateRisk, riskLevelForScore } from '../src/risk';

const t0 = 1_700_000_000_000;

describe('risk engine', () => {
  it('accumulates weights per event', () => {
    const r = new RiskTracker();
    r.add({ eventType: 'FACE_MISSING', confidence: 0.9, timestamp: t0 });
    const out = r.add({ eventType: 'PHONE_DETECTED', confidence: 0.95, timestamp: t0 + 5_000 });
    // FACE_MISSING 20 * (0.5+0.45) ≈ 19, PHONE 70 * 0.975 ≈ 68 → ~87
    expect(out.score).toBeGreaterThanOrEqual(80);
    expect(out.level).toBe('CRITICAL');
  });

  it('bands levels correctly', () => {
    expect(riskLevelForScore(10)).toBe('NORMAL');
    expect(riskLevelForScore(30)).toBe('LOW_CONCERN');
    expect(riskLevelForScore(60)).toBe('SUSPICIOUS');
    expect(riskLevelForScore(80)).toBe('CRITICAL');
    expect(riskLevelForScore(150)).toBe('CRITICAL');
    expect(riskLevelForScore(-5)).toBe('NORMAL');
  });

  it('decays score over time', () => {
    const r = new RiskTracker(DEFAULT_RISK_WEIGHTS, 600_000, 60_000);
    r.add({ eventType: 'CAMERA_BLOCKED', confidence: 1, timestamp: t0 }); // 60
    // After one half-life the residual is ~30, then +20 face missing ≈ 50
    const out = r.add({ eventType: 'FACE_MISSING', confidence: 1, timestamp: t0 + 600_000 });
    expect(out.score).toBeGreaterThanOrEqual(48);
    expect(out.score).toBeLessThan(60);
  });

  it('suppresses rapid repeats of the same event type', () => {
    const r = new RiskTracker();
    r.add({ eventType: 'LOOKING_AWAY', confidence: 1, timestamp: t0 }); // 10
    const out = r.add({ eventType: 'LOOKING_AWAY', confidence: 1, timestamp: t0 + 5_000 }); // repeat: weight 10*1*0.25 = 2.5 → rounds to 3
    expect(out.score).toBe(13);
  });

  it('gates weight by confidence', () => {
    const low = evaluateRisk([{ eventType: 'PHONE_DETECTED', confidence: 0.1, timestamp: t0 }]);
    const high = evaluateRisk([{ eventType: 'PHONE_DETECTED', confidence: 1.0, timestamp: t0 }]);
    expect(low.score).toBeLessThan(high.score);
  });

  it('supports custom weights (configurable per exam)', () => {
    const weights = { ...DEFAULT_RISK_WEIGHTS, PHONE_DETECTED: 10 };
    const out = evaluateRisk([{ eventType: 'PHONE_DETECTED', confidence: 1, timestamp: t0 }], weights);
    expect(out.score).toBe(10);
    expect(out.level).toBe('NORMAL');
  });
});