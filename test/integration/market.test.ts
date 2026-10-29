import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await Harness.create();
});
afterEach(async () => {
  await h.close();
});

describe('GET /assets', () => {
  it('lists the four seeded assets with latest prices', async () => {
    const res = await h.request(null, 'GET', '/assets');
    expect(res.statusCode).toBe(200);
    const { assets } = res.json();
    expect(assets.map((a: { symbol: string; price: string }) => [a.symbol, a.price])).toEqual([
      ['vSOL', '420.00'],
      ['vATL', '95.50'],
      ['vHLX', '180.25'],
      ['vVAN', '310.10'],
    ]);
    expect(assets[0]).toMatchObject({
      name: 'Solace AI',
      trading: { halted: false, haltedUntil: null },
    });
  });

  it('reflects the latest tick', async () => {
    h.clock.advanceSeconds(1);
    await h.tick('vSOL', '425.50');
    const { assets } = (await h.request(null, 'GET', '/assets')).json();
    expect(assets[0].price).toBe('425.50');
    expect(assets[0].changeFromInitial).toBe('0.013095');
  });
});

describe('GET /assets/:symbol', () => {
  it('returns details and chronological price history', async () => {
    for (const p of ['421.00', '422.00', '419.50']) {
      h.clock.advanceSeconds(1);
      await h.tick('vSOL', p);
    }
    const res = await h.request(null, 'GET', '/assets/vSOL');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.price).toBe('419.50');
    expect(body.priceHistory.map((t: { price: string }) => t.price)).toEqual([
      '420.00',
      '421.00',
      '422.00',
      '419.50',
    ]);
    expect(body.priceHistory[0].source).toBe('SEED');
  });

  it('supports limit and time-range filters on history', async () => {
    for (const p of ['421.00', '422.00', '423.00']) {
      h.clock.advanceSeconds(10);
      await h.tick('vSOL', p);
    }
    const latestTwo = (await h.request(null, 'GET', '/assets/vSOL?limit=2')).json();
    expect(latestTwo.priceHistory.map((t: { price: string }) => t.price)).toEqual([
      '422.00',
      '423.00',
    ]);
    const ranged = (
      await h.request(null, 'GET', '/assets/vSOL?from=2026-01-01T00:00:05Z&to=2026-01-01T00:00:21Z')
    ).json();
    expect(ranged.priceHistory.map((t: { price: string }) => t.price)).toEqual([
      '421.00',
      '422.00',
    ]);
  });

  it('404s for unknown assets', async () => {
    const res = await h.request(null, 'GET', '/assets/NOPE');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ASSET_NOT_FOUND');
  });

  it('ignores duplicate and out-of-order ticks', async () => {
    h.clock.advanceSeconds(1);
    expect((await h.tick('vSOL', '421.00')).status).toBe('RECORDED');
    expect((await h.tick('vSOL', '999.00')).status).toBe('DUPLICATE');
    const rows = await h.sql(
      `select count(*)::int as n from price_ticks t join assets a on a.id = t.asset_id where a.symbol = 'vSOL'`,
    );
    expect(rows[0]).toEqual({ n: 2 });
  });
});

describe('POST /calculator', () => {
  it('converts USD to shares at the latest price, rounding shares down', async () => {
    const res = await h.request(null, 'POST', '/calculator', { symbol: 'vSOL', usdAmount: '1000' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      symbol: 'vSOL',
      usdAmount: '1000.00000000',
      price: '420.00',
      priceType: 'INDICATIVE_MID',
      estimatedShares: '2.380952',
      estimatedCost: '999.99984000',
      remainder: '0.00016000',
      calculatedAt: h.clock.now().toISOString(),
    });
  });

  it('is read-only: no orders, journals or balance changes', async () => {
    const before = await h.sql(
      `select (select count(*) from orders) o, (select count(*) from journals) j, (select sum(balance) from accounts where user_id is not null) b`,
    );
    await h.request(null, 'POST', '/calculator', { symbol: 'vATL', usdAmount: '50000' });
    const after = await h.sql(
      `select (select count(*) from orders) o, (select count(*) from journals) j, (select sum(balance) from accounts where user_id is not null) b`,
    );
    expect(after).toEqual(before);
  });

  it.each([
    [{ symbol: 'NOPE', usdAmount: '10' }, 'UNKNOWN_SYMBOL'],
    [{ symbol: 'vSOL', usdAmount: '0' }, 'VALIDATION_ERROR'],
    [{ symbol: 'vSOL', usdAmount: '-5' }, 'VALIDATION_ERROR'],
    [{ symbol: 'vSOL', usdAmount: '1.123456789' }, 'VALIDATION_ERROR'],
    [{ symbol: 'vSOL', usdAmount: 'ten' }, 'VALIDATION_ERROR'],
    [{ symbol: 'vSOL', usdAmount: 100 }, 'VALIDATION_ERROR'],
    [{ symbol: 'vSOL' }, 'VALIDATION_ERROR'],
  ])('rejects %j', async (body, code) => {
    const res = await h.request(null, 'POST', '/calculator', body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(code);
  });

  it('rejects malformed JSON', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/calculator',
      payload: '{bad',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('price simulator', () => {
  it('produces deterministic ticks from a seed with a controllable clock', async () => {
    const run = async () => {
      const prices: string[] = [];
      for (let i = 0; i < 5; i++) {
        h.clock.advanceSeconds(1);
        await h.c.simulator.tickOnce();
      }
      const rows = await h.sql<{ price: string }>(
        `select t.price from price_ticks t join assets a on a.id = t.asset_id where a.symbol = 'vSOL' and t.source = 'SIMULATOR' order by t.observed_at`,
      );
      prices.push(...rows.map((r) => r.price));
      return prices;
    };
    const first = await run();
    expect(first).toHaveLength(5);
    expect(new Set(first).size).toBeGreaterThan(1);

    // A fresh environment with the same seed reproduces the exact same path.
    await h.close();
    h = await Harness.create();
    expect(await run()).toEqual(first);
  });

  it('does not create a second tick for the same time slot', async () => {
    h.clock.advanceSeconds(1);
    await h.c.simulator.tickOnce();
    await h.c.simulator.tickOnce();
    const rows = await h.sql(`select count(*)::int n from price_ticks where source = 'SIMULATOR'`);
    expect(rows[0]).toEqual({ n: 4 });
  });
});
