import { and, asc, desc, eq, gt, gte, lte, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../../db/client.js';
import { assetMarketState, assets, circuitBreakerEvents, priceTicks } from '../../db/schema.js';

export type AssetRow = typeof assets.$inferSelect;
export type MarketStateRow = typeof assetMarketState.$inferSelect;
export type PriceTickRow = typeof priceTicks.$inferSelect;
export type BreakerEventRow = typeof circuitBreakerEvents.$inferSelect;

export class MarketRepository {
  async listAssets(db: DbOrTx): Promise<Array<{ asset: AssetRow; state: MarketStateRow | null }>> {
    const rows = await db
      .select({ asset: assets, state: assetMarketState })
      .from(assets)
      .leftJoin(assetMarketState, eq(assetMarketState.assetId, assets.id))
      .orderBy(asc(assets.id));
    return rows;
  }

  async findAssetBySymbol(db: DbOrTx, symbol: string): Promise<AssetRow | null> {
    const [row] = await db.select().from(assets).where(eq(assets.symbol, symbol));
    return row ?? null;
  }

  async getState(db: DbOrTx, assetId: number): Promise<MarketStateRow | null> {
    const [row] = await db
      .select()
      .from(assetMarketState)
      .where(eq(assetMarketState.assetId, assetId));
    return row ?? null;
  }

  /** Row lock that serialises all trading activity of one asset. */
  async lockState(tx: Tx, assetId: number): Promise<MarketStateRow> {
    const [row] = await tx
      .select()
      .from(assetMarketState)
      .where(eq(assetMarketState.assetId, assetId))
      .for('update');
    if (!row) throw new Error(`market state missing for asset ${assetId}`);
    return row;
  }

  async updateState(
    tx: Tx,
    assetId: number,
    patch: Partial<Omit<MarketStateRow, 'assetId'>>,
  ): Promise<void> {
    await tx.update(assetMarketState).set(patch).where(eq(assetMarketState.assetId, assetId));
  }

  /** Inserts a tick; returns null if a tick for that asset+timestamp already exists. */
  async insertTick(
    tx: Tx,
    tick: {
      assetId: number;
      price: string;
      observedAt: Date;
      source: 'SEED' | 'SIMULATOR' | 'MANUAL';
    },
  ): Promise<PriceTickRow | null> {
    const [row] = await tx.insert(priceTicks).values(tick).onConflictDoNothing().returning();
    return row ?? null;
  }

  /**
   * Reference observation for the circuit breaker: latest tick at or before `boundary`, else the
   * earliest tick in (boundary, now]. Both lookups are index range scans on (asset_id, observed_at).
   */
  async findReferenceTick(
    db: DbOrTx,
    assetId: number,
    boundary: Date,
    now: Date,
  ): Promise<PriceTickRow | null> {
    const [before] = await db
      .select()
      .from(priceTicks)
      .where(and(eq(priceTicks.assetId, assetId), lte(priceTicks.observedAt, boundary)))
      .orderBy(desc(priceTicks.observedAt), desc(priceTicks.id))
      .limit(1);
    if (before) return before;
    const [earliest] = await db
      .select()
      .from(priceTicks)
      .where(
        and(
          eq(priceTicks.assetId, assetId),
          gt(priceTicks.observedAt, boundary),
          lte(priceTicks.observedAt, now),
        ),
      )
      .orderBy(asc(priceTicks.observedAt), asc(priceTicks.id))
      .limit(1);
    return earliest ?? null;
  }

  async insertBreakerEvent(
    tx: Tx,
    event: typeof circuitBreakerEvents.$inferInsert,
  ): Promise<BreakerEventRow> {
    const [row] = await tx.insert(circuitBreakerEvents).values(event).returning();
    if (!row) throw new Error('failed to insert breaker event');
    return row;
  }

  async priceHistory(
    db: DbOrTx,
    assetId: number,
    opts: { from?: Date | undefined; to?: Date | undefined; limit: number },
  ): Promise<PriceTickRow[]> {
    const conditions = [eq(priceTicks.assetId, assetId)];
    if (opts.from) conditions.push(gte(priceTicks.observedAt, opts.from));
    if (opts.to) conditions.push(lte(priceTicks.observedAt, opts.to));
    // newest N within range, returned in chronological order
    const rows = await db
      .select()
      .from(priceTicks)
      .where(and(...conditions))
      .orderBy(desc(priceTicks.observedAt), desc(priceTicks.id))
      .limit(opts.limit);
    return rows.reverse();
  }

  async recentBreakerEvents(
    db: DbOrTx,
    assetId: number,
    limit: number,
  ): Promise<BreakerEventRow[]> {
    return db
      .select()
      .from(circuitBreakerEvents)
      .where(eq(circuitBreakerEvents.assetId, assetId))
      .orderBy(desc(circuitBreakerEvents.triggeredAt), desc(circuitBreakerEvents.id))
      .limit(limit);
  }

  /** Latest price at or before `at` per asset (LATERAL + index, bounded by the asset count). */
  async pricesAt(
    db: DbOrTx,
    at: string,
  ): Promise<
    Array<{ assetId: number; price: string | null; observedAt: Date | null; tickId: number | null }>
  > {
    const result = await db.execute<{
      asset_id: number;
      price: string | null;
      observed_at: string | null;
      tick_id: string | null;
    }>(sql`
      select a.id as asset_id, p.price, p.observed_at, p.id as tick_id
        from assets a
        left join lateral (
          select t.price, t.observed_at, t.id
            from price_ticks t
           where t.asset_id = a.id and t.observed_at <= ${at}::timestamptz
           order by t.observed_at desc, t.id desc
           limit 1
        ) p on true
       order by a.id`);
    return result.rows.map((r) => ({
      assetId: Number(r.asset_id),
      price: r.price,
      observedAt: r.observed_at ? new Date(r.observed_at) : null,
      tickId: r.tick_id === null ? null : Number(r.tick_id),
    }));
  }
}
