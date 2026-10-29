import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness, type TestUser } from '../helpers/harness.js';
import { assertLedgerInvariants } from '../helpers/invariants.js';

/*
 * These tests run real concurrent requests through Fastify; every request runs its transaction on
 * its own pooled PostgreSQL connection, so row locks and unique indexes are genuinely contended.
 */
let h: Harness;
let alice: TestUser;

beforeEach(async () => {
  h = await Harness.create({ prices: { vATL: '100.00' }, poolMax: 40 });
  alice = await h.createUser();
});
afterEach(async () => {
  await assertLedgerInvariants(h);
  await h.close();
});

const marketBuy = (quantity: string) => ({ symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity });

describe('idempotency', () => {
  it('replays the original result for the same key and payload without executing twice', async () => {
    const first = await h.placeOrder(alice, marketBuy('10'), 'same-key');
    h.clock.advanceSeconds(5);
    await h.tick('vATL', '120.00');
    const second = await h.placeOrder(
      alice,
      { ...marketBuy('10.000'), symbol: 'vATL' },
      'same-key',
    );
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await h.sql(`select id from orders`)).toHaveLength(1);
    expect((await h.portfolio(alice)).cash.available).toBe('99000.00000000');
  });

  it('returns 409 when a key is reused with a different payload', async () => {
    const first = await h.placeOrder(alice, marketBuy('10'), 'k');
    const res = await h.placeOrder(alice, marketBuy('11'), 'k');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      details: { orderId: first.json().id },
    });
    expect(await h.sql(`select id from orders`)).toHaveLength(1);
  });

  it('scopes keys per user', async () => {
    const bob = await h.createUser();
    const a = await h.placeOrder(alice, marketBuy('1'), 'shared');
    const b = await h.placeOrder(bob, marketBuy('1'), 'shared');
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().id).not.toBe(b.json().id);
  });

  it('does not consume the key when the request fails (rejection can be retried)', async () => {
    const sell = { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '5' };
    expect((await h.placeOrder(alice, sell, 'retry-me')).statusCode).toBe(422);
    await h.placeOrder(alice, marketBuy('5'));
    const retry = await h.placeOrder(alice, sell, 'retry-me');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });

  it('creates exactly one order for concurrent requests with the same key', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => h.placeOrder(alice, marketBuy('3'), 'concurrent-key')),
    );
    expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(201));
    const ids = new Set(results.map((r) => r.json().id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] !== 'true')).toHaveLength(1);
    expect(await h.sql(`select id from orders`)).toHaveLength(1);
    expect(await h.sql(`select id from trades`)).toHaveLength(1);
    expect((await h.portfolio(alice)).positions[0].shares.total).toBe('3.000000');
  });

  it('concurrent same key with different payloads: one wins, the rest get 409', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.placeOrder(alice, marketBuy(String(i + 1)), 'race-key'),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(9);
    expect(await h.sql(`select id from orders`)).toHaveLength(1);
  });
});

describe('concurrency invariants', () => {
  it('never overspends: 25 concurrent market buys against a balance that covers 5', async () => {
    const user = await h.createUser('5000');
    const results = await Promise.all(
      Array.from({ length: 25 }, () => h.placeOrder(user, marketBuy('10'))),
    );
    const ok = results.filter((r) => r.statusCode === 201);
    expect(ok).toHaveLength(5);
    expect(
      results
        .filter((r) => r.statusCode === 422)
        .every((r) => r.json().error.code === 'INSUFFICIENT_FUNDS'),
    ).toBe(true);
    const p = await h.portfolio(user);
    expect(p.cash.available).toBe('0.00000000');
    expect(p.positions[0].shares.total).toBe('50.000000');
  });

  it('never double-reserves: 25 concurrent resting limit buys against a balance that covers 10', async () => {
    const user = await h.createUser('5000');
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        h.placeOrder(user, {
          symbol: 'vATL',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '10',
          limitPrice: '50.00',
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(10);
    const p = await h.portfolio(user);
    expect(p.cash).toMatchObject({
      available: '0.00000000',
      reserved: '5000.00000000',
      total: '5000.00000000',
    });
  });

  it('never oversells: concurrent sells of the same shares', async () => {
    await h.placeOrder(alice, marketBuy('10'));
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        h.placeOrder(alice, { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '3' }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(3);
    expect((await h.portfolio(alice)).positions[0].shares.total).toBe('1.000000');
  });

  it('never exceeds shared per-tick liquidity across users', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => h.createUser()));
    // 8 x 50 = 400 shares requested; the ladder holds 297.049115
    await Promise.all(users.map((u) => h.placeOrder(u, marketBuy('50'))));
    const [sum] = await h.sql<{ total: string }>(`select sum(quantity) total from trades`);
    expect(sum?.total).toBe('297.049115');
    const perLevel = await h.sql(
      `select price, sum(quantity) q from trades group by price order by price`,
    );
    expect(perLevel).toEqual([
      { price: '100.00', q: '100.000000' },
      { price: '101.00', q: '99.009900' },
      { price: '102.00', q: '98.039215' },
    ]);
  });

  it('a fill and a cancel never both consume the same remainder', async () => {
    for (let i = 0; i < 8; i++) {
      const placed = (
        await h.placeOrder(alice, {
          symbol: 'vATL',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '10',
          limitPrice: '95.00',
        })
      ).json();
      h.clock.advanceSeconds(1);
      const [cancel] = await Promise.all([
        h.request(alice, 'DELETE', `/orders/${placed.id}`),
        h.tick('vATL', i % 2 === 0 ? '95.00' : '94.00'),
      ]);
      const [order] = await h.sql<{
        status: string;
        reserved_remaining: string;
        filled_quantity: string;
      }>(`select status, reserved_remaining, filled_quantity from orders where id = $1`, [
        placed.id,
      ]);
      if (cancel.statusCode === 200) {
        expect(order).toMatchObject({ status: 'CANCELLED', filled_quantity: '0.000000' });
      } else {
        expect(cancel.statusCode).toBe(409);
        expect(order).toMatchObject({ status: 'FILLED', filled_quantity: '10.000000' });
      }
      expect(order!.reserved_remaining).toBe('0.00000000');
      const releases = await h.sql(
        `select id from journals where order_id = $1 and type = 'ORDER_RELEASE'`,
        [placed.id],
      );
      expect(releases.length).toBeLessThanOrEqual(1);
      h.clock.advanceSeconds(1);
      await h.tick('vATL', '100.00');
    }
  });

  it('mixed concurrent activity from many users keeps all ledger invariants', async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => h.createUser('20000')));
    await Promise.all(users.map((u) => h.placeOrder(u, marketBuy('20'))));
    const ops = users.flatMap((u, i) => [
      h.placeOrder(u, {
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '30',
        limitPrice: String(95 + i) + '.00',
      }),
      h.placeOrder(u, {
        symbol: 'vATL',
        side: 'SELL',
        type: 'LIMIT',
        quantity: '10',
        limitPrice: '104.00',
      }),
      h.placeOrder(u, { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '5' }),
      h.placeOrder(u, marketBuy('100')),
    ]);
    h.clock.advanceSeconds(1);
    await Promise.all([...ops, h.tick('vATL', '97.00')]);
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '105.00');
    // history at "now" must reconcile with the live portfolio for every user
    for (const u of users) {
      const live = await h.portfolio(u);
      const hist = await h.history(u, h.clock.now());
      expect(hist.cash).toEqual(live.cash);
      expect(hist.positions).toEqual(live.positions);
      expect(hist.totals).toEqual(live.totals);
    }
  });
});
