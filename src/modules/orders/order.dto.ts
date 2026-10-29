import { Decimal, fmtCash, fmtPrice, fmtShares, dec } from '../../domain/money.js';
import { CASH_INSTRUMENT } from '../../domain/types.js';
import type { OrderRow, TradeRow } from './order.repository.js';

export interface FillDto {
  id: number;
  quantity: string;
  price: string;
  notional: string;
  liquidityLevel: number;
  executedAt: string;
}

export interface OrderDto {
  id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  limitPrice: string | null;
  averageFillPrice: string | null;
  filledNotional: string;
  reservation: { instrument: string; initial: string; remaining: string };
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  lastFilledAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  fills: FillDto[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toOrderDto(order: OrderRow, symbol: string, fills: TradeRow[]): OrderDto {
  const filled = dec(order.filledQuantity);
  const reservationIsCash = order.side === 'BUY';
  const fmtReservation = reservationIsCash ? fmtCash : fmtShares;
  return {
    id: order.id,
    symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    quantity: fmtShares(order.quantity),
    filledQuantity: fmtShares(order.filledQuantity),
    remainingQuantity: fmtShares(order.remainingQuantity),
    limitPrice: order.limitPrice === null ? null : fmtPrice(order.limitPrice),
    averageFillPrice: filled.gt(0)
      ? fmtCash(dec(order.filledNotional).div(filled).toDecimalPlaces(8, Decimal.ROUND_HALF_EVEN))
      : null,
    filledNotional: fmtCash(order.filledNotional),
    reservation: {
      instrument: reservationIsCash ? CASH_INSTRUMENT : symbol,
      initial: fmtReservation(order.reservedInitial),
      remaining: fmtReservation(order.reservedRemaining),
    },
    cancelReason: order.cancelReason,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    lastFilledAt: iso(order.lastFilledAt),
    completedAt: iso(order.completedAt),
    cancelledAt: iso(order.cancelledAt),
    fills: fills.map((t) => ({
      id: t.id,
      quantity: fmtShares(t.quantity),
      price: fmtPrice(t.price),
      notional: fmtCash(t.notional),
      liquidityLevel: t.liquidityLevel,
      executedAt: t.executedAt.toISOString(),
    })),
  };
}
