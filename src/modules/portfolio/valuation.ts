import { averageCost, type PositionState } from '../../domain/cost-basis.js';
import { Decimal, ZERO, fmtCash, fmtPrice, fmtShares, notional } from '../../domain/money.js';

/**
 * Shared valuation used by both the current portfolio and the historical reconstruction so that
 * the two can be reconciled exactly.
 *   marketValue   = totalShares x price          (exact, no rounding)
 *   unrealizedPnl = marketValue - costBasis
 *   portfolioValue = total cash (available + reserved) + sum(marketValue)
 * Reservations are not extra assets: they are a split of the same total.
 */
export interface HoldingInput {
  symbol: string;
  available: Decimal;
  reserved: Decimal;
  position: PositionState;
  price: string | null;
  priceObservedAt: Date | null;
}

export interface CashInput {
  available: Decimal;
  reserved: Decimal;
}

export function buildValuation(cash: CashInput, holdings: HoldingInput[]) {
  let marketValueTotal = ZERO;
  let costBasisTotal = ZERO;
  let unrealizedTotal = ZERO;
  let realizedTotal = ZERO;
  let complete = true;

  const positions = holdings
    .filter(
      (h) =>
        !h.available.add(h.reserved).isZero() ||
        !h.position.realizedPnl.isZero() ||
        !h.position.costBasis.isZero(),
    )
    .map((h) => {
      const total = h.available.add(h.reserved);
      const marketValue = h.price === null ? null : notional(total, h.price);
      const unrealized = marketValue === null ? null : marketValue.sub(h.position.costBasis);
      if (marketValue === null && !total.isZero()) complete = false;
      marketValueTotal = marketValueTotal.add(marketValue ?? ZERO);
      costBasisTotal = costBasisTotal.add(h.position.costBasis);
      unrealizedTotal = unrealizedTotal.add(unrealized ?? ZERO);
      realizedTotal = realizedTotal.add(h.position.realizedPnl);
      const avg = averageCost(h.position);
      return {
        symbol: h.symbol,
        shares: {
          available: fmtShares(h.available),
          reserved: fmtShares(h.reserved),
          total: fmtShares(total),
        },
        averageCost: avg === null ? null : fmtCash(avg),
        costBasis: fmtCash(h.position.costBasis),
        price: h.price === null ? null : fmtPrice(h.price),
        priceObservedAt: h.priceObservedAt?.toISOString() ?? null,
        marketValue: marketValue === null ? null : fmtCash(marketValue),
        unrealizedPnl: unrealized === null ? null : fmtCash(unrealized),
        realizedPnl: fmtCash(h.position.realizedPnl),
      };
    });

  const cashTotal = cash.available.add(cash.reserved);
  return {
    cash: {
      instrument: 'USD' as const,
      available: fmtCash(cash.available),
      reserved: fmtCash(cash.reserved),
      total: fmtCash(cashTotal),
    },
    positions,
    totals: {
      costBasis: fmtCash(costBasisTotal),
      marketValue: fmtCash(marketValueTotal),
      unrealizedPnl: fmtCash(unrealizedTotal),
      realizedPnl: fmtCash(realizedTotal),
      portfolioValue: fmtCash(cashTotal.add(marketValueTotal)),
    },
    valuationComplete: complete,
  };
}
