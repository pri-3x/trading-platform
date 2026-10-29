import { Decimal, type DecimalInput, dec } from './money.js';

/**
 * Circuit breaker rule:
 *   triggered  <=>  |current - reference| / reference > threshold
 * evaluated without division as |current - reference| > threshold * reference so it is exact.
 *
 * Reference price: the most recent observation at or before (now - window). If the asset has no
 * observation that old (e.g. just listed), the earliest observation inside the window is used.
 * If neither exists the breaker cannot trigger.
 */
export interface BreakerEvaluation {
  triggered: boolean;
  changeRatio: Decimal | null;
}

export function evaluateBreaker(
  current: DecimalInput,
  reference: DecimalInput | null,
  threshold: DecimalInput,
): BreakerEvaluation {
  if (reference === null) return { triggered: false, changeRatio: null };
  const ref = dec(reference);
  if (ref.lte(0)) return { triggered: false, changeRatio: null };
  const move = dec(current).sub(ref).abs();
  return {
    triggered: move.gt(dec(threshold).mul(ref)),
    changeRatio: move.div(ref).toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN),
  };
}

export interface PriceObservation {
  price: string;
  observedAt: Date;
}

/** Pure version of the reference-price policy (the SQL implementation mirrors it). */
export function selectReferencePrice(
  observations: PriceObservation[],
  now: Date,
  windowSeconds: number,
): PriceObservation | null {
  const boundary = now.getTime() - windowSeconds * 1000;
  const sorted = [...observations]
    .filter((o) => o.observedAt.getTime() <= now.getTime())
    .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const atOrBefore = sorted.filter((o) => o.observedAt.getTime() <= boundary);
  if (atOrBefore.length > 0) return atOrBefore[atOrBefore.length - 1] ?? null;
  return sorted[0] ?? null;
}

export function isHalted(haltedUntil: Date | null, now: Date): boolean {
  return haltedUntil !== null && haltedUntil.getTime() > now.getTime();
}

export function retryAfterSeconds(haltedUntil: Date, now: Date): number {
  return Math.max(1, Math.ceil((haltedUntil.getTime() - now.getTime()) / 1000));
}
