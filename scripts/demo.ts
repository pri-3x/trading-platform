/**
 * Guided end-to-end demo for reviewers. Run against a running API:
 *   npm run demo                          (uses http://localhost:$PORT, PORT from .env, default 3000)
 *   BASE_URL=http://localhost:3001 npm run demo
 * Registers a fresh user each run, so it can be repeated safely.
 */
import 'dotenv/config';

const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
let token = '';
let step = 0;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Json };
}

function title(text: string) {
  console.log(`\n\x1b[1m${++step}. ${text}\x1b[0m`);
}
function show(label: string, value: unknown) {
  console.log(`   ${label}:`, typeof value === 'string' ? value : JSON.stringify(value));
}
function orderSummary(o: Json) {
  return `${o.type} ${o.side} ${o.quantity} ${o.symbol} -> ${o.status}, filled ${o.filledQuantity} @ avg ${o.averageFillPrice ?? '-'}, reserved ${o.reservation.remaining} ${o.reservation.instrument}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`Demo against ${BASE}`);
  const health = await call('GET', '/health').catch(() => null);
  if (!health || health.status !== 200) {
    throw new Error(`API not reachable at ${BASE}. Start it with "npm run dev" (or set BASE_URL).`);
  }

  title('Register a new user (funded with simulated USD stablecoin) and get a JWT');
  const email = `demo-${Date.now()}@example.com`;
  const reg = await call('POST', '/auth/register', { email, password: 'password123' });
  token = reg.body.token;
  show('user', reg.body.user.email);

  title('Market data: assets with live simulated prices');
  const { assets } = (await call('GET', '/assets')).body;
  for (const a of assets) show(a.symbol, `${a.name} @ ${a.price} (halted: ${a.trading.halted})`);
  const sol = assets.find((a: Json) => a.symbol === 'vSOL');

  title('Calculator: how many vSOL shares does $1000 buy? (read-only, indicative)');
  const calc = (await call('POST', '/calculator', { symbol: 'vSOL', usdAmount: '1000' })).body;
  show('result', `${calc.estimatedShares} shares @ ${calc.price}, remainder $${calc.remainder}`);

  title('Market BUY 2 vSOL (fills immediately against simulated liquidity)');
  const buyBody = { symbol: 'vSOL', side: 'BUY', type: 'MARKET', quantity: '2' };
  const buyKey = `demo-buy-${Date.now()}`;
  const buy = await call('POST', '/orders', buyBody, { 'idempotency-key': buyKey });
  show(`HTTP ${buy.status}`, orderSummary(buy.body));

  title('Idempotency: retry the same request with the same Idempotency-Key');
  const replay = await call('POST', '/orders', buyBody, { 'idempotency-key': buyKey });
  show(
    `HTTP ${replay.status}`,
    `same order id: ${replay.body.id === buy.body.id}, Idempotent-Replayed: ${replay.headers.get('idempotent-replayed')}`,
  );
  const conflict = await call(
    'POST',
    '/orders',
    { ...buyBody, quantity: '3' },
    { 'idempotency-key': buyKey },
  );
  show(`same key, different payload -> HTTP ${conflict.status}`, conflict.body.error.code);

  title('LIMIT BUY 5 vSOL far below the market price (rests and reserves cash)');
  const limitPrice = (Math.floor(Number(sol.price) * 0.5 * 100) / 100).toFixed(2);
  const limit = await call(
    'POST',
    '/orders',
    { symbol: 'vSOL', side: 'BUY', type: 'LIMIT', quantity: '5', limitPrice },
    { 'idempotency-key': `demo-limit-${Date.now()}` },
  );
  show(`HTTP ${limit.status}`, orderSummary(limit.body));
  const reservedAt = limit.body.createdAt as string;

  title('Portfolio now: cash is split into available + reserved');
  let p = (await call('GET', '/portfolio')).body;
  show('cash', p.cash);
  show('vSOL', p.positions[0]);

  await sleep(50);
  title('Cancel the resting limit order (reservation is released)');
  const cancel = await call('DELETE', `/orders/${limit.body.id}`);
  show(`HTTP ${cancel.status}`, orderSummary(cancel.body));
  const cancelAgain = await call('DELETE', `/orders/${limit.body.id}`);
  show(`cancel again -> HTTP ${cancelAgain.status}`, cancelAgain.body.error.code);

  title('Market SELL 1 vSOL (realizes P&L with weighted-average cost)');
  const sell = await call(
    'POST',
    '/orders',
    { symbol: 'vSOL', side: 'SELL', type: 'MARKET', quantity: '1' },
    { 'idempotency-key': `demo-sell-${Date.now()}` },
  );
  show(`HTTP ${sell.status}`, orderSummary(sell.body));
  p = (await call('GET', '/portfolio')).body;
  show('cash', p.cash);
  show('vSOL', p.positions[0]);
  show('totals', p.totals);

  title('Business-rule and validation errors');
  const poor = await call(
    'POST',
    '/orders',
    { symbol: 'vSOL', side: 'BUY', type: 'LIMIT', quantity: '100000', limitPrice: '400.00' },
    { 'idempotency-key': `demo-poor-${Date.now()}` },
  );
  show(`buy way more than the balance -> HTTP ${poor.status}`, poor.body.error.code);
  const oversell = await call(
    'POST',
    '/orders',
    { symbol: 'vSOL', side: 'SELL', type: 'MARKET', quantity: '50' },
    { 'idempotency-key': `demo-oversell-${Date.now()}` },
  );
  show(`sell shares not owned -> HTTP ${oversell.status}`, oversell.body.error.code);
  const noKey = await call('POST', '/orders', buyBody);
  show(`missing Idempotency-Key -> HTTP ${noKey.status}`, noKey.body.error.code);

  title('Historical portfolio: reconstructed from the immutable ledger');
  const past = (await call('GET', `/portfolio/history?at=${encodeURIComponent(reservedAt)}`)).body;
  show(`at ${reservedAt} (limit order still open)`, {
    cash: past.cash,
    reservations: past.reservations,
    vSOL: past.positions[0]?.shares,
  });
  const now = (
    await call('GET', `/portfolio/history?at=${encodeURIComponent(new Date().toISOString())}`)
  ).body;
  show('now (after cancel + sell)', {
    cash: now.cash,
    reservations: now.reservations,
    vSOL: now.positions[0]?.shares,
  });
  show(
    'history(now) matches GET /portfolio',
    JSON.stringify(now.totals) === JSON.stringify(p.totals) || '(price may have ticked in between)',
  );

  title("Ownership: another user cannot see this user's order");
  const other = await call('POST', '/auth/register', {
    email: `other-${Date.now()}@example.com`,
    password: 'password123',
  });
  token = other.body.token;
  const peek = await call('GET', `/orders/${buy.body.id}`);
  show(`GET someone else's order -> HTTP ${peek.status}`, peek.body.error.code);

  console.log(`\nDone. Explore everything else in Swagger UI: ${BASE}/docs`);
  console.log(
    'Circuit breaker, concurrency and race conditions are proven by the test suite: npm test',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
