import { loadEnv } from '../config/env.js';
import { createDatabase } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';

const env = loadEnv();
const database = createDatabase(env.DATABASE_URL, 2);
try {
  await runMigrations(database.db);
  console.log('migrations applied');
} finally {
  await database.close();
}
