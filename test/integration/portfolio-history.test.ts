import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Decimal } from '../../src/domain/money.js';
import { Harness, START, type TestUser } from '../helpers/harness.js';
import { assertLedgerInvariants } from '../helpers/invariants.js';

/*
 * Hand-calculated timeline (vATL, zero spread; asks/bids at level 0 equal the mid):
 *   t0  seed price 100.00
 *   t1  alice funded 100,000
 *   t2  LIMIT BUY 10 @ 95 rests              reserve 950
 *   t3  MARKET BUY 10 fills @ 100            cost 1,000
 *   t4  tick 95 -> resting order fills @ 95  cost 950 (reservation consumed)
 *   t5  tick 110, MARKET SELL 5 @ 110        proceeds 550, cost removed 5 x 97.5 = 487.5, realized 62.5
 *   t6  LIMIT SELL 5 @ 130 rests             reserve 5 shares
 *   t7  cancel it                            release 5 shares
 *   t8  tick 112
 */
let h: Harness;
let alice: TestUser;
const at = (seconds: number) => new Date(new Date(START).getTime() + seconds * 1000);
const ms = (seconds: number, deltaMs: number) => new Date(at(seconds).getTime() + deltaMs);
let restingBuyId: string;
let restingSellId: string;

async function runTimeline() {
  h.clock.set(at(2));
  restingBuyId = (
    await h.placeOrder(alice, {
      symbol: 'vATL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '10',
      limitPrice: '95.00',
    })
  ).json().id;
  h.clock.set(at(3));
  await h.placeOrder(alice, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '10' });
  h.clock.set(at(4));
  await h.tick('vATL', '95.00');
  h.clock.set(at(5));
  await h.tick('vATL', '110.00');
  await h.placeOrder(alice, { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '5' });
  h.clock.set(at(6));
  restingSellId = (
    await h.placeOrder(alice, {
      symbol: 'vATL',
      side: 'SELL',
      type: 'LIMIT',
      quantity: '5',
      limitPrice: '130.00',
    })
  ).json().id;
  h.clock.set(at(7));
  await h.request(alice, 'DELETE', `/orders/${restingSellId}`);
  h.clock.set(at(8));
  await h.tick('vATL', '112.00');
  h.clock.set(at(9));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON response bodies
type Json = any;
const position = (snapshot: { positions: Json[] }, symbol = 'vATL'): Json =>
  snapshot.positions.find((p) => p.symbol === symbol);

beforeEach(async () => {
  h = await Harness.create({ prices: { vATL: '100.00' } });
  alice = await h.createUser(); // funded at t1
});
afterEach(async () => {
  await assertLedgerInvariants(h);
  await h.close();
});

describe('GET /portfolio/history', () => {
  beforeEach(runTimeline);

  it('returns an empty portfolio before the user existed', async () => {
    const snap = await h.history(alice, ms(0, 500));
    expect(snap.cash).toEqual({
      instrument: 'USD',
      available: '0.00000000',
      reserved: '0.00000000',
      total: '0.00000000',
    });
    expect(snap.positions).toEqual([]);
    expect(snap.ledger.lastJournalSequence).toBeNull();
    expect(snap.totals.portfolioValue).toBe('0.00000000');
  });

  it('reconstructs the initial funded portfolio', async () => {
    const snap = await h.history(alice, at(1));
    expect(snap.cash.available).toBe('100000.00000000');
    expect(snap.positions).toEqual([]);
    expect(snap.valuationTimestamp).toBe(at(1).toISOString());
    // identical just before the next event
    const later = await h.history(alice, ms(2, -1));
    expect({ ...later, requestedAt: null }).toEqual({ ...snap, requestedAt: null });
  });

  it('reconstructs a limit-order reservation at the moment it was placed', async () => {
    const before = await h.history(alice, ms(2, -1));
    expect(before.cash.reserved).toBe('0.00000000');
    const snap = await h.history(alice, at(2));
    expect(snap.cash).toEqual({
      instrument: 'USD',
      available: '99050.00000000',
      reserved: '950.00000000',
      total: '100000.00000000',
    });
    // The order is FILLED today, but at t2 it was an open reservation.
    expect(snap.reservations).toEqual([
      { orderId: restingBuyId, instrument: 'USD', amount: '950.00000000' },
    ]);
  });

  it('reconstructs before and immediately after a buy', async () => {
    const before = await h.history(alice, ms(3, -1));
    expect(before.positions).toEqual([]);
    const after = await h.history(alice, at(3));
    expect(after.cash).toMatchObject({ available: '98050.00000000', reserved: '950.00000000' });
    expect(position(after)).toEqual({
      symbol: 'vATL',
      shares: { available: '10.000000', reserved: '0.000000', total: '10.000000' },
      averageCost: '100.00000000',
      costBasis: '1000.00000000',
      price: '100.00',
      priceObservedAt: at(0).toISOString(),
      marketValue: '1000.00000000',
      unrealizedPnl: '0.00000000',
      realizedPnl: '0.00000000',
    });
    expect(after.valuationTimestamp).toBe(at(3).toISOString());
  });

  it('reconstructs a point in time before a later fill of a resting order', async () => {
    const beforeFill = await h.history(alice, ms(4, -1));
    expect(beforeFill.reservations).toHaveLength(1);
    expect(position(beforeFill)!.shares.total).toBe('10.000000');
    const afterFill = await h.history(alice, at(4));
    expect(afterFill.reservations).toEqual([]);
    expect(afterFill.cash).toMatchObject({ available: '98050.00000000', reserved: '0.00000000' });
    expect(position(afterFill)).toMatchObject({
      shares: { total: '20.000000' },
      averageCost: '97.50000000',
      costBasis: '1950.00000000',
      price: '95.00',
      marketValue: '1900.00000000',
      unrealizedPnl: '-50.00000000',
    });
  });

  it('reconstructs after a sell with realized P&L, valued at the historical price', async () => {
    const snap = await h.history(alice, at(5));
    expect(snap.cash).toMatchObject({
      available: '98600.00000000',
      reserved: '0.00000000',
      total: '98600.00000000',
    });
    expect(position(snap)).toMatchObject({
      shares: { available: '15.000000', reserved: '0.000000', total: '15.000000' },
      averageCost: '97.50000000',
      costBasis: '1462.50000000',
      price: '110.00',
      priceObservedAt: at(5).toISOString(),
      marketValue: '1650.00000000',
      unrealizedPnl: '187.50000000',
      realizedPnl: '62.50000000',
    });
    expect(snap.totals).toEqual({
      costBasis: '1462.50000000',
      marketValue: '1650.00000000',
      unrealizedPnl: '187.50000000',
      realizedPnl: '62.50000000',
      portfolioValue: '100250.00000000',
    });
    // The current price is 112, but the snapshot must use the price observed at t5.
    expect((await h.portfolio(alice)).positions[0].price).toBe('112.00');
  });

  it('reconstructs share reservations before and after cancellation', async () => {
    const reserved = await h.history(alice, at(6));
    expect(position(reserved)!.shares).toEqual({
      available: '10.000000',
      reserved: '5.000000',
      total: '15.000000',
    });
    expect(reserved.reservations).toEqual([
      { orderId: restingSellId, instrument: 'vATL', amount: '5.000000' },
    ]);
    const beforeCancel = await h.history(alice, ms(7, -1));
    expect(position(beforeCancel)!.shares.reserved).toBe('5.000000');
    const cancelled = await h.history(alice, at(7));
    expect(position(cancelled)!.shares).toEqual({
      available: '15.000000',
      reserved: '0.000000',
      total: '15.000000',
    });
    expect(cancelled.reservations).toEqual([]);
    // cost basis and realized P&L are unaffected by reservations
    expect(position(cancelled)).toMatchObject({
      costBasis: '1462.50000000',
      realizedPnl: '62.50000000',
    });
  });

  it('later ledger entries and price ticks cannot change an earlier result', async () => {
    const snapshot = await h.history(alice, at(5));
    h.clock.set(at(20));
    await h.tick('vATL', '120.00');
    await h.placeOrder(alice, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '7' });
    await h.placeOrder(alice, { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '12' });
    await h.placeOrder(alice, {
      symbol: 'vATL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '3',
      limitPrice: '50.00',
    });
    h.clock.set(at(25));
    expect(await h.history(alice, at(5))).toEqual(snapshot);
  });

  it('reconciles with the live portfolio at the current time', async () => {
    const live = await h.portfolio(alice);
    const hist = await h.history(alice, h.clock.now());
    expect(hist.cash).toEqual(live.cash);
    expect(hist.positions).toEqual(live.positions);
    expect(hist.totals).toEqual(live.totals);
    expect(position(hist)!.marketValue).toBe('1680.00000000');
  });

  it('reports the prices actually used, never observed after the cutoff', async () => {
    const snap = await h.history(alice, ms(5, -1));
    const vatl = snap.pricesUsed.find((p: { symbol: string }) => p.symbol === 'vATL');
    expect(vatl).toEqual({ symbol: 'vATL', price: '95.00', observedAt: at(4).toISOString() });
    for (const p of snap.pricesUsed)
      expect(Date.parse(p.observedAt)).toBeLessThanOrEqual(ms(5, -1).getTime());
  });
});

describe('history edge cases', () => {
  it('handles multiple partial fills across ticks', async () => {
    h.clock.set(at(2));
    await h.placeOrder(alice, {
      symbol: 'vATL',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '250',
      limitPrice: '90.00',
    });
    h.clock.set(at(3));
    await h.tick('vATL', '90.00'); // fills 111.111111 @ 90.00
    h.clock.set(at(4));
    await h.tick('vATL', '89.00'); // fills 112.359550 @ 89.00 and 26.529339 @ 89.89

    const first = await h.history(alice, at(3));
    expect(position(first)!.shares.total).toBe('111.111111');
    expect(first.cash.reserved).toBe(new Decimal('250').sub('111.111111').mul('90').toFixed(8)); // 12500.00001
    expect(position(first)!.costBasis).toBe('9999.99999000');

    const done = await h.history(alice, at(4));
    const cost = new Decimal('111.111111')
      .mul(90)
      .add(new Decimal('112.359550').mul(89))
      .add(new Decimal('26.529339').mul('89.89'));
    expect(position(done)).toMatchObject({
      shares: { total: '250.000000' },
      costBasis: cost.toFixed(8),
    });
    expect(done.cash).toMatchObject({
      reserved: '0.00000000',
      available: new Decimal(100000).sub(cost).toFixed(8),
    });
  });

  it('orders same-timestamp events deterministically by ledger sequence', async () => {
    h.clock.set(at(10));
    // three orders, all committed with the identical timestamp t10
    await h.placeOrder(alice, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '5' });
    await h.placeOrder(alice, { symbol: 'vATL', side: 'SELL', type: 'MARKET', quantity: '5' });
    await h.placeOrder(alice, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '3' });
    const stamps = await h.sql<{ created_at: Date }>(
      `select distinct created_at from journals where user_id = $1 and type <> 'FUNDING'`,
      [alice.id],
    );
    expect(stamps).toHaveLength(1);

    const before = await h.history(alice, ms(10, -1));
    expect(before.positions).toEqual([]);
    const snap = await h.history(alice, at(10));
    // buy 5 @100, sell 5 @100 (realized 0), buy 3 @100. A sell-before-buy ordering would be invalid.
    expect(position(snap)).toMatchObject({
      shares: { total: '3.000000' },
      costBasis: '300.00000000',
      realizedPnl: '0.00000000',
    });
    for (let i = 0; i < 3; i++) expect(await h.history(alice, at(10))).toEqual(snap);
    expect(snap.ledger.lastJournalSequence).toBe(
      Number(
        (
          await h.sql<{ id: string }>(`select max(id)::text id from journals where user_id = $1`, [
            alice.id,
          ])
        )[0]!.id,
      ),
    );
  });

  it('includes a price tick observed exactly at the cutoff (inclusive boundary)', async () => {
    h.clock.set(at(30));
    await h.placeOrder(alice, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '1' });
    h.clock.set(at(31));
    await h.tick('vATL', '101.00');
    expect(position(await h.history(alice, at(31)))!.price).toBe('101.00');
    expect(position(await h.history(alice, ms(31, -1)))!.price).toBe('100.00');
  });

  it("isolates users: another user's activity never appears", async () => {
    const bob = await h.createUser();
    await h.placeOrder(bob, { symbol: 'vATL', side: 'BUY', type: 'MARKET', quantity: '9' });
    const snap = await h.history(alice, h.clock.now());
    expect(snap.positions).toEqual([]);
    expect(snap.cash.total).toBe('100000.00000000');
  });

  it.each([
    ['not-a-date', 'INVALID_TIMESTAMP'],
    ['2026-01-01', 'INVALID_TIMESTAMP'],
    ['2026-01-01T00:00:00', 'INVALID_TIMESTAMP'],
    ['2026-13-01T00:00:00Z', 'INVALID_TIMESTAMP'],
    ['2026-02-30T00:00:00Z', 'INVALID_TIMESTAMP'],
    ['2026-01-01T24:00:00Z', 'INVALID_TIMESTAMP'],
    ['2999-01-01T00:00:00Z', 'TIMESTAMP_IN_FUTURE'],
  ])('rejects at=%s', async (value, code) => {
    const res = await h.request(alice, 'GET', `/portfolio/history?at=${encodeURIComponent(value)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('requires the at parameter', async () => {
    expect((await h.request(alice, 'GET', '/portfolio/history')).statusCode).toBe(400);
  });

  it('accepts timezone offsets and sub-second precision', async () => {
    const snap = await h.history(alice, '2026-01-01T05:30:01.000+05:30');
    expect(snap.requestedAt).toBe(at(1).toISOString());
    expect(snap.cash.available).toBe('100000.00000000');
  });
});
