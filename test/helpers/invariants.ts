import { expect } from 'vitest';
import type { Harness } from './harness.js';

/**
 * Global accounting invariants, checked directly in SQL after every scenario:
 *  1. every journal nets to zero per instrument;
 *  2. every account's cached balance equals the sum of its ledger entries;
 *  3. no user account is negative;
 *  4. each user's reserved balance equals the outstanding reservations of their resting orders;
 *  5. terminal orders hold no reservation; filled + remaining = quantity;
 *  6. order filled quantity / notional equal the sum of their trades;
 *  7. positions quantity equals available + reserved shares;
 *  8. per instrument, the whole ledger nets to zero (house + users + external).
 */
export async function assertLedgerInvariants(h: Harness): Promise<void> {
  const unbalanced = await h.sql(`
    select journal_id, asset_id, sum(amount) from ledger_entries
     group by journal_id, asset_id having sum(amount) <> 0`);
  expect(unbalanced).toEqual([]);

  const cacheMismatch = await h.sql(`
    select a.id, a.balance, coalesce(sum(le.amount), 0) as ledger
      from accounts a left join ledger_entries le on le.account_id = a.id
     group by a.id having a.balance <> coalesce(sum(le.amount), 0)`);
  expect(cacheMismatch).toEqual([]);

  const negative = await h.sql(
    `select id, balance from accounts where user_id is not null and balance < 0`,
  );
  expect(negative).toEqual([]);

  const reservationMismatch = await h.sql(`
    with reserved as (
      select user_id, asset_id, balance from accounts where type = 'USER_RESERVED'
    ), outstanding as (
      select user_id,
             case when side = 'BUY' then null else asset_id end as asset_id,
             sum(reserved_remaining) as amount
        from orders where status in ('OPEN', 'PARTIALLY_FILLED')
       group by 1, 2
    )
    select r.user_id, r.asset_id, r.balance, coalesce(o.amount, 0) as outstanding
      from reserved r
      left join outstanding o on o.user_id = r.user_id and o.asset_id is not distinct from r.asset_id
     where r.balance <> coalesce(o.amount, 0)`);
  expect(reservationMismatch).toEqual([]);

  const badOrders = await h.sql(`
    select id from orders
     where (status in ('FILLED', 'CANCELLED') and reserved_remaining <> 0)
        or filled_quantity + remaining_quantity <> quantity
        or (type = 'MARKET' and status in ('OPEN', 'PARTIALLY_FILLED'))`);
  expect(badOrders).toEqual([]);

  const fillMismatch = await h.sql(`
    select o.id from orders o left join trades t on t.order_id = o.id
     group by o.id
    having o.filled_quantity <> coalesce(sum(t.quantity), 0)
        or o.filled_notional <> coalesce(sum(t.notional), 0)`);
  expect(fillMismatch).toEqual([]);

  const positionMismatch = await h.sql(`
    select p.user_id, p.asset_id from positions p
      join accounts a on a.user_id = p.user_id and a.asset_id = p.asset_id
     group by p.user_id, p.asset_id, p.quantity
    having p.quantity <> sum(a.balance)`);
  expect(positionMismatch).toEqual([]);

  const instrumentNet = await h.sql(
    `select asset_id, sum(balance) from accounts group by asset_id having sum(balance) <> 0`,
  );
  expect(instrumentNet).toEqual([]);
}
