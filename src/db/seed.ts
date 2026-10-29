import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { assetMarketState, assets, users } from './schema.js';
import type { Clock } from '../lib/clock.js';
import { LedgerRepository } from '../modules/ledger/ledger.repository.js';

export const SEED_ASSETS = [
  {
    symbol: 'vSOL',
    name: 'Solace AI',
    description: 'Fictional applied-AI lab',
    initialPrice: '420.00',
  },
  {
    symbol: 'vATL',
    name: 'Atlas Robotics',
    description: 'Fictional warehouse robotics maker',
    initialPrice: '95.50',
  },
  {
    symbol: 'vHLX',
    name: 'Helix Biotech',
    description: 'Fictional gene-therapy developer',
    initialPrice: '180.25',
  },
  {
    symbol: 'vVAN',
    name: 'Vantage Defense',
    description: 'Fictional aerospace & defense startup',
    initialPrice: '310.10',
  },
] as const;

/**
 * Idempotent reference data: assets, their market state with an initial SEED price tick, and the
 * system ledger accounts (external funding source, house cash and house share inventories).
 */
export async function seedReferenceData(db: Db, clock: Clock): Promise<void> {
  const ledger = new LedgerRepository();
  await db.transaction(async (tx) => {
    const now = clock.now();
    await ledger.ensureSystemAccount(tx, 'EXTERNAL_FUNDING', null);
    await ledger.ensureSystemAccount(tx, 'HOUSE_INVENTORY', null);
    for (const a of SEED_ASSETS) {
      await tx
        .insert(assets)
        .values({ ...a, createdAt: now })
        .onConflictDoNothing();
      const [asset] = await tx.select().from(assets).where(eq(assets.symbol, a.symbol));
      if (!asset) throw new Error(`asset ${a.symbol} missing after insert`);
      await ledger.ensureSystemAccount(tx, 'HOUSE_INVENTORY', asset.id);
      const [state] = await tx
        .select()
        .from(assetMarketState)
        .where(eq(assetMarketState.assetId, asset.id));
      if (!state) {
        await tx.insert(assetMarketState).values({ assetId: asset.id, updatedAt: now });
      }
    }
  });
}

export async function userExists(db: Db, email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase()));
  return Boolean(row);
}
