import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../../db/client.js';
import { accounts, journals, ledgerEntries } from '../../db/schema.js';
import { Decimal, ZERO, dec } from '../../domain/money.js';
import type { AccountType, JournalType } from '../../domain/types.js';

export interface AccountRow {
  id: number;
  userId: string | null;
  assetId: number | null;
  type: string;
  balance: string;
}

/** The four user accounts touched by an order on one asset. */
export interface UserTradingAccounts {
  cashAvailable: AccountRow;
  cashReserved: AccountRow;
  sharesAvailable: AccountRow;
  sharesReserved: AccountRow;
}

export interface JournalLine {
  account: Pick<AccountRow, 'id' | 'assetId'>;
  amount: Decimal;
}

export interface NewJournal {
  type: JournalType;
  userId: string | null;
  orderId?: string | null;
  description: string;
  createdAt: Date;
  lines: JournalLine[];
}

/** Persistence for ledger accounts and append-only journals. */
export class LedgerRepository {
  /** Idempotently creates the AVAILABLE/RESERVED accounts of a user for one instrument. */
  async ensureUserAccounts(tx: Tx, userId: string, assetId: number | null): Promise<void> {
    await tx
      .insert(accounts)
      .values(
        (['USER_AVAILABLE', 'USER_RESERVED'] as const).map((type) => ({ userId, assetId, type })),
      )
      .onConflictDoNothing();
  }

  /** Idempotently creates a system account (house inventory, external funding source). */
  async ensureSystemAccount(tx: Tx, type: AccountType, assetId: number | null): Promise<void> {
    await tx
      .insert(accounts)
      .values({ userId: null, assetId, type, allowNegative: true })
      .onConflictDoNothing();
  }

  async getSystemAccount(
    db: DbOrTx,
    type: AccountType,
    assetId: number | null,
  ): Promise<AccountRow> {
    const [row] = await db
      .select()
      .from(accounts)
      .where(
        and(
          isNull(accounts.userId),
          eq(accounts.type, type),
          assetId === null ? isNull(accounts.assetId) : eq(accounts.assetId, assetId),
        ),
      );
    if (!row) throw new Error(`system account ${type}/${assetId ?? 'USD'} missing (run seed)`);
    return row;
  }

  /**
   * Locks (SELECT ... FOR UPDATE) the user's cash and share accounts for one asset in ascending id
   * order — the global lock order for account rows — creating them first if necessary.
   */
  async lockUserTradingAccounts(
    tx: Tx,
    userId: string,
    assetId: number,
  ): Promise<UserTradingAccounts> {
    await this.ensureUserAccounts(tx, userId, null);
    await this.ensureUserAccounts(tx, userId, assetId);
    const rows = await tx
      .select()
      .from(accounts)
      .where(
        and(
          eq(accounts.userId, userId),
          sql`(${accounts.assetId} is null or ${accounts.assetId} = ${assetId})`,
        ),
      )
      .orderBy(asc(accounts.id))
      .for('update');
    const find = (cash: boolean, type: AccountType) => {
      const row = rows.find(
        (r) => (cash ? r.assetId === null : r.assetId === assetId) && r.type === type,
      );
      if (!row) throw new Error(`account ${type} missing for user ${userId}`);
      return row;
    };
    return {
      cashAvailable: find(true, 'USER_AVAILABLE'),
      cashReserved: find(true, 'USER_RESERVED'),
      sharesAvailable: find(false, 'USER_AVAILABLE'),
      sharesReserved: find(false, 'USER_RESERVED'),
    };
  }

  /**
   * Appends a balanced journal. Zero lines are dropped. Balance is verified here (fail fast) and
   * again by the deferred database constraint trigger at commit.
   */
  async postJournal(tx: Tx, journal: NewJournal): Promise<number> {
    const lines = journal.lines.filter((l) => !l.amount.isZero());
    const net = new Map<string, Decimal>();
    for (const l of lines) {
      const key = String(l.account.assetId);
      net.set(key, (net.get(key) ?? ZERO).add(l.amount));
    }
    for (const [instrument, sum] of net) {
      if (!sum.isZero())
        throw new Error(`unbalanced journal for instrument ${instrument}: ${sum.toString()}`);
    }
    const [header] = await tx
      .insert(journals)
      .values({
        type: journal.type,
        userId: journal.userId,
        orderId: journal.orderId ?? null,
        description: journal.description,
        createdAt: journal.createdAt,
      })
      .returning({ id: journals.id });
    if (!header) throw new Error('failed to insert journal');
    if (lines.length > 0) {
      await tx.insert(ledgerEntries).values(
        lines.map((l) => ({
          journalId: header.id,
          accountId: l.account.id,
          amount: l.amount.toFixed(),
          // asset_id / created_at are overwritten by the BEFORE INSERT trigger from account/journal
          assetId: l.account.assetId,
          createdAt: journal.createdAt,
        })),
      );
    }
    return header.id;
  }

  /**
   * Effective timestamp for a user's next journal. Must be called while holding the user's account
   * locks: it returns max(clock, user's latest journal time), so a user's ledger time never goes
   * backwards and (created_at, id) ordering always equals commit order for that user — even if the
   * transaction waited on a lock or wall clocks differ between application instances.
   */
  async monotonicNow(tx: Tx, userId: string, clockNow: Date): Promise<Date> {
    const [row] = await tx
      .select({ last: sql<string | null>`max(${journals.createdAt})` })
      .from(journals)
      .where(eq(journals.userId, userId));
    const last = row?.last ? new Date(row.last) : null;
    return last && last.getTime() > clockNow.getTime() ? last : clockNow;
  }

  async listUserAccounts(db: DbOrTx, userId: string): Promise<AccountRow[]> {
    return db.select().from(accounts).where(eq(accounts.userId, userId)).orderBy(asc(accounts.id));
  }

  async getAccountsByIds(db: DbOrTx, ids: number[]): Promise<AccountRow[]> {
    if (ids.length === 0) return [];
    return db.select().from(accounts).where(inArray(accounts.id, ids));
  }
}

export function balanceOf(row: AccountRow): Decimal {
  return dec(row.balance);
}
