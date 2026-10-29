import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';

export interface BalanceAggregate {
  assetId: number | null;
  type: 'USER_AVAILABLE' | 'USER_RESERVED';
  amount: string;
}

export interface TradeJournalLine {
  journalId: number;
  createdAt: Date;
  assetId: number | null;
  amount: string;
}

/**
 * Read-side queries over the immutable ledger used for historical reconstruction. All of them
 * are bounded by the user's own accounts / journals and the cutoff, and use the
 * (account_id, created_at, journal_id) and (user_id, created_at, id) indexes.
 * The cutoff is inclusive: an event is part of the state at T iff created_at <= T.
 */
export class PortfolioRepository {
  async balancesAt(db: DbOrTx, userId: string, at: string): Promise<BalanceAggregate[]> {
    const result = await db.execute<{ asset_id: number | null; type: string; amount: string }>(sql`
      select a.asset_id, a.type, sum(le.amount) as amount
        from accounts a
        join ledger_entries le on le.account_id = a.id
       where a.user_id = ${userId}
         and le.created_at <= ${at}::timestamptz
       group by a.asset_id, a.type`);
    return result.rows.map((r) => ({
      assetId: r.asset_id === null ? null : Number(r.asset_id),
      type: r.type as BalanceAggregate['type'],
      amount: r.amount,
    }));
  }

  /**
   * The user's own ledger lines of every TRADE journal up to the cutoff, in deterministic ledger
   * order (created_at, journal id, line id). Cost basis is replayed from these lines only.
   */
  async tradeLinesUntil(db: DbOrTx, userId: string, at: string): Promise<TradeJournalLine[]> {
    const result = await db.execute<{
      journal_id: string;
      created_at: string;
      asset_id: number | null;
      amount: string;
    }>(sql`
      select j.id as journal_id, j.created_at, le.asset_id, le.amount
        from journals j
        join ledger_entries le on le.journal_id = j.id
        join accounts a on a.id = le.account_id and a.user_id = ${userId}
       where j.user_id = ${userId}
         and j.type = 'TRADE'
         and j.created_at <= ${at}::timestamptz
       order by j.created_at, j.id, le.id`);
    return result.rows.map((r) => ({
      journalId: Number(r.journal_id),
      createdAt: new Date(r.created_at),
      assetId: r.asset_id === null ? null : Number(r.asset_id),
      amount: r.amount,
    }));
  }

  /** Outstanding reservations per order at the cutoff, derived purely from RESERVED-account lines. */
  async reservationsAt(db: DbOrTx, userId: string, at: string) {
    const result = await db.execute<{
      order_id: string;
      asset_id: number | null;
      amount: string;
    }>(sql`
      select j.order_id, le.asset_id, sum(le.amount) as amount
        from journals j
        join ledger_entries le on le.journal_id = j.id
        join accounts a on a.id = le.account_id and a.user_id = ${userId} and a.type = 'USER_RESERVED'
       where j.user_id = ${userId}
         and j.created_at <= ${at}::timestamptz
         and j.order_id is not null
       group by j.order_id, le.asset_id
      having sum(le.amount) <> 0
       order by j.order_id`);
    return result.rows.map((r) => ({
      orderId: r.order_id,
      assetId: r.asset_id === null ? null : Number(r.asset_id),
      amount: r.amount,
    }));
  }

  /** Last ledger event (sequence + timestamp) included in the reconstruction. */
  async lastJournalAt(
    db: DbOrTx,
    userId: string,
    at: string,
  ): Promise<{ id: number; createdAt: Date } | null> {
    const result = await db.execute<{ id: string; created_at: string }>(sql`
      select id, created_at from journals
       where user_id = ${userId} and created_at <= ${at}::timestamptz
       order by created_at desc, id desc
       limit 1`);
    const row = result.rows[0];
    return row ? { id: Number(row.id), createdAt: new Date(row.created_at) } : null;
  }
}
