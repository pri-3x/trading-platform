import { Decimal, SHARE_SCALE, type DecimalInput, dec, notional } from './money.js';

/**
 * Indicative USD -> shares conversion at a given (mid) price. Shares are rounded DOWN to the share
 * precision so the cost never exceeds the USD amount; the unspent USD is the remainder.
 */
export function usdToShares(usdAmount: DecimalInput, price: DecimalInput) {
  const usd = dec(usdAmount);
  const px = dec(price);
  if (px.lte(0)) throw new Error('price must be positive');
  const shares = usd.div(px).toDecimalPlaces(SHARE_SCALE, Decimal.ROUND_FLOOR);
  const cost = notional(shares, px);
  return { shares, cost, remainder: usd.sub(cost) };
}
