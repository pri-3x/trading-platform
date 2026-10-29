import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { isHalted } from '../../domain/circuit-breaker.js';
import { buildLadder, ladderSideFor, planFills } from '../../domain/liquidity.js';
import { dec } from '../../domain/money.js';
import type { OrderSide } from '../../domain/types.js';
import type { Clock } from '../../lib/clock.js';
import type { LedgerRepository } from '../ledger/ledger.repository.js';
import type { MarketRepository } from '../market/market.repository.js';
import type { OrderRepository } from './order.repository.js';
import type { TradeExecutor } from './trade-executor.js';

export interface MatchSummary {
  ordersExamined: number;
  ordersFilled: number;
  fills: number;
  halted: boolean;
}

/**
 * Re-evaluates resting LIMIT orders of one asset against the current tick's liquidity ladder,
 * in price-time priority. Each order is matched in its own short transaction holding:
 * asset market state -> order row -> user accounts. While the asset's circuit breaker is active
 * resting orders are frozen (not matched) but remain cancellable.
 */
export class MatchingService {
  constructor(
    private readonly db: Db,
    private readonly orders: OrderRepository,
    private readonly ledger: LedgerRepository,
    private readonly market: MarketRepository,
    private readonly executor: TradeExecutor,
    private readonly clock: Clock,
    private readonly liquidity: AppConfig['liquidity'],
    private readonly logger: Logger,
  ) {}

  async matchAsset(assetId: number): Promise<MatchSummary> {
    const summary: MatchSummary = { ordersExamined: 0, ordersFilled: 0, fills: 0, halted: false };
    const ids = await this.orders.restingOrderIds(this.db, assetId);
    for (const id of ids) {
      const outcome = await this.db.transaction(async (tx) => {
        const state = await this.market.lockState(tx, assetId);
        if (isHalted(state.haltedUntil, this.clock.now())) return 'HALTED' as const;
        if (state.lastPrice === null) return 'NO_PRICE' as const;
        const order = await this.orders.lockOrder(tx, id);
        if (!order || (order.status !== 'OPEN' && order.status !== 'PARTIALLY_FILLED'))
          return 'SKIPPED' as const;
        const side = order.side as OrderSide;
        const fills = planFills({
          side,
          quantity: dec(order.remainingQuantity),
          limitPrice: order.limitPrice === null ? null : dec(order.limitPrice),
          ladder: buildLadder(state.lastPrice, ladderSideFor(side), this.liquidity),
          alreadyConsumed: dec(side === 'BUY' ? state.askConsumed : state.bidConsumed),
        });
        if (fills.length === 0) return 'NO_FILL' as const;
        const accounts = await this.ledger.lockUserTradingAccounts(tx, order.userId, assetId);
        const now = await this.ledger.monotonicNow(tx, order.userId, this.clock.now());
        await this.executor.applyFills(tx, { order, state, accounts, fills, now });
        return fills.length;
      });
      summary.ordersExamined++;
      if (outcome === 'HALTED') {
        summary.halted = true;
        break;
      }
      if (outcome === 'NO_PRICE') break;
      if (typeof outcome === 'number') {
        summary.ordersFilled++;
        summary.fills += outcome;
      }
    }
    if (summary.fills > 0) this.logger.info({ assetId, ...summary }, 'resting orders matched');
    return summary;
  }
}
