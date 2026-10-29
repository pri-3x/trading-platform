import { bootstrap, onShutdown } from './bootstrap.js';

/**
 * Stand-alone price simulator / matching worker (production topology: run API replicas with
 * SIMULATOR_ENABLED=false and one or more of these; an advisory lock elects a single leader).
 */
async function main() {
  const c = bootstrap();
  onShutdown(c, async () => {
    await c.simulator.stop();
    await c.database.close();
  });
  c.simulator.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
