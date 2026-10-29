import type { Logger } from 'pino';
import type { AppConfig } from './config/env.js';
import type { Database } from './db/client.js';
import type { Clock } from './lib/clock.js';
import { AssetService } from './modules/assets/asset.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { CalculatorService } from './modules/calculator/calculator.service.js';
import { LedgerRepository } from './modules/ledger/ledger.repository.js';
import { MarketEngine, PriceSimulator } from './modules/market/market-engine.js';
import { MarketRepository } from './modules/market/market.repository.js';
import { PriceService } from './modules/market/price.service.js';
import { MatchingService } from './modules/orders/matching.service.js';
import { OrderRepository } from './modules/orders/order.repository.js';
import { OrderService } from './modules/orders/order.service.js';
import { TradeExecutor } from './modules/orders/trade-executor.js';
import { PortfolioRepository } from './modules/portfolio/portfolio.repository.js';
import { PortfolioService } from './modules/portfolio/portfolio.service.js';

/** Composition root: wires repositories and services (no framework DI needed). */
export function buildContainer(deps: {
  config: AppConfig;
  database: Database;
  clock: Clock;
  logger: Logger;
}) {
  const { config, database, clock, logger } = deps;
  const db = database.db;
  const ledgerRepo = new LedgerRepository();
  const marketRepo = new MarketRepository();
  const orderRepo = new OrderRepository();
  const portfolioRepo = new PortfolioRepository();

  const executor = new TradeExecutor(ledgerRepo, orderRepo, marketRepo);
  const prices = new PriceService(db, marketRepo, clock, config.circuitBreaker, logger);
  const matching = new MatchingService(
    db,
    orderRepo,
    ledgerRepo,
    marketRepo,
    executor,
    clock,
    config.liquidity,
    logger,
  );
  const engine = new MarketEngine(prices, matching);

  return {
    config,
    clock,
    logger,
    database,
    repos: { ledger: ledgerRepo, market: marketRepo, orders: orderRepo, portfolio: portfolioRepo },
    auth: new AuthService(db, ledgerRepo, clock, config.initialUserFunding),
    assets: new AssetService(db, marketRepo, clock),
    calculator: new CalculatorService(db, marketRepo, clock),
    prices,
    matching,
    engine,
    orders: new OrderService(
      db,
      orderRepo,
      ledgerRepo,
      marketRepo,
      executor,
      clock,
      config,
      logger,
    ),
    portfolio: new PortfolioService(db, ledgerRepo, orderRepo, marketRepo, portfolioRepo, clock),
    simulator: new PriceSimulator(
      db,
      database.pool,
      marketRepo,
      engine,
      clock,
      config.simulator,
      logger,
    ),
  };
}

export type Container = ReturnType<typeof buildContainer>;
