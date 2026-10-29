# Tokenized Pre-IPO Trading Platform

A simplified, production-minded backend for trading fictional pre-IPO share tokens against a
USD-denominated stablecoin. It provides simulated live prices, a USD→shares calculator, market and
limit orders with partial fills and cancellation, reservations for resting orders, idempotent order
placement, a per-asset circuit breaker, portfolio valuation with weighted-average cost basis, and
**historical portfolio reconstruction from an immutable double-entry ledger**.

- Node.js 22 · TypeScript (strict) · Fastify 5 · PostgreSQL (15/16) · Drizzle ORM + SQL migrations
- Zod validation → OpenAPI 3 (Swagger UI at `/docs`) · JWT auth · decimal.js (no float money)
- Vitest: 59 unit tests + 115 PostgreSQL integration tests (real concurrency, no mocked DB)

---

## Reviewer walkthrough (5 minutes)

**1. Start it** (needs Node.js ≥ 22.12 and Docker; for a local PostgreSQL instead, see
[Quick start](#quick-start))

```bash
npm ci
cp .env.example .env
docker compose up -d --wait postgres   # PostgreSQL on localhost:55432, databases `trading` + `trading_test`
npm run db:setup                # migrations + seed (4 assets, 2 funded users)
npm run dev                     # API on http://localhost:3000, prices tick every second
```

**2. Watch the whole flow** (in a second terminal, while the API is running)

```bash
npm run demo
```

The demo prints each step and its result: it registers a user, lists live prices, uses the
calculator, places a market buy, replays it with the same `Idempotency-Key` (same order, no double
execution) and with a different payload (409), places a limit buy that rests and reserves cash,
cancels it (reservation released), sells with realized P&L, triggers validation and insufficient
funds/shares errors, rebuilds the portfolio at a **past timestamp** from the ledger, and shows that
another user cannot read the order.

**3. Try it yourself** in Swagger UI at **http://localhost:3000/docs**. Log in with
`POST /auth/login` (`alice@example.com` / `password123`), click **Authorize**, paste the token,
then try `POST /orders` (add any `Idempotency-Key`), `GET /portfolio` and
`GET /portfolio/history?at=<ISO time>`.

![Swagger UI listing the market, orders and portfolio endpoints](docs/images/swagger-ui.webp)

**4. Run the tests** (they use the `trading_test` database, reset before every test)

```bash
npm test          # 174 tests: unit + PostgreSQL integration (concurrency, breaker, history)
npm run lint && npm run build
```

**What to look at**

| Requirement                                              | Where                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Immutable double-entry ledger, enforced by the database  | [Ledger model](#ledger-and-accounting-model), `drizzle/0001_ledger_guards.sql`                                                  |
| Historical portfolio (highest priority)                  | [Historical reconstruction](#historical-reconstruction), `src/modules/portfolio/`, `test/integration/portfolio-history.test.ts` |
| Orders, partial fills, reservations, cancellation        | [Trading engine](#trading-engine), `src/modules/orders/`                                                                        |
| Idempotency and concurrency                              | [Concurrency model](#concurrency-model), `test/integration/idempotency-concurrency.test.ts`                                     |
| Circuit breaker (not in the demo; needs injected prices) | [Circuit breaker](#circuit-breaker), `test/integration/circuit-breaker.test.ts`                                                 |
| Pure financial logic (no I/O)                            | `src/domain/`                                                                                                                   |

> If port 3000 is already in use, set `PORT=3001` in `.env`; `npm run demo` and the server both
> read it.

---

## Assumptions (where the brief was ambiguous)

Each open question, the decision taken, and why. Details are in the linked sections.

| Question                                             | Decision                                                                                                                                                                                                                              | Why                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Who is on the other side of a trade?                 | A simulated **house market maker** quotes a price ladder around the current price, with limited size per level. What one order uses up is shared by all users until the next price tick. ([Trading engine](#trading-engine))          | The brief has no other order flow; this gives realistic spread, partial fills and deterministic tests. Cross-user matching is a stretch goal. |
| What happens to the unfilled part of a market order? | **Cancelled immediately** (immediate-or-cancel). The order ends `CANCELLED` with `cancelReason: IOC_REMAINDER`, keeping its fills. Market orders never rest.                                                                          | A resting market order has no price limit, which is unsafe.                                                                                   |
| Market order size in shares or USD?                  | **Shares**, for both order types. `POST /calculator` converts USD to shares.                                                                                                                                                          | One size unit keeps reservations and validation simple.                                                                                       |
| When do resting limit orders fill?                   | On each new price tick, best limit first then oldest. Never at a worse price than the limit; a better price returns the difference to available cash.                                                                                 | Matches "resting" semantics against the simulated market.                                                                                     |
| How much is reserved?                                | Limit buy: quantity × limit price. Market buy: exact cost of its fills. Sell: the shares. Released on fill or cancel.                                                                                                                 | Guarantees an order can always settle; prevents double spending.                                                                              |
| Can a partially filled order be cancelled?           | Yes. Fills are kept, the remainder's reservation is released. Cancelling a filled or cancelled order → 409.                                                                                                                           | Standard exchange behaviour.                                                                                                                  |
| Idempotency details                                  | Key scoped per user. Same key + same body → original response (header `Idempotent-Replayed: true`). Same key + different body → 409. A failed request doesn't use up the key.                                                         | Safe client retries without duplicate orders.                                                                                                 |
| ">15% move in 60s": compared to what?                | Current price vs the **latest price at or before 60 s ago** (if none, the earliest price in the window). Strictly greater than 15%. ([Circuit breaker](#circuit-breaker))                                                             | A single, testable reference point; exact decimal comparison.                                                                                 |
| Do further big moves extend a halt?                  | **No.** A halt lasts 30 s; a qualifying move after it ends starts a new one.                                                                                                                                                          | Predictable `Retry-After`.                                                                                                                    |
| What still works during a halt?                      | Reads, the calculator and cancellations. Resting orders are **frozen** (not filled) until the halt ends. New orders → 503 with `Retry-After`.                                                                                         | A halt should stop execution, but users must be able to exit open orders.                                                                     |
| History: exact cut-off for `at`?                     | **Inclusive**: everything at or before `at`. Events with identical timestamps are ordered by ledger sequence. Future `at` → 400. Before the user existed → empty portfolio. ([Historical reconstruction](#historical-reconstruction)) | Deterministic, repeatable results.                                                                                                            |
| History: which price?                                | The latest price observed at or before `at`, never a later one. If none exists, value is `null` and `valuationComplete: false`.                                                                                                       | Values the past with the information available then.                                                                                          |
| Cost basis method                                    | **Weighted average**; selling realizes P&L against the average cost.                                                                                                                                                                  | Simple and common for this kind of product.                                                                                                   |
| Precision, fees, minimums                            | USD 8 decimals, shares 6, prices 2. Fees are zero. Minimum order value $1. ([Precision](#precision-rounding-fees-minimums))                                                                                                           | 6 + 2 = 8 decimals makes every trade value exact, with no rounding leftovers.                                                                 |
| Another user's order                                 | **404**, not 403.                                                                                                                                                                                                                     | Doesn't reveal that the order exists.                                                                                                         |
| Rejected orders                                      | Not stored; the whole transaction rolls back.                                                                                                                                                                                         | No partial financial effects; the key can be retried.                                                                                         |
| Short selling                                        | Not allowed: you can only sell shares you have available.                                                                                                                                                                             | Margin and shorting are stretch goals.                                                                                                        |
| Auth and funding                                     | Email/password → JWT. Every new user gets 100,000 simulated USD.                                                                                                                                                                      | Brief says not to over-invest in auth.                                                                                                        |

---

## Contents

0. [Assumptions](#assumptions-where-the-brief-was-ambiguous)
1. [Quick start](#quick-start)
2. [Scripts](#scripts)
3. [Architecture](#architecture)
4. [Precision, rounding, fees, minimums](#precision-rounding-fees-minimums)
5. [Ledger and accounting model](#ledger-and-accounting-model)
6. [Trading engine](#trading-engine)
7. [Circuit breaker](#circuit-breaker)
8. [Portfolio, cost basis and P&L](#portfolio-cost-basis-and-pl)
9. [Historical reconstruction](#historical-reconstruction)
10. [Concurrency model](#concurrency-model)
11. [Price simulator](#price-simulator)
12. [API reference](#api-reference)
13. [Testing](#testing)
14. [Limitations and trade-offs](#limitations-and-trade-offs)

---

## Quick start

Prerequisites: Node.js ≥ 22.12, and PostgreSQL 15+ (via Docker Compose or a local install).

```bash
npm ci
cp .env.example .env            # development defaults; never use the JWT placeholder in production
docker compose up -d --wait postgres   # localhost:55432, databases `trading` + `trading_test` (user/pass: trading)
npm run db:setup                # apply migrations + idempotent seed (assets, house accounts, users)
npm run dev                     # API on http://localhost:3000, simulator ticking every second
```

Open **http://localhost:3000/docs** for Swagger UI (raw spec: `/docs/json`, committed copy:
[docs/openapi.json](docs/openapi.json)).

> **Docker port:** Compose publishes PostgreSQL on host port **55432** (not 5432) so it never
> clashes with a locally installed PostgreSQL. If 55432 is taken, start it with
> `POSTGRES_PORT=<port> docker compose up -d --wait postgres` and use that port in both URLs in `.env`.
> Docker Desktop must be running (`docker info` should print a server version).
>
> **Local PostgreSQL instead of Docker?** Create the role and databases once:
> `psql -d postgres -c "CREATE ROLE trading LOGIN PASSWORD 'trading' CREATEDB" -c "CREATE DATABASE trading OWNER trading" -c "CREATE DATABASE trading_test OWNER trading"`,
> then change `55432` to `5432` in both URLs in `.env`.

### Authenticate locally

The seed creates two funded users (100,000 USD each): `alice@example.com` and `bob@example.com`,
password from `SEED_USER_PASSWORD` (default `password123`). Or register a new user, which is
funded with `INITIAL_USER_FUNDING`.

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"password123"}' | jq -r .token)
```

Send it as `Authorization: Bearer $TOKEN`. In Swagger UI use the **Authorize** button.

### Production topology

```bash
npm run build
npm run db:migrate                           # or: node dist/cli/migrate.js
SIMULATOR_ENABLED=false npm start            # N stateless API replicas
npm run start:worker                         # simulator + matching worker(s)
```

The simulator elects a single leader through a PostgreSQL advisory lock, so running several
workers (or leaving `SIMULATOR_ENABLED=true` on several API replicas) never double-ticks.
SIGINT/SIGTERM stop the simulator, drain HTTP connections and close the pool (10 s hard timeout).

---

## Scripts

| Script                                           | Purpose                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `npm run dev`                                    | API with hot reload (tsx)                                           |
| `npm run build` / `npm start`                    | Compile to `dist/` / run compiled API                               |
| `npm run worker` / `npm run start:worker`        | Simulator + matching worker (dev / compiled)                        |
| `npm run db:generate`                            | Generate a new SQL migration from `src/db/schema.ts` (drizzle-kit)  |
| `npm run db:migrate`                             | Apply SQL migrations in `drizzle/`                                  |
| `npm run db:seed`                                | Idempotent seed: assets, initial prices, system accounts, dev users |
| `npm run db:setup`                               | migrate + seed                                                      |
| `npm test`                                       | All tests (unit + PostgreSQL integration)                           |
| `npm run test:unit` / `npm run test:integration` | Subsets                                                             |
| `npm run lint`                                   | ESLint + Prettier check                                             |
| `npm run typecheck`                              | `tsc --noEmit` over src and tests                                   |
| `npm run openapi`                                | Regenerate `docs/openapi.json`                                      |

---

## Architecture

```
            HTTP (Fastify + Zod schemas → OpenAPI)           src/http
   ┌────────────┬────────────┬──────────────┬───────────────┐
   │ auth       │ assets /   │ orders       │ portfolio      │  routes: validation, auth,
   │ routes     │ calculator │ routes       │ routes         │  error mapping only
   └─────┬──────┴─────┬──────┴──────┬───────┴───────┬───────┘
         ▼            ▼             ▼               ▼
   AuthService  AssetService   OrderService    PortfolioService   application services
                CalculatorSvc  MatchingService (current + history)  (transactions, locking)
                PriceService ─ TradeExecutor ─┐
                MarketEngine / PriceSimulator │
         │            │             │         │     │
         ▼            ▼             ▼         ▼     ▼
   ┌─────────────────────────────────────────────────────────┐
   │ domain/ (pure, no I/O): money, liquidity ladder,        │   unit-tested
   │ order rules, cost basis, circuit breaker, calculator,   │
   │ GBM price process                                       │
   └─────────────────────────────────────────────────────────┘
         │ repositories (Drizzle query builder / SQL)          src/modules/*/*.repository.ts
         ▼
   PostgreSQL: tables + CHECK constraints + ledger triggers    drizzle/*.sql
```

- `src/domain` holds all financial rules as pure functions over `Decimal`.
- `src/modules/*` contain services (own transactions and lock ordering) and repositories (SQL).
- `src/http` only validates, authenticates, calls a service and maps errors. No trading logic.
- `src/container.ts` is the composition root; the `Clock` is injected everywhere.
- Structured JSON logging (pino) with request IDs (`x-request-id`), env validation with Zod at
  boot, central error handler, graceful shutdown.

**Why Fastify (not NestJS) and Drizzle:** the app is a handful of modules; plain Fastify plugins
plus a composition root keep the request path transparent. Drizzle provides typed schema and
queries while still allowing `SELECT … FOR UPDATE`, `ON CONFLICT`, and raw SQL where it matters.
The table DDL is generated by drizzle-kit (`drizzle/0000_initial_schema.sql`); the ledger
integrity triggers are a hand-written migration (`drizzle/0001_ledger_guards.sql`).

### Database schema

| Table                    | Purpose                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `users`                  | Email + scrypt password hash                                                                                                        |
| `assets`                 | vSOL, vATL, vHLX, vVAN (fictional)                                                                                                  |
| `price_ticks`            | Immutable price observations, unique per `(asset_id, observed_at)`                                                                  |
| `asset_market_state`     | Latest tick, per-tick liquidity consumed, `halted_until`. **Its row lock serialises all trading in one asset**                      |
| `circuit_breaker_events` | Immutable record of every halt (reference, trigger, ratio, window)                                                                  |
| `accounts`               | Ledger accounts: per user × instrument × {AVAILABLE, RESERVED}; house and funding accounts. `balance` is a trigger-maintained cache |
| `journals`               | Append-only journal headers; `id` is the global ledger sequence                                                                     |
| `ledger_entries`         | Append-only double-entry lines                                                                                                      |
| `orders`                 | Order state incl. filled/remaining qty, filled notional, reservation initial/remaining, timestamps                                  |
| `trades`                 | One row per fill, linked to its TRADE journal and the price tick it executed against                                                |
| `positions`              | Current weighted-average cost and realized P&L (a cache; history never reads it)                                                    |
| `idempotency_records`    | `(user_id, scope, key)` unique; request hash, order id, stored response                                                             |

---

## Precision, rounding, fees, minimums

| Quantity         | Scale | Column          | Notes                                        |
| ---------------- | ----- | --------------- | -------------------------------------------- |
| Stablecoin (USD) | 8 dp  | `NUMERIC(38,8)` | USDC-like; chosen so every notional is exact |
| Shares           | 6 dp  | `NUMERIC(38,6)` |                                              |
| Prices           | 2 dp  | `NUMERIC(20,2)` |                                              |

- **No floating point money.** NUMERIC is read as string (`pg` type parser), all arithmetic uses
  `decimal.js` (60 significant digits), API values are decimal strings. ESLint bans `parseFloat`.
  Input amounts must be JSON strings in plain notation (`"2.5"`; no `1e3`, `+1`, `.5`, numbers).
- **Fill notional = quantity × price is always exact** (6 dp × 2 dp = 8 dp). A DB CHECK enforces
  `trades.notional = quantity * price`. Reservations (`qty × limit`) are exact too, so a limit
  buy's reservation always reconciles to the cent-fraction — no rounding dust.
- Rounding rules:
  - Liquidity ladder prices: asks rounded **up**, bids **down** to the cent (house-favourable).
  - Ladder level sizes and calculator share estimates: rounded **down** to 6 dp.
  - Weighted-average cost removed on a partial sell: half-even to 8 dp; selling the whole position
    removes the exact remaining cost (no residue).
  - Simulator prices: half-even to 2 dp, floored at $0.01.
- **Fees:** zero. There is no fee code path (see limitations for how it would be added).
- **Minimum order:** quantity ≥ 0.000001 and notional ≥ `MIN_ORDER_NOTIONAL_USD` (default $1),
  measured at the limit price, or at the current mid for market orders (422 `ORDER_BELOW_MINIMUM`).
  Maximum quantity `MAX_ORDER_QUANTITY` (default 1,000,000), limit price ≤ 1e9.

---

## Ledger and accounting model

Double-entry, append-only. Each financial operation posts one **journal** with ≥ 2 **entries**.

**Sign convention:** `amount > 0` increases the account's balance, `amount < 0` decreases it.
**Balance rule:** within every journal, entries sum to zero **per instrument** (USD, and each
asset's shares separately).

Accounts (instrument = USD when `asset_id IS NULL`, otherwise that asset's shares):

| Account            | Owner  | May be negative | Meaning                                                           |
| ------------------ | ------ | --------------- | ----------------------------------------------------------------- |
| `USER_AVAILABLE`   | user   | no              | Spendable cash / sellable shares                                  |
| `USER_RESERVED`    | user   | no              | Earmarked for resting/in-flight orders                            |
| `HOUSE_INVENTORY`  | system | yes             | Simulated liquidity provider's cash and per-asset share inventory |
| `EXTERNAL_FUNDING` | system | yes             | Source of stablecoin issued to users                              |

Journal types and legs:

| Journal                           | Legs                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `FUNDING`                         | EXTERNAL_FUNDING(USD) −X · user AVAILABLE(USD) +X                                                |
| `ORDER_RESERVE`                   | BUY: AVAILABLE(USD) −R · RESERVED(USD) +R — SELL: AVAILABLE(sh) −q · RESERVED(sh) +q             |
| `TRADE` (BUY fill q @ p, limit L) | RESERVED(USD) −q·L · HOUSE(USD) +q·p · AVAILABLE(USD) +q·(L−p) · HOUSE(sh) −q · AVAILABLE(sh) +q |
| `TRADE` (SELL fill q @ p)         | RESERVED(sh) −q · HOUSE(sh) +q · HOUSE(USD) −q·p · AVAILABLE(USD) +q·p                           |
| `ORDER_RELEASE`                   | RESERVED −r · AVAILABLE +r (cancel, or unfilled market-order remainder)                          |

For a MARKET buy the reservation is exactly the cost of its planned fills, so `L` is replaced by `p`
and there is no improvement leg.

**Invariants enforced by PostgreSQL itself** (`drizzle/0001_ledger_guards.sql`), independent of
application code:

1. `journals`, `ledger_entries`, `trades`, `price_ticks`, `circuit_breaker_events` reject `UPDATE`
   and `DELETE` (and `TRUNCATE` for the ledger). Corrections must be compensating journals.
2. A deferred constraint trigger rejects, at commit, any journal not netting to zero per instrument.
3. `accounts.balance` is updated **only** by an `AFTER INSERT` trigger on `ledger_entries`; a
   direct `UPDATE` of a balance raises an error. The cache therefore always equals
   `SUM(ledger_entries.amount)`.
4. `CHECK (allow_negative OR balance >= 0)`: an overdraft aborts the whole transaction.
5. Entry `asset_id`/`created_at` are copied from the account/journal by trigger (cannot disagree).
6. Orders: `filled + remaining = quantity`; terminal orders hold no reservation; `FILLED ⇒ remaining = 0`.

Invariants additionally asserted after **every** integration test (`test/helpers/invariants.ts`):
balanced journals; cache = ledger; no negative user account; each user's RESERVED balance equals the
sum of `reserved_remaining` of their resting orders; order filled qty/notional = Σ trades;
positions qty = available + reserved shares; every instrument nets to zero across all accounts.

Ordering: `journals.id` is a global sequence. Every journal of a user is written while holding
that user's account row locks, and its timestamp is taken **after** those locks are acquired as
`max(clock.now(), user's latest journal time)`. Hence for each user `(created_at, id)` order equals
commit order, even if a transaction waited on a lock or app servers' clocks differ.

---

## Trading engine

### Simulated liquidity (house market maker)

Executions happen against a deterministic ladder quoted around the latest tick's mid price:

```
ask level i = ceil_2dp (mid × (1 + (HALF_SPREAD_BPS + i × LEVEL_STEP_BPS) / 10 000))
bid level i = floor_2dp(mid × (1 − (HALF_SPREAD_BPS + i × LEVEL_STEP_BPS) / 10 000))
level size  = floor_6dp(LEVEL_NOTIONAL_USD / level price)          i = 0 … LIQUIDITY_LEVELS−1
```

Defaults: 5 levels, 10 bps half-spread, 10 bps step, $25,000 per level. Liquidity consumed is
tracked per tick in `asset_market_state.ask_consumed/bid_consumed` (shared by all users) and is
replenished when the next tick arrives. So total volume per tick can never exceed the quoted
ladder. Each consumed level becomes a separate fill (trade row).

### Order types

|                  | MARKET                                                                                                                            | LIMIT                                                        |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Execution        | Walks the ladder immediately                                                                                                      | Executes immediately whatever is at or better than the limit |
| Remainder        | **Cancelled immediately (IOC)**: `CANCELLED` with `cancelReason=IOC_REMAINDER` (or `NO_LIQUIDITY` if nothing filled). Never rests | Rests (`OPEN` / `PARTIALLY_FILLED`)                          |
| BUY reservation  | Exact cost of the planned fills; rejected (422) if available cash is short                                                        | `quantity × limitPrice`; price improvement released per fill |
| SELL reservation | `quantity` shares (422 if not available); unfilled remainder released                                                             | `quantity` shares                                            |

Status machine: `OPEN → PARTIALLY_FILLED → FILLED`, and `OPEN | PARTIALLY_FILLED → CANCELLED`.
Rejected requests (validation, funds, breaker) are **not persisted** — they roll back entirely.

BUY limits never fill above the limit, SELL limits never below (asserted in code and tests).

**Resting orders** are re-evaluated whenever a new tick is recorded (`MarketEngine.ingest` →
`MatchingService.matchAsset`) in **price-time priority** (best limit first, then oldest), each in
its own short transaction. Average fill price = filled notional / filled quantity.

### Idempotency (`POST /orders`)

- `Idempotency-Key` header required (400 `IDEMPOTENCY_KEY_REQUIRED`), 1–255 printable ASCII chars.
- Scoped to `(user, "POST /orders", key)`; unique constraint in PostgreSQL.
- The key is claimed (`INSERT … ON CONFLICT DO NOTHING`) as the **first** statement of the order
  transaction. A concurrent request with the same key blocks on the unique index until the first
  commits, then sees the conflict — so only one logical order can ever exist per key.
- Same key + same payload → the stored original response (201, same body) with header
  `Idempotent-Replayed: true`; nothing is executed again. Payload equality is semantic (canonical
  hash, so `"10"` and `"10.000"` match).
- Same key + different payload → **409 `IDEMPOTENCY_KEY_REUSED`**.
- **Failure policy:** the claim lives in the same transaction as the order, so any failure
  (validation, 422, 503 breaker, crash) rolls back everything including the claim. Only successful
  orders are recorded; a failed request may be retried with the same key.

### Cancellation (`DELETE /orders/:id`)

Allowed for `OPEN` and `PARTIALLY_FILLED` orders (also while the asset's breaker is active).
Atomically: lock order → lock accounts → post `ORDER_RELEASE` for `reserved_remaining` → set
`CANCELLED`, `cancelled_at`, `reserved_remaining = 0`. Prior fills are preserved (a partially
filled order ends `CANCELLED` with its fills and filled quantity intact). Cancelling a `FILLED` or
`CANCELLED` order → 409 `ORDER_NOT_CANCELLABLE`. Another user's order → 404 (no existence oracle).

---

## Circuit breaker

- Evaluated atomically with each recorded tick, under the asset's market-state lock.
- `triggered ⇔ |current − reference| > 0.15 × reference` (exact decimal comparison, no division;
  exactly 15% does **not** trigger).
- **Reference price** = the latest observation at or before `tick time − 60 s`. If the asset has
  no observation that old (just listed), the earliest observation within the window is used. If
  neither exists, the breaker cannot trigger.
- On trigger: `halted_until = tick time + 30 s` and an immutable `circuit_breaker_events` row.
- **No extension:** qualifying moves during an active halt are recorded but do not extend it. After
  expiry, the next qualifying tick (the old reference may still be in the window) starts a new halt.
- While halted: `POST /orders` for that asset → **503 `CIRCUIT_BREAKER_ACTIVE`** with a `Retry-After`
  header and `details.haltedUntil`. Other assets, cancellations and all reads keep working.
- **Resting orders are frozen** (not matched) during the halt and stay cancellable; matching
  resumes on the first tick after expiry that does not itself trigger a halt.
- Duplicate/out-of-order ticks (same or older timestamp) are ignored — they can neither move the
  price nor trip the breaker.
- Bypass-proof: order placement takes the same market-state row lock and re-checks `halted_until`
  after acquiring it; tested by racing a triggering tick against 15 concurrent orders.

---

## Portfolio, cost basis and P&L

**Weighted-average cost**, per user and asset:

- BUY fill (q, cost c = q·p): `quantity += q`, `costBasis += c`.
- SELL fill (q, proceeds r = q·p): `costRemoved = costBasis × q / quantity` (half-even 8 dp; all
  of it when the position is closed), `realizedPnl += r − costRemoved`, `costBasis −= costRemoved`.
  Average cost of the remaining shares is unchanged.
- Partial fills are just several fills; each is applied in ledger order.
- Fees are zero; if added, buy fees would be capitalised into cost basis and sell fees deducted
  from proceeds.
- Reservations never change cost basis (reserved shares are still owned).

**Valuation:** `marketValue = totalShares × latest price` (mid, exact), `unrealizedPnl = marketValue
− costBasis`, `portfolioValue = total cash (available + reserved) + Σ marketValue`. Reservations are
a split of the same total, never extra assets: `available + reserved = total` for cash and for
every asset. If a held asset had no price, its market value is `null` and `valuationComplete=false`.

`GET /portfolio` reads balances, positions and prices in one `REPEATABLE READ` read-only snapshot.

---

## Historical reconstruction

`GET /portfolio/history?at=<ISO-8601 with timezone>` rebuilds the portfolio exactly as it was at
`at`, using **only immutable data**:

| Output                                       | Source                                                                                                                                                                |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Available / reserved / total cash and shares | `SUM(ledger_entries.amount)` per user account with `created_at <= at`                                                                                                 |
| Cost basis, average cost, realized P&L       | Replay of the user's `TRADE` journals with `created_at <= at`, ordered by `(created_at, journal id, entry id)`, through the same weighted-average functions used live |
| Outstanding reservations per order           | Net `USER_RESERVED` entries grouped by `journals.order_id`                                                                                                            |
| Prices                                       | For each asset, the latest `price_tick` with `observed_at <= at` (ties by id)                                                                                         |
| Market value, unrealized P&L, totals         | Same valuation function as the live portfolio                                                                                                                         |

Rules:

- **Boundary:** inclusive — an event or price observed at exactly `at` is included; everything with
  a later timestamp is excluded. Events sharing a timestamp are all included and are ordered by the
  journal sequence (deterministic; a sell can never be replayed before the buy that funded it).
- **Never reads mutable state:** not `accounts.balance`, not `positions`, not `orders.status`. A
  limit order that is `FILLED` today shows as an open reservation at a time before its fill.
- **Timestamp policy:** must be ISO-8601 with `Z` or an offset (`2026-01-01T12:00:00Z`,
  `…+05:30`, up to µs); calendar-validated (`2026-02-30` rejected). `at > now` → 400
  `TIMESTAMP_IN_FUTURE`. Times before the user existed return an empty (zero) portfolio.
- **Missing prices:** an asset with no observation at or before `at` has `price: null`; if it was
  held, its market value/unrealized P&L are `null` and `valuationComplete: false`.
- Response includes `requestedAt`, `valuationTimestamp` (newest input actually used: last ledger
  event or price observation), `ledger.lastJournalSequence`, `reservations`, and `pricesUsed`.
- All queries run in one `REPEATABLE READ` read-only transaction; they are bounded by the user's
  accounts and the cutoff and use the `(account_id, created_at)`, `(user_id, created_at, id)` and
  `(asset_id, observed_at)` indexes (prices via a `LATERAL … LIMIT 1` per asset).
- **Snapshots:** none — the ledger is replayed from the beginning for that user. For very long
  histories, periodic per-user checkpoints (balances + position state at a journal sequence,
  verified against the ledger) could be added and replayed forward; they would never replace the
  ledger as the source of truth.

Reconciliation: `history(now)` equals `GET /portfolio` exactly — tested after random concurrent
activity for several users.

---

## Concurrency model

All financial operations run in a single PostgreSQL `READ COMMITTED` transaction with explicit row
locks taken in one global order:

```
idempotency key claim → asset_market_state (FOR UPDATE) → order row (FOR UPDATE)
  → user's accounts (FOR UPDATE, ascending id) → house accounts (via ledger trigger)
```

| Operation             | Locks                         |
| --------------------- | ----------------------------- |
| Place order           | key → asset → user accounts   |
| Match resting order   | asset → order → user accounts |
| Cancel                | order → user accounts         |
| Record tick / breaker | asset                         |

Consequences: one asset's placements, matches and ticks are serialised (consistent liquidity and
breaker state); a fill and a cancel serialise on the order row and both re-check its status after
locking, so a remainder is consumed or released exactly once; balance checks happen while holding
the account locks; and the DB CHECK constraints are a final backstop. No in-memory mutexes are
relied upon, so this holds across processes. Deadlocks/serialisation failures (should not occur
given the lock order) map to 409 `TRANSACTION_CONFLICT` (retryable).

Tested with real concurrent requests on separate pooled connections: 25 buys vs a balance covering
5 (exactly 5 succeed), 25 resting buys (exactly 10 reservations), 12 concurrent sells of the same
shares, 20 requests with one idempotency key (one order), shared per-tick liquidity across 8 users,
fill-vs-cancel races, and breaker-vs-orders races.

---

## Price simulator

- Geometric Brownian motion per asset:
  `S(t+dt) = S(t)·exp((μ − σ²/2)dt + σ√dt·Z)`, `Z` from a seeded mulberry32 PRNG (Box–Muller).
  Arithmetic in Decimal, rounded to 2 dp. Configure with `SIMULATOR_SEED`, `SIMULATOR_VOLATILITY`
  (annualised, default 0.6), `SIMULATOR_DRIFT`, `SIMULATOR_TICK_MS`.
- Ticks are created by a background timer — never by HTTP requests. Tick timestamps are aligned to
  the interval, and `(asset_id, observed_at)` is unique, so retries/duplicates are harmless.
- Development: runs inside `npm run dev`. Production: `SIMULATOR_ENABLED=false` on API replicas and
  `npm run start:worker`; leader election via `pg_try_advisory_lock`.
- Tests disable the timer, use a `ManualClock`, and inject prices directly with
  `MarketEngine.ingest` / `PriceSimulator.tickOnce()`; the same seed reproduces the same path.

---

## API reference

Full schemas: Swagger UI `/docs`, spec [docs/openapi.json](docs/openapi.json).

| Method | Path                     | Auth   | Description                                                             |
| ------ | ------------------------ | ------ | ----------------------------------------------------------------------- |
| GET    | `/health`                | –      | Liveness + DB check                                                     |
| POST   | `/auth/register`         | –      | Create user (funded) → JWT                                              |
| POST   | `/auth/login`            | –      | Email/password → JWT                                                    |
| GET    | `/assets`                | –      | Assets, latest price, halt status                                       |
| GET    | `/assets/:symbol`        | –      | Details + price history (`from`, `to`, `limit` ≤ 5000) + breaker events |
| POST   | `/calculator`            | –      | Indicative USD → shares (read-only)                                     |
| POST   | `/orders`                | Bearer | Place order (`Idempotency-Key` required)                                |
| GET    | `/orders`                | Bearer | List own orders (`status`, `symbol`, `limit`, `offset`)                 |
| GET    | `/orders/:id`            | Bearer | Own order with fills                                                    |
| DELETE | `/orders/:id`            | Bearer | Cancel open remainder                                                   |
| GET    | `/portfolio`             | Bearer | Current portfolio                                                       |
| GET    | `/portfolio/history?at=` | Bearer | Portfolio reconstructed at `at`                                         |

### Error mapping

Every error: `{"error": {"code", "message", "details"?, "requestId"}}`.

| Status | Codes                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `VALIDATION_ERROR`, `MALFORMED_REQUEST`, `UNKNOWN_SYMBOL`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_TIMESTAMP`, `TIMESTAMP_IN_FUTURE` |
| 401    | `UNAUTHORIZED` (missing/invalid/expired token, bad credentials)                                                                                              |
| 404    | `ASSET_NOT_FOUND`, `ORDER_NOT_FOUND` (incl. other users' orders), `ROUTE_NOT_FOUND`                                                                          |
| 409    | `IDEMPOTENCY_KEY_REUSED`, `ORDER_NOT_CANCELLABLE`, `EMAIL_TAKEN`, `TRANSACTION_CONFLICT`                                                                     |
| 422    | `INSUFFICIENT_FUNDS`, `INSUFFICIENT_SHARES`, `ORDER_BELOW_MINIMUM`                                                                                           |
| 503    | `CIRCUIT_BREAKER_ACTIVE`, `MARKET_DATA_UNAVAILABLE` (+ `Retry-After`)                                                                                        |
| 500    | `INTERNAL_ERROR` (no internals leaked; full error logged)                                                                                                    |

403 is intentionally unused: ownership violations return 404 so order IDs cannot be probed.

### Examples

```bash
B=http://localhost:3000
curl -s $B/assets | jq
curl -s "$B/assets/vSOL?limit=20" | jq
curl -s -X POST $B/calculator -H 'content-type: application/json' \
  -d '{"symbol":"vSOL","usdAmount":"1000"}' | jq

# market buy
curl -s -X POST $B/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"symbol":"vSOL","side":"BUY","type":"MARKET","quantity":"2.5"}' | jq

# resting limit buy (reserves 2.5 × 400 = 1000 USD)
curl -s -X POST $B/orders -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'Idempotency-Key: my-limit-1' \
  -d '{"symbol":"vSOL","side":"BUY","type":"LIMIT","quantity":"2.5","limitPrice":"400.00"}' | jq

curl -s "$B/orders?status=OPEN" -H "authorization: Bearer $TOKEN" | jq
curl -s -X DELETE $B/orders/<order-id> -H "authorization: Bearer $TOKEN" | jq
curl -s $B/portfolio -H "authorization: Bearer $TOKEN" | jq
curl -s "$B/portfolio/history?at=2026-10-29T10:00:00Z" -H "authorization: Bearer $TOKEN" | jq
```

Example order response (abridged):

```json
{
  "id": "56d5069b-5b30-4977-bafc-b55028e9fc5e",
  "symbol": "vSOL",
  "side": "BUY",
  "type": "MARKET",
  "status": "FILLED",
  "quantity": "2.500000",
  "filledQuantity": "2.500000",
  "remainingQuantity": "0.000000",
  "limitPrice": null,
  "averageFillPrice": "420.33000000",
  "filledNotional": "1050.82500000",
  "reservation": { "instrument": "USD", "initial": "1050.82500000", "remaining": "0.00000000" },
  "cancelReason": null,
  "fills": [
    {
      "id": 1,
      "quantity": "2.500000",
      "price": "420.33",
      "notional": "1050.82500000",
      "liquidityLevel": 0,
      "executedAt": "…"
    }
  ]
}
```

---

## Testing

```bash
npm test                 # everything (needs TEST_DATABASE_URL, default postgres://trading:trading@localhost:55432/trading_test)
npm run test:unit
npm run test:integration
```

Integration tests **drop and recreate the `public` schema of the test database** before each test,
run the real migrations, and use a `ManualClock` and injected prices — no flakiness, no mocks of
the database. Files run sequentially (shared DB); requests inside a test run concurrently on
separate pooled connections.

| File                              | Covers                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/*`                     | Decimal parsing/precision, liquidity ladder & fill planning, weighted-average cost, breaker math and reference policy, calculator, deterministic GBM, order validation, env validation                                                                                                                                               |
| `market.test.ts`                  | Asset list/details, price history & filters, duplicate ticks, calculator correctness/validation/read-only, deterministic simulator                                                                                                                                                                                                   |
| `orders.test.ts`                  | Market buy/sell, multi-level fills, IOC partial fills, per-tick liquidity, resting/immediate/partial limit orders, later fills on ticks, price-time priority, cancellation & release, 409s, insufficient cash/shares, double reservation, minimum notional, input validation, rollback on mid-transaction failure, DB guard triggers |
| `idempotency-concurrency.test.ts` | Replay, 409 on payload change, per-user scope, failed request doesn't consume key, concurrent same key, overspend/oversell/double-reserve races, shared liquidity, fill-vs-cancel race, history ↔ live reconciliation after concurrent activity                                                                                      |
| `circuit-breaker.test.ts`         | Activation, 503 + Retry-After, per-asset scope, reads/cancel allowed, exact 15% boundary, reference window, duplicate ticks, no extension, frozen resting orders, race with orders                                                                                                                                                   |
| `portfolio-history.test.ts`       | Empty/initial funding, before/after buy, reservations before/after, before a later fill, after sell with realized P&L, historical vs current price, cancellation, immutability under later activity, multiple partial fills, same-timestamp ordering, inclusive boundary, user isolation, timestamp validation                       |
| `auth.test.ts`                    | Register/login, protected routes, forged tokens, ownership                                                                                                                                                                                                                                                                           |

---

## Limitations and trade-offs

- **Liquidity is simulated** by a house market maker (the counterparty of every trade); there is no
  cross-user order book. Price-time priority applies among resting orders competing for the house
  ladder. Users' orders never match each other.
- **Per-asset serialisation.** The market-state row lock makes each asset's trading single-file;
  the house USD account row is also updated by every trade, so trades platform-wide serialise on
  it at commit. Correct and simple, but it caps throughput; a production system would shard house
  inventory or derive house balances without a hot cached row.
- Market orders are IOC and size-based (shares). There is no notional ("spend $X") order type; the
  calculator gives the indicative share count.
- Resting orders are matched only when a new tick arrives (not continuously within a tick).
- The breaker evaluates the move between the current tick and one reference price, not the
  intra-window high/low.
- `GET /portfolio/history` with `at` very close to "now" may not yet include a transaction that is
  still in flight (its journal becomes visible on commit); past cutoffs are stable.
- Rejected orders are not persisted (no audit trail of rejections other than logs).
- Fees are not implemented (zero). Adding them: a `FEE_INCOME` system account, an extra leg in the
  TRADE journal, reservation `qty × limit × (1 + fee)`, fee capitalised into buy cost basis.
- No rate limiting, WebSockets, admin halt/resume, short selling or margin (out of scope).
- Auth is deliberately lightweight: email/password (scrypt) → HS256 JWT, no refresh tokens or
  revocation. Registration grants simulated funds.
- Accounts are created lazily per instrument; system accounts must exist (created by the seed).
