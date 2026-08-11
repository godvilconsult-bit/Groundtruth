import { describe, it, expect } from 'vitest';
import {
  computeConfidence,
  CONFIDENCE_FORMULA_VERSION,
  type ConfidenceInputs,
} from './confidence.js';

const base: ConfidenceInputs = {
  collectorReputations: [1],
  bestGpsAccuracyM: 5,
  daysSinceLastVerified: 0,
  resurvey: null,
};

const withInputs = (o: Partial<ConfidenceInputs>) => computeConfidence({ ...base, ...o });

describe('confidence score', () => {
  it('stamps the formula version, because customers will ask which one produced a number', () => {
    expect(computeConfidence(base).formulaVersion).toBe(CONFIDENCE_FORMULA_VERSION);
  });

  it('always lands within [0,1]', () => {
    const extremes: ConfidenceInputs[] = [
      { ...base, collectorReputations: Array(500).fill(1), resurvey: { agreed: true } },
      { ...base, collectorReputations: [0], bestGpsAccuracyM: 10_000, daysSinceLastVerified: 99_999 },
      { ...base, collectorReputations: [1, 1, 1, 1, 1, 1, 1, 1], daysSinceLastVerified: -50 },
    ];
    for (const input of extremes) {
      const { score } = computeConfidence(input);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('scores zero with no observations at all', () => {
    expect(computeConfidence({ ...base, collectorReputations: [] }).score).toBe(0);
  });

  it('fits numeric(4,3) — at most three decimal places', () => {
    const { score } = withInputs({ collectorReputations: [0.731, 0.442], bestGpsAccuracyM: 17.3 });
    expect(String(score).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(3);
  });
});

describe('evidence: independent observations', () => {
  it('rises with each additional independent collector', () => {
    const one = withInputs({ collectorReputations: [1] }).score;
    const two = withInputs({ collectorReputations: [1, 1] }).score;
    const three = withInputs({ collectorReputations: [1, 1, 1] }).score;
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it('saturates, so volume cannot substitute for quality', () => {
    // The gain from the 9th observation must be far smaller than from the 2nd,
    // otherwise spamming visits becomes a rational way to manufacture confidence.
    const s = (n: number) => withInputs({ collectorReputations: Array(n).fill(1) }).score;
    const earlyGain = s(2) - s(1);
    const lateGain = s(9) - s(8);
    expect(lateGain).toBeLessThan(earlyGain / 10);
  });

  it('weights by collector reputation', () => {
    const proven = withInputs({ collectorReputations: [0.95] }).score;
    const trainee = withInputs({ collectorReputations: [0.2] }).score;
    expect(proven).toBeGreaterThan(trainee);
  });

  it('clamps out-of-range reputations rather than letting them distort the score', () => {
    const absurd = withInputs({ collectorReputations: [99] }).score;
    const perfect = withInputs({ collectorReputations: [1] }).score;
    expect(absurd).toBe(perfect);
  });

  it('treats one collector as one opinion regardless of visit count', () => {
    // Three visits by the same mapper is one opinion. The caller passes distinct
    // collectors; this documents the contract the QA pipeline must honour.
    const oneCollector = withInputs({ collectorReputations: [0.8] }).score;
    const threeCollectors = withInputs({ collectorReputations: [0.8, 0.8, 0.8] }).score;
    expect(threeCollectors).toBeGreaterThan(oneCollector);
  });
});

describe('GPS accuracy', () => {
  it('does not penalise accuracy at or below 5 m', () => {
    expect(withInputs({ bestGpsAccuracyM: 5 }).accuracyFactor).toBe(1);
    expect(withInputs({ bestGpsAccuracyM: 2 }).accuracyFactor).toBe(1);
  });

  it('degrades monotonically between 5 m and 50 m', () => {
    const factors = [5, 10, 20, 35, 50].map((m) => withInputs({ bestGpsAccuracyM: m }).accuracyFactor);
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i]!).toBeLessThan(factors[i - 1]!);
    }
  });

  it('floors at 0.3 rather than zero — a coarse fix is still evidence', () => {
    expect(withInputs({ bestGpsAccuracyM: 50 }).accuracyFactor).toBeCloseTo(0.3, 3);
    expect(withInputs({ bestGpsAccuracyM: 5000 }).accuracyFactor).toBeCloseTo(0.3, 3);
  });
});

describe('recency', () => {
  it('does not penalise a freshly verified feature', () => {
    expect(withInputs({ daysSinceLastVerified: 0 }).recencyFactor).toBe(1);
  });

  it('halves at the 540-day half-life', () => {
    expect(withInputs({ daysSinceLastVerified: 540 }).recencyFactor).toBeCloseTo(0.5, 2);
  });

  it('decays monotonically', () => {
    const factors = [0, 90, 365, 540, 1080].map(
      (d) => withInputs({ daysSinceLastVerified: d }).recencyFactor,
    );
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i]!).toBeLessThanOrEqual(factors[i - 1]!);
    }
  });

  it('floors at 0.4, so well-verified old data stays useful', () => {
    expect(withInputs({ daysSinceLastVerified: 100_000 }).recencyFactor).toBe(0.4);
  });
});

describe('independent re-survey', () => {
  it('is neutral when no re-survey has happened', () => {
    expect(withInputs({ resurvey: null }).resurveyFactor).toBe(1);
  });

  it('rewards agreement', () => {
    const agreed = withInputs({ collectorReputations: [0.6], resurvey: { agreed: true } }).score;
    const none = withInputs({ collectorReputations: [0.6], resurvey: null }).score;
    expect(agreed).toBeGreaterThan(none);
  });

  it('penalises disagreement heavily — two mappers walked it and disagreed', () => {
    const disagreed = withInputs({ resurvey: { agreed: false } }).score;
    const none = withInputs({ resurvey: null }).score;
    expect(disagreed).toBeLessThan(none * 0.6);
  });

  it('ranks disagreement below agreement, holding everything else equal', () => {
    const a = withInputs({ resurvey: { agreed: true } }).score;
    const d = withInputs({ resurvey: { agreed: false } }).score;
    expect(d).toBeLessThan(a);
  });
});

describe('breakdown', () => {
  it('reports every component so a score can be explained without re-deriving it', () => {
    const r = withInputs({
      collectorReputations: [0.9, 0.7],
      bestGpsAccuracyM: 12,
      daysSinceLastVerified: 200,
      resurvey: { agreed: true },
    });
    expect(r).toHaveProperty('evidenceFactor');
    expect(r).toHaveProperty('accuracyFactor');
    expect(r).toHaveProperty('recencyFactor');
    expect(r).toHaveProperty('resurveyFactor');
    // The score is the clamped product of the four factors.
    const product = r.evidenceFactor * r.accuracyFactor * r.recencyFactor * r.resurveyFactor;
    expect(r.score).toBeCloseTo(Math.min(1, product), 2);
  });

  it('is frozen, so a caller cannot mutate a score it was handed', () => {
    const r = computeConfidence(base);
    expect(Object.isFrozen(r)).toBe(true);
  });
});

describe('regression pins — changing these means publishing a new formula version', () => {
  // Exact values, deliberately. A silent change to any constant alters every score
  // in the dataset and every customer's expectations. If one of these fails, the
  // question is not "fix the test" but "did we mean to publish confidence@1.1?"
  it.each([
    [{ collectorReputations: [1] }, 0.593],
    [{ collectorReputations: [1, 1] }, 0.835],
    [{ collectorReputations: [0.5] }, 0.362],
    [{ collectorReputations: [1], bestGpsAccuracyM: 50 }, 0.178],
    [{ collectorReputations: [1], daysSinceLastVerified: 540 }, 0.297],
    [{ collectorReputations: [1], resurvey: { agreed: false } }, 0.297],
  ])('pins %j to %f', (input, expected) => {
    expect(withInputs(input as Partial<ConfidenceInputs>).score).toBeCloseTo(expected, 3);
  });
});
