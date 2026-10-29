export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED';
export type CancelReason = 'USER_REQUESTED' | 'IOC_REMAINDER' | 'NO_LIQUIDITY';

export const RESTING_STATUSES: readonly OrderStatus[] = ['OPEN', 'PARTIALLY_FILLED'];

/** Ledger account types. One set of user accounts per instrument ('USD' or an asset symbol). */
export type AccountType =
  'USER_AVAILABLE' | 'USER_RESERVED' | 'HOUSE_INVENTORY' | 'EXTERNAL_FUNDING';

export type JournalType = 'FUNDING' | 'ORDER_RESERVE' | 'TRADE' | 'ORDER_RELEASE';

export const CASH_INSTRUMENT = 'USD';
