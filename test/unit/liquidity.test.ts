import { describe, expect, it } from 'vitest';
import { buildLadder, planFills } from '../../src/domain/liquidity.js';
import { Decimal } from '../../src/domain/money.js';

const cfg = { levels: 3, halfSpreadBps: 10, levelStepBps: 10, levelNotionalUsd: '1000' };
const d = (v: string) => new Decimal(v);

describe('buildLadder', () => {
  it('rounds asks up and bids down to the cent (house-favourable)', () => {
    const asks = buildLadder('100.05', 'ASK', cfg);
    expect(asks.map((l) => l.price.toFixed(2))).toEqual(['100.16', '100.26', '100.36']);
    const bids = buildLadder('100.05', 'BID', cfg);
    expect(bids.map((l) => l.price.toFixed(2))).toEqual(['99.94', '99.84', '99.74']);
  });

  it('sizes each level as floor(notional / price) shares', () => {
    const [first] = buildLadder('100', 'ASK', { ...cfg, halfSpreadBps: 0 });
    expect(first!.quantity.toFixed()).toBe('10');
    const [second] = buildLadder('300', 'ASK', { ...cfg, halfSpreadBps: 0 });
    expect(second!.quantity.toFixed()).toBe('3.333333');
  });
});

describe('planFills', () => {
  const ladder = buildLadder('100', 'ASK', {
    levels: 3,
    halfSpreadBps: 0,
    levelStepBps: 100,
    levelNotionalUsd: '1000',
  });
  // asks: 100.00 x 10, 101.00 x 9.90099, 102.00 x 9.803921

  it('walks levels in order and splits into per-level fills', () => {
    const fills = planFills({
      side: 'BUY',
      quantity: d('15'),
      limitPrice: null,
      ladder,
      alreadyConsumed: d('0'),
    });
    expect(fills.map((f) => [f.price.toFixed(2), f.quantity.toFixed()])).toEqual([
      ['100.00', '10'],
      ['101.00', '5'],
    ]);
    expect(fills[1]!.notional.toFixed()).toBe('505');
  });

  it('never exceeds total ladder liquidity (partial fill)', () => {
    const fills = planFills({
      side: 'BUY',
      quantity: d('1000'),
      limitPrice: null,
      ladder,
      alreadyConsumed: d('0'),
    });
    const total = fills.reduce((a, f) => a.add(f.quantity), d('0'));
    expect(total.toFixed()).toBe('29.704911');
  });

  it('respects a BUY limit price', () => {
    const fills = planFills({
      side: 'BUY',
      quantity: d('25'),
      limitPrice: d('101.00'),
      ladder,
      alreadyConsumed: d('0'),
    });
    expect(fills.every((f) => f.price.lte(101))).toBe(true);
    expect(fills.reduce((a, f) => a.add(f.quantity), d('0')).toFixed()).toBe('19.90099');
  });

  it('returns nothing when the best level is above the BUY limit', () => {
    expect(
      planFills({
        side: 'BUY',
        quantity: d('1'),
        limitPrice: d('99.99'),
        ladder,
        alreadyConsumed: d('0'),
      }),
    ).toEqual([]);
  });

  it('respects a SELL limit price on the bid ladder', () => {
    const bids = buildLadder('100', 'BID', {
      levels: 3,
      halfSpreadBps: 0,
      levelStepBps: 100,
      levelNotionalUsd: '1000',
    });
    const fills = planFills({
      side: 'SELL',
      quantity: d('50'),
      limitPrice: d('99.00'),
      ladder: bids,
      alreadyConsumed: d('0'),
    });
    expect(fills.map((f) => f.price.toFixed(2))).toEqual(['100.00', '99.00']);
  });

  it('skips liquidity already consumed in this tick', () => {
    const fills = planFills({
      side: 'BUY',
      quantity: d('5'),
      limitPrice: null,
      ladder,
      alreadyConsumed: d('12'),
    });
    expect(fills).toHaveLength(1);
    expect(fills[0]!.price.toFixed(2)).toBe('101.00');
    const exhausted = planFills({
      side: 'BUY',
      quantity: d('5'),
      limitPrice: null,
      ladder,
      alreadyConsumed: d('29.704911'),
    });
    expect(exhausted).toEqual([]);
  });
});
