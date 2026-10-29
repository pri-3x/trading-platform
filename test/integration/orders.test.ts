import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Harness, type TestUser } from '../helpers/harness.js';
import { assertLedgerInvariants } from '../helpers/invariants.js';

/*
 * vATL mid = 100.00 with the test liquidity config gives:
 *   asks 100.00 x 100, 101.00 x 99.009900, 102.00 x 98.039215
 *   bids 100.00 x 100,  99.00 x 101.010101, 98.00 x 102.040816
 */
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

const buy = (type: 'MARKET' | 'LIMIT', quantity: string, limitPrice?: string) => ({
  symbol: 'vATL',
  side: 'BUY',
  type,
  quantity,
  ...(limitPrice ? { limitPrice } : {}),
});
const sell = (type: 'MARKET' | 'LIMIT', quantity: string, limitPrice?: string) => ({
  ...buy(type, quantity, limitPrice),
  side: 'SELL',
});

async function journals(userId: string) {
  return h.sql<{ type: string }>(`select type from journals where user_id = $1 order by id`, [
    userId,
  ]);
}

describe('market orders', () => {
  it('market buy fills at the ask and settles cash and shares', async () => {
    const res = await h.placeOrder(alice, buy('MARKET', '10'));
    expect(res.statusCode).toBe(201);
    const order = res.json();
    expect(order).toMatchObject({
      status: 'FILLED',
      filledQuantity: '10.000000',
      remainingQuantity: '0.000000',
      averageFillPrice: '100.00000000',
      filledNotional: '1000.00000000',
      reservation: { instrument: 'USD', initial: '1000.00000000', remaining: '0.00000000' },
      cancelReason: null,
    });
    expect(order.fills).toHaveLength(1);
    const p = await h.portfolio(alice);
    expect(p.cash).toEqual({
      instrument: 'USD',
      available: '99000.00000000',
      reserved: '0.00000000',
      total: '99000.00000000',
    });
    expect(p.positions[0]).toMatchObject({
      symbol: 'vATL',
      shares: { available: '10.000000', reserved: '0.000000', total: '10.000000' },
    });
    expect((await journals(alice.id)).map((j) => j.type)).toEqual([
      'FUNDING',
      'ORDER_RESERVE',
      'TRADE',
    ]);
  });

  it('market sell hits the bid and realizes P&L', async () => {
    await h.placeOrder(alice, buy('MARKET', '10'));
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '110.00');
    const res = await h.placeOrder(alice, sell('MARKET', '4'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'FILLED',
      averageFillPrice: '110.00000000',
      reservation: { instrument: 'vATL', initial: '4.000000' },
    });
    const p = await h.portfolio(alice);
    expect(p.cash.available).toBe('99440.00000000');
    expect(p.positions[0]).toMatchObject({
      shares: { total: '6.000000' },
      averageCost: '100.00000000',
      costBasis: '600.00000000',
      realizedPnl: '40.00000000',
      marketValue: '660.00000000',
      unrealizedPnl: '60.00000000',
    });
  });

  it('walks multiple levels producing several fills', async () => {
    const order = (await h.placeOrder(alice, buy('MARKET', '150'))).json();
    expect(order.status).toBe('FILLED');
    expect(
      order.fills.map((f: { price: string; quantity: string }) => [f.price, f.quantity]),
    ).toEqual([
      ['100.00', '100.000000'],
      ['101.00', '50.000000'],
    ]);
    expect(order.filledNotional).toBe('15050.00000000');
    expect(order.averageFillPrice).toBe('100.33333333');
  });

  it('partially fills when liquidity runs out and cancels the remainder (IOC)', async () => {
    const order = (await h.placeOrder(alice, buy('MARKET', '400'))).json();
    expect(order).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'IOC_REMAINDER',
      filledQuantity: '297.049115',
      remainingQuantity: '102.950885',
      filledNotional: '29999.99983000',
    });
    expect(order.fills).toHaveLength(3);
    const p = await h.portfolio(alice);
    expect(p.cash.reserved).toBe('0.00000000');
    expect(p.cash.available).toBe('70000.00017000');
  });

  it('consumes per-tick liquidity: a second order in the same tick gets the next level', async () => {
    await h.placeOrder(alice, buy('MARKET', '100'));
    const second = (await h.placeOrder(alice, buy('MARKET', '1'))).json();
    expect(second.fills[0].price).toBe('101.00');
    // a new tick replenishes the ladder
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '100.00');
    const third = (await h.placeOrder(alice, buy('MARKET', '1'))).json();
    expect(third.fills[0].price).toBe('100.00');
  });

  it('cancels with NO_LIQUIDITY when nothing is left in this tick', async () => {
    await h.placeOrder(alice, buy('MARKET', '297.049115'));
    const res = (await h.placeOrder(alice, buy('MARKET', '1'))).json();
    expect(res).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'NO_LIQUIDITY',
      filledQuantity: '0.000000',
    });
  });
});

describe('limit orders', () => {
  it('rests a non-marketable limit buy and reserves qty x limit', async () => {
    const order = (await h.placeOrder(alice, buy('LIMIT', '10', '95.00'))).json();
    expect(order).toMatchObject({
      status: 'OPEN',
      fills: [],
      reservation: { instrument: 'USD', initial: '950.00000000', remaining: '950.00000000' },
    });
    const p = await h.portfolio(alice);
    expect(p.cash).toMatchObject({
      available: '99050.00000000',
      reserved: '950.00000000',
      total: '100000.00000000',
    });
    expect(p.totals.portfolioValue).toBe('100000.00000000');
  });

  it('executes a marketable limit buy immediately and releases the price improvement', async () => {
    const order = (await h.placeOrder(alice, buy('LIMIT', '10', '105.00'))).json();
    expect(order).toMatchObject({
      status: 'FILLED',
      averageFillPrice: '100.00000000',
      reservation: { initial: '1050.00000000', remaining: '0.00000000' },
    });
    const p = await h.portfolio(alice);
    expect(p.cash).toMatchObject({ available: '99000.00000000', reserved: '0.00000000' });
  });

  it('never buys above the limit: partially fills then rests the remainder', async () => {
    const order = (await h.placeOrder(alice, buy('LIMIT', '250', '101.00'))).json();
    expect(order).toMatchObject({
      status: 'PARTIALLY_FILLED',
      filledQuantity: '199.009900',
      remainingQuantity: '50.990100',
      reservation: { initial: '25250.00000000', remaining: '5150.00010000' },
    });
    expect(order.fills.every((f: { price: string }) => Number(f.price) <= 101)).toBe(true);
    const p = await h.portfolio(alice);
    expect(p.cash.reserved).toBe('5150.00010000');
  });

  it('rests a limit sell above the bid and reserves the shares', async () => {
    await h.placeOrder(alice, buy('MARKET', '10'));
    const order = (await h.placeOrder(alice, sell('LIMIT', '6', '120.00'))).json();
    expect(order).toMatchObject({
      status: 'OPEN',
      reservation: { instrument: 'vATL', initial: '6.000000' },
    });
    const p = await h.portfolio(alice);
    expect(p.positions[0].shares).toEqual({
      available: '4.000000',
      reserved: '6.000000',
      total: '10.000000',
    });
  });

  it('never sells below the limit', async () => {
    await h.placeOrder(alice, buy('MARKET', '150'));
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '100.00');
    const order = (await h.placeOrder(alice, sell('LIMIT', '150', '99.50'))).json();
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.fills.map((f: { price: string }) => f.price)).toEqual(['100.00']);
  });

  it('fills a resting order when a later tick makes it marketable (with price improvement)', async () => {
    const placed = (await h.placeOrder(alice, buy('LIMIT', '10', '95.00'))).json();
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '97.00');
    expect((await h.request(alice, 'GET', `/orders/${placed.id}`)).json().status).toBe('OPEN');
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '94.00');
    const order = (await h.request(alice, 'GET', `/orders/${placed.id}`)).json();
    expect(order).toMatchObject({
      status: 'FILLED',
      averageFillPrice: '94.00000000',
      reservation: { remaining: '0.00000000' },
    });
    expect(order.lastFilledAt).toBe(h.clock.now().toISOString());
    const p = await h.portfolio(alice);
    expect(p.cash).toMatchObject({ available: '99060.00000000', reserved: '0.00000000' });
  });

  it('fills resting orders across several ticks (multiple partial fills)', async () => {
    const placed = (await h.placeOrder(alice, buy('LIMIT', '250', '90.00'))).json();
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '90.00'); // asks 90.00 x 111.111111 only (91.80 > limit)
    let order = (await h.request(alice, 'GET', `/orders/${placed.id}`)).json();
    expect(order).toMatchObject({ status: 'PARTIALLY_FILLED', filledQuantity: '111.111111' });
    h.clock.advanceSeconds(1);
    await h.tick('vATL', '89.00'); // asks 89.00 x 112.359550, 89.89 x 111.247080
    order = (await h.request(alice, 'GET', `/orders/${placed.id}`)).json();
    expect(order.status).toBe('FILLED');
    expect(
      order.fills.map((f: { price: string; quantity: string }) => [f.price, f.quantity]),
    ).toEqual([
      ['90.00', '111.111111'],
      ['89.00', '112.359550'],
      ['89.89', '26.529339'],
    ]);
    expect(order.reservation.remaining).toBe('0.00000000');
  });

  it('matches resting orders in price-time priority', async () => {
    const bob = await h.createUser();
    const low = (await h.placeOrder(alice, buy('LIMIT', '60', '96.00'))).json();
    const highLate = (await h.placeOrder(bob, buy('LIMIT', '60', '98.00'))).json();
    h.clock.advanceSeconds(1);
    // ask level 0 at 95.00 has floor(10000/95) = 105.263157 shares; level 1 at 95.95 is within both limits
    await h.tick('vATL', '95.00');
    const a = (await h.request(alice, 'GET', `/orders/${low.id}`)).json();
    const b = (await h.request(bob, 'GET', `/orders/${highLate.id}`)).json();
    expect(b.fills[0]).toMatchObject({ price: '95.00', quantity: '60.000000' });
    expect(a.fills[0]).toMatchObject({ price: '95.00', quantity: '45.263157' });
    expect(a.fills[1].price).toBe('95.95');
  });
});

describe('cancellation', () => {
  it('cancels a resting order and releases the reservation', async () => {
    const placed = (await h.placeOrder(alice, buy('LIMIT', '10', '95.00'))).json();
    h.clock.advanceSeconds(1);
    const res = await h.request(alice, 'DELETE', `/orders/${placed.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'USER_REQUESTED',
      reservation: { remaining: '0.00000000' },
      cancelledAt: h.clock.now().toISOString(),
    });
    const p = await h.portfolio(alice);
    expect(p.cash).toMatchObject({ available: '100000.00000000', reserved: '0.00000000' });
    expect((await journals(alice.id)).map((j) => j.type)).toEqual([
      'FUNDING',
      'ORDER_RESERVE',
      'ORDER_RELEASE',
    ]);
  });

  it('cancels the remainder of a partially filled order and keeps its fills', async () => {
    const placed = (await h.placeOrder(alice, buy('LIMIT', '250', '101.00'))).json();
    const res = (await h.request(alice, 'DELETE', `/orders/${placed.id}`)).json();
    expect(res).toMatchObject({
      status: 'CANCELLED',
      filledQuantity: '199.009900',
      remainingQuantity: '50.990100',
    });
    expect(res.fills).toHaveLength(2);
    const p = await h.portfolio(alice);
    expect(p.cash.reserved).toBe('0.00000000');
    expect(p.positions[0].shares.total).toBe('199.009900');
  });

  it('releases reserved shares of a cancelled sell', async () => {
    await h.placeOrder(alice, buy('MARKET', '10'));
    const placed = (await h.placeOrder(alice, sell('LIMIT', '10', '150.00'))).json();
    await h.request(alice, 'DELETE', `/orders/${placed.id}`);
    const p = await h.portfolio(alice);
    expect(p.positions[0].shares).toEqual({
      available: '10.000000',
      reserved: '0.000000',
      total: '10.000000',
    });
  });

  it('rejects cancelling twice, or cancelling filled orders, with 409', async () => {
    const resting = (await h.placeOrder(alice, buy('LIMIT', '10', '95.00'))).json();
    await h.request(alice, 'DELETE', `/orders/${resting.id}`);
    const again = await h.request(alice, 'DELETE', `/orders/${resting.id}`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toMatchObject({
      code: 'ORDER_NOT_CANCELLABLE',
      details: { status: 'CANCELLED' },
    });
    const filled = (await h.placeOrder(alice, buy('MARKET', '1'))).json();
    const res = await h.request(alice, 'DELETE', `/orders/${filled.id}`);
    expect(res.statusCode).toBe(409);
    const releases = await h.sql(
      `select count(*)::int n from journals where type = 'ORDER_RELEASE'`,
    );
    expect(releases[0]).toEqual({ n: 1 });
  });

  it('404s for unknown orders and validates the id', async () => {
    expect(
      (await h.request(alice, 'DELETE', '/orders/00000000-0000-4000-8000-000000000000')).statusCode,
    ).toBe(404);
    expect((await h.request(alice, 'DELETE', '/orders/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('business rule violations', () => {
  it('rejects insufficient cash with 422 and leaves no trace', async () => {
    const poor = await h.createUser('1000');
    const res = await h.placeOrder(poor, buy('LIMIT', '20', '100.00'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
      details: { required: '2000.00000000', available: '1000.00000000' },
    });
    const market = await h.placeOrder(poor, buy('MARKET', '20'));
    expect(market.statusCode).toBe(422);
    expect(await h.sql(`select id from orders where user_id = $1`, [poor.id])).toEqual([]);
    expect(
      (await h.sql(`select count(*)::int n from journals where user_id = $1`, [poor.id]))[0],
    ).toEqual({ n: 1 });
  });

  it('rejects selling shares that are not owned', async () => {
    const res = await h.placeOrder(alice, sell('MARKET', '1'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_SHARES');
  });

  it('prevents double reservation: shares reserved by a resting sell cannot be sold again', async () => {
    await h.placeOrder(alice, buy('MARKET', '10'));
    expect((await h.placeOrder(alice, sell('LIMIT', '10', '150.00'))).statusCode).toBe(201);
    const res = await h.placeOrder(alice, sell('MARKET', '1'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details).toEqual({ required: '1.000000', available: '0.000000' });
  });

  it('prevents spending cash reserved by a resting buy', async () => {
    const user = await h.createUser('1000');
    expect((await h.placeOrder(user, buy('LIMIT', '10', '90.00'))).statusCode).toBe(201);
    const res = await h.placeOrder(user, buy('LIMIT', '2', '90.00'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.available).toBe('100.00000000');
  });

  it('enforces the minimum order notional', async () => {
    const res = await h.placeOrder(alice, buy('LIMIT', '0.001', '100.00'));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('ORDER_BELOW_MINIMUM');
  });
});

describe('input validation', () => {
  it.each([
    [{ quantity: 'abc' }, 'VALIDATION_ERROR'],
    [{ quantity: '0' }, 'VALIDATION_ERROR'],
    [{ quantity: '-1' }, 'VALIDATION_ERROR'],
    [{ quantity: '1.1234567' }, 'VALIDATION_ERROR'],
    [{ quantity: 10 }, 'VALIDATION_ERROR'],
    [{ quantity: '2000000' }, 'VALIDATION_ERROR'],
    [{ limitPrice: '100.001' }, 'VALIDATION_ERROR'],
    [{ limitPrice: '0' }, 'VALIDATION_ERROR'],
    [{ limitPrice: '-5' }, 'VALIDATION_ERROR'],
    [{ limitPrice: undefined }, 'VALIDATION_ERROR'],
    [{ type: 'MARKET' }, 'VALIDATION_ERROR'],
    [{ type: 'STOP' }, 'VALIDATION_ERROR'],
    [{ side: 'HOLD' }, 'VALIDATION_ERROR'],
    [{ symbol: 'NOPE' }, 'UNKNOWN_SYMBOL'],
  ])('rejects %j with 400', async (patch, code) => {
    const body = { ...buy('LIMIT', '1', '100.00'), ...patch };
    const res = await h.placeOrder(alice, body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('requires the Idempotency-Key header', async () => {
    const res = await h.request(alice, 'POST', '/orders', buy('MARKET', '1'));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});

describe('listing', () => {
  it('lists own orders newest first with filters', async () => {
    await h.placeOrder(alice, buy('MARKET', '1'));
    h.clock.advanceSeconds(1);
    await h.placeOrder(alice, buy('LIMIT', '1', '50.00'));
    const all = (await h.request(alice, 'GET', '/orders')).json().orders;
    expect(all.map((o: { type: string }) => o.type)).toEqual(['LIMIT', 'MARKET']);
    const open = (await h.request(alice, 'GET', '/orders?status=OPEN')).json().orders;
    expect(open).toHaveLength(1);
    expect((await h.request(alice, 'GET', '/orders?symbol=vSOL')).json().orders).toEqual([]);
  });
});

describe('atomicity', () => {
  it('rolls back every effect when a financial operation fails mid-transaction', async () => {
    const before = await h.sql(`select id, balance from accounts order by id`);
    const spy = vi
      .spyOn(h.c.repos.orders, 'insertTrade')
      .mockRejectedValueOnce(new Error('simulated crash'));
    const res = await h.placeOrder(alice, buy('MARKET', '10'), 'crash-key');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    spy.mockRestore();

    expect(await h.sql(`select id, balance from accounts order by id`)).toEqual(before);
    expect(await h.sql(`select id from orders`)).toEqual([]);
    expect(await h.sql(`select id from idempotency_records`)).toEqual([]);
    expect(
      (await h.sql(`select count(*)::int n from journals where type <> 'FUNDING'`))[0],
    ).toEqual({ n: 0 });

    // The key was not consumed: a retry executes normally.
    const retry = await h.placeOrder(alice, buy('MARKET', '10'), 'crash-key');
    expect(retry.statusCode).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
  });
});

describe('database guards', () => {
  it('forbids updating or deleting ledger history', async () => {
    await expect(h.sql(`update ledger_entries set amount = amount + 1`)).rejects.toThrow(
      /append-only/,
    );
    await expect(h.sql(`delete from journals`)).rejects.toThrow(/append-only/);
    await expect(h.sql(`truncate ledger_entries cascade`)).rejects.toThrow(/append-only/);
  });

  it('forbids changing balances outside the ledger', async () => {
    await expect(
      h.sql(`update accounts set balance = balance + 1000000 where user_id = $1`, [alice.id]),
    ).rejects.toThrow(/only change through ledger/);
  });

  it('rejects unbalanced journals at commit and overdrafts immediately', async () => {
    const client = await h.database.pool.connect();
    try {
      const [acct] = (
        await client.query(
          `select id from accounts where user_id = $1 and asset_id is null and type = 'USER_AVAILABLE'`,
          [alice.id],
        )
      ).rows;
      await client.query('begin');
      const j = await client.query(
        `insert into journals (type, user_id, description, created_at) values ('FUNDING', $1, 'free money', now()) returning id`,
        [alice.id],
      );
      await client.query(
        `insert into ledger_entries (journal_id, account_id, amount, created_at) values ($1, $2, 5, now())`,
        [j.rows[0].id, acct.id],
      );
      await expect(client.query('commit')).rejects.toThrow(/unbalanced/);

      await client.query('begin');
      const j2 = await client.query(
        `insert into journals (type, user_id, description, created_at) values ('FUNDING', $1, 'overdraft', now()) returning id`,
        [alice.id],
      );
      await expect(
        client.query(
          `insert into ledger_entries (journal_id, account_id, amount, created_at) values ($1, $2, -1000000, now())`,
          [j2.rows[0].id, acct.id],
        ),
      ).rejects.toThrow(/accounts_non_negative/);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
