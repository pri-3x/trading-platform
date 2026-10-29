import type { Logger } from 'pino';
import type { AppConfig } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { gbmStep, mulberry32, normal } from '../../domain/price-process.js';
import type { Clock } from '../../lib/clock.js';
import type { MatchingService } from '../orders/matching.service.js';
import type { MarketRepository } from './market.repository.js';
import type { IngestResult, PriceService, TickSource } from './price.service.js';

/**
 * Price ingestion entry point used by the simulator and by tests: record the tick (which also
 * evaluates the circuit breaker) and then match resting orders against the fresh liquidity.
 */
export class MarketEngine {
  constructor(
    private readonly prices: PriceService,
    private readonly matching: MatchingService,
  ) {}

  async ingest(
    assetId: number,
    price: string,
    observedAt: Date,
    source: TickSource,
  ): Promise<IngestResult> {
    const result = await this.prices.ingestTick(assetId, price, observedAt, source);
    if (result.status === 'RECORDED') await this.matching.matchAsset(assetId);
    return result;
  }
}

/**
 * Deterministic GBM price simulator. Given the same seed, starting prices and clock it produces
 * exactly the same tick sequence. Tick timestamps are aligned to the tick interval, so even if
 * two instances raced, the (asset_id, observed_at) unique index would keep one tick per slot.
 * Only the instance holding a PostgreSQL advisory lock runs ticks (leader election).
 */
export class PriceSimulator {
  static readonly ADVISORY_LOCK_KEY = 7_420_001;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private leaderClient: import('pg').PoolClient | null = null;
  private readonly rand: () => number;

  constructor(
    private readonly db: Db,
    private readonly pool: import('pg').Pool,
    private readonly market: MarketRepository,
    private readonly engine: MarketEngine,
    private readonly clock: Clock,
    private readonly config: AppConfig['simulator'],
    private readonly logger: Logger,
  ) {
    this.rand = mulberry32(config.seed);
  }

  /** Advances every asset by one GBM step at the given (aligned) timestamp. */
  async tickOnce(at: Date = this.clock.now()): Promise<void> {
    const slot = new Date(Math.floor(at.getTime() / this.config.tickMs) * this.config.tickMs);
    const rows = await this.market.listAssets(this.db);
    for (const { asset, state } of rows) {
      const current = state?.lastPrice ?? asset.initialPrice;
      const next = gbmStep({
        price: current,
        drift: this.config.drift,
        volatility: this.config.volatility,
        dtMs: this.config.tickMs,
        z: normal(this.rand),
      });
      await this.engine.ingest(asset.id, next.toFixed(2), slot, 'SIMULATOR');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.loop(), this.config.tickMs);
    this.logger.info(
      { tickMs: this.config.tickMs, seed: this.config.seed },
      'price simulator started',
    );
  }

  private async loop(): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      if (!(await this.ensureLeader())) return;
      await this.tickOnce();
    } catch (err) {
      this.logger.error({ err }, 'price simulator tick failed');
    } finally {
      this.running = false;
    }
  }

  private async ensureLeader(): Promise<boolean> {
    if (this.leaderClient) return true;
    const client = await this.pool.connect();
    const { rows } = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [
      PriceSimulator.ADVISORY_LOCK_KEY,
    ]);
    if (rows[0]?.ok) {
      this.leaderClient = client;
      this.logger.info('price simulator acquired leadership');
      return true;
    }
    client.release();
    return false;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 10));
    if (this.leaderClient) {
      await this.leaderClient
        .query('select pg_advisory_unlock($1)', [PriceSimulator.ADVISORY_LOCK_KEY])
        .catch(() => undefined);
      this.leaderClient.release();
      this.leaderClient = null;
    }
  }
}
