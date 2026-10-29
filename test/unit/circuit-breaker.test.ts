import { describe, expect, it } from 'vitest';
import {
  evaluateBreaker,
  isHalted,
  retryAfterSeconds,
  selectReferencePrice,
} from '../../src/domain/circuit-breaker.js';

describe('evaluateBreaker', () => {
  it('does not trigger at exactly 15% (strictly greater than)', () => {
    expect(evaluateBreaker('115.00', '100.00', '0.15').triggered).toBe(false);
    expect(evaluateBreaker('85.00', '100.00', '0.15').triggered).toBe(false);
  });

  it('triggers just above 15% in either direction without float error', () => {
    expect(evaluateBreaker('115.01', '100.00', '0.15').triggered).toBe(true);
    expect(evaluateBreaker('84.99', '100.00', '0.15').triggered).toBe(true);
    // 0.1 + 0.2 style float traps: 0.3 * 3 = 0.9 exactly here
    expect(evaluateBreaker('0.35', '0.30', '0.15').triggered).toBe(true);
    expect(evaluateBreaker('0.345', '0.30', '0.15').triggered).toBe(false);
  });

  it('cannot trigger without a reference price', () => {
    expect(evaluateBreaker('1000', null, '0.15')).toEqual({ triggered: false, changeRatio: null });
  });

  it('reports the change ratio', () => {
    expect(evaluateBreaker('120', '100', '0.15').changeRatio!.toFixed()).toBe('0.2');
  });
});

describe('selectReferencePrice', () => {
  const t = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s));
  const obs = [
    { price: '100', observedAt: t(0) },
    { price: '101', observedAt: t(30) },
    { price: '102', observedAt: t(59) },
    { price: '130', observedAt: t(90) },
  ];

  it('uses the latest observation at or before now - window', () => {
    expect(selectReferencePrice(obs, t(90), 60)?.price).toBe('101'); // boundary t(30) inclusive
    expect(selectReferencePrice(obs, t(89), 60)?.price).toBe('100');
  });

  it('falls back to the earliest observation in the window when history is shorter', () => {
    expect(selectReferencePrice(obs.slice(1), t(59), 60)?.price).toBe('101');
  });

  it('ignores observations after now', () => {
    expect(selectReferencePrice(obs, t(10), 60)?.price).toBe('100');
  });
});

describe('halt helpers', () => {
  it('computes halted state and retry-after', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const until = new Date('2026-01-01T00:00:12.200Z');
    expect(isHalted(until, now)).toBe(true);
    expect(isHalted(until, until)).toBe(false);
    expect(isHalted(null, now)).toBe(false);
    expect(retryAfterSeconds(until, now)).toBe(13);
  });
});
