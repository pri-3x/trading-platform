import { z } from 'zod';

/** Monetary values travel as strings to avoid floating point anywhere in the pipeline. */
export const decimalString = (example: string, description: string) =>
  z.string().describe(`${description} (decimal string, e.g. "${example}")`);

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string(),
    }),
  })
  .describe('Standard error envelope');

export const AuthRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
});

export const AuthResponse = z.object({
  token: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.string(),
  user: z.object({ id: z.string().uuid(), email: z.string() }),
});

export const TradingStatus = z.object({ halted: z.boolean(), haltedUntil: z.string().nullable() });

export const AssetSummary = z.object({
  symbol: z.string(),
  name: z.string(),
  description: z.string(),
  initialPrice: z.string(),
  price: z.string().nullable(),
  priceObservedAt: z.string().nullable(),
  changeFromInitial: z.string().nullable(),
  trading: TradingStatus,
});

export const AssetDetail = AssetSummary.extend({
  priceHistory: z.array(
    z.object({ price: z.string(), observedAt: z.string(), source: z.string() }),
  ),
  circuitBreakerEvents: z.array(
    z.object({
      triggeredAt: z.string(),
      haltedUntil: z.string(),
      referencePrice: z.string(),
      referenceObservedAt: z.string(),
      triggerPrice: z.string(),
      changeRatio: z.string(),
    }),
  ),
});

export const CalculatorRequest = z.object({
  symbol: z.string().min(1).max(16),
  usdAmount: decimalString('1000', 'USD amount, > 0, at most 8 decimals'),
});

export const CalculatorResponse = z.object({
  symbol: z.string(),
  usdAmount: z.string(),
  price: z.string(),
  priceObservedAt: z.string(),
  priceType: z.literal('INDICATIVE_MID'),
  estimatedShares: z.string(),
  estimatedCost: z.string(),
  remainder: z.string(),
  rounding: z.string(),
  calculatedAt: z.string(),
  disclaimer: z.string(),
});

export const OrderRequest = z.object({
  symbol: z.string().min(1).max(16),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT']),
  quantity: decimalString('2.5', 'Share quantity, > 0, at most 6 decimals'),
  limitPrice: decimalString(
    '400.00',
    'Required for LIMIT, forbidden for MARKET; at most 2 decimals',
  ).optional(),
});

export const Order = z.object({
  id: z.string().uuid(),
  symbol: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT']),
  status: z.enum(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED']),
  quantity: z.string(),
  filledQuantity: z.string(),
  remainingQuantity: z.string(),
  limitPrice: z.string().nullable(),
  averageFillPrice: z.string().nullable(),
  filledNotional: z.string(),
  reservation: z.object({ instrument: z.string(), initial: z.string(), remaining: z.string() }),
  cancelReason: z.enum(['USER_REQUESTED', 'IOC_REMAINDER', 'NO_LIQUIDITY']).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastFilledAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  fills: z.array(
    z.object({
      id: z.number().int(),
      quantity: z.string(),
      price: z.string(),
      notional: z.string(),
      liquidityLevel: z.number().int(),
      executedAt: z.string(),
    }),
  ),
});

export const ListOrdersQuery = z.object({
  status: z.enum(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED']).optional(),
  symbol: z.string().max(16).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const Position = z.object({
  symbol: z.string(),
  shares: z.object({ available: z.string(), reserved: z.string(), total: z.string() }),
  averageCost: z.string().nullable(),
  costBasis: z.string(),
  price: z.string().nullable(),
  priceObservedAt: z.string().nullable(),
  marketValue: z.string().nullable(),
  unrealizedPnl: z.string().nullable(),
  realizedPnl: z.string(),
});

const Valuation = z.object({
  cash: z.object({
    instrument: z.literal('USD'),
    available: z.string(),
    reserved: z.string(),
    total: z.string(),
  }),
  positions: z.array(Position),
  totals: z.object({
    costBasis: z.string(),
    marketValue: z.string(),
    unrealizedPnl: z.string(),
    realizedPnl: z.string(),
    portfolioValue: z.string(),
  }),
  valuationComplete: z.boolean(),
});

export const PortfolioResponse = Valuation.extend({ userId: z.string(), asOf: z.string() });

export const PortfolioHistoryQuery = z.object({
  at: z.string().describe('Inclusive cutoff, ISO-8601 with timezone, not in the future'),
});

export const PortfolioHistoryResponse = Valuation.extend({
  userId: z.string(),
  requestedAt: z.string(),
  valuationTimestamp: z.string().nullable(),
  ledger: z.object({
    lastJournalSequence: z.number().int().nullable(),
    lastEventAt: z.string().nullable(),
    boundary: z.string(),
  }),
  reservations: z.array(
    z.object({ orderId: z.string(), instrument: z.string(), amount: z.string() }),
  ),
  pricesUsed: z.array(
    z.object({
      symbol: z.string(),
      price: z.string().nullable(),
      observedAt: z.string().nullable(),
    }),
  ),
});
