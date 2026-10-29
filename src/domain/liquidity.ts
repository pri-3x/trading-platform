import {
  Decimal,
  PRICE_SCALE,
  SHARE_SCALE,
  ZERO,
  minDec,
  notional,
  type DecimalInput,
  dec,
} from './money.js';
import type { OrderSide } from './types.js';

/**
 * Simulated execution liquidity ("house market maker").
 *
 * For every price tick the house quotes a deterministic ladder on each side of the mid price:
 *   ask level i = ceil_2dp(mid * (1 + (halfSpreadBps + i * levelStepBps) / 10_000))
 *   bid level i = floor_2dp(mid * (1 - (halfSpreadBps + i * levelStepBps) / 10_000))
 *   size of each level = floor_6dp(levelNotionalUsd / levelPrice)
 * Rounding of quoted prices is always in the house's favour. Liquidity consumed by fills is
 * tracked per tick (asset_market_state.ask_consumed / bid_consumed) and replenished when the
 * next tick arrives, so total executed volume per tick can never exceed the quoted ladder.
 */
export interface LiquidityConfig {
  levels: number;
  halfSpreadBps: number;
  levelStepBps: number;
  levelNotionalUsd: string;
}

export interface LadderLevel {
  level: number;
  price: Decimal;
  quantity: Decimal;
}

export interface PlannedFill {
  level: number;
  price: Decimal;
  quantity: Decimal;
  notional: Decimal;
}

const BPS = new Decimal(10_000);

export function buildLadder(
  mid: DecimalInput,
  side: 'ASK' | 'BID',
  cfg: LiquidityConfig,
): LadderLevel[] {
  const midPrice = dec(mid);
  const levels: LadderLevel[] = [];
  for (let i = 0; i < cfg.levels; i++) {
    const offset = new Decimal(cfg.halfSpreadBps + i * cfg.levelStepBps).div(BPS);
    const price =
      side === 'ASK'
        ? midPrice.mul(Decimal.add(1, offset)).toDecimalPlaces(PRICE_SCALE, Decimal.ROUND_CEIL)
        : midPrice.mul(Decimal.sub(1, offset)).toDecimalPlaces(PRICE_SCALE, Decimal.ROUND_FLOOR);
    if (price.lte(0)) break;
    const quantity = dec(cfg.levelNotionalUsd)
      .div(price)
      .toDecimalPlaces(SHARE_SCALE, Decimal.ROUND_FLOOR);
    if (quantity.lte(0)) continue;
    levels.push({ level: i, price, quantity });
  }
  return levels;
}

/** BUY orders lift the ask ladder; SELL orders hit the bid ladder. */
export function ladderSideFor(side: OrderSide): 'ASK' | 'BID' {
  return side === 'BUY' ? 'ASK' : 'BID';
}

export function isPriceEligible(
  side: OrderSide,
  levelPrice: Decimal,
  limitPrice: Decimal | null,
): boolean {
  if (limitPrice === null) return true;
  return side === 'BUY' ? levelPrice.lte(limitPrice) : levelPrice.gte(limitPrice);
}

/**
 * Walks the ladder (skipping liquidity already consumed this tick) and returns the fills that an
 * order of `quantity` would receive. Limit prices are respected: a BUY never fills above, a SELL
 * never fills below its limit. Pure function — no side effects.
 */
export function planFills(params: {
  side: OrderSide;
  quantity: Decimal;
  limitPrice: Decimal | null;
  ladder: LadderLevel[];
  alreadyConsumed: Decimal;
}): PlannedFill[] {
  const fills: PlannedFill[] = [];
  let toSkip = params.alreadyConsumed;
  let remaining = params.quantity;
  for (const level of params.ladder) {
    if (remaining.lte(0)) break;
    let available = level.quantity;
    if (toSkip.gt(0)) {
      const skipped = minDec(toSkip, available);
      available = available.sub(skipped);
      toSkip = toSkip.sub(skipped);
    }
    if (available.lte(0)) continue;
    if (!isPriceEligible(params.side, level.price, params.limitPrice)) break;
    const qty = minDec(available, remaining);
    fills.push({
      level: level.level,
      price: level.price,
      quantity: qty,
      notional: notional(qty, level.price),
    });
    remaining = remaining.sub(qty);
  }
  return fills;
}

export function sumQuantity(fills: PlannedFill[]): Decimal {
  return fills.reduce((acc, f) => acc.add(f.quantity), ZERO);
}

export function sumNotional(fills: PlannedFill[]): Decimal {
  return fills.reduce((acc, f) => acc.add(f.notional), ZERO);
}
