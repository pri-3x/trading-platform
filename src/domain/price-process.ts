import { Decimal, PRICE_SCALE, type DecimalInput, dec } from './money.js';

/** Deterministic 32-bit PRNG (mulberry32). Same seed => same sequence on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller using the supplied uniform source. */
export function normal(rand: () => number): number {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MS_PER_YEAR = new Decimal(365 * 24 * 3600 * 1000);
const MIN_PRICE = new Decimal('0.01');

/**
 * One geometric Brownian motion step:
 *   S(t+dt) = S(t) * exp((mu - sigma^2/2) dt + sigma sqrt(dt) Z)
 * The random shock Z is a simulation *input*; all price arithmetic is done in Decimal and the
 * result is rounded half-even to the 2dp price precision (floored at $0.01).
 */
export function gbmStep(params: {
  price: DecimalInput;
  drift: DecimalInput;
  volatility: DecimalInput;
  dtMs: number;
  z: number;
}): Decimal {
  const dt = new Decimal(params.dtMs).div(MS_PER_YEAR);
  const sigma = dec(params.volatility);
  const mu = dec(params.drift);
  const z = new Decimal(params.z.toFixed(12));
  const exponent = mu.sub(sigma.pow(2).div(2)).mul(dt).add(sigma.mul(dt.sqrt()).mul(z));
  const next = dec(params.price)
    .mul(exponent.exp())
    .toDecimalPlaces(PRICE_SCALE, Decimal.ROUND_HALF_EVEN);
  return next.lt(MIN_PRICE) ? MIN_PRICE : next;
}
