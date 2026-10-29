import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Harness } from '../helpers/harness.js';

let h: Harness;
beforeEach(async () => {
  h = await Harness.create();
});
afterEach(async () => {
  await h.close();
});

describe('authentication', () => {
  it('registers, funds and logs in a user', async () => {
    const reg = await h.request(null, 'POST', '/auth/register', {
      email: 'Carol@Example.com',
      password: 'longpassword',
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ tokenType: 'Bearer', user: { email: 'carol@example.com' } });
    const login = await h.request(null, 'POST', '/auth/login', {
      email: 'carol@example.com',
      password: 'longpassword',
    });
    expect(login.statusCode).toBe(200);
    const portfolio = await h.app.inject({
      method: 'GET',
      url: '/portfolio',
      headers: { authorization: `Bearer ${login.json().token}` },
    });
    expect(portfolio.json().cash.available).toBe('100000.00000000');
  });

  it('rejects duplicate emails, bad passwords and malformed credentials', async () => {
    await h.request(null, 'POST', '/auth/register', {
      email: 'dave@example.com',
      password: 'longpassword',
    });
    expect(
      (
        await h.request(null, 'POST', '/auth/register', {
          email: 'dave@example.com',
          password: 'longpassword',
        })
      ).statusCode,
    ).toBe(409);
    const bad = await h.request(null, 'POST', '/auth/login', {
      email: 'dave@example.com',
      password: 'wrongpassword',
    });
    expect(bad.statusCode).toBe(401);
    expect(
      (
        await h.request(null, 'POST', '/auth/login', {
          email: 'nobody@example.com',
          password: 'whatever1',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.request(null, 'POST', '/auth/register', {
          email: 'not-an-email',
          password: 'longpassword',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.request(null, 'POST', '/auth/register', {
          email: 'e@example.com',
          password: 'short',
        })
      ).statusCode,
    ).toBe(400);
  });

  it.each([
    ['GET', '/portfolio'],
    ['GET', '/portfolio/history?at=2026-01-01T00:00:00Z'],
    ['GET', '/orders'],
    ['POST', '/orders'],
    ['GET', '/orders/00000000-0000-4000-8000-000000000000'],
    ['DELETE', '/orders/00000000-0000-4000-8000-000000000000'],
  ] as const)('protects %s %s', async (method, url) => {
    const res = await h.request(null, method, url, method === 'POST' ? {} : undefined);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
    const forged = await h.app.inject({
      method,
      url,
      headers: { authorization: 'Bearer abc.def.ghi' },
    });
    expect(forged.statusCode).toBe(401);
  });

  it('rejects tokens signed with another secret', async () => {
    const { createSigner } = await import('fast-jwt');
    const token = createSigner({ key: 'some-other-secret-some-other-secret' })({
      sub: 'x',
      email: 'x',
    });
    const res = await h.app.inject({
      method: 'GET',
      url: '/portfolio',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('resource ownership', () => {
  it("prevents reading or cancelling another user's order", async () => {
    const alice = await h.createUser();
    const bob = await h.createUser();
    const order = (
      await h.placeOrder(alice, {
        symbol: 'vATL',
        side: 'BUY',
        type: 'LIMIT',
        quantity: '1',
        limitPrice: '50.00',
      })
    ).json();
    expect((await h.request(bob, 'GET', `/orders/${order.id}`)).statusCode).toBe(404);
    const cancel = await h.request(bob, 'DELETE', `/orders/${order.id}`);
    expect(cancel.statusCode).toBe(404);
    expect((await h.request(bob, 'GET', '/orders')).json().orders).toEqual([]);
    expect((await h.request(alice, 'GET', `/orders/${order.id}`)).json().status).toBe('OPEN');
    // bob's portfolio is unaffected by alice's activity
    expect((await h.portfolio(bob)).cash.reserved).toBe('0.00000000');
  });
});
