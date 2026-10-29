import type { Tx } from '../../db/client.js';
import {
  applyBuyFill,
  applySellFill,
  EMPTY_POSITION,
  type PositionState,
} from '../../domain/cost-basis.js';
import type { PlannedFill } from '../../domain/liquidity.js';
import { Decimal, ZERO, dec, notional } from '../../domain/money.js';
import { restingStatus } from '../../domain/order-rules.js';
import type { CancelReason } from '../../domain/types.js';
import type { LedgerRepository, UserTradingAccounts } from '../ledger/ledger.repository.js';
import type { MarketRepository, MarketStateRow } from '../market/market.repository.js';
import type { OrderRepository, OrderRow, TradeRow } from './order.repository.js';

/**
 * Settles fills and reservation releases. Every method must be called inside a transaction that
 * already holds (in this order) the asset market-state lock (for fills), the order row and the
 * user's trading accounts.
 *
 * TRADE journal legs (amount > 0 increases the account):
 *   BUY  : user USD reserved  -q*L (LIMIT) or -q*p (MARKET)
 *          house USD          +q*p
 *          user USD available +q*(L-p)          (limit price improvement, LIMIT only)
 *          house shares       -q
 *          user shares avail  +q
 *   SELL : user shares reserved -q, house shares +q, house USD -q*p, user USD available +q*p
 */
export class TradeExecutor {
  constructor(
    private readonly ledger: LedgerRepository,
    private readonly orders: OrderRepository,
    private readonly market: MarketRepository,
  ) {}

  async applyFills(
    tx: Tx,
    ctx: {
      order: OrderRow;
      state: MarketStateRow;
      accounts: UserTradingAccounts;
      fills: PlannedFill[];
      now: Date;
    },
  ): Promise<{ order: OrderRow; trades: TradeRow[] }> {
    const { order, state, accounts, fills, now } = ctx;
    if (fills.length === 0) return { order, trades: [] };
    if (state.lastTickId === null) throw new Error('cannot fill without a price tick');

    const totalQty = fills.reduce((acc, f) => acc.add(f.quantity), ZERO);
    const remaining = dec(order.remainingQuantity);
    if (totalQty.gt(remaining)) throw new Error('fill exceeds remaining quantity');

    const houseCash = await this.ledger.getSystemAccount(tx, 'HOUSE_INVENTORY', null);
    const houseShares = await this.ledger.getSystemAccount(tx, 'HOUSE_INVENTORY', order.assetId);
    const limitPrice = order.limitPrice === null ? null : dec(order.limitPrice);

    const existing = await this.orders.getPosition(tx, order.userId, order.assetId);
    let position: PositionState = existing
      ? {
          quantity: dec(existing.quantity),
          costBasis: dec(existing.costBasis),
          realizedPnl: dec(existing.realizedPnl),
        }
      : EMPTY_POSITION;

    let reserved = dec(order.reservedRemaining);
    let filledNotional = dec(order.filledNotional);
    const trades: TradeRow[] = [];

    for (const fill of fills) {
      const value = fill.notional;
      let lines;
      if (order.side === 'BUY') {
        const reservedUsed = limitPrice ? notional(fill.quantity, limitPrice) : value;
        const improvement = reservedUsed.sub(value);
        if (improvement.lt(0)) throw new Error('buy filled above limit price');
        lines = [
          { account: accounts.cashReserved, amount: reservedUsed.neg() },
          { account: houseCash, amount: value },
          { account: accounts.cashAvailable, amount: improvement },
          { account: houseShares, amount: fill.quantity.neg() },
          { account: accounts.sharesAvailable, amount: fill.quantity },
        ];
        reserved = reserved.sub(reservedUsed);
        position = applyBuyFill(position, fill.quantity, value);
      } else {
        if (limitPrice && fill.price.lt(limitPrice))
          throw new Error('sell filled below limit price');
        lines = [
          { account: accounts.sharesReserved, amount: fill.quantity.neg() },
          { account: houseShares, amount: fill.quantity },
          { account: houseCash, amount: value.neg() },
          { account: accounts.cashAvailable, amount: value },
        ];
        reserved = reserved.sub(fill.quantity);
        position = applySellFill(position, fill.quantity, value).state;
      }
      if (reserved.lt(0)) throw new Error('reservation exhausted before fill');

      const journalId = await this.ledger.postJournal(tx, {
        type: 'TRADE',
        userId: order.userId,
        orderId: order.id,
        description: `${order.side} ${fill.quantity.toFixed()} @ ${fill.price.toFixed(2)} (level ${fill.level})`,
        createdAt: now,
        lines,
      });
      trades.push(
        await this.orders.insertTrade(tx, {
          orderId: order.id,
          userId: order.userId,
          assetId: order.assetId,
          side: order.side,
          quantity: fill.quantity.toFixed(),
          price: fill.price.toFixed(),
          notional: value.toFixed(),
          liquidityLevel: fill.level,
          priceTickId: state.lastTickId,
          journalId,
          executedAt: now,
        }),
      );
      filledNotional = filledNotional.add(value);
    }

    const filledQty = dec(order.filledQuantity).add(totalQty);
    const remainingQty = remaining.sub(totalQty);
    const status = restingStatus(filledQty, remainingQty);
    const updated = await this.orders.updateOrder(tx, order.id, {
      filledQuantity: filledQty.toFixed(),
      remainingQuantity: remainingQty.toFixed(),
      filledNotional: filledNotional.toFixed(),
      reservedRemaining: reserved.toFixed(),
      status,
      lastFilledAt: now,
      completedAt: status === 'FILLED' ? now : order.completedAt,
      updatedAt: now,
    });
    if (status === 'FILLED' && !reserved.isZero()) {
      throw new Error(`filled order ${order.id} still has reservation ${reserved.toFixed()}`);
    }

    await this.orders.upsertPosition(tx, {
      userId: order.userId,
      assetId: order.assetId,
      quantity: position.quantity.toFixed(),
      costBasis: position.costBasis.toFixed(),
      realizedPnl: position.realizedPnl.toFixed(),
      updatedAt: now,
    });

    const consumedField = order.side === 'BUY' ? 'askConsumed' : 'bidConsumed';
    const consumed = dec(state[consumedField]).add(totalQty);
    await this.market.updateState(tx, order.assetId, {
      [consumedField]: consumed.toFixed(),
      updatedAt: now,
    });
    state[consumedField] = consumed.toFixed();

    return { order: updated, trades };
  }

  /**
   * Releases whatever is still reserved for the order and makes it terminal (CANCELLED). Used for
   * user cancellation and for the unfilled remainder of MARKET (immediate-or-cancel) orders.
   */
  async cancelRemainder(
    tx: Tx,
    ctx: { order: OrderRow; accounts: UserTradingAccounts; reason: CancelReason; now: Date },
  ): Promise<OrderRow> {
    const { order, accounts, reason, now } = ctx;
    const reserved: Decimal = dec(order.reservedRemaining);
    if (reserved.gt(0)) {
      const [from, to] =
        order.side === 'BUY'
          ? [accounts.cashReserved, accounts.cashAvailable]
          : [accounts.sharesReserved, accounts.sharesAvailable];
      await this.ledger.postJournal(tx, {
        type: 'ORDER_RELEASE',
        userId: order.userId,
        orderId: order.id,
        description: `release ${reason}`,
        createdAt: now,
        lines: [
          { account: from, amount: reserved.neg() },
          { account: to, amount: reserved },
        ],
      });
    }
    return this.orders.updateOrder(tx, order.id, {
      status: 'CANCELLED',
      cancelReason: reason,
      reservedRemaining: '0',
      cancelledAt: now,
      completedAt: now,
      updatedAt: now,
    });
  }
}
