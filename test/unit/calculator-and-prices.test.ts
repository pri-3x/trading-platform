import { describe, expect, it } from 'vitest';
import { usdToShares } from '../../src/domain/calculator.js';
import { gbmStep, mulberry32, normal } from '../../src/domain/price-process.js';
import { validateOrderRequest } from '../../src/domain/order-rules.js';

describe('usdToShares', () => {
  it('rounds shares down and reports the remainder', () => {
    const r = usdToShares('1000', '420.00');
    expect(r.shares.toFixed()).toBe('2.380952');
    expect(r.cost.toFixed()).toBe('999.99984');
    expect(r.remainder.toFixed()).toBe('0.00016');
    expect(r.cost.add(r.remainder).toFixed()).toBe('1000');
  });

  it('is exact for evenly divisible amounts', () => {
    const r = usdToShares('955', '95.50');
    expect(r.shares.toFixed()).toBe('10');
    expect(r.remainder.toFixed()).toBe('0');
  });
});

describe('price process', () => {
  it('is deterministic for a given seed', () => {
    const run = (seed: number) => {
      const rand = mulberry32(seed);
      let p = '420.00';
      const out: string[] = [];
      for (let i = 0; i < 50; i++) {
        p = gbmStep({
          price: p,
          drift: '0.05',
          volatility: '0.6',
          dtMs: 1000,
          z: normal(rand),
        }).toFixed(2);
        out.push(p);
      }
      return out;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('produces 2dp positive prices that change over time', () => {
    const rand = mulberry32(1);
    let p = '95.50';
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const next = gbmStep({
        price: p,
        drift: '0',
        volatility: '5',
        dtMs: 60_000,
        z: normal(rand),
      });
      expect(next.decimalPlaces()).toBeLessThanOrEqual(2);
      expect(next.gt(0)).toBe(true);
      p = next.toFixed(2);
      seen.add(p);
    }
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe('validateOrderRequest', () => {
  const limits = { minOrderNotionalUsd: '1', maxOrderQuantity: '1000' };
  const base = {
    symbol: 'vSOL',
    side: 'BUY' as const,
    type: 'LIMIT' as const,
    quantity: '1',
    limitPrice: '10.00',
  };

  it('accepts a valid limit order', () => {
    const v = validateOrderRequest(base, limits);
    expect(v.quantity.toFixed()).toBe('1');
    expect(v.limitPrice!.toFixed()).toBe('10');
  });

  it.each([
    [{ quantity: '0' }, /quantity/],
    [{ quantity: '-1' }, /quantity/],
    [{ quantity: '1.0000001' }, /EXCESSIVE_PRECISION/],
    [{ quantity: '1001' }, /maximum/],
    [{ limitPrice: '0' }, /limitPrice/],
    [{ limitPrice: '10.001' }, /EXCESSIVE_PRECISION/],
    [{ limitPrice: 'abc' }, /limitPrice/],
    [{ limitPrice: undefined }, /required/],
    [{ type: 'MARKET' as const }, /must not be provided/],
  ])('rejects %j', (patch, message) => {
    expect(() => validateOrderRequest({ ...base, ...patch }, limits)).toThrow(message);
  });
});
