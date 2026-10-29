import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

// Keep NUMERIC/BIGINT as strings: never let node-postgres coerce money into JS floats.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => v);

export type Db = NodePgDatabase<typeof schema>;
/** Either the root database handle or an open transaction. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export interface Database {
  pool: pg.Pool;
  db: Db;
  close(): Promise<void>;
}

export function createDatabase(connectionString: string, max = 20): Database {
  const pool = new pg.Pool({ connectionString, max, application_name: 'trading-platform' });
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: () => pool.end(),
  };
}
