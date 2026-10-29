import { bootstrap, onShutdown } from './bootstrap.js';
import { loadEnv } from './config/env.js';
import { buildApp } from './http/app.js';

/** API process. Runs the price simulator in-process too when SIMULATOR_ENABLED=true. */
async function main() {
  const env = loadEnv();
  const c = bootstrap();
  const app = await buildApp(c, { httpLogging: true });
  onShutdown(c, async () => {
    await c.simulator.stop();
    await app.close();
    await c.database.close();
  });
  await app.listen({ port: env.PORT, host: env.HOST });
  if (c.config.simulator.enabled) c.simulator.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
