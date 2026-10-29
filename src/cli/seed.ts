import { bootstrap } from '../bootstrap.js';
import { seedReferenceData, userExists } from '../db/seed.js';
import { loadEnv } from '../config/env.js';

/** Idempotent: safe to run repeatedly. */
const env = loadEnv();
const c = bootstrap();
try {
  await seedReferenceData(c.database.db, c.clock);
  // Initial SEED price tick for assets that have never been priced.
  for (const { asset, state } of await c.repos.market.listAssets(c.database.db)) {
    if (!state?.lastPrice)
      await c.prices.ingestTick(asset.id, asset.initialPrice, c.clock.now(), 'SEED');
  }
  for (const email of [env.SEED_USER_EMAIL, 'bob@example.com']) {
    if (await userExists(c.database.db, email)) {
      console.log(`user ${email} already exists`);
    } else {
      await c.auth.register(email, env.SEED_USER_PASSWORD);
      console.log(`created user ${email} funded with ${env.INITIAL_USER_FUNDING} USD`);
    }
  }
  console.log('seed complete');
} finally {
  await c.database.close();
}
