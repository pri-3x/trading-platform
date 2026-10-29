import { Decimal as DecimalJs } from 'decimal.js';

/**
 * Arbitrary-precision decimal used for every monetary / quantity calculation.
 * 60 significant digits comfortably exceed NUMERIC(38, 8) so intermediate products never lose
 * precision; explicit `toDecimalPlaces` calls apply the documented rounding rules.
 */
export const Decimal = DecimalJs.clone({
  precision: 60,
  rounding: DecimalJs.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Decimal = InstanceType<typeof Decimal>;
export type DecimalInput = Decimal | string | number;

/** Stablecoin (USD) precision. Chosen so that qty(6dp) x price(2dp) is always exact. */
export const CASH_SCALE = 8;
/** Share token precision. */
export const SHARE_SCALE = 6;
/** Price precision (USD per share). */
export const PRICE_SCALE = 2;

export const ZERO = new Decimal(0);

export function dec(value: DecimalInput): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(\.\d+)?$/;

export type DecimalParseError = 'INVALID_NUMBER' | 'EXCESSIVE_PRECISION' | 'NOT_POSITIVE';

/**
 * Strictly parses a user supplied decimal string: plain notation only (no sign, exponent, spaces,
 * hex, leading zeros), at most `scale` fractional digits and strictly positive.
 */
export function parsePositiveDecimal(
  raw: string,
  scale: number,
): { ok: true; value: Decimal } | { ok: false; error: DecimalParseError } {
  if (typeof raw !== 'string' || !DECIMAL_PATTERN.test(raw) || raw.length > 40) {
    return { ok: false, error: 'INVALID_NUMBER' };
  }
  const value = new Decimal(raw);
  if (value.decimalPlaces() > scale) return { ok: false, error: 'EXCESSIVE_PRECISION' };
  if (value.lte(0)) return { ok: false, error: 'NOT_POSITIVE' };
  return { ok: true, value };
}

/** Formats with a fixed number of decimals (string, never a JS number) for API responses. */
export function fmt(value: DecimalInput, scale: number): string {
  return dec(value).toFixed(scale, Decimal.ROUND_HALF_EVEN);
}

export const fmtCash = (v: DecimalInput) => fmt(v, CASH_SCALE);
export const fmtShares = (v: DecimalInput) => fmt(v, SHARE_SCALE);
export const fmtPrice = (v: DecimalInput) => fmt(v, PRICE_SCALE);

/** Notional of a fill. qty has <= 6dp and price <= 2dp, so the product has <= 8dp: exact. */
export function notional(quantity: DecimalInput, price: DecimalInput): Decimal {
  const result = dec(quantity).mul(dec(price));
  if (result.decimalPlaces() > CASH_SCALE) {
    throw new Error(`notional ${result.toString()} exceeds cash scale`);
  }
  return result;
}

export function minDec(a: Decimal, b: Decimal): Decimal {
  return a.lte(b) ? a : b;
}
