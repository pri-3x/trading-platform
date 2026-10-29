import type { Logger } from 'pino';
import type { Db } from '../../db/client.js';
import type { AppConfig } from '../../config/env.js';
import { evaluateBreaker, isHalted } from '../../domain/circuit-breaker.js';
import { PRICE_SCALE, dec, fmtPrice } from '../../domain/money.js';
import type { Clock } from '../../lib/clock.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import type { BreakerEventRow, MarketRepository, PriceTickRow } from './market.repository.js';

export type TickSource = 'SEED' | 'SIMULATOR' | 'MANUAL';

export interface IngestResult {
  status: 'RECORDED' | 'DUPLICATE' | 'STALE';
  tick: PriceTickRow | null;
  breaker: BreakerEventRow | null;
}

/**
 * Records price observations and evaluates the per-asset circuit breaker atomically, under the
 * asset's market-state row lock (the same lock order placement takes), so no order can slip in
 * between a qualifying price move and the halt being recorded.
 *
 * Halt policy: a qualifying move starts a halt of `haltSeconds` from the tick's timestamp. Moves
 * observed while a halt is active are recorded but do NOT extend it; once the halt expires, the
 * next qualifying tick (the old reference can still be inside the window) starts a new halt.
 */
export class PriceService {
  constructor(
    private readonly db: Db,
    private readonly market: MarketRepository,
    private readonly clock: Clock,
    private readonly config: AppConfig['circuitBreaker'],
    private readonly logger: Logger,
  ) {}

  async ingestTickBySymbol(
    symbol: string,
    price: string,
    observedAt?: Date,
    source: TickSource = 'MANUAL',
  ) {
    const asset = await this.market.findAssetBySymbol(this.db, symbol);
    if (!asset) throw new NotFoundError(`unknown asset ${symbol}`, 'ASSET_NOT_FOUND');
    return this.ingestTick(asset.id, price, observedAt ?? this.clock.now(), source);
  }

  async ingestTick(
    assetId: number,
    price: string,
    observedAt: Date,
    source: TickSource,
  ): Promise<IngestResult> {
    const px = dec(price);
    if (px.lte(0) || px.decimalPlaces() > PRICE_SCALE) {
      throw new ValidationError(`price must be positive with at most ${PRICE_SCALE} decimals`);
    }
    return this.db.transaction(async (tx) => {
      const state = await this.market.lockState(tx, assetId);
      // Ticks must be strictly increasing in time per asset; duplicates/out-of-order are ignored
      // so replays of the same simulator step can never move the price or trip the breaker.
      if (state.lastTickAt && observedAt.getTime() <= state.lastTickAt.getTime()) {
        return {
          status: observedAt.getTime() === state.lastTickAt.getTime() ? 'DUPLICATE' : 'STALE',
          tick: null,
          breaker: null,
        } as const;
      }
      const tick = await this.market.insertTick(tx, {
        assetId,
        price: fmtPrice(px),
        observedAt,
        source,
      });
      if (!tick) return { status: 'DUPLICATE', tick: null, breaker: null } as const;

      let breaker: BreakerEventRow | null = null;
      let haltedUntil = state.haltedUntil;
      if (!isHalted(state.haltedUntil, observedAt)) {
        const boundary = new Date(observedAt.getTime() - this.config.windowSeconds * 1000);
        const reference = await this.market.findReferenceTick(tx, assetId, boundary, observedAt);
        const evaluation = evaluateBreaker(px, reference?.price ?? null, this.config.threshold);
        if (evaluation.triggered && reference && evaluation.changeRatio) {
          haltedUntil = new Date(observedAt.getTime() + this.config.haltSeconds * 1000);
          breaker = await this.market.insertBreakerEvent(tx, {
            assetId,
            triggerTickId: tick.id,
            triggerPrice: tick.price,
            referencePrice: reference.price,
            referenceObservedAt: reference.observedAt,
            changeRatio: evaluation.changeRatio.toFixed(),
            triggeredAt: observedAt,
            haltedUntil,
          });
          this.logger.warn(
            { assetId, price: tick.price, reference: reference.price, haltedUntil },
            'circuit breaker triggered',
          );
        }
      }
      await this.market.updateState(tx, assetId, {
        lastTickId: tick.id,
        lastPrice: tick.price,
        lastTickAt: observedAt,
        askConsumed: '0',
        bidConsumed: '0',
        haltedUntil,
        updatedAt: this.clock.now(),
      });
      return { status: 'RECORDED', tick, breaker } as const;
    });
  }
}
