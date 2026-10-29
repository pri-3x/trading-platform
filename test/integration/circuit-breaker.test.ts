import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, START, type TestUser } from '../helpers/harness.js';
import { assertLedgerInvariants } from '../helpers/invariants.js';

let h: Harness;
let alice: TestUser;

beforeEach(async () => {
  h = await Harness.create({ prices: { vATL: '100.00' } });
  alice = await h.createUser();
});
afterEach(async () => {
  await assertLedgerInvariants(h);
  await h.close();
});

const marketBuy = (symbol = 'vATL') => ({ symbol, side: 'BUY', type: 'MARKET', quantity: '1' });
const at = (seconds: number) => new Date(new Date(START).getTime() + seconds * 1000);

describe('circuit breaker', () => {
  it('halts new orders for 30s after a >15% move within 60s, then expires', async () => {
    h.clock.set(at(10));
    const result = await h.tick('vATL', '115.01');
    expect(result.breaker).toMatchObject({
      referencePrice: '100.00',
      triggerPrice: '115.01',
      changeRatio: '0.150100000000',
    });
    expect(result.breaker!.haltedUntil.toISOString()).toBe(at(40).toISOString());

    h.clock.set(at(15));
    const rejected = await h.placeOrder(alice, marketBuy());
    expect(rejected.statusCode).toBe(503);
    expect(rejected.headers['retry-after']).toBe('25');
    expect(rejected.json().error).toMatchObject({
      code: 'CIRCUIT_BREAKER_ACTIVE',
      details: { symbol: 'vATL', haltedUntil: at(40).toISOString(), retryAfterSeconds: 25 },
    });
    expect(await h.sql(`select id from orders`)).toEqual([]);

    // Other assets keep trading.
    expect((await h.placeOrder(alice, marketBuy('vSOL'))).statusCode).toBe(201);

    // Read-only endpoints keep working and report the halt.
    const assets = (await h.request(null, 'GET', '/assets')).json().assets;
    expect(assets.find((a: { symbol: string }) => a.symbol === 'vATL').trading).toEqual({
      halted: true,
      haltedUntil: at(40).toISOString(),
    });
    expect(
      (await h.request(null, 'POST', '/calculator', { symbol: 'vATL', usdAmount: '100' }))
        .statusCode,
    ).toBe(200);
    expect((await h.request(alice, 'GET', '/portfolio')).statusCode).toBe(200);

    h.clock.set(at(39.999));
    expect((await h.placeOrder(alice, marketBuy())).statusCode).toBe(503);
    h.clock.set(at(40));
    expect((await h.placeOrder(alice, marketBuy())).statusCode).toBe(201);
  });

  it('does not trigger at exactly 15%', async () => {
    h.clock.set(at(10));
    expect((await h.tick('vATL', '115.00')).breaker).toBeNull();
    expect((await h.tick('vATL', '85.00').catch(() => null))?.status).toBe('DUPLICATE');
    h.clock.set(at(11));
    expect((await h.tick('vATL', '85.00')).breaker).toBeNull();
    expect((await h.placeOrder(alice, marketBuy())).statusCode).toBe(201);
  });

  it('triggers on downward moves too', async () => {
    h.clock.set(at(5));
    expect((await h.tick('vATL', '84.99')).breaker).not.toBeNull();
  });

  it('uses the latest observation at or before the 60s lookback boundary as reference', async () => {
    h.clock.set(at(61));
    await h.tick('vATL', '112.00'); // vs 100 at t0 (boundary t1): 12%, no trigger
    h.clock.set(at(122));
    // boundary = t62 -> reference is 112.00 (t61), not 100.00: 13.4% => no halt
    expect((await h.tick('vATL', '127.00')).breaker).toBeNull();
    h.clock.set(at(130));
    // boundary = t70 -> reference still 112.00 (t61): 129 / 112 = +15.18% => halt
    expect((await h.tick('vATL', '129.00')).breaker).toMatchObject({ referencePrice: '112.00' });
  });

  it('does not trip on duplicated simulator updates', async () => {
    h.clock.set(at(10));
    await h.tick('vATL', '110.00');
    const dup = await h.tick('vATL', '200.00'); // same timestamp: ignored
    expect(dup).toMatchObject({ status: 'DUPLICATE', breaker: null });
    expect(await h.sql(`select id from circuit_breaker_events`)).toEqual([]);
  });

  it('does not extend an active halt; a qualifying move after expiry starts a new one', async () => {
    h.clock.set(at(10));
    await h.tick('vATL', '120.00');
    h.clock.set(at(20));
    expect((await h.tick('vATL', '140.00')).breaker).toBeNull();
    h.clock.set(at(41));
    const again = await h.tick('vATL', '141.00');
    expect(again.breaker!.haltedUntil.toISOString()).toBe(at(71).toISOString());
    expect(await h.sql(`select id from circuit_breaker_events`)).toHaveLength(2);
  });

  it('freezes resting orders during a halt but still allows cancellation', async () => {
    const resting = (
      await h.placeOrder(alice, {
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '5',
        limitPrice: '84.00',
      })
    ).json();
    const toCancel = (
      await h.placeOrder(alice, {
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '5',
        limitPrice: '83.00',
      })
    ).json();
    h.clock.set(at(10));
    await h.tick('vATL', '82.00'); // -18%: halt; marketable for both orders but frozen
    expect((await h.request(alice, 'GET', `/orders/${resting.id}`)).json().status).toBe('OPEN');
    const cancelled = await h.request(alice, 'DELETE', `/orders/${toCancel.id}`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('CANCELLED');

    // First halt expired at t40, but at t41 the reference is still the t0 price (100.00), so
    // 83.50 (-16.5%) starts a new halt before matching runs: the order stays frozen.
    h.clock.set(at(41));
    await h.tick('vATL', '83.50');
    expect((await h.request(alice, 'GET', `/orders/${resting.id}`)).json().status).toBe('OPEN');
    h.clock.set(at(72));
    await h.tick('vATL', '83.60'); // boundary t12: ref 82.00 -> +1.95%, no halt -> matches
    const filled = (await h.request(alice, 'GET', `/orders/${resting.id}`)).json();
    expect(filled).toMatchObject({ status: 'FILLED', averageFillPrice: '83.60000000' });
  });

  it('cannot be bypassed by orders racing the triggering tick', async () => {
    h.clock.set(at(10));
    const [preTick] = await h.sql<{ id: string }>(
      `select last_tick_id::text id from asset_market_state s join assets a on a.id = s.asset_id where a.symbol = 'vATL'`,
    );
    const requests = Array.from({ length: 15 }, () => h.placeOrder(alice, marketBuy()));
    const [tickResult, ...responses] = await Promise.all([h.tick('vATL', '130.00'), ...requests]);
    expect(tickResult.breaker).not.toBeNull();
    const accepted = responses.filter((r) => r.statusCode === 201);
    const halted = responses.filter((r) => r.statusCode === 503);
    expect(accepted.length + halted.length).toBe(15);
    // Every accepted order executed before the halt, i.e. against the pre-jump tick.
    const trades = await h.sql<{ price_tick_id: string }>(`select price_tick_id::text from trades`);
    expect(trades).toHaveLength(accepted.length);
    expect(trades.every((t) => t.price_tick_id === preTick!.id)).toBe(true);
  });
});
