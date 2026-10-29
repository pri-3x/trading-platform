import type { Db } from '../../db/client.js';
import {
  applyBuyFill,
  applySellFill,
  EMPTY_POSITION,
  type PositionState,
} from '../../domain/cost-basis.js';
import { Decimal, ZERO, dec, fmtCash, fmtShares } from '../../domain/money.js';
import type { Clock } from '../../lib/clock.js';
import { ValidationError } from '../../lib/errors.js';
import type { LedgerRepository } from '../ledger/ledger.repository.js';
import type { MarketRepository } from '../market/market.repository.js';
import type { OrderRepository } from '../orders/order.repository.js';
import type { PortfolioRepository, TradeJournalLine } from './portfolio.repository.js';
import { buildValuation, type HoldingInput } from './valuation.js';

/**
 * Replays the user's TRADE journals in ledger order and rebuilds weighted-average cost positions.
 * A journal's net effect on the user's own accounts identifies the fill:
 *   BUY : shares +q, USD -cost   (reserved->available improvement legs net to zero)
 *   SELL: shares -q, USD +proceeds
 */
export function replayPositions(lines: TradeJournalLine[]): Map<number, PositionState> {
  const positions = new Map<number, PositionState>();
  const journals = new Map<number, { assetId: number | null; shares: Decimal; cash: Decimal }>();
  const order: number[] = [];
  for (const line of lines) {
    let j = journals.get(line.journalId);
    if (!j) {
      j = { assetId: null, shares: ZERO, cash: ZERO };
      journals.set(line.journalId, j);
      order.push(line.journalId);
    }
    if (line.assetId === null) j.cash = j.cash.add(line.amount);
    else {
      j.assetId = line.assetId;
      j.shares = j.shares.add(line.amount);
    }
  }
  for (const id of order) {
    const j = journals.get(id)!;
    if (j.assetId === null || j.shares.isZero()) continue;
    const current = positions.get(j.assetId) ?? EMPTY_POSITION;
    positions.set(
      j.assetId,
      j.shares.gt(0)
        ? applyBuyFill(current, j.shares, j.cash.neg())
        : applySellFill(current, j.shares.neg(), j.cash).state,
    );
  }
  return positions;
}

/** Inclusive cutoff timestamps must be ISO-8601 with an explicit timezone. */
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,6})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Strict calendar validation (JavaScript would silently roll 2026-02-30 over to March). */
export function parseCutoff(raw: string): Date | null {
  const m = ISO_WITH_ZONE.exec(raw);
  if (!m) return null;
  const [year, month, day, hour, minute, second = '0', offH = '0', offM = '0'] = m
    .slice(1)
    .map((v) => v ?? undefined);
  const daysInMonth = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth)
    return null;
  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offH) > 14 ||
    Number(offM) > 59
  )
    return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export class PortfolioService {
  constructor(
    private readonly db: Db,
    private readonly ledger: LedgerRepository,
    private readonly orders: OrderRepository,
    private readonly market: MarketRepository,
    private readonly portfolio: PortfolioRepository,
    private readonly clock: Clock,
  ) {}

  /** Current portfolio from the live balance cache and positions, read in one consistent snapshot. */
  async current(userId: string) {
    return this.db.transaction(
      async (tx) => {
        const now = this.clock.now();
        const [accounts, positions, assets] = await Promise.all([
          this.ledger.listUserAccounts(tx, userId),
          this.orders.listPositions(tx, userId),
          this.market.listAssets(tx),
        ]);
        const bal = (assetId: number | null, type: string) =>
          dec(accounts.find((a) => a.assetId === assetId && a.type === type)?.balance ?? '0');
        const holdings: HoldingInput[] = assets.map(({ asset, state }) => {
          const p = positions.find((x) => x.assetId === asset.id);
          return {
            symbol: asset.symbol,
            available: bal(asset.id, 'USER_AVAILABLE'),
            reserved: bal(asset.id, 'USER_RESERVED'),
            position: p
              ? {
                  quantity: dec(p.quantity),
                  costBasis: dec(p.costBasis),
                  realizedPnl: dec(p.realizedPnl),
                }
              : EMPTY_POSITION,
            price: state?.lastPrice ?? null,
            priceObservedAt: state?.lastTickAt ?? null,
          };
        });
        return {
          userId,
          asOf: now.toISOString(),
          ...buildValuation(
            { available: bal(null, 'USER_AVAILABLE'), reserved: bal(null, 'USER_RESERVED') },
            holdings,
          ),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  /**
   * Historical reconstruction. Uses ONLY immutable data: ledger entries / journals with
   * created_at <= at, and price ticks with observed_at <= at. No mutable table (accounts.balance,
   * positions, orders.status) is read, so later activity can never change the result.
   */
  async historyAt(userId: string, atRaw: string) {
    const requested = parseCutoff(atRaw);
    if (!requested) {
      throw new ValidationError(
        'at must be an ISO-8601 timestamp with timezone, e.g. 2026-01-01T12:00:00Z',
        {
          field: 'at',
        },
        'INVALID_TIMESTAMP',
      );
    }
    const now = this.clock.now();
    if (requested.getTime() > now.getTime()) {
      throw new ValidationError(
        'at must not be in the future',
        { field: 'at', now: now.toISOString() },
        'TIMESTAMP_IN_FUTURE',
      );
    }

    return this.db.transaction(
      async (tx) => {
        const [balances, tradeLines, reservations, prices, lastJournal, assets] = await Promise.all(
          [
            this.portfolio.balancesAt(tx, userId, atRaw),
            this.portfolio.tradeLinesUntil(tx, userId, atRaw),
            this.portfolio.reservationsAt(tx, userId, atRaw),
            this.market.pricesAt(tx, atRaw),
            this.portfolio.lastJournalAt(tx, userId, atRaw),
            this.market.listAssets(tx),
          ],
        );
        const symbolOf = new Map(assets.map(({ asset }) => [asset.id, asset.symbol]));
        const bal = (assetId: number | null, type: string) =>
          dec(balances.find((b) => b.assetId === assetId && b.type === type)?.amount ?? '0');
        const positions = replayPositions(tradeLines);

        const holdings: HoldingInput[] = assets.map(({ asset }) => {
          const px = prices.find((p) => p.assetId === asset.id);
          return {
            symbol: asset.symbol,
            available: bal(asset.id, 'USER_AVAILABLE'),
            reserved: bal(asset.id, 'USER_RESERVED'),
            position: positions.get(asset.id) ?? EMPTY_POSITION,
            price: px?.price ?? null,
            priceObservedAt: px?.observedAt ?? null,
          };
        });
        const valuation = buildValuation(
          { available: bal(null, 'USER_AVAILABLE'), reserved: bal(null, 'USER_RESERVED') },
          holdings,
        );

        // Effective time of the reconstructed state: the newest input actually used.
        const usedPriceTimes = valuation.positions
          .map((p) => (p.priceObservedAt ? Date.parse(p.priceObservedAt) : null))
          .filter((t): t is number => t !== null);
        const candidates = [
          ...usedPriceTimes,
          ...(lastJournal ? [lastJournal.createdAt.getTime()] : []),
        ];
        const valuationTimestamp =
          candidates.length > 0 ? new Date(Math.max(...candidates)).toISOString() : null;

        return {
          userId,
          requestedAt: requested.toISOString(),
          valuationTimestamp,
          ledger: {
            lastJournalSequence: lastJournal?.id ?? null,
            lastEventAt: lastJournal?.createdAt.toISOString() ?? null,
            boundary:
              'inclusive: events with created_at <= requestedAt, ordered by (created_at, journal sequence)',
          },
          ...valuation,
          reservations: reservations.map((r) => ({
            orderId: r.orderId,
            instrument: r.assetId === null ? 'USD' : (symbolOf.get(r.assetId) ?? '?'),
            amount: r.assetId === null ? fmtCash(r.amount) : fmtShares(r.amount),
          })),
          pricesUsed: prices.map((p) => ({
            symbol: symbolOf.get(p.assetId) ?? '?',
            price: p.price,
            observedAt: p.observedAt?.toISOString() ?? null,
          })),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
