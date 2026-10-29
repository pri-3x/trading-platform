import { BusinessRuleError, ValidationError } from '../lib/errors.js';
import { Decimal, PRICE_SCALE, SHARE_SCALE, dec, notional, parsePositiveDecimal } from './money.js';
import type { OrderSide, OrderStatus, OrderType } from './types.js';

export interface OrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: string;
  limitPrice?: string | undefined;
}

export interface ValidatedOrder {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  quantity: Decimal;
  limitPrice: Decimal | null;
}

export interface TradingLimits {
  minOrderNotionalUsd: string;
  maxOrderQuantity: string;
}

const MAX_LIMIT_PRICE = new Decimal('1000000000');

/** Structural validation of an order request (400 errors). */
export function validateOrderRequest(req: OrderRequest, limits: TradingLimits): ValidatedOrder {
  const qty = parsePositiveDecimal(req.quantity, SHARE_SCALE);
  if (!qty.ok) {
    throw new ValidationError(`quantity is invalid: ${qty.error}`, {
      field: 'quantity',
      reason: qty.error,
    });
  }
  if (qty.value.gt(dec(limits.maxOrderQuantity))) {
    throw new ValidationError(`quantity exceeds maximum of ${limits.maxOrderQuantity}`, {
      field: 'quantity',
    });
  }
  let limitPrice: Decimal | null = null;
  if (req.type === 'LIMIT') {
    if (req.limitPrice === undefined) {
      throw new ValidationError('limitPrice is required for LIMIT orders', { field: 'limitPrice' });
    }
    const px = parsePositiveDecimal(req.limitPrice, PRICE_SCALE);
    if (!px.ok) {
      throw new ValidationError(`limitPrice is invalid: ${px.error}`, {
        field: 'limitPrice',
        reason: px.error,
      });
    }
    if (px.value.gt(MAX_LIMIT_PRICE)) {
      throw new ValidationError('limitPrice is unreasonably large', { field: 'limitPrice' });
    }
    limitPrice = px.value;
  } else if (req.limitPrice !== undefined) {
    throw new ValidationError('limitPrice must not be provided for MARKET orders', {
      field: 'limitPrice',
    });
  }
  return { symbol: req.symbol, side: req.side, type: req.type, quantity: qty.value, limitPrice };
}

/**
 * Minimum order size: notional (qty x limit price, or qty x current mid for market orders) must be
 * at least MIN_ORDER_NOTIONAL_USD. Business rule => 422.
 */
export function assertMinimumNotional(
  order: ValidatedOrder,
  referencePrice: Decimal,
  limits: TradingLimits,
): void {
  const px = order.limitPrice ?? referencePrice;
  if (notional(order.quantity, px).lt(dec(limits.minOrderNotionalUsd))) {
    throw new BusinessRuleError(
      'ORDER_BELOW_MINIMUM',
      `order notional must be at least ${limits.minOrderNotionalUsd} USD`,
    );
  }
}

/** Status after a set of fills, for orders that are allowed to rest (LIMIT). */
export function restingStatus(filled: Decimal, remaining: Decimal): OrderStatus {
  if (remaining.isZero()) return 'FILLED';
  return filled.gt(0) ? 'PARTIALLY_FILLED' : 'OPEN';
}

export function isCancellable(status: OrderStatus): boolean {
  return status === 'OPEN' || status === 'PARTIALLY_FILLED';
}
