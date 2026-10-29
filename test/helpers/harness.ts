import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import pg from 'pg';
import type { AppConfig } from '../../src/config/env.js';
import { buildContainer, type Container } from '../../src/container.js';
import { createDatabase, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedReferenceData } from '../../src/db/seed.js';
import { buildApp } from '../../src/http/app.js';
import { ManualClock } from '../../src/lib/clock.js';

export const START = '2026-01-01T00:00:00.000Z';

/**
 * Deterministic test configuration. Liquidity: no spread, 3 levels 1% apart, $10,000 per level,
 * so hand calculations are easy: with mid 100.00 the ask ladder is 100.00 / 101.00 / 102.00 with
 * 100 / 99.009900 / 98.039215 shares.
 */
export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    env: 'test',
    logLevel: 'silent',
    jwt: { secret: 'test-secret-test-secret-test-secret-123', expiresIn: '1h' },
    initialUserFunding: '100000',
    simulator: { enabled: false, tickMs: 1000, seed: 42, volatility: '0.6', drift: '0.05' },
    liquidity: { levels: 3, halfSpreadBps: 0, levelStepBps: 100, levelNotionalUsd: '10000' },
    trading: { minOrderNotionalUsd: '1', maxOrderQuantity: '1000000' },
    circuitBreaker: { windowSeconds: 60, threshold: '0.15', haltSeconds: 30 },
    ...overrides,
  };
}

/** Drops and recreates the test schema, then applies all migrations. */
export async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      'drop schema if exists drizzle cascade; drop schema public cascade; create schema public;',
    );
  } finally {
    await client.end();
  }
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
}

export class Harness {
  private userCounter = 0;

  private constructor(
    readonly c: Container,
    readonly app: FastifyInstance,
    readonly clock: ManualClock,
    readonly database: Database,
  ) {}

  static async create(
    opts: { config?: Partial<AppConfig>; prices?: Record<string, string>; poolMax?: number } = {},
  ): Promise<Harness> {
    const url = process.env.TEST_DATABASE_URL!;
    await resetDatabase(url);
    const database = createDatabase(url, opts.poolMax ?? 30);
    await runMigrations(database.db);
    const clock = new ManualClock(START);
    const c = buildContainer({
      config: testConfig(opts.config),
      database,
      clock,
      logger: pino({ level: 'silent' }),
    });
    await seedReferenceData(database.db, clock);
    const prices = {
      vSOL: '420.00',
      vATL: '95.50',
      vHLX: '180.25',
      vVAN: '310.10',
      ...opts.prices,
    };
    for (const [symbol, price] of Object.entries(prices)) {
      await c.prices.ingestTickBySymbol(symbol, price, clock.now(), 'SEED');
    }
    clock.advanceSeconds(1);
    const app = await buildApp(c);
    await app.ready();
    return new Harness(c, app, clock, database);
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.database.close();
  }

  async createUser(funding = '100000'): Promise<TestUser> {
    const email = `user${++this.userCounter}@example.com`;
    const user = await this.c.auth.register(email, 'password123', funding);
    const token = this.app.jwt.sign({ sub: user.id, email });
    return { ...user, token };
  }

  /** Records a price tick at the current clock time and matches resting orders. */
  async tick(symbol: string, price: string) {
    const asset = await this.c.repos.market.findAssetBySymbol(this.database.db, symbol);
    return this.c.engine.ingest(asset!.id, price, this.clock.now(), 'MANUAL');
  }

  async assetId(symbol: string): Promise<number> {
    return (await this.c.repos.market.findAssetBySymbol(this.database.db, symbol))!.id;
  }

  request(
    user: TestUser | null,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return this.app.inject({
      method,
      url,
      payload: body as never,
      headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), ...headers },
    });
  }

  private keyCounter = 0;

  placeOrder(user: TestUser, body: Record<string, unknown>, key = `key-${++this.keyCounter}`) {
    return this.request(user, 'POST', '/orders', body, { 'idempotency-key': key });
  }

  async portfolio(user: TestUser) {
    const res = await this.request(user, 'GET', '/portfolio');
    if (res.statusCode !== 200) throw new Error(`portfolio failed: ${res.body}`);
    return res.json();
  }

  async history(user: TestUser, at: Date | string) {
    const iso = typeof at === 'string' ? at : at.toISOString();
    const res = await this.request(user, 'GET', `/portfolio/history?at=${encodeURIComponent(iso)}`);
    if (res.statusCode !== 200) throw new Error(`history failed: ${res.statusCode} ${res.body}`);
    return res.json();
  }

  async sql<T extends pg.QueryResultRow = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const { rows } = await this.database.pool.query<T>(text, params);
    return rows;
  }
}
