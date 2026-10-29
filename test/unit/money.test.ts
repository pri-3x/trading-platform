import { describe, expect, it } from 'vitest';
import {
  CASH_SCALE,
  Decimal,
  PRICE_SCALE,
  SHARE_SCALE,
  fmtCash,
  notional,
  parsePositiveDecimal,
} from '../../src/domain/money.js';

describe('parsePositiveDecimal', () => {
  it.each([
    ['1', '1'],
    ['2.5', '2.5'],
    ['0.000001', '0.000001'],
    ['1000000', '1000000'],
  ])('accepts %s', (raw, expected) => {
    const r = parsePositiveDecimal(raw, SHARE_SCALE);
    expect(r.ok && r.value.toFixed()).toBe(expected);
  });

  it.each([
    ['', 'INVALID_NUMBER'],
    ['abc', 'INVALID_NUMBER'],
    ['-1', 'INVALID_NUMBER'],
    ['+1', 'INVALID_NUMBER'],
    ['1e3', 'INVALID_NUMBER'],
    ['01', 'INVALID_NUMBER'],
    ['1.', 'INVALID_NUMBER'],
    ['.5', 'INVALID_NUMBER'],
    [' 1', 'INVALID_NUMBER'],
    ['0x10', 'INVALID_NUMBER'],
    ['NaN', 'INVALID_NUMBER'],
    ['Infinity', 'INVALID_NUMBER'],
    ['0', 'NOT_POSITIVE'],
    ['0.000000', 'NOT_POSITIVE'],
    ['1.0000001', 'EXCESSIVE_PRECISION'],
  ])('rejects %j with %s', (raw, error) => {
    expect(parsePositiveDecimal(raw, SHARE_SCALE)).toEqual({ ok: false, error });
  });

  it('enforces price precision of 2 decimals', () => {
    expect(parsePositiveDecimal('400.001', PRICE_SCALE)).toEqual({
      ok: false,
      error: 'EXCESSIVE_PRECISION',
    });
  });
});

describe('notional', () => {
  it('is exact for 6dp quantity x 2dp price (no float error)', () => {
    expect(notional('0.1', '0.2').toFixed()).toBe('0.02');
    expect(notional('2.333333', '420.33').toFixed()).toBe('980.76985989');
    expect(notional('2.333333', '420.33').decimalPlaces()).toBeLessThanOrEqual(CASH_SCALE);
  });

  it('formats with fixed scale', () => {
    expect(fmtCash(new Decimal('1.5'))).toBe('1.50000000');
  });
});
