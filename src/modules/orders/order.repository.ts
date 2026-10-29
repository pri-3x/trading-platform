import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../../db/client.js';
import { assets, idempotencyRecords, orders, positions, trades } from '../../db/schema.js';
import type { OrderStatus } from '../../domain/types.js';

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type IdempotencyRow = typeof idempotencyRecords.$inferSelect;

export class OrderRepository {
  async insertOrder(tx: Tx, values: NewOrderRow): Promise<OrderRow> {
    const [row] = await tx.insert(orders).values(values).returning();
    if (!row) throw new Error('failed to insert order');
    return row;
  }

  async lockOrder(tx: Tx, orderId: string): Promise<OrderRow | null> {
    const [row] = await tx.select().from(orders).where(eq(orders.id, orderId)).for('update');
    return row ?? null;
  }

  async updateOrder(tx: Tx, orderId: string, patch: Partial<NewOrderRow>): Promise<OrderRow> {
    const [row] = await tx.update(orders).set(patch).where(eq(orders.id, orderId)).returning();
    if (!row) throw new Error(`order ${orderId} vanished`);
    return row;
  }

  async findOrder(db: DbOrTx, orderId: string): Promise<OrderRow | null> {
    const [row] = await db.select().from(orders).where(eq(orders.id, orderId));
    return row ?? null;
  }

  async listOrders(
    db: DbOrTx,
    userId: string,
    filter: {
      status?: OrderStatus | undefined;
      assetId?: number | undefined;
      limit: number;
      offset: number;
    },
  ): Promise<OrderRow[]> {
    const conditions = [eq(orders.userId, userId)];
    if (filter.status) conditions.push(eq(orders.status, filter.status));
    if (filter.assetId !== undefined) conditions.push(eq(orders.assetId, filter.assetId));
    return db
      .select()
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /** Resting orders of an asset in price-time priority (best price first, then oldest). */
  async restingOrderIds(db: DbOrTx, assetId: number): Promise<string[]> {
    const rows = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.assetId, assetId), inArray(orders.status, ['OPEN', 'PARTIALLY_FILLED'])))
      .orderBy(
        asc(orders.side),
        sql`case when ${orders.side} = 'BUY' then -${orders.limitPrice} else ${orders.limitPrice} end`,
        asc(orders.createdAt),
        asc(orders.id),
      );
    return rows.map((r) => r.id);
  }

  async insertTrade(tx: Tx, values: typeof trades.$inferInsert): Promise<TradeRow> {
    const [row] = await tx.insert(trades).values(values).returning();
    if (!row) throw new Error('failed to insert trade');
    return row;
  }

  async tradesForOrders(db: DbOrTx, orderIds: string[]): Promise<TradeRow[]> {
    if (orderIds.length === 0) return [];
    return db
      .select()
      .from(trades)
      .where(inArray(trades.orderId, orderIds))
      .orderBy(asc(trades.id));
  }

  async getPosition(db: DbOrTx, userId: string, assetId: number): Promise<PositionRow | null> {
    const [row] = await db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.assetId, assetId)));
    return row ?? null;
  }

  async upsertPosition(tx: Tx, row: typeof positions.$inferInsert): Promise<void> {
    await tx
      .insert(positions)
      .values(row)
      .onConflictDoUpdate({
        target: [positions.userId, positions.assetId],
        set: {
          quantity: row.quantity,
          costBasis: row.costBasis,
          realizedPnl: row.realizedPnl,
          updatedAt: row.updatedAt,
        },
      });
  }

  async listPositions(db: DbOrTx, userId: string): Promise<PositionRow[]> {
    return db.select().from(positions).where(eq(positions.userId, userId));
  }

  async assetSymbols(db: DbOrTx): Promise<Map<number, string>> {
    const rows = await db.select({ id: assets.id, symbol: assets.symbol }).from(assets);
    return new Map(rows.map((r) => [r.id, r.symbol]));
  }

  /**
   * Claims an idempotency key inside the caller's transaction. If another transaction holds or has
   * committed the same (user, scope, key), PostgreSQL makes this INSERT wait for it and then report
   * the conflict, so at most one logical order can ever be created per key.
   */
  async claimIdempotencyKey(
    tx: Tx,
    values: { userId: string; scope: string; key: string; requestHash: string; createdAt: Date },
  ): Promise<boolean> {
    const rows = await tx
      .insert(idempotencyRecords)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: idempotencyRecords.id });
    return rows.length === 1;
  }

  async findIdempotencyRecord(
    db: DbOrTx,
    userId: string,
    scope: string,
    key: string,
  ): Promise<IdempotencyRow | null> {
    const [row] = await db
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.userId, userId),
          eq(idempotencyRecords.scope, scope),
          eq(idempotencyRecords.key, key),
        ),
      );
    return row ?? null;
  }

  async completeIdempotencyRecord(
    tx: Tx,
    where: { userId: string; scope: string; key: string },
    result: { orderId: string; responseStatus: number; responseBody: unknown },
  ): Promise<void> {
    await tx
      .update(idempotencyRecords)
      .set(result)
      .where(
        and(
          eq(idempotencyRecords.userId, where.userId),
          eq(idempotencyRecords.scope, where.scope),
          eq(idempotencyRecords.key, where.key),
        ),
      );
  }
}
