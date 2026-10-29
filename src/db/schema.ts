import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/*
 * Numeric conventions (see README "Precision"):
 *   cash / ledger amounts  NUMERIC(38, 8)
 *   share quantities       NUMERIC(38, 6)
 *   prices                 NUMERIC(20, 2)
 * Drizzle returns NUMERIC as string; the application converts with decimal.js only.
 */
const cash = (name: string) => numeric(name, { precision: 38, scale: 8 });
const shares = (name: string) => numeric(name, { precision: 38, scale: 6 });
const price = (name: string) => numeric(name, { precision: 20, scale: 2 });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const assets = pgTable(
  'assets',
  {
    id: serial('id').primaryKey(),
    symbol: text('symbol').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    initialPrice: price('initial_price').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [check('assets_initial_price_positive', sql`${t.initialPrice} > 0`)],
);

/** Immutable price observations. One row per asset per timestamp (duplicates are ignored). */
export const priceTicks = pgTable(
  'price_ticks',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    price: price('price').notNull(),
    observedAt: ts('observed_at').notNull(),
    source: text('source').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('price_ticks_asset_observed_uq').on(t.assetId, t.observedAt),
    check('price_ticks_price_positive', sql`${t.price} > 0`),
    check('price_ticks_source', sql`${t.source} in ('SEED', 'SIMULATOR', 'MANUAL')`),
  ],
);

/**
 * Mutable per-asset market state. Its row lock serialises order placement, resting-order matching
 * and price ingestion for one asset, which is what makes the circuit breaker and the simulated
 * liquidity book race-free.
 */
export const assetMarketState = pgTable(
  'asset_market_state',
  {
    assetId: integer('asset_id')
      .primaryKey()
      .references(() => assets.id),
    lastTickId: bigint('last_tick_id', { mode: 'number' }).references(() => priceTicks.id),
    lastPrice: price('last_price'),
    lastTickAt: ts('last_tick_at'),
    /** Liquidity already consumed from the current tick's simulated ask / bid ladders. */
    askConsumed: shares('ask_consumed').notNull().default('0'),
    bidConsumed: shares('bid_consumed').notNull().default('0'),
    haltedUntil: ts('halted_until'),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [check('ams_consumed_non_negative', sql`${t.askConsumed} >= 0 and ${t.bidConsumed} >= 0`)],
);

export const circuitBreakerEvents = pgTable(
  'circuit_breaker_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    triggerTickId: bigint('trigger_tick_id', { mode: 'number' })
      .notNull()
      .references(() => priceTicks.id),
    triggerPrice: price('trigger_price').notNull(),
    referencePrice: price('reference_price').notNull(),
    referenceObservedAt: ts('reference_observed_at').notNull(),
    changeRatio: numeric('change_ratio', { precision: 30, scale: 12 }).notNull(),
    triggeredAt: ts('triggered_at').notNull(),
    haltedUntil: ts('halted_until').notNull(),
  },
  (t) => [index('cbe_asset_triggered_idx').on(t.assetId, t.triggeredAt)],
);

/**
 * Ledger accounts. `assetId` NULL means the USD stablecoin, otherwise shares of that asset.
 * `balance` is a cache maintained exclusively by a trigger on ledger_entries; it can never be
 * written directly and can never go negative for user accounts.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').references(() => users.id),
    assetId: integer('asset_id').references(() => assets.id),
    type: text('type').notNull(),
    allowNegative: boolean('allow_negative').notNull().default(false),
    balance: cash('balance').notNull().default('0'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('accounts_owner_instrument_type_uq').on(t.userId, t.assetId, t.type).nullsNotDistinct(),
    check('accounts_non_negative', sql`${t.allowNegative} or ${t.balance} >= 0`),
    check(
      'accounts_type',
      sql`${t.type} in ('USER_AVAILABLE', 'USER_RESERVED', 'HOUSE_INVENTORY', 'EXTERNAL_FUNDING')`,
    ),
    check(
      'accounts_owner_matches_type',
      sql`(${t.type} like 'USER_%') = (${t.userId} is not null)`,
    ),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    side: text('side').notNull(),
    type: text('type').notNull(),
    status: text('status').notNull(),
    quantity: shares('quantity').notNull(),
    filledQuantity: shares('filled_quantity').notNull().default('0'),
    remainingQuantity: shares('remaining_quantity').notNull(),
    limitPrice: price('limit_price'),
    filledNotional: cash('filled_notional').notNull().default('0'),
    /** Reservation originally taken (USD for BUY, shares for SELL). */
    reservedInitial: cash('reserved_initial').notNull().default('0'),
    /** Reservation still outstanding. Zero once the order is terminal. */
    reservedRemaining: cash('reserved_remaining').notNull().default('0'),
    cancelReason: text('cancel_reason'),
    idempotencyKey: text('idempotency_key'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
    lastFilledAt: ts('last_filled_at'),
    completedAt: ts('completed_at'),
    cancelledAt: ts('cancelled_at'),
  },
  (t) => [
    index('orders_user_created_idx').on(t.userId, t.createdAt),
    index('orders_resting_idx')
      .on(t.assetId, t.side, t.limitPrice, t.createdAt)
      .where(sql`${t.status} in ('OPEN', 'PARTIALLY_FILLED')`),
    check('orders_side', sql`${t.side} in ('BUY', 'SELL')`),
    check('orders_type', sql`${t.type} in ('MARKET', 'LIMIT')`),
    check('orders_status', sql`${t.status} in ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED')`),
    check('orders_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'orders_quantity_reconciles',
      sql`${t.filledQuantity} >= 0 and ${t.remainingQuantity} >= 0 and ${t.filledQuantity} + ${t.remainingQuantity} = ${t.quantity}`,
    ),
    check(
      'orders_limit_price',
      sql`(${t.type} = 'LIMIT' and ${t.limitPrice} > 0) or (${t.type} = 'MARKET' and ${t.limitPrice} is null)`,
    ),
    check(
      'orders_reservation_bounds',
      sql`${t.reservedRemaining} >= 0 and ${t.reservedRemaining} <= ${t.reservedInitial}`,
    ),
    check(
      'orders_terminal_released',
      sql`${t.status} in ('OPEN', 'PARTIALLY_FILLED') or ${t.reservedRemaining} = 0`,
    ),
    check('orders_filled_complete', sql`${t.status} <> 'FILLED' or ${t.remainingQuantity} = 0`),
  ],
);

/** Append-only journal header. `id` is the global, deterministic ledger sequence. */
export const journals = pgTable(
  'journals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    type: text('type').notNull(),
    userId: uuid('user_id').references(() => users.id),
    orderId: uuid('order_id').references(() => orders.id),
    description: text('description').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('journals_user_created_idx').on(t.userId, t.createdAt, t.id),
    index('journals_order_idx').on(t.orderId),
    check(
      'journals_type',
      sql`${t.type} in ('FUNDING', 'ORDER_RESERVE', 'TRADE', 'ORDER_RELEASE')`,
    ),
  ],
);

/**
 * Append-only double-entry lines. Positive amount = increase of the account balance.
 * For every journal and instrument the amounts sum to zero (deferred constraint trigger).
 * `asset_id` and `created_at` are copied from the account / journal by a trigger.
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    journalId: bigint('journal_id', { mode: 'number' })
      .notNull()
      .references(() => journals.id),
    accountId: bigint('account_id', { mode: 'number' })
      .notNull()
      .references(() => accounts.id),
    assetId: integer('asset_id').references(() => assets.id),
    amount: cash('amount').notNull(),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    index('ledger_entries_account_created_idx').on(t.accountId, t.createdAt, t.journalId),
    index('ledger_entries_journal_idx').on(t.journalId),
    check('ledger_entries_amount_non_zero', sql`${t.amount} <> 0`),
  ],
);

/** Individual executions. Immutable; linked to the TRADE journal that settled it. */
export const trades = pgTable(
  'trades',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    side: text('side').notNull(),
    quantity: shares('quantity').notNull(),
    price: price('price').notNull(),
    notional: cash('notional').notNull(),
    liquidityLevel: integer('liquidity_level').notNull(),
    priceTickId: bigint('price_tick_id', { mode: 'number' })
      .notNull()
      .references(() => priceTicks.id),
    journalId: bigint('journal_id', { mode: 'number' })
      .notNull()
      .references(() => journals.id),
    executedAt: ts('executed_at').notNull(),
  },
  (t) => [
    index('trades_order_idx').on(t.orderId, t.id),
    index('trades_user_executed_idx').on(t.userId, t.executedAt),
    check('trades_positive', sql`${t.quantity} > 0 and ${t.price} > 0 and ${t.notional} > 0`),
    check('trades_notional_exact', sql`${t.notional} = ${t.quantity} * ${t.price}`),
  ],
);

/** Current weighted-average cost position (derived/cache; history is rebuilt from the ledger). */
export const positions = pgTable(
  'positions',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    assetId: integer('asset_id')
      .notNull()
      .references(() => assets.id),
    quantity: shares('quantity').notNull(),
    costBasis: cash('cost_basis').notNull(),
    realizedPnl: cash('realized_pnl').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.assetId] }),
    check('positions_non_negative', sql`${t.quantity} >= 0 and ${t.costBasis} >= 0`),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    orderId: uuid('order_id').references(() => orders.id),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: ts('created_at').notNull(),
  },
  (t) => [
    unique('idempotency_user_scope_key_uq').on(t.userId, t.scope, t.key),
    check('idempotency_key_length', sql`char_length(${t.key}) between 1 and 255`),
  ],
);
