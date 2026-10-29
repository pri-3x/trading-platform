import type { Db } from '../../db/client.js';
import { isHalted } from '../../domain/circuit-breaker.js';
import { dec, fmtPrice } from '../../domain/money.js';
import type { Clock } from '../../lib/clock.js';
import { NotFoundError } from '../../lib/errors.js';
import type { AssetRow, MarketRepository, MarketStateRow } from '../market/market.repository.js';

export interface AssetSummaryDto {
  symbol: string;
  name: string;
  description: string;
  initialPrice: string;
  price: string | null;
  priceObservedAt: string | null;
  changeFromInitial: string | null;
  trading: { halted: boolean; haltedUntil: string | null };
}

export class AssetService {
  constructor(
    private readonly db: Db,
    private readonly market: MarketRepository,
    private readonly clock: Clock,
  ) {}

  async listAssets(): Promise<AssetSummaryDto[]> {
    const rows = await this.market.listAssets(this.db);
    const now = this.clock.now();
    return rows.map(({ asset, state }) => this.summary(asset, state, now));
  }

  async getAsset(
    symbol: string,
    history: { from?: Date | undefined; to?: Date | undefined; limit: number },
  ) {
    const asset = await this.market.findAssetBySymbol(this.db, symbol);
    if (!asset) throw new NotFoundError(`asset ${symbol} not found`, 'ASSET_NOT_FOUND');
    const [state, ticks, breakerEvents] = await Promise.all([
      this.market.getState(this.db, asset.id),
      this.market.priceHistory(this.db, asset.id, history),
      this.market.recentBreakerEvents(this.db, asset.id, 10),
    ]);
    return {
      ...this.summary(asset, state, this.clock.now()),
      priceHistory: ticks.map((t) => ({
        price: fmtPrice(t.price),
        observedAt: t.observedAt.toISOString(),
        source: t.source,
      })),
      circuitBreakerEvents: breakerEvents.map((e) => ({
        triggeredAt: e.triggeredAt.toISOString(),
        haltedUntil: e.haltedUntil.toISOString(),
        referencePrice: fmtPrice(e.referencePrice),
        referenceObservedAt: e.referenceObservedAt.toISOString(),
        triggerPrice: fmtPrice(e.triggerPrice),
        changeRatio: e.changeRatio,
      })),
    };
  }

  private summary(asset: AssetRow, state: MarketStateRow | null, now: Date): AssetSummaryDto {
    const price = state?.lastPrice ?? null;
    const halted = isHalted(state?.haltedUntil ?? null, now);
    return {
      symbol: asset.symbol,
      name: asset.name,
      description: asset.description,
      initialPrice: fmtPrice(asset.initialPrice),
      price: price === null ? null : fmtPrice(price),
      priceObservedAt: state?.lastTickAt?.toISOString() ?? null,
      changeFromInitial:
        price === null
          ? null
          : dec(price)
              .sub(asset.initialPrice)
              .div(asset.initialPrice)
              .toDecimalPlaces(6)
              .toFixed(6),
      trading: { halted, haltedUntil: halted ? state!.haltedUntil!.toISOString() : null },
    };
  }
}
