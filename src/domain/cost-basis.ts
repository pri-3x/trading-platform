import { CASH_SCALE, Decimal, ZERO } from './money.js';

/**
 * Weighted-average cost basis.
 *  - BUY fill: quantity += q; costBasis += cash paid (q * price, fees are zero).
 *  - SELL fill: the cost removed is costBasis * q / quantity (rounded half-even to 8dp; selling
 *    the whole position removes the entire remaining cost so no residue is left behind).
 *    realizedPnl += proceeds - costRemoved. The average cost of remaining shares is unchanged.
 * Reservations do not affect cost basis: reserved shares are still owned.
 */
export interface PositionState {
  quantity: Decimal;
  costBasis: Decimal;
  realizedPnl: Decimal;
}

export const EMPTY_POSITION: PositionState = { quantity: ZERO, costBasis: ZERO, realizedPnl: ZERO };

export function applyBuyFill(
  state: PositionState,
  quantity: Decimal,
  cost: Decimal,
): PositionState {
  if (quantity.lte(0) || cost.lt(0)) throw new Error('invalid buy fill');
  return {
    quantity: state.quantity.add(quantity),
    costBasis: state.costBasis.add(cost),
    realizedPnl: state.realizedPnl,
  };
}

export function applySellFill(
  state: PositionState,
  quantity: Decimal,
  proceeds: Decimal,
): { state: PositionState; costRemoved: Decimal; realized: Decimal } {
  if (quantity.lte(0) || proceeds.lt(0)) throw new Error('invalid sell fill');
  if (quantity.gt(state.quantity)) {
    throw new Error(`cannot sell ${quantity.toString()} > held ${state.quantity.toString()}`);
  }
  const costRemoved = quantity.eq(state.quantity)
    ? state.costBasis
    : state.costBasis
        .mul(quantity)
        .div(state.quantity)
        .toDecimalPlaces(CASH_SCALE, Decimal.ROUND_HALF_EVEN);
  const realized = proceeds.sub(costRemoved);
  return {
    state: {
      quantity: state.quantity.sub(quantity),
      costBasis: state.costBasis.sub(costRemoved),
      realizedPnl: state.realizedPnl.add(realized),
    },
    costRemoved,
    realized,
  };
}

export function averageCost(state: PositionState): Decimal | null {
  if (state.quantity.lte(0)) return null;
  return state.costBasis.div(state.quantity).toDecimalPlaces(CASH_SCALE, Decimal.ROUND_HALF_EVEN);
}
