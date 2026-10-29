import { describe, expect, it } from 'vitest';
import {
  applyBuyFill,
  applySellFill,
  averageCost,
  EMPTY_POSITION,
} from '../../src/domain/cost-basis.js';
import { Decimal } from '../../src/domain/money.js';

const d = (v: string) => new Decimal(v);

describe('weighted average cost basis', () => {
  it('accumulates buys and averages cost', () => {
    let p = applyBuyFill(EMPTY_POSITION, d('10'), d('1000'));
    p = applyBuyFill(p, d('10'), d('1200'));
    expect(p.quantity.toFixed()).toBe('20');
    expect(p.costBasis.toFixed()).toBe('2200');
    expect(averageCost(p)!.toFixed()).toBe('110');
  });

  it('realizes P&L on sells and keeps the average cost of the remainder', () => {
    let p = applyBuyFill(EMPTY_POSITION, d('10'), d('1000'));
    p = applyBuyFill(p, d('10'), d('1200'));
    const r = applySellFill(p, d('5'), d('750'));
    expect(r.costRemoved.toFixed()).toBe('550');
    expect(r.realized.toFixed()).toBe('200');
    expect(r.state.quantity.toFixed()).toBe('15');
    expect(r.state.costBasis.toFixed()).toBe('1650');
    expect(averageCost(r.state)!.toFixed()).toBe('110');
  });

  it('removes all remaining cost when the full position is sold (no rounding residue)', () => {
    let p = applyBuyFill(EMPTY_POSITION, d('3'), d('100'));
    const a = applySellFill(p, d('1'), d('40'));
    expect(a.costRemoved.toFixed()).toBe('33.33333333');
    p = a.state;
    const b = applySellFill(p, d('2'), d('60'));
    expect(b.state.costBasis.toFixed()).toBe('0');
    expect(b.state.quantity.toFixed()).toBe('0');
    expect(b.state.realizedPnl.toFixed()).toBe(
      new Decimal('40').sub('33.33333333').add(new Decimal('60').sub('66.66666667')).toFixed(),
    );
    expect(b.state.realizedPnl.toFixed()).toBe('0');
  });

  it('rejects selling more than held', () => {
    const p = applyBuyFill(EMPTY_POSITION, d('1'), d('100'));
    expect(() => applySellFill(p, d('2'), d('200'))).toThrow();
  });

  it('has no average cost for a flat position', () => {
    expect(averageCost(EMPTY_POSITION)).toBeNull();
  });
});
