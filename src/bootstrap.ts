import { loadEnv, toAppConfig } from './config/env.js';
import { buildContainer, type Container } from './container.js';
import { createDatabase } from './db/client.js';
import { SystemClock } from './lib/clock.js';
import { createLogger } from './lib/logger.js';

/** Builds the production container from environment variables. */
export function bootstrap(): Container {
  const env = loadEnv();
  const config = toAppConfig(env);
  const logger = createLogger(
    env.LOG_LEVEL,
    env.NODE_ENV === 'development' && process.stdout.isTTY,
  );
  const database = createDatabase(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  return buildContainer({ config, database, clock: new SystemClock(), logger });
}

/** Registers SIGINT/SIGTERM handlers that run `shutdown` once, with a hard timeout. */
export function onShutdown(
  container: Container,
  shutdown: () => Promise<void>,
  timeoutMs = 10_000,
): void {
  let closing = false;
  const handler = (signal: string) => {
    if (closing) return;
    closing = true;
    container.logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      container.logger.error('graceful shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    shutdown()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        container.logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}
