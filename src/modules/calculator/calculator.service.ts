import type { Db } from '../../db/client.js';
import { usdToShares } from '../../domain/calculator.js';
import {
  CASH_SCALE,
  fmtCash,
  fmtPrice,
  fmtShares,
  parsePositiveDecimal,
} from '../../domain/money.js';
import type { Clock } from '../../lib/clock.js';
import { ServiceUnavailableError, ValidationError } from '../../lib/errors.js';
import type { MarketRepository } from '../market/market.repository.js';

/**
 * Read-only, indicative USD -> shares conversion at the latest mid price. It never touches
 * orders, reservations or balances. Actual executions happen against the simulated liquidity
 * ladder (mid +/- spread, finite depth) and can therefore differ.
 */
export class CalculatorService {
  constructor(
    private readonly db: Db,
    private readonly market: MarketRepository,
    private readonly clock: Clock,
  ) {}

  async calculate(symbol: string, usdAmountRaw: string) {
    const parsed = parsePositiveDecimal(usdAmountRaw, CASH_SCALE);
    if (!parsed.ok) {
      throw new ValidationError(`usdAmount is invalid: ${parsed.error}`, {
        field: 'usdAmount',
        reason: parsed.error,
      });
    }
    if (parsed.value.gt('1000000000000')) {
      throw new ValidationError('usdAmount is unreasonably large', { field: 'usdAmount' });
    }
    const asset = await this.market.findAssetBySymbol(this.db, symbol);
    if (!asset)
      throw new ValidationError(`unknown symbol ${symbol}`, { field: 'symbol' }, 'UNKNOWN_SYMBOL');
    const state = await this.market.getState(this.db, asset.id);
    if (!state?.lastPrice || !state.lastTickAt) {
      throw new ServiceUnavailableError(
        'MARKET_DATA_UNAVAILABLE',
        `no price available for ${symbol}`,
        5,
      );
    }
    const { shares, cost, remainder } = usdToShares(parsed.value, state.lastPrice);
    return {
      symbol: asset.symbol,
      usdAmount: fmtCash(parsed.value),
      price: fmtPrice(state.lastPrice),
      priceObservedAt: state.lastTickAt.toISOString(),
      priceType: 'INDICATIVE_MID' as const,
      estimatedShares: fmtShares(shares),
      estimatedCost: fmtCash(cost),
      remainder: fmtCash(remainder),
      rounding: 'shares rounded down to 6 decimals; remainder = usdAmount - shares x price',
      calculatedAt: this.clock.now().toISOString(),
      disclaimer:
        'Indicative only. Orders execute against simulated liquidity (spread and depth), so actual fill prices may differ.',
    };
  }
}
