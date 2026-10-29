import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { isHalted, retryAfterSeconds } from '../../domain/circuit-breaker.js';
import {
  buildLadder,
  ladderSideFor,
  planFills,
  sumNotional,
  sumQuantity,
} from '../../domain/liquidity.js';
import { dec, fmtCash, fmtShares, notional } from '../../domain/money.js';
import {
  assertMinimumNotional,
  isCancellable,
  validateOrderRequest,
  type OrderRequest,
  type ValidatedOrder,
} from '../../domain/order-rules.js';
import type { OrderStatus } from '../../domain/types.js';
import type { Clock } from '../../lib/clock.js';
import {
  BusinessRuleError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from '../../lib/errors.js';
import { balanceOf, type LedgerRepository } from '../ledger/ledger.repository.js';
import type { MarketRepository } from '../market/market.repository.js';
import { toOrderDto, type OrderDto } from './order.dto.js';
import type { OrderRepository } from './order.repository.js';
import type { TradeExecutor } from './trade-executor.js';

export const PLACE_ORDER_SCOPE = 'POST /orders';

export interface PlaceOrderResult {
  statusCode: number;
  body: OrderDto;
  replayed: boolean;
}

/** Canonical hash of the semantic request, so "2.5" and "2.50" are the same payload. */
export function hashOrderRequest(order: ValidatedOrder): string {
  const canonical = JSON.stringify({
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    quantity: order.quantity.toFixed(),
    limitPrice: order.limitPrice?.toFixed() ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class OrderService {
  constructor(
    private readonly db: Db,
    private readonly orders: OrderRepository,
    private readonly ledger: LedgerRepository,
    private readonly market: MarketRepository,
    private readonly executor: TradeExecutor,
    private readonly clock: Clock,
    private readonly config: Pick<AppConfig, 'liquidity' | 'trading'>,
    private readonly logger: Logger,
  ) {}

  /**
   * Places an order atomically. Lock order: idempotency key -> asset market state -> user
   * accounts -> (house accounts via ledger trigger). Any error rolls back everything, including
   * the idempotency claim, so a failed request leaves no trace and may be retried with the same key.
   */
  async placeOrder(
    userId: string,
    request: OrderRequest,
    idempotencyKey: string,
  ): Promise<PlaceOrderResult> {
    if (!/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
      throw new ValidationError(
        'Idempotency-Key must be 1-255 printable ASCII characters',
        undefined,
        'INVALID_IDEMPOTENCY_KEY',
      );
    }
    const order = validateOrderRequest(request, this.config.trading);
    const asset = await this.market.findAssetBySymbol(this.db, order.symbol);
    if (!asset)
      throw new ValidationError(
        `unknown symbol ${order.symbol}`,
        { field: 'symbol' },
        'UNKNOWN_SYMBOL',
      );
    const requestHash = hashOrderRequest(order);

    return this.db.transaction(async (tx) => {
      const claimed = await this.orders.claimIdempotencyKey(tx, {
        userId,
        scope: PLACE_ORDER_SCOPE,
        key: idempotencyKey,
        requestHash,
        createdAt: this.clock.now(),
      });
      if (!claimed) {
        const existing = await this.orders.findIdempotencyRecord(
          tx,
          userId,
          PLACE_ORDER_SCOPE,
          idempotencyKey,
        );
        if (!existing || existing.responseBody === null || existing.responseStatus === null) {
          throw new ConflictError(
            'IDEMPOTENCY_IN_PROGRESS',
            'a request with this Idempotency-Key is still being processed',
          );
        }
        if (existing.requestHash !== requestHash) {
          throw new ConflictError(
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used with a different request payload',
            { orderId: existing.orderId },
          );
        }
        return {
          statusCode: existing.responseStatus,
          body: existing.responseBody as OrderDto,
          replayed: true,
        };
      }

      const state = await this.market.lockState(tx, asset.id);
      const lockedAt = this.clock.now();
      if (isHalted(state.haltedUntil, lockedAt)) {
        const retryAfter = retryAfterSeconds(state.haltedUntil!, lockedAt);
        throw new ServiceUnavailableError(
          'CIRCUIT_BREAKER_ACTIVE',
          `trading in ${asset.symbol} is halted until ${state.haltedUntil!.toISOString()}`,
          retryAfter,
          {
            symbol: asset.symbol,
            haltedUntil: state.haltedUntil!.toISOString(),
            retryAfterSeconds: retryAfter,
          },
        );
      }
      if (state.lastPrice === null || state.lastTickId === null) {
        throw new ServiceUnavailableError(
          'MARKET_DATA_UNAVAILABLE',
          `no price available for ${asset.symbol}`,
          5,
        );
      }
      const mid = dec(state.lastPrice);
      assertMinimumNotional(order, mid, this.config.trading);

      const accounts = await this.ledger.lockUserTradingAccounts(tx, userId, asset.id);
      // Timestamp taken only after all locks are held (see LedgerRepository.monotonicNow).
      const now = await this.ledger.monotonicNow(tx, userId, this.clock.now());
      const ladder = buildLadder(mid, ladderSideFor(order.side), this.config.liquidity);
      const alreadyConsumed = dec(order.side === 'BUY' ? state.askConsumed : state.bidConsumed);
      const fills = planFills({
        side: order.side,
        quantity: order.quantity,
        limitPrice: order.limitPrice,
        ladder,
        alreadyConsumed,
      });

      // Reservation: LIMIT BUY reserves qty x limit; MARKET BUY reserves the exact cost of its
      // planned fills (it never rests); SELL reserves the full quantity of shares.
      let reservation;
      if (order.side === 'BUY') {
        reservation = order.limitPrice
          ? notional(order.quantity, order.limitPrice)
          : sumNotional(fills);
        const available = balanceOf(accounts.cashAvailable);
        if (reservation.gt(available)) {
          throw new BusinessRuleError('INSUFFICIENT_FUNDS', 'insufficient available USD balance', {
            required: fmtCash(reservation),
            available: fmtCash(available),
          });
        }
      } else {
        reservation = order.quantity;
        const available = balanceOf(accounts.sharesAvailable);
        if (reservation.gt(available)) {
          throw new BusinessRuleError(
            'INSUFFICIENT_SHARES',
            `insufficient available ${asset.symbol} shares`,
            {
              required: fmtShares(reservation),
              available: fmtShares(available),
            },
          );
        }
      }

      let row = await this.orders.insertOrder(tx, {
        userId,
        assetId: asset.id,
        side: order.side,
        type: order.type,
        status: 'OPEN',
        quantity: order.quantity.toFixed(),
        remainingQuantity: order.quantity.toFixed(),
        limitPrice: order.limitPrice?.toFixed() ?? null,
        reservedInitial: reservation.toFixed(),
        reservedRemaining: reservation.toFixed(),
        idempotencyKey,
        createdAt: now,
        updatedAt: now,
      });

      if (reservation.gt(0)) {
        const [from, to] =
          order.side === 'BUY'
            ? [accounts.cashAvailable, accounts.cashReserved]
            : [accounts.sharesAvailable, accounts.sharesReserved];
        await this.ledger.postJournal(tx, {
          type: 'ORDER_RESERVE',
          userId,
          orderId: row.id,
          description: `reserve for ${order.type} ${order.side} ${order.quantity.toFixed()} ${asset.symbol}`,
          createdAt: now,
          lines: [
            { account: from, amount: reservation.neg() },
            { account: to, amount: reservation },
          ],
        });
      }

      const executed = await this.executor.applyFills(tx, {
        order: row,
        state,
        accounts,
        fills,
        now,
      });
      row = executed.order;

      // MARKET orders are immediate-or-cancel: any unfilled remainder is cancelled right away.
      if (order.type === 'MARKET' && row.status !== 'FILLED') {
        row = await this.executor.cancelRemainder(tx, {
          order: row,
          accounts,
          reason: sumQuantity(fills).gt(0) ? 'IOC_REMAINDER' : 'NO_LIQUIDITY',
          now,
        });
      }

      const body = toOrderDto(row, asset.symbol, executed.trades);
      await this.orders.completeIdempotencyRecord(
        tx,
        { userId, scope: PLACE_ORDER_SCOPE, key: idempotencyKey },
        { orderId: row.id, responseStatus: 201, responseBody: body },
      );
      this.logger.info(
        {
          orderId: row.id,
          userId,
          symbol: asset.symbol,
          side: order.side,
          type: order.type,
          status: row.status,
        },
        'order placed',
      );
      return { statusCode: 201, body, replayed: false };
    });
  }

  /**
   * Cancels the open remainder of an order. Locks the order row first, then the accounts, which is
   * the same order the matcher uses, so a fill and a cancel can never both consume the remainder.
   * Prior fills are preserved; a partially filled order ends CANCELLED with its fills intact.
   */
  async cancelOrder(userId: string, orderId: string): Promise<OrderDto> {
    const symbols = await this.orders.assetSymbols(this.db);
    return this.db.transaction(async (tx) => {
      const order = await this.orders.lockOrder(tx, orderId);
      // Other users' orders are indistinguishable from missing ones (no existence oracle).
      if (!order || order.userId !== userId)
        throw new NotFoundError(`order ${orderId} not found`, 'ORDER_NOT_FOUND');
      if (!isCancellable(order.status as OrderStatus)) {
        throw new ConflictError(
          'ORDER_NOT_CANCELLABLE',
          `order is ${order.status} and cannot be cancelled`,
          {
            status: order.status,
          },
        );
      }
      const accounts = await this.ledger.lockUserTradingAccounts(tx, userId, order.assetId);
      const now = await this.ledger.monotonicNow(tx, userId, this.clock.now());
      const cancelled = await this.executor.cancelRemainder(tx, {
        order,
        accounts,
        reason: 'USER_REQUESTED',
        now,
      });
      const trades = await this.orders.tradesForOrders(tx, [order.id]);
      this.logger.info({ orderId, userId }, 'order cancelled');
      return toOrderDto(cancelled, symbols.get(order.assetId) ?? '?', trades);
    });
  }

  async getOrder(userId: string, orderId: string): Promise<OrderDto> {
    const order = await this.orders.findOrder(this.db, orderId);
    if (!order || order.userId !== userId)
      throw new NotFoundError(`order ${orderId} not found`, 'ORDER_NOT_FOUND');
    const [symbols, trades] = await Promise.all([
      this.orders.assetSymbols(this.db),
      this.orders.tradesForOrders(this.db, [order.id]),
    ]);
    return toOrderDto(order, symbols.get(order.assetId) ?? '?', trades);
  }

  async listOrders(
    userId: string,
    filter: {
      status?: OrderStatus | undefined;
      symbol?: string | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<OrderDto[]> {
    let assetId: number | undefined;
    if (filter.symbol) {
      const asset = await this.market.findAssetBySymbol(this.db, filter.symbol);
      if (!asset) return [];
      assetId = asset.id;
    }
    const rows = await this.orders.listOrders(this.db, userId, { ...filter, assetId });
    const [symbols, trades] = await Promise.all([
      this.orders.assetSymbols(this.db),
      this.orders.tradesForOrders(
        this.db,
        rows.map((r) => r.id),
      ),
    ]);
    return rows.map((r) =>
      toOrderDto(
        r,
        symbols.get(r.assetId) ?? '?',
        trades.filter((t) => t.orderId === r.id),
      ),
    );
  }
}
